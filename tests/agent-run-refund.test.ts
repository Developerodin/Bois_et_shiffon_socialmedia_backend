import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const db = vi.hoisted(() => {
  const d = {
    agentRun: { findUnique: vi.fn(), findFirstOrThrow: vi.fn(), updateMany: vi.fn() },
    agentEvent: { create: vi.fn() },
    contentVersion: { findFirst: vi.fn() },
    job: { findFirst: vi.fn() },
    // holdsLease's SELECT … FOR SHARE: one row while this runner still holds the job.
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  d.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(d));
  return d;
});
const refund = vi.hoisted(() => vi.fn());
vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/services/credits", async (orig) => ({ ...(await orig<object>()), refundCharge: refund }));
vi.mock("@/server/agents/brand-context", () => ({ loadBrandContext: vi.fn(async () => ({})), languageLine: () => null }));
vi.mock("@/server/agents/registry", () => ({
  getAgent: () => ({ key: "creator", name: "Creator", inputSchema: z.object({}).passthrough(), run: async () => ({ drafts: 1 }) }),
}));

import { executeAgentRun, onAgentRunFailure } from "@/server/agents/engine";

const payload = { runId: "r1", workspaceId: "w1", brandId: "b1" };
const run = { id: "r1", workspaceId: "w1", brandId: "b1", agentKey: "creator", input: { itemId: "i1", chargeId: "c1" }, startedAt: null, triggeredByUserId: null };
const lease = { jobId: "j1", leasedBy: "runner-1" };
const succeeded = () => db.agentRun.updateMany.mock.calls.some(([a]) => (a as { data: { status: string } }).data.status === "SUCCEEDED");

beforeEach(() => {
  vi.clearAllMocks();
  db.agentRun.findUnique.mockResolvedValue({ ...run, status: "RUNNING" });
  db.agentRun.findFirstOrThrow.mockResolvedValue({ ...run, status: "QUEUED" });
  db.agentRun.updateMany.mockResolvedValue({ count: 1 });
  db.contentVersion.findFirst.mockResolvedValue(null);
  db.job.findFirst.mockResolvedValue(null);
  db.$queryRaw.mockResolvedValue([{ id: "j1" }]);
});

describe("onAgentRunFailure and paid runs", () => {
  it("refunds a paid run that finally fails without delivering, in the same transaction as FAILED", async () => {
    await onAgentRunFailure(payload, new Error("boom"), true);
    expect(db.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "r1", status: { in: ["QUEUED", "RUNNING"] } }, data: expect.objectContaining({ status: "FAILED" }) }));
    expect(refund).toHaveBeenCalledWith("w1", "c1", db);
  });

  it("keeps the charge when the run already saved a version (a re-run found nothing left to do)", async () => {
    db.contentVersion.findFirst.mockResolvedValue({ id: "v1" });
    await onAgentRunFailure(payload, new Error("Nothing to write"), true);
    expect(refund).not.toHaveBeenCalled();
    expect(db.contentVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { agentRunId: "r1", item: { workspaceId: "w1" } } }));
  });

  it("keeps the charge when the run queued a story render (that job refunds on its own failure)", async () => {
    db.job.findFirst.mockResolvedValue({ id: "j1" });
    await onAgentRunFailure(payload, new Error("cut off"), true);
    expect(refund).not.toHaveBeenCalled();
  });

  it("leaves a run that already SUCCEEDED as it is: no refund, not marked failed", async () => {
    db.agentRun.findUnique.mockResolvedValue({ ...run, status: "SUCCEEDED" });
    await onAgentRunFailure(payload, new Error("Stopped: it was cut off"), true);
    expect(db.agentRun.updateMany).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
  });

  it("a run that SUCCEEDED between the read and the write is neither marked failed nor refunded", async () => {
    db.agentRun.updateMany.mockResolvedValue({ count: 0 }); // the compare-and-set finds it no longer QUEUED/RUNNING
    await onAgentRunFailure(payload, new Error("boom"), true);
    expect(refund).not.toHaveBeenCalled();
    expect(db.agentEvent.create).not.toHaveBeenCalled();
  });

  it("called again for a run it already failed, it writes nothing and refunds nothing", async () => {
    db.agentRun.findUnique.mockResolvedValue({ ...run, status: "FAILED" });
    await onAgentRunFailure(payload, new Error("boom"), true);
    expect(db.agentRun.updateMany).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
  });

  it("doesn't refund an attempt that will be retried", async () => {
    await onAgentRunFailure(payload, new Error("boom"), false);
    expect(refund).not.toHaveBeenCalled();
  });
});

describe("executeAgentRun's status writes", () => {
  it("writes SUCCEEDED only from RUNNING, while it holds the job", async () => {
    await executeAgentRun(payload, lease);
    expect(db.agentRun.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: "r1", status: "RUNNING" }, data: expect.objectContaining({ status: "SUCCEEDED" }) }));
  });

  it("a runner that lost its lease doesn't write SUCCEEDED, and throws so the queue's lease-guarded failJob decides", async () => {
    db.$queryRaw.mockResolvedValue([]); // renewals failed, the job was reclaimed
    await expect(executeAgentRun(payload, lease)).rejects.toThrow("wasn't saved");
    expect(succeeded()).toBe(false);
  });

  it("a lease that is late, not lost (two renewals failed, 30 s left), still ends the run SUCCEEDED", async () => {
    // The lease row holds only for a margin under 30 s; a 1-minute margin would refuse it and strand the run RUNNING.
    db.$queryRaw.mockImplementation(async (sql: TemplateStringsArray, ...values: unknown[]) =>
      30 > (sql.join("?").includes("1 minute") ? 60 : Number(values[2] ?? 0)) ? [{ id: "j1" }] : []);
    await executeAgentRun(payload, lease);
    expect(succeeded()).toBe(true);
  });

  it("a run failed (and refunded) meanwhile stays FAILED: the SUCCEEDED compare-and-set matches nothing", async () => {
    db.agentRun.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await executeAgentRun(payload, lease).catch(() => {});
    expect(db.agentEvent.create).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ level: "SUCCESS" }) }));
  });

  it("doesn't start a run that ended before it was picked up", async () => {
    db.agentRun.updateMany.mockResolvedValue({ count: 0 });
    await executeAgentRun(payload, lease);
    expect(succeeded()).toBe(false);
    expect(db.agentRun.updateMany).toHaveBeenCalledTimes(1);
  });
});
