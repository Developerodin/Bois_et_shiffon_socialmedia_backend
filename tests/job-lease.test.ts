import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ $executeRaw: vi.fn() }));
vi.mock("@/server/db/prisma", () => ({ prisma: db }));

import type { Job } from "@prisma/client";
import { holdLease, LEASE_MS } from "@/server/jobs/queue";

const job = { id: "j1", type: "agent.run", leasedBy: "runner-1" } as Job;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("holdLease", () => {
  it("says so when a renewal finds the lease taken by another runner", async () => {
    db.$executeRaw.mockResolvedValue(0);
    const stop = holdLease(job);
    await vi.advanceTimersByTimeAsync(LEASE_MS / 3);
    stop();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("lease lost"));
  });

  it("logs a renewal that failed instead of swallowing it", async () => {
    db.$executeRaw.mockRejectedValue(new Error("pool timeout"));
    const stop = holdLease(job);
    await vi.advanceTimersByTimeAsync(LEASE_MS / 3);
    stop();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("lease renewal failed"), expect.any(Error));
  });

  it("is quiet while the renewal holds", async () => {
    db.$executeRaw.mockResolvedValue(1);
    const stop = holdLease(job);
    await vi.advanceTimersByTimeAsync(LEASE_MS);
    stop();
    expect(console.warn).not.toHaveBeenCalled();
    expect(db.$executeRaw).toHaveBeenCalledTimes(3);
  });
});
