import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ workspaceMember: { findMany: vi.fn() } }));
vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/jobs/queue", () => ({ enqueueJob: vi.fn() }));

import { enqueueJob } from "@/server/jobs/queue";
import { DIGEST_JOB, enqueueWeeklyDigests } from "@/server/digest/job";

const MONDAY_SWEEP = new Date("2026-11-23T05:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  db.workspaceMember.findMany.mockResolvedValue([{ workspaceId: "w1", userId: "u1" }, { workspaceId: "w1", userId: "u2" }]);
});

describe("enqueueWeeklyDigests", () => {
  it("queues on Mondays only", async () => {
    await enqueueWeeklyDigests(new Date("2026-11-24T05:00:00Z"));
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("one job per member, keyed by the week, at least 3 h after the sweep and within the hour after that", async () => {
    await enqueueWeeklyDigests(MONDAY_SWEEP);
    expect(enqueueJob).toHaveBeenCalledTimes(2);
    for (const [job] of vi.mocked(enqueueJob).mock.calls) {
      expect(job).toMatchObject({ type: DIGEST_JOB, payload: { workspaceId: "w1", weekStart: "2026-11-16" } });
      expect(job.idempotencyKey).toMatch(/^digest:w1:u[12]:2026-11-16$/);
      const after = job.runAt!.getTime() - MONDAY_SWEEP.getTime();
      expect(after).toBeGreaterThanOrEqual(3 * 3_600_000);
      expect(after).toBeLessThan(4 * 3_600_000);
    }
  });
});
