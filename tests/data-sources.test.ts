import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const del = () => ({ deleteMany: vi.fn(async () => ({ count: 0 })) });
  return {
    // pruneOldRows and the daily agents, for the sweep test
    rateLimitBucket: del(), transientEntry: del(), oAuthStateTransaction: del(), job: del(), emailOutbox: del(), agentEvent: del(), pageView: del(),
    brand: { findMany: vi.fn(async () => []) },
  };
});
const sweep = vi.hoisted(() => ({
  claim: vi.fn(), complete: vi.fn(), catalog: vi.fn(async () => undefined), data: vi.fn(), overdue: vi.fn(async () => 0), noop: vi.fn(async () => undefined),
}));
vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("next/server", async (orig) => ({ ...(await orig<object>()), after: vi.fn() }));
vi.mock("@/server/jobs/queue", async (orig) => ({ ...(await orig<object>()), claimNextJob: sweep.claim, completeJob: sweep.complete, holdLease: () => () => {} }));
vi.mock("@/server/services/subscriptions", () => ({ renewDuePlans: sweep.noop }));
vi.mock("@/server/services/connections", async (orig) => ({ ...(await orig<object>()), refreshExpiringTokens: sweep.noop }));
vi.mock("@/server/services/automations", () => ({ runMonthlyPlans: sweep.noop }));
vi.mock("@/server/catalog/sync", async (orig) => ({ ...(await orig<object>()), enqueueDailyCatalogSyncs: sweep.catalog }));
vi.mock("@/server/reels/recordings", async (orig) => ({ ...(await orig<object>()), purgeOldRecordings: sweep.noop }));
vi.mock("@/server/stories/uploads", async (orig) => ({ ...(await orig<object>()), purgeStaleUploads: sweep.noop }));
vi.mock("@/server/reels/clones", async (orig) => ({ ...(await orig<object>()), reclaimAbandonedClones: sweep.noop }));
vi.mock("@/server/notifications/daily-tasks", () => ({ notifyOverdueTasks: sweep.overdue, notifyRechecks: sweep.noop, pruneNotifications: sweep.noop }));
vi.mock("@/server/data/sources", async (orig) => ({ ...(await orig<object>()), enqueueDailyDataSyncs: sweep.data }));

import { DATA_SOURCE_KINDS, DATA_SOURCE_SLUGS, READ_KEY } from "@/shared";
import { advanceSyncedThrough, dailyWindow, nextBackfillWindow, spreadSecs, zoneToday } from "@/server/data/sources";
import { DAILY_SWEEP_JOB, runDueJobs } from "@/server/jobs/runner";

describe("day helpers", () => {
  it("the daily window is today−3..today−1, across a month end", () => {
    expect(dailyWindow("2026-03-02")).toEqual({ from: "2026-02-27", to: "2026-03-01" });
  });

  it("zoneToday is the zone's date, not UTC's", () => {
    const lateUtc = new Date("2026-11-23T23:30:00Z");
    expect(zoneToday("UTC", lateUtc)).toBe("2026-11-23");
    expect(zoneToday("Europe/Paris", lateUtc)).toBe("2026-11-24");
    expect(zoneToday("America/Los_Angeles", lateUtc)).toBe("2026-11-23");
  });

  it("backfill walks windows oldest first and stops at the end", () => {
    expect(nextBackfillWindow(null, "2026-01-01", "2026-03-01", 30)).toEqual({ from: "2026-01-01", to: "2026-01-30" });
    expect(nextBackfillWindow("2026-01-30", "2026-01-01", "2026-03-01", 30)).toEqual({ from: "2026-01-31", to: "2026-03-01" });
    expect(nextBackfillWindow("2026-03-01", "2026-01-01", "2026-03-01", 30)).toBeNull();
  });

  it("syncedThrough advances only contiguously and only on a complete window", () => {
    const w = { from: "2026-01-31", to: "2026-02-28" };
    expect(advanceSyncedThrough("2026-01-30", w, true)).toBe("2026-02-28");
    expect(advanceSyncedThrough("2026-01-30", w, false)).toBe("2026-01-30");
    expect(advanceSyncedThrough("2026-01-20", w, true)).toBe("2026-01-20"); // a gap: held where it was
    expect(advanceSyncedThrough(null, w, true)).toBe("2026-02-28");
    expect(advanceSyncedThrough("2026-03-10", w, true)).toBe("2026-03-10"); // never backwards
  });

  it("the sweep spreads sources over two hours", () => {
    const offsets = Array.from({ length: 50 }, (_, i) => spreadSecs(`source-${i}`));
    expect(Math.min(...offsets)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...offsets)).toBeLessThan(7200);
    expect(new Set(offsets).size).toBeGreaterThan(40);
  });
});

describe("kinds", () => {
  it("every kind has a URL slug and a read key; sales and ads need their own keys", () => {
    for (const k of DATA_SOURCE_KINDS) expect(DATA_SOURCE_SLUGS[k]).toMatch(/^[a-z-]+$/);
    expect(READ_KEY).toEqual({ SEARCH_CONSOLE: "analytics.read", POST_METRICS: "analytics.read", SHOPIFY_ORDERS: "crm.read", META_ADS: "ads.read" });
  });
});

describe("daily sweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sweep.claim.mockResolvedValueOnce({ id: "j1", type: DAILY_SWEEP_JOB, payload: {}, attempts: 1, maxAttempts: 3, leasedBy: "w" }).mockResolvedValue(null);
  });

  it("queues data syncs after the catalogue syncs, and a failing data step stops nothing else", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    sweep.data.mockRejectedValue(new Error("db down"));
    await runDueJobs({ budgetMs: 5_000 });
    expect(sweep.catalog).toHaveBeenCalledTimes(1);
    expect(sweep.data).toHaveBeenCalledTimes(1);
    expect(sweep.data).toHaveBeenCalledWith(expect.any(Date));
    expect(sweep.catalog.mock.invocationCallOrder[0]).toBeLessThan(sweep.data.mock.invocationCallOrder[0]!);
    expect(sweep.overdue).toHaveBeenCalledTimes(1);
    expect(sweep.complete).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("data"), expect.any(Error));
  });

  it("a failing later step doesn't stop the data step", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    sweep.data.mockResolvedValue(0);
    sweep.overdue.mockRejectedValueOnce(new Error("bad time zone"));
    await runDueJobs({ budgetMs: 5_000 });
    expect(sweep.data).toHaveBeenCalledTimes(1);
    expect(sweep.complete).toHaveBeenCalledTimes(1);
  });
});
