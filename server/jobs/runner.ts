import { randomUUID } from "node:crypto";
import { after } from "next/server";
import {
  AGENT_RUN_JOB,
  executeAgentRun,
  NothingToDoError,
  onAgentRunFailure,
  startAgentRun,
} from "@/server/agents/engine";
import { AGENTS } from "@/server/agents/registry";
import { SiteBlockedError } from "@/server/agents/definitions/site-audit";
import { AiProviderError } from "@/server/ai/provider";
import { runCatalogPages } from "@/server/catalog/page-reader";
import { CATALOG_PAGES_JOB, CATALOG_SYNC_JOB, enqueueDailyCatalogSyncs, runCatalogSync } from "@/server/catalog/sync";
import { ADS_ALERTS_JOB, runAdAlerts } from "@/server/ads/alerts";
import { DATA_SYNC_JOB, enqueueDailyDataSyncs, runDataSync } from "@/server/data/sources";
import { DIGEST_JOB, enqueueWeeklyDigests, runDigest } from "@/server/digest/job";
import { enqueueFxSync, FX_SYNC_JOB, runFxSync } from "@/server/data/fx";
import { enqueueMissedStoryReads, runStoryRead, STORY_READ_JOB } from "@/server/data/story-metrics";
import { ensurePostMetricSources } from "@/server/data/post-metric-sync"; // also registers the POST_METRICS runner
import "@/server/data/shopify-orders-sync"; // registers the SHOPIFY_ORDERS runner
import "@/server/data/meta-ads-sync"; // registers the META_ADS sync
import { crmDailySweep } from "@/server/crm/sweep";
import "@/server/quotes/status-sync"; // registers the SHOPIFY_QUOTES runner (quote status, expiry, reminders)
import { prisma } from "@/server/db/prisma";
import { EMAIL_SEND_JOB, sendOutboxEmail } from "@/server/email/outbox";
import { notifyOverdueTasks, notifyRechecks, pruneNotifications } from "@/server/notifications/daily-tasks";
import { purgeStaleTaskFiles } from "@/server/tasks/files";
import type { Job } from "@prisma/client";
import { claimNextJob, completeJob, deadLetterJob, enqueueJob, failJob, holdLease, type Lease, releaseJob } from "@/server/jobs/queue";
import { onShootFailure, PHOTOSHOOT_JOB, runShoot } from "@/server/photoshoot/shoot";
import { advanceRender, failRender, REEL_RENDER_JOB } from "@/server/reels/render";
import { onAssetFailure, REEL_ASSET_JOB, runAsset } from "@/server/reels/assets";
import "@/server/reels/templates"; // registers its asset kind
import "@/server/reels/presenters"; // registers its asset kind
import { QUERY_RETENTION_DAYS } from "@/server/data/search-sync"; // also registers the SEARCH_CONSOLE sync
import { purgeOldRecordings } from "@/server/reels/recordings";
import { clearFindings, FINDING_CLEAR_JOB, FINDING_TASKS_JOB, tasksFromReport } from "@/server/seo/finding-tasks";
import { runSeoLinks, SEO_LINKS_JOB } from "@/server/seo/site-crawl";
import { runSeoDeclines, SEO_DECLINES_JOB } from "@/server/seo/declines";
import { purgeStaleUploads } from "@/server/stories/uploads";
import { onStoryRenderFailure, runStoryRender, STORY_RENDER_JOB } from "@/server/stories/service";
import { onVoiceDeleteFailure, reclaimAbandonedClones, runVoiceDelete, VOICE_DELETE_JOB } from "@/server/reels/clones";
import { ReconnectNeeded, refreshExpiringTokens } from "@/server/services/connections";
import { executePublication, onPublishJobLost, PUBLISH_JOB, PublishingError } from "@/server/services/publishing";
import { runMonthlyPlans } from "@/server/services/automations";
import { AUDIT_ALL_JOB, runAuditAllJob } from "@/server/services/competitor-audits";
import { renewDuePlans } from "@/server/services/subscriptions";
import { expireStaleWrites } from "@/server/shopify/writes";

type Handler = {
  run: (payload: unknown, lease: Lease) => Promise<void>;
  onFailure?: (payload: unknown, error: unknown, exhausted: boolean) => Promise<void>;
};

export const DAILY_SWEEP_JOB = "system.daily-sweep";

const HANDLERS: Record<string, Handler> = {
  [ADS_ALERTS_JOB]: { run: runAdAlerts },
  [AGENT_RUN_JOB]: { run: executeAgentRun, onFailure: onAgentRunFailure },
  [AUDIT_ALL_JOB]: { run: runAuditAllJob },
  [CATALOG_PAGES_JOB]: { run: runCatalogPages },
  [CATALOG_SYNC_JOB]: { run: runCatalogSync },
  [DAILY_SWEEP_JOB]: { run: dailySweep },
  [DATA_SYNC_JOB]: { run: runDataSync },
  [DIGEST_JOB]: { run: runDigest },
  [EMAIL_SEND_JOB]: { run: sendOutboxEmail },
  [FINDING_CLEAR_JOB]: { run: clearFindings },
  [FINDING_TASKS_JOB]: { run: tasksFromReport },
  [FX_SYNC_JOB]: { run: runFxSync },
  [PHOTOSHOOT_JOB]: { run: runShoot, onFailure: onShootFailure },
  [PUBLISH_JOB]: { run: executePublication, onFailure: onPublishJobLost },
  [REEL_ASSET_JOB]: { run: runAsset, onFailure: onAssetFailure },
  [REEL_RENDER_JOB]: { run: advanceRender, onFailure: failRender },
  [SEO_DECLINES_JOB]: { run: runSeoDeclines },
  [SEO_LINKS_JOB]: { run: runSeoLinks },
  [STORY_READ_JOB]: { run: runStoryRead },
  [STORY_RENDER_JOB]: { run: runStoryRender, onFailure: onStoryRenderFailure },
  [VOICE_DELETE_JOB]: { run: runVoiceDelete, onFailure: onVoiceDeleteFailure },
};

/**
 * Drains due jobs until none remain, the time budget is spent (design §8b-1) or `signal` aborts. The budget and the
 * signal are only checked between jobs: an abort claims nothing new and lets the job in flight finish.
 * ponytail: sequential, one job at a time; the worker runs several of these at once (WORKER_CONCURRENCY).
 * ponytail: nothing caps a job's run time off Vercel (maxDuration no longer kills it). A worker's stop grace
 * (compose stop_grace_period, docker stop -t) must exceed the longest job, or the job is killed mid-run and run again
 * once its lease (LEASE_MS) expires, as a new attempt. Publishing survives that: its attempt is claimed
 * SCHEDULED → PUBLISHING first and maxAttempts is 1, so the rerun posts nothing and onPublishJobLost marks it
 * PENDING_VERIFY for a person to check. Paid agent or render work is paid twice. Add a per-job ceiling if that bites.
 */
export async function runDueJobs({ budgetMs = 45_000, signal }: { budgetMs?: number; signal?: AbortSignal } = {}) {
  const workerId = `runner-${randomUUID()}`;
  const deadline = Date.now() + budgetMs;
  let processed = 0;
  while (Date.now() < deadline && !signal?.aborted) {
    const job = await claimNextJob(workerId);
    if (!job) break;
    processed++;
    const handler = HANDLERS[job.type];
    // Reclaimed after its last attempt died mid-run (timeout, crash): stop here instead of looping forever.
    // Also how a parked job whose failure hook didn't finish comes back (giveUp).
    if (job.attempts > job.maxAttempts) {
      const error = new Error("Stopped: it was cut off before finishing on every attempt");
      // Keep the saved error: a parked job's is the real failure (a story render's refusal text is shown from it).
      // ponytail: a job cut off mid-run after an earlier failed attempt keeps that attempt's error too.
      if ((await failJob(job, error, false, job.lastError ?? String(error))) !== null) await giveUp(job, handler, error);
      continue;
    }
    // Not a failure of the job: another release may know this type. Leave it for that one, attempt uncounted.
    if (!handler) {
      await releaseJob(job);
      continue;
    }
    const release = holdLease(job);
    try {
      await handler.run(job.payload, { jobId: job.id, leasedBy: job.leasedBy });
      await completeJob(job);
    } catch (error) {
      // A catalogue or data sync whose token was refused waits for a person to reconnect; a story render refused
      // (stale, approved meanwhile, text or clip window) would be refused again, and so would a site audit of a site that
      // blocks automated readers. Retrying can't help either.
      const refused = ((job.type === CATALOG_SYNC_JOB || job.type === DATA_SYNC_JOB) && error instanceof ReconnectNeeded) || (job.type === STORY_RENDER_JOB && error instanceof PublishingError) || error instanceof SiteBlockedError;
      const retryable = error instanceof AiProviderError ? error.retryable : !(error instanceof NothingToDoError || refused);
      const exhausted = await failJob(job, error, retryable);
      // A runner that lost its lease leaves the job to whoever holds it: its failure hooks (mark failed, refund) would
      // undo work the other runner may still finish.
      if (exhausted) await giveUp(job, handler, error);
      else if (exhausted === false) await handler.onFailure?.(job.payload, error, false).catch((e) => console.error(`[jobs] ${job.type} ${job.id}: failure hook failed`, e));
    } finally {
      release();
    }
  }
  return { processed, workerId };
}

/**
 * A job out of tries, parked by failJob: run its failure hook (mark failed, refund, queue a later retry), then
 * dead-letter it. If the hook throws, or the process dies before it finishes, the job stays parked and its next claim
 * (HOOK_RETRY_MS later) runs the hook again through the attempts > maxAttempts branch, never the job itself. So an
 * agent run isn't left RUNNING without its refund, nor a voice delete without its later retry. Every hook is safe to
 * run twice: each is a compare-and-set on its entity's status. ponytail: a hook that always throws is retried every
 * minute, logged each time; a retried hook gets the generic "cut off" error, not the original one.
 */
async function giveUp(job: Job, handler: Handler | undefined, error: unknown) {
  try {
    await handler?.onFailure?.(job.payload, error, true);
  } catch (e) {
    console.error(`[jobs] ${job.type} ${job.id}: failure hook failed; it runs again in a minute`, e);
    return;
  }
  await deadLetterJob(job);
}

/** Run the queue after the response is sent, so user-triggered work starts immediately. */
export function kickRunner() {
  // The standalone worker process owns the queue (RUN_JOBS_IN_API=false); the API only enqueues.
  if (process.env.RUN_JOBS_IN_API === "false") return;
  after(() => runDueJobs().then(() => undefined));
}

let lastDueCheck = 0;
/**
 * Called from routes the open app polls: if a job is overdue (a scheduled post, an agent retry), run it now in this
 * process. At most one check per 30 s per server instance. Only matters where the API runs jobs (dev); in production
 * (RUN_JOBS_IN_API=false) the worker polls the queue itself, so this skips the query.
 */
export async function kickIfDue() {
  if (process.env.RUN_JOBS_IN_API === "false") return;
  if (Date.now() - lastDueCheck < 30_000) return;
  lastDueCheck = Date.now();
  const due = await prisma.job.findFirst({
    where: { OR: [{ status: "PENDING", runAt: { lte: new Date() } }, { status: "RUNNING", leasedUntil: { lt: new Date() } }] },
    select: { id: true },
  });
  if (due) kickRunner();
}

/**
 * Daily cron entry: start the daily agents for every active brand and the weekly ones that are due (startScheduledAgents), and queue each brand's catalogue sync.
 * The sweep job is unique per day (idempotency key), so a double cron delivery
 * runs it once; a retried sweep skips agents already started today.
 */
async function dailySweep() {
  await refreshExpiringTokens();
  await pruneOldRows();
  await renewDuePlans();
  await runMonthlyPlans();
  await enqueueDailyCatalogSyncs();
  await purgeOldRecordings();
  await purgeStaleUploads();
  await reclaimAbandonedClones();
  await startScheduledAgents();
  // Last, and each on its own: a failing step is logged and never blocks the steps above (billing renewals).
  const now = new Date();
  // "data" only queues each data source's sync (no provider calls), spread over the next two hours; "post-metric
  // sources" first gives each brand with published posts its POST_METRICS source. "fx" queues the day's exchange-rate
  // read (server/data/fx.ts), one short job outside the data cap; "story reads" queues reads the publish paths missed.
  // "digest" queues Monday's digests for after those syncs, last: a workspace-wide insert that must never hold up the
  // steps before it.
  for (const [name, step] of [["post-metric sources", ensurePostMetricSources], ["data", enqueueDailyDataSyncs], ["fx", enqueueFxSync], ["story reads", enqueueMissedStoryReads], ["overdue", notifyOverdueTasks], ["rechecks", notifyRechecks], ["prune", pruneNotifications], ["shopify writes", expireStaleWrites], ["task files", purgeStaleTaskFiles], ["crm", crmDailySweep], ["digest", enqueueWeeklyDigests]] as const) {
    try {
      await step(now);
    } catch (e) {
      console.error(`[jobs] daily sweep: ${name} failed`, e);
    }
  }
}

/** The UTC weekday (0–6) a brand's weekly agents run on, from its id, so the brands spread over the week. */
export const weeklySlot = (brandId: string) => [...brandId].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % 7;

/**
 * Start each daily agent once per brand per UTC day, and each weekly agent (SEO, GEO) for an active brand with a
 * website when that agent has had no run of any trigger (so a manual run pushes the next one back) since 6 days before
 * today, on the brand's weekday (weeklySlot); a brand that missed its day (no run in the last 8 days, today included)
 * catches up on the next sweep, whatever the weekday.
 * ponytail: the queue runs jobs one at a time per worker, and a weekly run is an SEO audit (crawl + PageSpeed + 1 AI
 * call) and a GEO audit (crawl + ~8 AI calls, 5 with web search), free to the user: at N brands that is ~2N/7 audits
 * queued behind the day's posts each sweep. A catch-up or manual run moves a brand off its weekday (8-day cycles until
 * it lands on it again). Make the cadence a brand setting, or add workers, if the backlog delays publishing.
 */
export async function startScheduledAgents(now = new Date()) {
  const startOfDay = new Date(now.toISOString().slice(0, 10));
  const daysBefore = (n: number) => new Date(startOfDay.getTime() - n * 86_400_000);
  const start = (brand: { id: string; workspaceId: string }, agentKey: string) =>
    startAgentRun({ workspaceId: brand.workspaceId, brandId: brand.id, agentKey, trigger: "schedule" }).catch(() => {}); // disabled for brand → skip

  const daily = AGENTS.filter((a) => a.schedule === "daily");
  if (daily.length) {
    const brands = await prisma.brand.findMany({ where: { status: "ACTIVE" }, select: { id: true, workspaceId: true } });
    for (const brand of brands) {
      for (const agent of daily) {
        const already = await prisma.agentRun.count({
          where: { brandId: brand.id, agentKey: agent.key, trigger: "schedule", createdAt: { gte: startOfDay } },
        });
        if (already === 0) await start(brand, agent.key);
      }
    }
  }

  const weekly = AGENTS.filter((a) => a.schedule === "weekly");
  if (!weekly.length) return;
  // Brands without a website are skipped: SEO and GEO would only fail.
  const brands = await prisma.brand.findMany({
    where: { status: "ACTIVE", profile: { websiteUrl: { not: null } } },
    select: { id: true, workspaceId: true },
  });
  if (!brands.length) return;
  const runs = await prisma.agentRun.groupBy({
    by: ["brandId", "agentKey"],
    where: { brandId: { in: brands.map((b) => b.id) }, agentKey: { in: weekly.map((a) => a.key) }, createdAt: { gte: daysBefore(7) } },
    _max: { createdAt: true },
  });
  const lastRun = new Map(runs.map((r) => [`${r.brandId}:${r.agentKey}`, r._max.createdAt]));
  for (const brand of brands) {
    const today = weeklySlot(brand.id) === now.getUTCDay();
    for (const agent of weekly) {
      const last = lastRun.get(`${brand.id}:${agent.key}`);
      if (last && (last >= daysBefore(6) || !today)) continue;
      await start(brand, agent.key);
    }
  }
}

/** Housekeeping: rows that only matter for a while. Audit events, decisions and AI usage are kept. */
export async function pruneOldRows() {
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
  await prisma.rateLimitBucket.deleteMany({ where: { windowStart: { lt: ago(2) } } });
  await prisma.transientEntry.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  await prisma.oAuthStateTransaction.deleteMany({ where: { expiresAt: { lt: ago(2) } } });
  await prisma.job.deleteMany({ where: { status: "COMPLETED", updatedAt: { lt: ago(30) } } });
  // FAILED too: a send that failed for 30 days won't go, and its text may still hold a link.
  await prisma.emailOutbox.deleteMany({ where: { status: { in: ["SENT", "NOT_CONFIGURED", "FAILED"] }, createdAt: { lt: ago(30) } } });
  await prisma.digest.deleteMany({ where: { createdAt: { lt: ago(12 * 7) } } });
  await prisma.agentEvent.deleteMany({ where: { createdAt: { lt: ago(90) } } });
  await prisma.pageView.deleteMany({ where: { createdAt: { lt: ago(180) } } });
  await prisma.searchQueryDay.deleteMany({ where: { day: { lt: ago(QUERY_RETENTION_DAYS) } } });
}

export async function enqueueDailySweep() {
  const day = new Date().toISOString().slice(0, 10);
  await enqueueJob({
    type: DAILY_SWEEP_JOB,
    payload: {},
    idempotencyKey: `daily-sweep:${day}`,
  });
}
