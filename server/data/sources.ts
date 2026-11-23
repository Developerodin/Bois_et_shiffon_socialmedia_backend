import type { DataSource, IntegrationConnection, Prisma } from "@prisma/client";
import { z } from "zod";
import { DATA_SOURCE_KINDS, DATA_SYNC_ERRORS, READ_KEY, type DataSourceDto, type DataSourceKind, type DataSyncReason, type DataSyncResult } from "@/shared";
import { prisma } from "@/server/db/prisma";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { enqueueJob, type Lease } from "@/server/jobs/queue";
import { ReconnectNeeded } from "@/server/services/connections";

/**
 * Data sources (docs/superpowers/plans/2026-11-23-phase-2-data.md, "Sync rules"). One job type, `data.sync`, fills a
 * source's daily rows; screens read only our tables. This module owns the job, its sweep, Sync now and the sync state
 * (`DataSource.lastResult`); each kind's client registers its runner with `registerSync` and only fetches and writes.
 *
 * How a kind plugs in (server/data/<kind>.ts, imported once from server/jobs/runner.ts so it registers):
 *
 *   registerSync("SEARCH_CONSOLE", async (ctx) => {
 *     const { from, to } = ctx.window ?? dailyWindow(zoneToday("America/Los_Angeles"));
 *     const days = await fetchAll(ctx, from, to);       // buffer the whole window; ctx.signal is the deadline
 *     if (!days.complete) return { count: 0, reason: "partial" };    // nothing written, syncedThrough kept
 *     await prisma.$transaction((tx) => replaceDays(tx, ctx.source, days.rows));
 *     return { count: days.rows.length, complete: true };
 *   });
 *
 * replaceDays pattern (each kind writes its own table, so there is no shared helper): for every day the window read in
 * full, inside one transaction, `deleteMany({ where: { brandId, <source key>, day } })` then `createMany` that day's
 * rows. A repeated or overlapping job (daily + Sync now + backfill) then writes the same rows, so there is no lock; a
 * row the provider dropped for a day is gone. Never write a day some page of which failed.
 *
 * Errors: throw ReconnectNeeded for a refused token (status ERROR, not retried), anything else to retry (maxAttempts 3).
 * A missing permission, a provider rate limit or a stop mid-window is not thrown: return reason "permission",
 * "rate-limited" or "partial". Provider text may go to the log (never URLs: tokens ride in query strings), never into
 * `lastResult`, which only holds DATA_SYNC_ERRORS strings.
 */
export const DATA_SYNC_JOB = "data.sync";

export type SyncMode = "daily" | "manual" | "backfill";
/** Inclusive provider days, "YYYY-MM-DD". */
export type DayWindow = { from: string; to: string };

export type SyncContext = {
  source: DataSource;
  /** The source's connection, same brand (null for POST_METRICS). Tokens only through accessToken(connection). */
  connection: IntegrationConnection | null;
  mode: SyncMode;
  /** Backfill only: the window to read. Daily and manual runs pick their own (dailyWindow). */
  window?: DayWindow;
  lease: Lease;
  /** The run's deadline (DEADLINE_MS); pass it to every fetch. */
  signal: AbortSignal;
};

export type SyncOutcome = {
  count: number;
  /** Every day of the window was read and written. A complete backfill window advances syncedThrough. */
  complete?: boolean;
  reason?: Extract<DataSyncReason, "partial" | "permission" | "rate-limited"> | null;
  /** Shopify's updated_at high-water mark, saved as DataSource.cursor */
  cursor?: string;
};
export type SyncRunner = (ctx: SyncContext) => Promise<SyncOutcome>;

const RUNNERS: Partial<Record<DataSourceKind, SyncRunner>> = {};
export const registerSync = (kind: DataSourceKind, runner: SyncRunner) => void (RUNNERS[kind] = runner);

/** A kind whose client isn't built yet: the job completes and writes nothing. */
export const NOT_BUILT = { count: 0, notBuilt: true } as const;
export async function runSync(kind: DataSourceKind, ctx: SyncContext): Promise<SyncOutcome | typeof NOT_BUILT> {
  const runner = RUNNERS[kind];
  return runner ? runner(ctx) : NOT_BUILT;
}

// ---- day helpers -------------------------------------------------------------------------------------------------

/** Today's date in `zone`, "YYYY-MM-DD". */
export const zoneToday = (zone: string, now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(now);
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** The days a daily run re-reads: today−back .. today−1 (the provider's late numbers settle within them). */
export const dailyWindow = (today: string, back = 3): DayWindow => ({ from: addDays(today, -back), to: addDays(today, -1) });
/** The next backfill window after `syncedThrough` (oldest first), `windowDays` long, or null once `end` is reached. */
export function nextBackfillWindow(syncedThrough: string | null, start: string, end: string, windowDays: number): DayWindow | null {
  const from = syncedThrough && syncedThrough >= start ? addDays(syncedThrough, 1) : start;
  if (from > end) return null;
  const to = addDays(from, windowDays - 1);
  return { from, to: to < end ? to : end };
}
/** syncedThrough moves only contiguously: a complete window that starts at most a day after it (or none held yet). */
export function advanceSyncedThrough(current: string | null, window: DayWindow, complete: boolean) {
  if (!complete) return current;
  if (current !== null && window.from > addDays(current, 1)) return current;
  return current !== null && current >= window.to ? current : window.to;
}
const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

// ---- jobs ---------------------------------------------------------------------------------------------------------

type SourceRef = Pick<DataSource, "id" | "workspaceId" | "brandId" | "kind" | "updatedAt">;
const Payload = z.object({
  dataSourceId: z.string(),
  workspaceId: z.string(),
  brandId: z.string(),
  kind: z.enum(DATA_SOURCE_KINDS),
  mode: z.enum(["daily", "manual", "backfill"]),
  from: z.string().optional(),
  to: z.string().optional(),
  /** Backfill: the last day the chain reads. */
  end: z.string().optional(),
  /** Backfill: retries of a window that stopped partway. */
  retry: z.number().int().optional(),
});
type Payload = z.infer<typeof Payload>;

const DEADLINE_MS = 240_000;
const WAIT_MS = 5 * 60_000;
const PARTIAL_RETRY_MS = 60 * 60_000;
const PARTIAL_RETRIES = 3;
const SPREAD_SECS = 120 * 60;

/** Spreads a source's daily run over two hours after the sweep, from its id. */
export const spreadSecs = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % SPREAD_SECS;

/**
 * Queue one run. Keys: daily `data:<id>:<UTC day>` (a double sweep queues one); backfill
 * `data:<id>:backfill:<updatedAt epoch>:<windowStart>` (re-picking the site or account re-runs it); manual has none.
 * No token, email or customer data in the payload: ids and days only.
 */
export function enqueueSourceSync(
  source: SourceRef,
  mode: SyncMode,
  opts: { runAt?: Date; window?: DayWindow & { end: string }; retry?: number; key?: string } = {},
) {
  const day = new Date().toISOString().slice(0, 10);
  const key = opts.key
    ?? (mode === "daily" ? `data:${source.id}:${day}`
      : mode === "backfill" && opts.window ? `data:${source.id}:backfill:${source.updatedAt.getTime()}:${opts.window.from}${opts.retry ? `:r${opts.retry}` : ""}`
      : undefined);
  return enqueueJob({
    type: DATA_SYNC_JOB,
    workspaceId: source.workspaceId,
    brandId: source.brandId,
    payload: {
      dataSourceId: source.id, workspaceId: source.workspaceId, brandId: source.brandId, kind: source.kind, mode,
      ...(opts.window ? { from: opts.window.from, to: opts.window.to, end: opts.window.end } : {}),
      ...(opts.retry ? { retry: opts.retry } : {}),
    },
    runAt: opts.runAt,
    maxAttempts: 3,
    idempotencyKey: key,
  });
}

/**
 * Daily sweep step: one query, enqueue only (no provider calls), each source at its own offset in the next two hours.
 * Sources in ERROR are included (a failed day tries again; a refused token fails fast until reconnected); OFF ones not.
 * ponytail: one upsert per source; at a few thousand sources batch them with createMany(skipDuplicates).
 */
export async function enqueueDailyDataSyncs(now = new Date()) {
  const sources = await prisma.dataSource.findMany({
    where: { status: { not: "OFF" }, brand: { status: "ACTIVE" } },
    select: { id: true, workspaceId: true, brandId: true, kind: true, updatedAt: true },
  });
  for (const s of sources) await enqueueSourceSync(s, "daily", { runAt: new Date(now.getTime() + spreadSecs(s.id) * 1000) });
  return sources.length;
}

/** Saves the run's result. Only fixed strings reach `error`; `okAt` moves on a run with no reason. */
async function recordSync(source: DataSource, reason: DataSyncReason | null, count: number, data: Prisma.DataSourceUpdateManyMutationInput = {}) {
  const at = new Date().toISOString();
  const prev = source.lastResult as DataSyncResult | null;
  const lastResult: DataSyncResult = { at, okAt: reason ? (prev?.okAt ?? null) : at, reason, count, error: reason ? DATA_SYNC_ERRORS[reason] : null };
  await prisma.dataSource.updateMany({
    where: { id: source.id, workspaceId: source.workspaceId, brandId: source.brandId },
    // A permission or rate stop isn't the connection's fault; the source stays on and tries again tomorrow.
    data: { ...data, lastResult, status: reason === "reconnect" || reason === "permission" ? "ERROR" : "ACTIVE" },
  });
}

/** A backfill job of this source is running now (another than `jobId`). */
const backfillRunning = (sourceId: string, jobId: string) =>
  prisma.job.findFirst({
    where: { type: DATA_SYNC_JOB, status: "RUNNING", id: { not: jobId }, idempotencyKey: { startsWith: `data:${sourceId}:backfill:` } },
    select: { id: true },
  });

/**
 * Job handler. Re-reads the source by id AND the payload's workspace, brand and kind, so a payload naming another
 * brand's source finds nothing; a deleted or switched-off source is a no-op. A connection that is gone, revoked or of
 * another brand records "reconnect" and stops (rows kept). A daily or manual run that finds this source's backfill
 * running waits 5 minutes rather than racing it.
 */
export async function runDataSync(payload: unknown, lease: Lease) {
  const p: Payload = Payload.parse(payload);
  const source = await prisma.dataSource.findFirst({ where: { id: p.dataSourceId, workspaceId: p.workspaceId, brandId: p.brandId, kind: p.kind } });
  if (!source || source.status === "OFF") return;

  if (p.mode !== "backfill" && (await backfillRunning(source.id, lease.jobId))) {
    const runAt = new Date(Math.ceil((Date.now() + WAIT_MS) / 60_000) * 60_000);
    // Keyed by the minute it runs at: a duplicate delivery queues one wait, and a later wait gets its own key.
    await enqueueSourceSync(source, p.mode, { runAt, key: `data:${source.id}:wait:${runAt.toISOString()}` });
    return;
  }

  let connection: IntegrationConnection | null = null;
  if (source.connectionId) {
    connection = await prisma.integrationConnection.findFirst({ where: { id: source.connectionId, workspaceId: source.workspaceId, brandId: source.brandId } });
    if (!connection || connection.status === "REVOKED") return void (await recordSync(source, "reconnect", 0));
  }

  const window = p.mode === "backfill" && p.from && p.to ? { from: p.from, to: p.to } : undefined;
  let outcome: Awaited<ReturnType<typeof runSync>>;
  try {
    outcome = await runSync(source.kind, { source, connection, mode: p.mode, window, lease, signal: AbortSignal.timeout(DEADLINE_MS) });
  } catch (error) {
    console.warn("[data] sync failed", source.brandId, source.kind, error instanceof Error ? error.message : error);
    await recordSync(source, error instanceof ReconnectNeeded ? "reconnect" : "failed", 0);
    throw error;
  }
  if ("notBuilt" in outcome) return void console.info(`[data] ${source.kind} sync isn't built yet; nothing written`);

  const syncedThrough = window ? advanceSyncedThrough(dayOf(source.syncedThrough), window, !!outcome.complete) : dayOf(source.syncedThrough);
  await recordSync(source, outcome.reason ?? null, outcome.count, {
    ...(syncedThrough !== dayOf(source.syncedThrough) ? { syncedThrough: new Date(`${syncedThrough}T00:00:00Z`) } : {}),
    ...(outcome.cursor !== undefined ? { cursor: outcome.cursor } : {}),
  });

  // Backfill chain: one window at a time. A complete window queues the next; one that stopped partway is tried again
  // in an hour (a few times), so an hourly quota isn't burned through retries.
  if (!window || !p.end) return;
  const days = (Date.parse(window.to) - Date.parse(window.from)) / 86_400_000 + 1;
  if (outcome.complete) {
    const next = nextBackfillWindow(syncedThrough, window.from, p.end, days);
    if (next) await enqueueSourceSync(source, "backfill", { window: { ...next, end: p.end } });
  } else if ((p.retry ?? 0) < PARTIAL_RETRIES) {
    await enqueueSourceSync(source, "backfill", { window: { ...window, end: p.end }, retry: (p.retry ?? 0) + 1, runAt: new Date(Date.now() + PARTIAL_RETRY_MS) });
  }
}

// ---- Sync now -----------------------------------------------------------------------------------------------------

export const MANUAL_LIMIT = { limit: 3, windowMs: 60 * 60_000 };
const FRESH_MS = 5 * 60_000;

type Scope = { workspaceId: string; brandId: string; userId: string };
/** queued: a run was queued for at least one source; limited: every source due was over its 3 an hour. */
export type SyncNow = { found: boolean; queued: boolean; limited: boolean };

/**
 * "Sync now" for every source of a kind (a brand can have several ad accounts). Per source: skipped if it synced in
 * the last 5 minutes or a run is queued or running (a double click, two people); else limited to 3 an hour per
 * person; else a manual job. Only a press that queues counts toward the limit.
 * ponytail: check-then-create like requestCatalogSync, so two presses in the same instant can queue two runs; the
 * delete-then-insert writes make that harmless.
 */
export async function requestSourceSync(scope: Scope, kind: DataSourceKind): Promise<SyncNow> {
  const sources = await prisma.dataSource.findMany({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId, kind, status: { not: "OFF" } } });
  let queued = false;
  let limited = false;
  for (const s of sources) {
    const okAt = (s.lastResult as DataSyncResult | null)?.okAt;
    if (okAt && Date.now() - Date.parse(okAt) < FRESH_MS) continue;
    const pending = await prisma.job.findFirst({
      where: { type: DATA_SYNC_JOB, workspaceId: s.workspaceId, brandId: s.brandId, payload: { path: ["dataSourceId"], equals: s.id },
        // A daily run queued for later in the sweep's two hours doesn't hold Sync now back.
        OR: [{ status: "RUNNING" }, { status: "PENDING", runAt: { lte: new Date() } }] },
      select: { id: true },
    });
    if (pending) continue;
    if (!(await hitRateLimit(`data-sync:${s.id}:${scope.userId}`, MANUAL_LIMIT.limit, MANUAL_LIMIT.windowMs)).allowed) {
      limited = true;
      continue;
    }
    await enqueueSourceSync(s, "manual");
    queued = true;
  }
  return { found: sources.length > 0, queued, limited: limited && !queued };
}

// ---- reading ------------------------------------------------------------------------------------------------------

/**
 * GET data-sources: the brand's sources a person may see. A row only with its kind's read key; `label` (shop domain,
 * ad account name) only with integrations.manage. `error` is rebuilt from the reason, so only fixed strings leave.
 */
export async function listDataSources(scope: { workspaceId: string; brandId: string }, perms: ReadonlySet<string>): Promise<DataSourceDto[]> {
  const kinds = DATA_SOURCE_KINDS.filter((k) => perms.has(READ_KEY[k]));
  if (!kinds.length) return [];
  const rows = await prisma.dataSource.findMany({
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId, kind: { in: kinds } },
    orderBy: [{ kind: "asc" }, { createdAt: "asc" }],
  });
  const manage = perms.has("integrations.manage");
  return rows.map((r) => {
    const last = r.lastResult as DataSyncResult | null;
    const settings = (r.settings ?? {}) as { reportsIn?: unknown; timeZone?: unknown };
    const zone = settings.reportsIn ?? settings.timeZone;
    return {
      id: r.id,
      kind: r.kind,
      ...(manage ? { label: r.label } : {}),
      status: r.status,
      lastResult: last && { at: last.at, okAt: last.okAt ?? null, reason: last.reason ?? null, count: last.count ?? 0, error: last.reason ? (DATA_SYNC_ERRORS[last.reason] ?? null) : null },
      syncedThrough: dayOf(r.syncedThrough),
      reportsInZone: typeof zone === "string" ? zone : null,
    };
  });
}
