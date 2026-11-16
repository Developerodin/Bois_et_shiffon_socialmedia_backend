import { beforeEach, describe, expect, it, vi } from "vitest";

// A job out of tries: its failure hook (mark the run failed, refund) must run at least once, so the job is parked
// before the hook and dead-lettered only after it succeeded.
const m = vi.hoisted(() => ({ claim: vi.fn(), complete: vi.fn(), updateMany: vi.fn(), hook: vi.fn(), run: vi.fn() }));
vi.mock("@/server/db/prisma", () => ({ prisma: { job: { updateMany: m.updateMany } } }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/server/agents/engine", async (orig) => ({ ...(await orig<object>()), executeAgentRun: m.run, onAgentRunFailure: m.hook }));
vi.mock("@/server/jobs/queue", async (orig) => ({ ...(await orig<object>()), claimNextJob: m.claim, completeJob: m.complete, holdLease: () => () => {} }));

import { runDueJobs } from "@/server/jobs/runner";

const job = (attempts: number) => ({ id: "j1", type: "agent.run", payload: { runId: "r1" }, attempts, maxAttempts: 3, leasedBy: "w" });
const writes = () => m.updateMany.mock.calls.map(([a]) => a as { where: Record<string, unknown>; data: Record<string, unknown> });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  m.updateMany.mockResolvedValue({ count: 1 });
  m.run.mockRejectedValue(new Error("boom"));
});

describe("a job that used its last attempt", () => {
  it("is parked (pending, no tries left), its hook runs, then it is dead-lettered", async () => {
    m.claim.mockResolvedValueOnce(job(3)).mockResolvedValue(null);
    m.hook.mockResolvedValue(undefined);
    await runDueJobs({ budgetMs: 5_000 });
    const [park, dead] = writes();
    expect(park.where).toEqual({ id: "j1", leasedBy: "w", status: "RUNNING" });
    expect(park.data).toMatchObject({ status: "PENDING", attempts: 3 });
    expect(m.hook).toHaveBeenCalledWith({ runId: "r1" }, expect.any(Error), true);
    expect(dead).toEqual({ where: { id: "j1", leasedBy: "w", status: "PENDING" }, data: { status: "DEAD_LETTER" } });
  });

  it("stays parked when the hook throws, and the next claim runs only the hook again, then dead-letters it", async () => {
    m.claim.mockResolvedValueOnce(job(3)).mockResolvedValue(null);
    m.hook.mockRejectedValueOnce(new Error("pool timeout"));
    await runDueJobs({ budgetMs: 5_000 });
    expect(writes().map((w) => w.data.status)).toEqual(["PENDING"]); // no DEAD_LETTER
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("runs again in a minute"), expect.any(Error));

    // A minute later: the claim counts one more attempt than allowed, so the job itself doesn't run again.
    m.claim.mockResolvedValueOnce(job(4)).mockResolvedValue(null);
    m.hook.mockResolvedValue(undefined);
    await runDueJobs({ budgetMs: 5_000 });
    expect(m.run).toHaveBeenCalledTimes(1);
    expect(m.hook).toHaveBeenCalledTimes(2);
    expect(writes().at(-1)!.data).toEqual({ status: "DEAD_LETTER" });
  });

  it("a runner that lost the lease neither runs the hook nor dead-letters", async () => {
    m.claim.mockResolvedValueOnce(job(3)).mockResolvedValue(null);
    m.updateMany.mockResolvedValue({ count: 0 });
    await runDueJobs({ budgetMs: 5_000 });
    expect(m.hook).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);
  });

  it("a retryable failure with tries left goes back with backoff and runs the hook as not exhausted", async () => {
    m.claim.mockResolvedValueOnce(job(1)).mockResolvedValue(null);
    m.hook.mockResolvedValue(undefined);
    await runDueJobs({ budgetMs: 5_000 });
    expect(writes()).toHaveLength(1);
    expect(writes()[0].data).not.toHaveProperty("attempts");
    expect(m.hook).toHaveBeenCalledWith({ runId: "r1" }, expect.any(Error), false);
  });
});
