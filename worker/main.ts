/**
 * Standalone job worker (EC2): drains the queue in a loop and queues the daily sweep once a day.
 * Run built: node dist/worker.js. Run in dev: npm run worker:dev -w server.
 * ponytail: one worker process; two would be safe (claims use SKIP LOCKED, the sweep is idempotent) just wasteful.
 */
import { enqueueDailySweep, runDueJobs } from "@/server/jobs/runner";

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

export async function runWorker({ intervalMs, signal, now = () => new Date() }: { intervalMs: number; signal: AbortSignal; now?: () => Date }) {
  let sweptDay = "";
  // The loop is sequential, so an abort mid-run waits for that runDueJobs to settle before the loop sees it.
  while (!signal.aborted) {
    const t = now();
    const day = t.toISOString().slice(0, 10);
    if (t.getUTCHours() >= SWEEP_HOUR_UTC && sweptDay !== day) {
      try {
        await enqueueDailySweep(); // idempotent per day, so a restart that forgets sweptDay is harmless
        sweptDay = day;
      } catch (error) {
        console.error("[worker] daily sweep", error); // tried again next loop
      }
    }
    try {
      const { processed } = await runDueJobs({ budgetMs: BUDGET_MS });
      if (processed) console.log(`[worker] processed ${processed} job(s)`);
    } catch (error) {
      console.error("[worker]", error);
    }
    await sleep(intervalMs, signal);
  }
}

// Entry point. The bundle (dist/worker.js) and tsx both run this file directly; tests only import runWorker.
if (process.env.VITEST === undefined) {
  const ac = new AbortController();
  const stop = (name: string) => () => {
    console.log(`[worker] ${name}: finishing the current run, then exiting`);
    ac.abort();
  };
  process.once("SIGTERM", stop("SIGTERM"));
  process.once("SIGINT", stop("SIGINT"));
  const intervalMs = Number(process.env.WORKER_INTERVAL_MS) || 15_000;
  console.log(`[worker] started, polling every ${intervalMs} ms`);
  runWorker({ intervalMs, signal: ac.signal }).then(
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
