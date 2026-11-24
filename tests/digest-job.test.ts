import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ workspaceMember: { findMany: vi.fn() }, job: { createMany: vi.fn() } }));
vi.mock("@/server/db/prisma", () => ({ prisma: db }));

import { DIGEST_JOB, enqueueWeeklyDigests } from "@/server/digest/job";

const MONDAY_SWEEP = new Date("2026-11-23T05:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  db.workspaceMember.findMany.mockResolvedValue([{ workspaceId: "w1", userId: "u1" }, { workspaceId: "w1", userId: "u2" }]);
});

describe("enqueueWeeklyDigests", () => {
  it("queues on Mondays only", async () => {
    await enqueueWeeklyDigests(new Date("2026-11-24T05:00:00Z"));
    expect(db.job.createMany).not.toHaveBeenCalled();
  });

  it("one job per member, keyed by the week, at least 3 h after the sweep and within the hour after that", async () => {
    await enqueueWeeklyDigests(MONDAY_SWEEP);
    expect(db.job.createMany).toHaveBeenCalledTimes(1);
    const { data, skipDuplicates } = db.job.createMany.mock.calls[0]![0] as { data: { idempotencyKey: string; runAt: Date }[]; skipDuplicates: boolean };
    expect(skipDuplicates).toBe(true);
    expect(data).toHaveLength(2);
    for (const job of data) {
      expect(job).toMatchObject({ type: DIGEST_JOB, payload: { workspaceId: "w1", weekStart: "2026-11-16" } });
      expect(job.idempotencyKey).toMatch(/^digest:w1:u[12]:2026-11-16$/);
      const after = job.runAt.getTime() - MONDAY_SWEEP.getTime();
      expect(after).toBeGreaterThanOrEqual(3 * 3_600_000);
      expect(after).toBeLessThan(4 * 3_600_000);
    }
  });

  it("inserts members in chunks of 500, one statement each", async () => {
    db.workspaceMember.findMany.mockResolvedValue(Array.from({ length: 1001 }, (_, i) => ({ workspaceId: "w1", userId: `u${i}` })));
    await enqueueWeeklyDigests(MONDAY_SWEEP);
    expect(db.job.createMany.mock.calls.map(([a]) => (a as { data: unknown[] }).data.length)).toEqual([500, 500, 1]);
  });
});
