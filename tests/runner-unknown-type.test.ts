import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ claim: vi.fn(), complete: vi.fn(), fail: vi.fn(), release: vi.fn(), after: vi.fn() }));
vi.mock("@/server/db/prisma", () => ({ prisma: {} }));
vi.mock("next/server", () => ({ after: m.after }));
vi.mock("@/server/jobs/queue", async (orig) => ({
  ...(await orig<object>()),
  claimNextJob: m.claim,
  completeJob: m.complete,
  failJob: m.fail,
  releaseJob: m.release,
  holdLease: () => () => {},
}));

import { kickRunner, runDueJobs } from "@/server/jobs/runner";

const job = { id: "j1", type: "from.a.newer.release", payload: {}, attempts: 1, maxAttempts: 5, leasedBy: "w" };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.RUN_JOBS_IN_API;
  m.claim.mockResolvedValueOnce(job).mockResolvedValue(null);
  m.release.mockResolvedValue(undefined);
});

describe("a job whose type this runner doesn't know", () => {
  it("goes back to the queue without counting the attempt or failing", async () => {
    await runDueJobs({ budgetMs: 5_000 });
    expect(m.release).toHaveBeenCalledWith(job);
    expect(m.fail).not.toHaveBeenCalled();
    expect(m.complete).not.toHaveBeenCalled();
  });
});

describe("runDueJobs with an abort signal", () => {
  it("claims nothing after the abort, but finishes the job in flight", async () => {
    const ac = new AbortController();
    m.claim.mockReset().mockResolvedValue(job); // the queue never runs dry
    m.release.mockImplementation(async () => ac.abort()); // SIGTERM arrives while the first job runs
    const { processed } = await runDueJobs({ budgetMs: 5_000, signal: ac.signal });
    expect(m.claim).toHaveBeenCalledTimes(1);
    expect(m.release).toHaveBeenCalledTimes(1);
    expect(processed).toBe(1);
  });
});

describe("kickRunner", () => {
  it("schedules a run after the response by default", () => {
    kickRunner();
    expect(m.after).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the worker process owns the queue (RUN_JOBS_IN_API=false)", () => {
    process.env.RUN_JOBS_IN_API = "false";
    kickRunner();
    expect(m.after).not.toHaveBeenCalled();
  });
});
