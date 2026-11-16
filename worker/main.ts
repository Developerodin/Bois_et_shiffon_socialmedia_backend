/**
 * Standalone job worker (EC2): drains the queue in a loop and, when WORKER_DAILY_SWEEP is on, queues the daily sweep
 * once a day.
 * Run built: node dist/worker.js. Run in dev: npm run worker:dev -w server.
 * It runs WORKER_CONCURRENCY (default 4) independent claim loops, so a 5-minute Research run doesn't hold up a
 * password-reset email or a scheduled publish: an idle loop claims those within one poll interval.
 * ponytail: the ceiling is N long jobs at once; with every loop busy a short job waits for the first one to finish.
 * Raise WORKER_CONCURRENCY or add worker instances (claims use SKIP LOCKED, the sweep is idempotent) when that bites.
 */
import { enqueueDailySweep, runDueJobs } from "@/server/jobs/runner";
import { assertProductionEnv } from "@/server/production-env";

const SWEEP_HOUR_UTC = 5; // the old cron's 05:00
const BUDGET_MS = 30_000;

/** Resolves after ms, or at once when the signal aborts. */
function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

/**
 * The worker's settings from its env. WORKER_DAILY_SWEEP: unset means on only when NODE_ENV=production, so a dev or
 * local worker (worker:dev, a local docker worker on a shared dev database) never queues the paid daily sweep (scheduled
 * agent runs, plan renewals) by surprise. WORKER_CONCURRENCY is clamped to an integer of at least 1.
 */
export function workerSettings(env: Record<string, string | undefined> = process.env) {
  const sweep = env.WORKER_DAILY_SWEEP;
  return {
    intervalMs: Number(env.WORKER_INTERVAL_MS) || 15_000,
    concurrency: Math.max(1, Math.floor(Number(env.WORKER_CONCURRENCY) || 4)),
    dailySweep: sweep === undefined || sweep === "" ? env.NODE_ENV === "production" : sweep === "true",
  };
}

export async function runWorker({ intervalMs, signal, concurrency = 4, dailySweep = true, now = () => new Date() }: { intervalMs: number; signal: AbortSignal; concurrency?: number; dailySweep?: boolean; now?: () => Date }) {
  let sweptDay = "";
  // Each loop is sequential. An abort claims nothing new (runDueJobs sees the signal) and waits for the job in flight.
  const loop = async () => {
    while (!signal.aborted) {
      const t = now();
      const day = t.toISOString().slice(0, 10);
      if (dailySweep && t.getUTCHours() >= SWEEP_HOUR_UTC && sweptDay !== day) {
        sweptDay = day; // taken before the await, so only one loop queues it
        try {
          await enqueueDailySweep(); // idempotent per day, so a restart that forgets sweptDay is harmless
        } catch (error) {
          sweptDay = "";
          console.error("[worker] daily sweep", error); // tried again next loop
        }
      }
      try {
        const { processed } = await runDueJobs({ budgetMs: BUDGET_MS, signal });
        if (processed) console.log(`[worker] processed ${processed} job(s)`);
      } catch (error) {
        console.error("[worker]", error);
      }
      await sleep(intervalMs, signal);
    }
  };
  // Independent loops: each runDueJobs has its own workerId, and the claim's SKIP LOCKED keeps two off one job.
  await Promise.all(Array.from({ length: concurrency }, loop));
}

// Entry point. The bundle (dist/worker.js) and tsx both run this file directly; tests only import runWorker.
if (process.env.VITEST === undefined) {
  assertProductionEnv(); // the same checks the api runs at startup: email links from jobs need an https AUTH_URL
  const ac = new AbortController();
  const stop = (name: string) => () => {
    console.log(`[worker] ${name}: finishing the jobs in flight, then exiting`);
    ac.abort();
  };
  process.once("SIGTERM", stop("SIGTERM"));
  process.once("SIGINT", stop("SIGINT"));
  const settings = workerSettings();
  console.log(`[worker] started, ${settings.concurrency} loop(s) polling every ${settings.intervalMs} ms, daily sweep ${settings.dailySweep ? "on" : "off (WORKER_DAILY_SWEEP)"}`);
  runWorker({ ...settings, signal: ac.signal }).then(
    () => {
      console.log("[worker] stopped");
      process.exit(0);
    },
    (error) => {
      console.error("[worker] crashed", error);
      process.exit(1);
    },
  );
}
