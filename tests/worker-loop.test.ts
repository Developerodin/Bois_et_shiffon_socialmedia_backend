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
  await runWorker({ intervalMs: 1, signal: ac.signal, now: c.now });
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
    const p = runWorker({ intervalMs: 1, signal: ac.signal }).then(() => { done = true; });
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
    await runWorker({ intervalMs: 1, signal: ac.signal });
    expect(m.run).toHaveBeenCalledTimes(2);
  });
});
