import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ run: vi.fn(), sweep: vi.fn() }));
vi.mock("@/server/jobs/runner", () => ({ runDueJobs: m.run, enqueueDailySweep: m.sweep }));

import { runWorker } from "@/worker/main";

/** A clock the test moves by hand; each loop's sleep is the only thing that ticks it. */
function clock(startIso: string) {
  let t = Date.parse(startIso);
  return { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.run.mockResolvedValue({ processed: 0, workerId: "w" });
  m.sweep.mockResolvedValue(undefined);
});

/** Run `loops` iterations (advancing the fake clock `stepMs` per loop), then abort. */
async function runLoops(startIso: string, loops: number, stepMs: number) {
  const c = clock(startIso);
  const ac = new AbortController();
  let n = 0;
  m.run.mockImplementation(async () => {
    c.advance(stepMs);
    if (++n >= loops) ac.abort();
    return { processed: 0, workerId: "w" };
  });
  await runWorker({ intervalMs: 1, signal: ac.signal, concurrency: 1, now: c.now });
  return n;
}

describe("runWorker", () => {
  it("queues the daily sweep once per UTC day at or after 05:00, however many loops run", async () => {
    // 05:01 start, 30 minutes per loop, 3 days of loops
    const loops = await runLoops("2026-11-16T05:01:00Z", 3 * 48, 30 * 60_000);
    expect(loops).toBe(144);
    expect(m.sweep).toHaveBeenCalledTimes(3);
  });

  it("does not queue it at 04:59", async () => {
    await runLoops("2026-11-16T04:59:00Z", 1, 0);
    expect(m.sweep).not.toHaveBeenCalled();
  });

  it("queues it when the clock passes 05:00 later the same day", async () => {
    await runLoops("2026-11-16T04:59:00Z", 3, 60_000);
    expect(m.sweep).toHaveBeenCalledTimes(1);
  });

  it("on abort stops claiming and returns only after the in-flight run settles", async () => {
    const ac = new AbortController();
    let finish!: () => void;
    m.run.mockImplementation(() => new Promise((r) => { finish = () => r({ processed: 1, workerId: "w" }); }));
    let done = false;
    const p = runWorker({ intervalMs: 1, signal: ac.signal, concurrency: 1 }).then(() => { done = true; });
    await vi.waitFor(() => expect(m.run).toHaveBeenCalledTimes(1));
    ac.abort();
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    finish();
    await p;
    expect(done).toBe(true);
    expect(m.run).toHaveBeenCalledTimes(1);
  });

  it("keeps looping after a failed run", async () => {
    const ac = new AbortController();
    m.run.mockRejectedValueOnce(new Error("db down")).mockImplementation(async () => { ac.abort(); return { processed: 0, workerId: "w" }; });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runWorker({ intervalMs: 1, signal: ac.signal, concurrency: 1 });
    expect(m.run).toHaveBeenCalledTimes(2);
  });

  it("starts a job queued during a long run within the poll interval, on another loop", async () => {
    // A tiny queue: each runDueJobs call takes the next job, as claimNextJob would.
    const queue = ["research"];
    const ran: string[] = [];
    let finishLong!: () => void;
    m.run.mockImplementation(async () => {
      const job = queue.shift();
      if (!job) return { processed: 0, workerId: "w" };
      ran.push(job);
      if (job === "research") await new Promise<void>((r) => { finishLong = r; });
      return { processed: 1, workerId: "w" };
    });
    const ac = new AbortController();
    const p = runWorker({ intervalMs: 5, signal: ac.signal, concurrency: 2 });
    await vi.waitFor(() => expect(ran).toEqual(["research"]));
    queue.push("password-reset email");
    await vi.waitFor(() => expect(ran).toEqual(["research", "password-reset email"]), { timeout: 200 });
    ac.abort();
    finishLong();
    await p;
  });

  it("queues the daily sweep once even with several loops", async () => {
    const ac = new AbortController();
    let n = 0;
    m.run.mockImplementation(async () => {
      if (++n >= 12) ac.abort();
      return { processed: 0, workerId: "w" };
    });
    await runWorker({ intervalMs: 1, signal: ac.signal, concurrency: 4, now: () => new Date("2026-11-16T06:00:00Z") });
    expect(m.sweep).toHaveBeenCalledTimes(1);
  });
});
