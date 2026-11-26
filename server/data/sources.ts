import type { SyncStop } from "./sync-stop";
import type { DataSource, IntegrationConnection, Prisma } from "@prisma/client";
import { z } from "zod";
import { DATA_SOURCE_KINDS, DATA_SYNC_ERRORS, parseRange, READ_KEY, type DateRange, type DataSourceDto, type DataSourceKind, type DataSyncReason, type DataSyncResult } from "@/shared";
import { prisma } from "@/server/db/prisma";
import { problemResponse } from "@/server/api/http-error";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { enqueueJob, type Lease } from "@/server/jobs/queue";
import { ReconnectNeeded } from "@/server/services/reconnect-needed";
import { DEFAULT_TIME_ZONE } from "@/server/catalog/campaigns";

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
 * "rate_limited" or "partial". Provider text may go to the log (never URLs: tokens ride in query strings), never into
 * `lastResult` (StoredSyncResult), whose `error` only holds DATA_SYNC_ERRORS strings; beside it are counts, times and
 * a running job's `runningSince` stamp.
 */
export const DATA_SYNC_JOB = "data.sync";
/**
 * `DataSource.lastResult` as stored: the shared result plus `runningSince`, stamped when a run starts and dropped when
 * recordSync replaces the whole value. Server-only: the screens get it as `sync.since`. A source's first run stamps a
 * NULL lastResult, so the row can hold `runningSince` alone, with no `at`.
 */
type StoredSyncResult = DataSyncResult & { runningSince?: string };
/** Follow-up runs in a row after cursor runs that stopped partway, and the wait before each. */
export const FOLLOW_UPS = 5;
const FOLLOW_UP_MS = 60_000;

/**
 * A client's stop as the job's outcome: reconnect throws ReconnectNeeded (not retried), failed throws (retried);
 * the rest are returned. capped and rate_limited still write what was read.
 */
export function stopReason(stop: SyncStop | undefined): SyncOutcome["reason"] {
  switch (stop) {
    case undefined: return null;
    case "reconnect": throw new ReconnectNeeded("reconnect");
    case "failed": throw new Error("data source sync failed");
    case "permission": case "missing_scope": return "permission";
    case "rate_limited": return "rate_limited";
    case "capped": return "partial";
  }
}

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
  reason?: Extract<DataSyncReason, "partial" | "permission" | "rate_limited"> | null;
  /** Daily and manual runs: the days read. A complete one moves syncedThrough on contiguously (never starts it). */
  window?: DayWindow;
  /** Shopify's updated_at high-water mark, saved as DataSource.cursor */
  cursor?: string;
  /**
   * Keys to set in, or remove from, DataSource.settings. recordSync merges them (one jsonb statement), so keys not
   * named here (reportsIn, backfill, currency) are never clobbered. A patch that sets `backfill` starts that plan:
   * runDataSync queues its first window after today's daily spread.
   */
  settings?: { set?: Record<string, unknown>; unset?: string[] };
  /**
   * The provider said this backfill can't go on for now (Shopify orders: AskCart's read_all_orders_pending): not a
   * failure. okAt and the status stay as they were, and nothing more is queued (no retry, no next window).
   */
  stopChain?: true;
};
export type SyncRunner = (ctx: SyncContext) => Promise<SyncOutcome>;
/**
 * halveOnCap: a backfill window still stopped by the time cap after its retries is read again at half its length
 * (down to 1 day) instead of waiting for the sweep's daily restart. Opt-in (Shopify orders): other kinds keep today's
 * retries.
 */
type SyncOptions = { halveOnCap?: boolean };

const RUNNERS: Partial<Record<DataSourceKind, SyncRunner>> = {};
const OPTIONS: Partial<Record<DataSourceKind, SyncOptions>> = {};
export const registerSync = (kind: DataSourceKind, runner: SyncRunner, options: SyncOptions = {}) => {
  RUNNERS[kind] = runner;
  OPTIONS[kind] = options;
};

export async function runSync(kind: DataSourceKind, ctx: SyncContext): Promise<SyncOutcome> {
  const runner = RUNNERS[kind];
  if (!runner) throw new Error(`no data sync registered for ${kind}`);
  return runner(ctx);
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
/** `?from&to` of a read route: real days, from ≤ to, at most `maxDays` long; else null (answer with badRange). */
export const parseDayRange = (params: URLSearchParams, maxDays: number) => parseRange(params.get("from"), params.get("to"), maxDays);
/** What a refused range is told (the routes' badRange and the chat's sales tools). */
export const badRangeDetail = (maxDays: number) => `from and to must be YYYY-MM-DD days, from not after to, at most ${maxDays} days.`;
/** The one answer to a range parseDayRange refused (or another bad query, with its own detail). */
export const badRange = (maxDays: number, detail = badRangeDetail(maxDays)) =>
  problemResponse({ type: "https://api.brandpilot/errors/invalid-range", title: "Invalid range", status: 422, detail });
/** How many days `range` covers, both ends counted. */
export const rangeDays = (range: DateRange) => (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 + 1;
/** The same number of days right before `range`. */
export function previousRange(range: DateRange): DateRange {
  return { from: addDays(range.from, -rangeDays(range)), to: addDays(range.from, -1) };
}
/** A @db.Date value (UTC midnight) as "YYYY-MM-DD"; null stays null. The one helper for these columns. */
export function dayOf(d: Date): string;
export function dayOf(d: Date | null): string | null;
export function dayOf(d: Date | null) {
  return d ? d.toISOString().slice(0, 10) : null;
}
/** "YYYY-MM-DD" as the UTC-midnight Date a @db.Date column takes. */
export const dayDate = (day: string) => new Date(`${day}T00:00:00Z`);

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
  /** Cursor kinds: follow-up runs queued in a row after runs that stopped partway (FOLLOW_UPS). */
  follow: z.number().int().optional(),
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
 * When a backfill chain the runner or the sweep starts gets its first window: after the daily runs' two-hour spread,
 * so a long chain doesn't hold one of the two data-job slots in the busy hours, and never within WAIT_MS of the run
 * that planned it (same token).
 */
export const chainStart = (id: string, now = Date.now()) => new Date(now + (SPREAD_SECS + spreadSecs(id)) * 1000);

/**
 * Queue one run. Keys: daily `data:<id>:<UTC day>` (a double sweep queues one); backfill
 * `data:<id>:backfill:<updatedAt epoch>:<windowStart>` (re-picking the site or account re-runs it); manual has none.
 * No token, email or customer data in the payload: ids and days only.
 */
export function enqueueSourceSync(
  source: SourceRef,
  mode: SyncMode,
  opts: { runAt?: Date; window?: DayWindow & { end: string }; retry?: number; follow?: number; key?: string; halved?: number } = {},
) {
  const day = new Date().toISOString().slice(0, 10);
  const key = opts.key
    ?? (mode === "daily" ? `data:${source.id}:${day}`
      : mode === "backfill" && opts.window
        // :h<days> on a halved window: the same start day, so without it the upsert-on-key would swallow the re-read.
        ? `data:${source.id}:backfill:${source.updatedAt.getTime()}:${opts.window.from}${opts.halved ? `:h${opts.halved}` : ""}${opts.retry ? `:r${opts.retry}` : ""}`
      : undefined);
  return enqueueJob({
    type: DATA_SYNC_JOB,
    workspaceId: source.workspaceId,
    brandId: source.brandId,
    payload: {
      dataSourceId: source.id, workspaceId: source.workspaceId, brandId: source.brandId, kind: source.kind, mode,
      ...(opts.window ? { from: opts.window.from, to: opts.window.to, end: opts.window.end } : {}),
      ...(opts.retry ? { retry: opts.retry } : {}),
      ...(opts.follow ? { follow: opts.follow } : {}),
    },
    runAt: opts.runAt,
    maxAttempts: 3,
    idempotencyKey: key,
  });
}

/** A source's backfill, saved as `settings.backfill` when it starts so the sweep can restart a chain that died. */
export type BackfillPlan = { start: string; end: string; days: number };
/** `total` provider days up to the day before `today`, read `windowDays` at a time. */
export function backfillPlan(today: string, total: number, windowDays: number): BackfillPlan {
  const end = addDays(today, -1);
  return { start: addDays(end, -(total - 1)), end, days: windowDays };
}
const planOf = (settings: unknown) => (settings as { backfill?: BackfillPlan } | null)?.backfill;

/** Queues the next window of a source's backfill (the first, when nothing is held yet); null once it's done. */
export function enqueueBackfill(source: SourceRef & { syncedThrough: Date | null }, plan: BackfillPlan, opts: { key?: string; runAt?: Date } = {}) {
  const next = nextBackfillWindow(dayOf(source.syncedThrough), plan.start, plan.end, plan.days);
  return next ? enqueueSourceSync(source, "backfill", { window: { ...next, end: plan.end }, key: opts.key, runAt: opts.runAt }) : null;
}

/**
 * Daily sweep step: one query, enqueue only (no provider calls), each source at its own offset in the next two hours.
 * Sources in ERROR are included (a failed day tries again; a refused token fails fast until reconnected); OFF ones not.
 * A source whose backfill isn't through its end and has no backfill job queued or running gets its next window
 * queued too: a chain that died (out of retries) starts again from syncedThrough.
 * ponytail: one upsert per source (plus one job lookup per unfinished backfill); at a few thousand sources batch them
 * with createMany(skipDuplicates). That lookup's `idempotencyKey startsWith` is a LIKE 'prefix%' the unique index
 * can't serve under a non-C collation, so each one scans the Job table (about 1,000 rows today). Past tens of thousands
 * of jobs, add a text_pattern_ops index on the key, or store the source id in its own column.
 */
export async function enqueueDailyDataSyncs(now = new Date()) {
  const sources = await prisma.dataSource.findMany({
    where: { status: { not: "OFF" }, brand: { status: "ACTIVE" } },
    select: { id: true, workspaceId: true, brandId: true, kind: true, updatedAt: true, syncedThrough: true, settings: true },
  });
  const day = now.toISOString().slice(0, 10);
  for (const s of sources) {
    await enqueueSourceSync(s, "daily", { runAt: new Date(now.getTime() + spreadSecs(s.id) * 1000) });
    const plan = planOf(s.settings);
    const held = dayOf(s.syncedThrough);
    if (!plan || (held !== null && held >= plan.end)) continue;
    const alive = await prisma.job.findFirst({
      where: { type: DATA_SYNC_JOB, status: { in: ["PENDING", "RUNNING"] }, idempotencyKey: { startsWith: `data:${s.id}:backfill:` } },
      select: { id: true },
    });
    // Keyed by the sweep's day: a double sweep restarts it once. After the daily spread, like a chain's first window.
    if (!alive) await enqueueBackfill(s, plan, { key: `data:${s.id}:backfill:restart:${day}`, runAt: chainStart(s.id, now.getTime()) });
  }
  return sources.length;
}

/**
 * Saves the run's result. Only fixed strings reach `error`; `okAt` moves on a run with no reason. A run that stopped
 * its chain (`quiet`: not a success, not a failure) keeps the previous okAt, reason, error and status, so it never
 * hides an earlier stop. `settings` is merged in by one jsonb statement in the same transaction: `- unset` then
 * `|| set`, top-level keys only, so keys it doesn't name are kept.
 */
async function recordSync(
  source: DataSource,
  reason: DataSyncReason | null,
  count: number,
  data: Prisma.DataSourceUpdateManyMutationInput = {},
  startedAt: string | null = null,
  opts: { quiet?: boolean; settings?: SyncOutcome["settings"] } = {},
) {
  const at = new Date().toISOString();
  const prev = source.lastResult as StoredSyncResult | null;
  const okAt = reason || opts.quiet ? (prev?.okAt ?? null) : at;
  const kept = opts.quiet ? (prev?.reason ?? null) : reason;
  const lastResult: DataSyncResult = { at, startedAt, okAt, reason: kept, count, error: kept ? DATA_SYNC_ERRORS[kept] : null };
  const where = { id: source.id, workspaceId: source.workspaceId, brandId: source.brandId };
  // A permission or rate stop isn't the connection's fault; the source stays on and tries again tomorrow.
  const status = opts.quiet ? {} : { status: reason === "reconnect" || reason === "permission" ? ("ERROR" as const) : ("ACTIVE" as const) };
  const write = prisma.dataSource.updateMany({ where, data: { ...data, lastResult, ...status } });
  const patch = opts.settings;
  if (!patch || (!patch.unset?.length && !Object.keys(patch.set ?? {}).length)) return void (await write);
  await prisma.$transaction([
    write,
    prisma.$executeRaw`
      UPDATE "DataSource" SET "settings" = (COALESCE("settings", '{}'::jsonb) - ${patch.unset ?? []}::text[]) || ${JSON.stringify(patch.set ?? {})}::jsonb
      WHERE "id" = ${source.id} AND "workspaceId" = ${source.workspaceId} AND "brandId" = ${source.brandId}`,
  ]);
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
    // Keyed by the minute it runs at: a duplicate delivery queues one wait, and a later wait gets its own key. A
    // follow-up keeps its count, so waiting doesn't give its chain a fresh set of FOLLOW_UPS.
    await enqueueSourceSync(source, p.mode, { runAt, key: `data:${source.id}:wait:${runAt.toISOString()}`, follow: p.follow });
    return;
  }

  let connection: IntegrationConnection | null = null;
  if (source.connectionId) {
    connection = await prisma.integrationConnection.findFirst({ where: { id: source.connectionId, workspaceId: source.workspaceId, brandId: source.brandId } });
    if (!connection || connection.status === "REVOKED") return void (await recordSync(source, "reconnect", 0));
  }

  const window = p.mode === "backfill" && p.from && p.to ? { from: p.from, to: p.to } : undefined;
  // When this run started, for the screens ("started 12:04"): kept beside the last result until recordSync replaces it.
  const startedAt = new Date().toISOString();
  await prisma.$executeRaw`
    UPDATE "DataSource" SET "lastResult" = COALESCE("lastResult", '{}'::jsonb) || jsonb_build_object('runningSince', ${startedAt}::text)
    WHERE "id" = ${source.id} AND "workspaceId" = ${source.workspaceId} AND "brandId" = ${source.brandId}`;
  let outcome: SyncOutcome;
  try {
    outcome = await runSync(source.kind, { source, connection, mode: p.mode, window, lease, signal: AbortSignal.timeout(DEADLINE_MS) });
  } catch (error) {
    console.warn("[data] sync failed", source.brandId, source.kind, error instanceof Error ? error.message : error);
    await recordSync(source, error instanceof ReconnectNeeded ? "reconnect" : "failed", 0, {}, startedAt);
    throw error;
  }
  // A daily or manual run only extends a held range: it never starts one, or the backfill would skip its days.
  const held = dayOf(source.syncedThrough);
  const read = window ?? (held !== null ? outcome.window : undefined);
  const syncedThrough = read ? advanceSyncedThrough(held, read, !!outcome.complete) : held;
  const windowDays = window ? (Date.parse(window.to) - Date.parse(window.from)) / 86_400_000 + 1 : 0;
  // A window still capped after its retries is read again at half its length (opt-in kinds); the plan keeps that
  // length, so a sweep restart doesn't go back to windows too big for one run.
  const plan = planOf(source.settings);
  const halve = !!window && !!p.end && !outcome.stopChain && !outcome.complete && outcome.reason === "partial"
    && (p.retry ?? 0) >= PARTIAL_RETRIES && windowDays > 1 && !!OPTIONS[source.kind]?.halveOnCap
    ? Math.max(1, Math.floor(windowDays / 2)) : 0;
  const settings = halve && plan
    ? { ...outcome.settings, set: { ...outcome.settings?.set, backfill: { ...plan, days: halve } } }
    : outcome.settings;
  await recordSync(source, outcome.reason ?? null, outcome.count, {
    ...(syncedThrough !== dayOf(source.syncedThrough) ? { syncedThrough: new Date(`${syncedThrough}T00:00:00Z`) } : {}),
    ...(outcome.cursor !== undefined ? { cursor: outcome.cursor } : {}),
  }, startedAt, { quiet: outcome.stopChain, settings });

  // The provider said "not now" (no retry, no next window, no follow-up): a later run starts the chain again.
  if (outcome.stopChain) return;

  // A plan this run started: its first window, after today's daily spread (also from a daily, manual or follow-up run).
  const started = outcome.settings?.set?.backfill as BackfillPlan | undefined;
  if (started) await enqueueBackfill({ ...source, syncedThrough: syncedThrough ? new Date(`${syncedThrough}T00:00:00Z`) : null }, started, { runAt: chainStart(source.id) });

  // A cursor kind (Shopify orders) that stopped partway and moved its cursor carries on in a minute rather than at the
  // next daily sweep. Keyed by this job's id: a duplicate delivery queues one, and each step of a chain (or a later
  // chain that ends on a cursor an earlier one reached) gets its own key; at most FOLLOW_UPS in a row, so a store
  // that is always rate limited waits for the sweep. A run that read to the end never queues one (even when it steps
  // the cursor back to re-read an incomplete order), so the chain can't loop.
  if (!window && (outcome.reason === "partial" || outcome.reason === "rate_limited") && outcome.cursor !== undefined
    && outcome.cursor !== source.cursor && (p.follow ?? 0) < FOLLOW_UPS) {
    await enqueueSourceSync(source, p.mode, { follow: (p.follow ?? 0) + 1, runAt: new Date(Date.now() + FOLLOW_UP_MS), key: `data:${source.id}:more:${lease.jobId}` });
  }

  // Backfill chain: one window at a time. A complete window queues the next; one that stopped partway is tried again
  // in an hour (a few times), so an hourly quota isn't burned through retries.
  if (!window || !p.end) return;
  const days = windowDays;
  if (halve) {
    const half = { from: window.from, to: addDays(window.from, halve - 1), end: p.end };
    await enqueueSourceSync(source, "backfill", { window: half, halved: halve, runAt: new Date(Date.now() + PARTIAL_RETRY_MS) });
  } else if (outcome.complete) {
    // From the day after this window: if syncedThrough couldn't move (a gap before it), this window isn't re-queued.
    const next = nextBackfillWindow(syncedThrough, addDays(window.to, 1), p.end, days);
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
    const okAt = (s.lastResult as StoredSyncResult | null)?.okAt;
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
  const runs = await syncRuns(scope);
  return rows.map((r) => {
    const last = r.lastResult as StoredSyncResult | null;
    const job = runs.get(r.id);
    const zone = ((r.settings ?? {}) as { reportsIn?: unknown }).reportsIn;
    return {
      id: r.id,
      kind: r.kind,
      ...(manage ? { label: r.label } : {}),
      status: r.status,
      // No `at` yet (a first run's start stamp alone): no result to show.
      lastResult: last?.at ? { at: last.at, startedAt: last.startedAt ?? null, okAt: last.okAt ?? null, reason: last.reason ?? null, count: last.count ?? 0, error: last.reason ? (DATA_SYNC_ERRORS[last.reason] ?? null) : null } : null,
      sync: job ? { state: job.state, since: job.state === "running" ? (last?.runningSince ?? null) : job.runAt.toISOString(), backfill: job.backfill } : null,
      syncedThrough: dayOf(r.syncedThrough),
      reportsInZone: typeof zone === "string" ? zone : null,
      ...(r.kind === "SHOPIFY_ORDERS" ? { history: orderHistory(r) } : {}),
    };
  });
}

/**
 * Shopify orders' history past 60 days, for the Sales tab's note: whether the store lets us read all orders (null:
 * not known yet), since when orders are visible while it doesn't, and how far a running history has come.
 */
function orderHistory(r: DataSource): DataSourceDto["history"] {
  const settings = (r.settings ?? {}) as { allOrders?: unknown; visibleSince?: unknown };
  const allOrders = typeof settings.allOrders === "boolean" ? settings.allOrders : null;
  const plan = planOf(r.settings);
  const held = dayOf(r.syncedThrough);
  const loading = !!plan && (held === null || held < plan.end);
  if (allOrders === null && !loading) return null;
  return {
    allOrders,
    visibleSince: allOrders === false && typeof settings.visibleSince === "string" ? settings.visibleSince : null,
    through: loading ? held : null,
    loading,
  };
}

/** How far ahead a queued run still counts as "queued" on screen: the follow-up's minute, not the sweep's two hours. */
const SOON_MS = 2 * 60_000;
/**
 * How long past its time a pending run still counts as "queued". Later than this, no worker is taking jobs: saying
 * "queued" would keep the page polling every few seconds for a run that isn't coming.
 */
const OVERDUE_MS = 10 * 60_000;

/**
 * The brand's data-sync jobs running now or due within SOON_MS (and not more than OVERDUE_MS late), by source id;
 * running wins over queued. Running needs a live lease: a job whose process died stays RUNNING until another worker
 * claims it, and must not show as syncing meanwhile. A daily or manual run waiting behind a running history window
 * (its `:wait:` key, runDataSync) counts as part of that history run.
 * ponytail: reads the brand's due data jobs (a handful); the (status, runAt) index serves it.
 */
async function syncRuns(scope: { workspaceId: string; brandId: string }) {
  const jobs = await prisma.job.findMany({
    where: { type: DATA_SYNC_JOB, workspaceId: scope.workspaceId, brandId: scope.brandId,
      OR: [{ status: "RUNNING", leasedUntil: { gte: new Date() } }, { status: "PENDING", runAt: { gte: new Date(Date.now() - OVERDUE_MS), lte: new Date(Date.now() + SOON_MS) } }] },
    select: { status: true, runAt: true, payload: true, idempotencyKey: true },
    orderBy: { runAt: "asc" },
  });
  const runs = new Map<string, { state: "queued" | "running"; runAt: Date; backfill: boolean }>();
  for (const j of jobs) {
    const payload = j.payload as { dataSourceId?: unknown; mode?: unknown };
    const id = payload.dataSourceId;
    if (typeof id !== "string") continue;
    const state = j.status === "RUNNING" ? "running" : "queued";
    const backfill = payload.mode === "backfill" || !!j.idempotencyKey?.startsWith(`data:${id}:wait:`);
    if (!runs.has(id) || state === "running") runs.set(id, { state, runAt: j.runAt, backfill });
  }
  return runs;
}

/**
 * The brand's sources of `kind` that are on: their external ids (ad accounts "act_…", the site), the last day every one
 * of them has read in full (their minimum `syncedThrough`; null when there is none or any hasn't finished its first
 * sync, as a lagging one's missing days would read as a drop), and how many are switched off. One query; budgets'
 * pacing and spend and the chat's default ranges read it. The digest's `synced()` keeps its own, wider rule.
 */
export async function liveSources(scope: { workspaceId: string; brandId: string }, kind: DataSourceKind) {
  const all = await prisma.dataSource.findMany({
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId, kind },
    select: { status: true, externalId: true, syncedThrough: true },
  });
  const on = all.filter((s) => s.status !== "OFF");
  const syncedThrough = !on.length || on.some((s) => !s.syncedThrough) ? null : on.map((s) => dayOf(s.syncedThrough!)).sort()[0];
  return { externalIds: on.map((s) => s.externalId), syncedThrough, offCount: all.length - on.length };
}

/** The brand's own zone (BrandProfile.timeZone, else the default), for days we bucket ourselves. */
export async function brandTimeZone(scope: { workspaceId: string; brandId: string }) {
  const profile = await prisma.brandProfile.findFirst({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId }, select: { timeZone: true } });
  return profile?.timeZone ?? DEFAULT_TIME_ZONE;
}
