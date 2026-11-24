import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Prisma, ShopifyWrite, ShopifyWriteAction, ShopifyWriteEntity, ShopifyWriteStatus } from "@prisma/client";
import { AccessDeniedError } from "@/server/auth/errors";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { subKey } from "@/server/crypto/credentials";
import { prisma } from "@/server/db/prisma";
import { problemResponse } from "@/server/api/http-error";
import { isUniqueViolation } from "@/server/tasks/errors";
import { isShopifyMcp } from "@/server/shopify/catalog-mcp";
import { askCartWriteAdapter, type ShopifyRefusal, type ShopifyResult, type ShopifyWriteAdapter } from "@/server/shopify/adapter";
import { SHOPIFY_WRITE_SCOPE, type PermissionKey, type ShopifyWriteCode, type ShopifyWritePreview, type ShopifyWritesReady } from "@/shared";

/**
 * Writes to Shopify only after a person confirms the exact change, at most once, audited (plan 2026-11-24-phase-3-crm,
 * Task 4). previewWrite returns the payload and a confirmToken signed over it; confirmWrite re-checks the permission,
 * rebuilds the payload, refuses if it changed, then sends it through the adapter under a ShopifyWrite row:
 *  - no row → PENDING, sent. FAILED (a definite refusal, nothing written) → the same row, sent again.
 *  - PENDING younger than 2 min → "Already sending"; older → UNKNOWN (expireStaleWrites does the same after 10 min).
 *  - UNKNOWN (no answer, may have been written) → reconcile first; found → DONE, never sent twice; not found → wait
 *    until 10 min after the send (Shopify's search lags), then a person may choose "Send again" = the next attempt.
 *  - DONE → "Already done"; a repeatable action (invoice) is sent again only as a deliberate next attempt.
 * ponytail: an adapter call is assumed to answer or throw well within 2 min; a slower one could overlap a confirm that
 * found it stale (reconcile then runs while the first send is in flight). Keep adapter timeouts under a minute.
 */
export type WriteScope = { workspaceId: string; brandId: string; userId: string; perms: Set<PermissionKey> };
export type WriteKey = { entityType: ShopifyWriteEntity; entityId: string; action: ShopifyWriteAction };

const CONFIRM_TTL_MS = 10 * 60_000;
export const PENDING_STALE_MS = 2 * 60_000;
export const UNKNOWN_WAIT_MS = 10 * 60_000;
const HOUR = 3_600_000;
/** A send with no answer by then counts as unanswered (UNKNOWN), well inside PENDING_STALE_MS. */
const RUN_TIMEOUT_MS = 60_000;
const REPEATABLE = new Set<ShopifyWriteAction>(["DRAFT_ORDER_INVOICE_SEND"]);

/** A refused preview or confirm; routes answer it with shopifyWriteProblem. Messages are fixed text, never Shopify's. */
export class ShopifyWriteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ShopifyWriteCode,
    /** USER_ERROR: Shopify's field paths */ readonly fields?: string[],
  ) {
    super(message);
  }
}

export function shopifyWriteProblem(error: unknown) {
  if (!(error instanceof ShopifyWriteError)) return null;
  return problemResponse({ type: "https://api.brandpilot/errors/shopify-write", title: error.message, status: error.status, detail: error.message, code: error.code, ...(error.fields ? { fields: error.fields } : {}) });
}

const sorted = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v;

/** sha256 of the payload as JSON with keys sorted at every level: the same content always hashes the same. */
export const payloadHash = (payload: unknown) => createHash("sha256").update(JSON.stringify(sorted(payload)) ?? "").digest("hex");

type Claims = WriteKey & { brandId: string; version: number; attempt: number; hash: string; userId: string; exp: number };

const sign = (body: string) => createHmac("sha256", subKey("shopify-confirm")).update(body).digest();

export function confirmToken(c: Claims) {
  const body = Buffer.from([c.brandId, c.entityType, c.entityId, c.version, c.action, c.attempt, c.hash, c.userId, c.exp].join("|")).toString("base64url");
  return `${body}.${sign(body).toString("base64url")}`;
}

/** The claims of a token we signed that hasn't expired, else null. */
export function readConfirmToken(token: string, now = new Date()): Claims | null {
  if (typeof token !== "string" || token.length > 1000) return null;
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined) return null;
  const given = Buffer.from(mac, "base64url");
  const expected = sign(body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const [brandId, entityType, entityId, version, action, attempt, hash, userId, exp] = Buffer.from(body, "base64url").toString("utf8").split("|");
  if (!userId || !Number.isFinite(Number(exp)) || Number(exp) < now.getTime()) return null;
  return { brandId, entityType: entityType as ShopifyWriteEntity, entityId, version: Number(version), action: action as ShopifyWriteAction, attempt: Number(attempt), hash, userId, exp: Number(exp) };
}

export const MCP_ONLY = "This store is connected through Shopify MCP, which reads products only. Reconnect it through the AskCart app to enable this.";

/**
 * The brand's Shopify is connected only through Shopify MCP (catalogue reads): nothing can be written or read back
 * through the write adapter, so callers stop before reaching it. A brand with no Shopify connection isn't MCP-only.
 */
export async function shopifyMcpOnly(scope: { workspaceId: string; brandId: string }) {
  const conns = await prisma.integrationConnection.findMany({
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId, provider: "SHOPIFY", status: { not: "REVOKED" } },
    select: { scopes: true },
  });
  return conns.length > 0 && conns.every(isShopifyMcp);
}

/**
 * Whether this brand's writes for `action` can run now. An MCP-only brand is refused (422) before the adapter.
 * `mcpOnly`: shopifyMcpOnly as the caller already read it for this preview or confirm (read here when not given).
 */
export async function writesReady(adapter: ShopifyWriteAdapter, scope: WriteScope, action: ShopifyWriteAction, mcpOnly?: boolean): Promise<ShopifyWritesReady> {
  if (mcpOnly ?? (await shopifyMcpOnly(scope))) throw new ShopifyWriteError(MCP_ONLY, 422, "NOT_CONNECTED");
  const caps = await adapter.capabilities({ workspaceId: scope.workspaceId, brandId: scope.brandId });
  if (!caps.connected) return { ready: false, reason: "NOT_CONNECTED" };
  const needed = SHOPIFY_WRITE_SCOPE[action];
  return caps.scopes.includes(needed) ? { ready: true } : { ready: false, reason: "MISSING_SCOPE", scope: needed };
}

const NOT_CONNECTED = "Shopify writes aren't connected yet";
const refusalError = (r: ShopifyRefusal | Exclude<ShopifyWritesReady, { ready: true }>) =>
  r.reason === "NOT_CONNECTED"
    ? new ShopifyWriteError(NOT_CONNECTED, 503, "NOT_CONNECTED")
    : r.reason === "MISSING_SCOPE"
      ? new ShopifyWriteError(`Shopify access is missing ${r.scope}. Ask for it to be added to the store's app.`, 422, "MISSING_SCOPE")
      : new ShopifyWriteError("Shopify refused the change", 422, "USER_ERROR", r.fields.slice(0, 20).map((f) => f.slice(0, 100)));
const REFUSAL_TEXT: Record<ShopifyRefusal["reason"], string> = { NOT_CONNECTED, MISSING_SCOPE: "Missing scope", USER_ERROR: "Shopify refused the change" };

const latest = (scope: WriteScope, key: WriteKey, version: number) =>
  prisma.shopifyWrite.findFirst({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId, ...key, version }, orderBy: { attempt: "desc" } });

/**
 * What a person is shown before confirming: the payload as it will be written (the caller lists every field, link
 * target and, for an invoice, to, subject and message in it: all of it is in the hash) and a token valid 10 min.
 * `again`: after a DONE repeatable action or an UNKNOWN that reconcile can't find, the token is for the next attempt.
 */
export async function previewWrite<P>(
  scope: WriteScope,
  input: WriteKey & { version: number; payload: P; again?: boolean; mcpOnly?: boolean },
  adapter: ShopifyWriteAdapter = askCartWriteAdapter,
  now = new Date(),
): Promise<ShopifyWritePreview<P>> {
  const { entityType, entityId, action, version, payload } = input;
  const last = await latest(scope, { entityType, entityId, action }, version);
  const next = input.again && last && (last.status === "UNKNOWN" || (last.status === "DONE" && REPEATABLE.has(action)));
  const attempt = !last ? 1 : next ? last.attempt + 1 : last.attempt;
  const exp = now.getTime() + CONFIRM_TTL_MS;
  const confirm = confirmToken({ brandId: scope.brandId, entityType, entityId, version, action, attempt, hash: payloadHash(payload), userId: scope.userId, exp });
  return {
    preview: payload,
    attempt,
    confirmToken: confirm,
    expiresAt: new Date(exp).toISOString(),
    writes: await writesReady(adapter, scope, action, input.mcpOnly),
    last: last && last.attempt === attempt ? last.status : null,
  };
}

export type ConfirmHooks<P, R extends { shopifyId: string }> = {
  /** Held by the person now (scope.perms is read at confirm, so a key removed since the preview refuses). */
  permission: PermissionKey;
  /** Re-reads the entity (brand-scoped) and builds the payload as it would be written now. */
  rebuild: () => Promise<{ version: number; payload: P }>;
  /** The write, through the adapter. */
  run: (adapter: ShopifyWriteAdapter, payload: P, requestId: string) => Promise<ShopifyResult<R>>;
  /** Whether an unanswered send reached Shopify: the written object, or null when Shopify has no sign of it. */
  reconcile: (adapter: ShopifyWriteAdapter, write: ShopifyWrite) => Promise<ShopifyResult<R | null>>;
  /** Runs in the transaction that marks the write DONE: update the entity from Shopify's answer. Database writes only, no network calls. */
  onDone?: (tx: Prisma.TransactionClient, result: R, write: ShopifyWrite) => Promise<void>;
  /** shopifyMcpOnly as the caller already read it for this confirm (read here when not given). */
  mcpOnly?: boolean;
};

/** Confirms a previewed write. Returns Shopify's answer once DONE; every other outcome throws a ShopifyWriteError. */
export async function confirmWrite<P, R extends { shopifyId: string }>(
  scope: WriteScope,
  token: string,
  key: WriteKey,
  hooks: ConfirmHooks<P, R>,
  adapter: ShopifyWriteAdapter = askCartWriteAdapter,
  now = new Date(),
): Promise<{ result: R; write: ShopifyWrite }> {
  if (!scope.perms.has(hooks.permission)) throw new AccessDeniedError(`Missing permission ${hooks.permission}`);
  const c = readConfirmToken(token, now);
  if (!c || c.userId !== scope.userId || c.brandId !== scope.brandId || c.entityType !== key.entityType || c.entityId !== key.entityId || c.action !== key.action) {
    throw new ShopifyWriteError("This confirmation is no longer valid. Check the change again.", 409, "BAD_TOKEN");
  }
  const { version, payload } = await hooks.rebuild();
  if (version !== c.version || payloadHash(payload) !== c.hash) throw new ShopifyWriteError("This changed since you checked it", 409, "CHANGED");
  const ready = await writesReady(adapter, scope, key.action, hooks.mcpOnly);
  if (!ready.ready) throw refusalError(ready);

  const where = { workspaceId: scope.workspaceId, brandId: scope.brandId, ...key, version };
  let row = await prisma.shopifyWrite.findFirst({ where: { ...where, attempt: c.attempt } });
  if (!row) {
    if (c.attempt > 1) await mayTryAgain(await prisma.shopifyWrite.findFirst({ where: { ...where, attempt: c.attempt - 1 } }), hooks, adapter, now);
    try {
      row = await prisma.shopifyWrite.create({
        data: { ...where, attempt: c.attempt, payloadHash: c.hash, actorUserId: scope.userId, startedAt: now },
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ShopifyWriteError("Already sending", 409, "ALREADY_SENDING");
      throw e;
    }
    // Counted only once this confirm won the row; refused → the row goes, nothing was sent.
    const created = row;
    await rateLimit(scope, () => prisma.shopifyWrite.deleteMany({ where: { id: created.id, status: "PENDING", runs: 1 } }));
    return send(row, payload, hooks, adapter);
  }
  if (row.status === "DONE") throw new ShopifyWriteError("Already done", 409, "ALREADY_DONE");
  // A send in flight or unanswered was for what its own token showed; settling it can't stand for a different payload.
  if (row.status !== "FAILED" && row.payloadHash !== c.hash) throw new ShopifyWriteError("This changed since you checked it", 409, "CHANGED");
  if (row.status === "PENDING") {
    if (now.getTime() - row.startedAt.getTime() < PENDING_STALE_MS) throw new ShopifyWriteError("Already sending", 409, "ALREADY_SENDING");
    await settle(row, "UNKNOWN", "No answer from Shopify", {}, "PENDING");
    row = { ...row, status: "UNKNOWN" };
  }
  if (row.status === "UNKNOWN") {
    const found = await reconciled(row, hooks, adapter);
    if (found) return found;
    throw waitOrSendAgain(row, now);
  }
  // FAILED: nothing was written, so the same row is sent again (a new run, so a new request id).
  const failed = row;
  const reused = await prisma.shopifyWrite.updateMany({
    where: { id: failed.id, status: "FAILED", runs: failed.runs },
    data: { status: "PENDING", runs: { increment: 1 }, startedAt: now, error: null, actorUserId: scope.userId, payloadHash: c.hash },
  });
  if (!reused.count) throw new ShopifyWriteError("Already sending", 409, "ALREADY_SENDING");
  await rateLimit(scope, () =>
    prisma.shopifyWrite.updateMany({
      where: { id: failed.id, status: "PENDING", runs: failed.runs + 1 },
      data: { status: "FAILED", runs: failed.runs, startedAt: failed.startedAt, error: failed.error, actorUserId: failed.actorUserId, payloadHash: failed.payloadHash },
    }),
  );
  return send({ ...failed, status: "PENDING", runs: failed.runs + 1, startedAt: now, actorUserId: scope.userId, payloadHash: c.hash }, payload, hooks, adapter);
}

/** A next attempt may go only after a DONE repeatable one, or an UNKNOWN one Shopify still has no sign of after 10 min. */
type SettleHooks<R extends { shopifyId: string }> = Pick<ConfirmHooks<unknown, R>, "reconcile" | "onDone">;

async function mayTryAgain<R extends { shopifyId: string }>(prev: ShopifyWrite | null, hooks: SettleHooks<R>, adapter: ShopifyWriteAdapter, now: Date) {
  if (prev?.status === "DONE" && REPEATABLE.has(prev.action)) return;
  if (prev?.status === "DONE") throw new ShopifyWriteError("Already done", 409, "ALREADY_DONE");
  if (prev?.status !== "UNKNOWN") throw new ShopifyWriteError("This confirmation is no longer valid. Check the change again.", 409, "BAD_TOKEN");
  if (await reconciled(prev, hooks, adapter)) throw new ShopifyWriteError("Already done: the last attempt reached Shopify", 409, "ALREADY_DONE");
  if (now.getTime() - prev.startedAt.getTime() < UNKNOWN_WAIT_MS) throw waitOrSendAgain(prev, now);
}

function waitOrSendAgain(row: ShopifyWrite, now: Date) {
  return now.getTime() - row.startedAt.getTime() < UNKNOWN_WAIT_MS
    ? new ShopifyWriteError("Shopify hasn't confirmed the last attempt yet; check again in a few minutes", 409, "NOT_CONFIRMED_YET")
    : new ShopifyWriteError("Shopify has no sign of the last attempt. Choose Send again to try once more.", 409, "SEND_AGAIN");
}

async function reconciled<R extends { shopifyId: string }>(row: ShopifyWrite, hooks: SettleHooks<R>, adapter: ShopifyWriteAdapter) {
  const found = await hooks.reconcile(adapter, row);
  if (!found.ok) throw refusalError(found);
  return found.value ? done(row, found.value, hooks) : null;
}

/** `undo` puts the row back as it was when a limit refuses. */
async function rateLimit(scope: WriteScope, undo: () => Promise<unknown>) {
  // Both buckets count every confirm that reaches here, refused or not (one round trip instead of two).
  const [perUser, perBrand] = await Promise.all([hitRateLimit(`shopify-writes:${scope.brandId}:${scope.userId}`, 30, HOUR), hitRateLimit(`shopify-writes:${scope.brandId}`, 100, HOUR)]);
  if (perUser.allowed && perBrand.allowed) return;
  await undo();
  throw new ShopifyWriteError("Too many Shopify changes this hour. Try again later.", 429, "RATE_LIMITED");
}

/** hooks.run, or a throw (= no answer) after RUN_TIMEOUT_MS, so a PENDING row is never still in flight when it goes stale. */
async function withTimeout<T>(run: Promise<T>) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("Shopify write timed out"), { name: "TimeoutError" })), RUN_TIMEOUT_MS);
  });
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function send<P, R extends { shopifyId: string }>(row: ShopifyWrite, payload: P, hooks: ConfirmHooks<P, R>, adapter: ShopifyWriteAdapter) {
  let res: ShopifyResult<R>;
  try {
    res = await withTimeout(hooks.run(adapter, payload, `${row.id}.${row.runs}`));
  } catch (e) {
    // The outcome is unknown: it may have been written. Logged by error name only (adapter text can carry anything).
    console.error(`[shopify] write ${row.id} got no answer`, e instanceof Error ? e.name : "error");
    await settle(row, "UNKNOWN", "No answer from Shopify");
    throw new ShopifyWriteError("Shopify didn't answer. It is checked before anything is sent again.", 502, "NOT_CONFIRMED_YET");
  }
  if (res.ok) return done(row, res.value, hooks);
  await settle(row, "FAILED", REFUSAL_TEXT[res.reason], res.reason === "USER_ERROR" ? { fields: res.fields.length } : {});
  throw refusalError(res);
}

/** Only the run that set the row PENDING (or found it UNKNOWN) may settle it. */
const ownRun = (row: ShopifyWrite) => ({ id: row.id, runs: row.runs, status: { in: ["PENDING", "UNKNOWN"] as ShopifyWriteStatus[] } });

const audit = (tx: Prisma.TransactionClient, row: ShopifyWrite, status: ShopifyWriteStatus, extra: Record<string, string | number | null> = {}) =>
  tx.auditEvent.create({
    data: {
      workspaceId: row.workspaceId,
      brandId: row.brandId,
      actorUserId: row.actorUserId,
      action: `shopify.${row.action.toLowerCase()}`,
      entityType: "ShopifyWrite",
      entityId: row.id,
      metadata: { entityType: row.entityType, entityId: row.entityId, version: row.version, attempt: row.attempt, run: row.runs, status, ...extra },
    },
  });

/** `from`: only a row still in that state (the stale-PENDING path); else whatever ownRun allows. */
async function settle(row: ShopifyWrite, status: "FAILED" | "UNKNOWN", error: string, extra: Record<string, number> = {}, from?: ShopifyWriteStatus) {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.shopifyWrite.updateMany({ where: from ? { id: row.id, runs: row.runs, status: from } : ownRun(row), data: { status, error } });
    if (count) await audit(tx, row, status, extra);
  });
}

async function done<R extends { shopifyId: string }>(row: ShopifyWrite, result: R, hooks: Pick<SettleHooks<R>, "onDone">) {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.shopifyWrite.updateMany({ where: ownRun(row), data: { status: "DONE", shopifyId: result.shopifyId, error: null } });
    const write = await tx.shopifyWrite.findUniqueOrThrow({ where: { id: row.id } });
    if (!count) {
      // Another confirm reconciled this run to DONE (and ran onDone) while the send was still in flight: the send
      // succeeded, so its confirmer gets the result too.
      if (write.status === "DONE" && write.runs === row.runs && write.shopifyId === result.shopifyId) return { result, write };
      throw new ShopifyWriteError("Already done", 409, "ALREADY_DONE");
    }
    await hooks.onDone?.(tx, result, write);
    await audit(tx, write, "DONE", { shopifyId: result.shopifyId });
    return { result, write };
  });
}

/**
 * Settles a row a caller found from an earlier run (not one this confirm sent): DONE with Shopify's id when the write
 * was found there, or FAILED when it wasn't. Only while the row is still as read (same run and state); audited with
 * `actorUserId`, who settled it. In the caller's transaction; false when the row had moved on.
 */
export async function settleFoundRow(tx: Prisma.TransactionClient, row: ShopifyWrite, outcome: { status: "DONE"; shopifyId: string } | { status: "FAILED"; error: string }, actorUserId: string) {
  const { count } = await tx.shopifyWrite.updateMany({
    where: { id: row.id, runs: row.runs, status: row.status },
    data: outcome.status === "DONE" ? { status: "DONE", shopifyId: outcome.shopifyId, error: null } : { status: "FAILED", error: outcome.error },
  });
  if (count) await audit(tx, { ...row, actorUserId }, outcome.status, outcome.status === "DONE" ? { shopifyId: outcome.shopifyId } : {});
  return count > 0;
}

/** Whether a write of the entity (of one of `actions`, else any) is being sent or unconfirmed: PENDING or UNKNOWN. */
export async function writeInFlight(scope: { workspaceId: string; brandId: string }, entityType: ShopifyWriteEntity, entityId: string, actions?: ShopifyWriteAction[]) {
  const row = await prisma.shopifyWrite.findFirst({
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId, entityType, entityId, status: { in: ["PENDING", "UNKNOWN"] }, ...(actions ? { action: { in: actions } } : {}) },
    select: { id: true },
  });
  return !!row;
}

/** Daily sweep: a PENDING write with no answer for 10 min becomes UNKNOWN (reconciled at the next confirm). */
export async function expireStaleWrites(now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.shopifyWrite.updateManyAndReturn({
      where: { status: "PENDING", startedAt: { lt: new Date(now.getTime() - UNKNOWN_WAIT_MS) } },
      data: { status: "UNKNOWN", error: "No answer from Shopify" },
    });
    for (const row of rows) await audit(tx, row, "UNKNOWN");
    return rows.length;
  });
}
