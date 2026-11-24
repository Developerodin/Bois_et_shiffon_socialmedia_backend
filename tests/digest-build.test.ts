import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  dataSource: { findFirst: vi.fn() },
  $queryRaw: vi.fn(),
}));
vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/data/sales-read", () => ({ salesSummary: vi.fn() }));
vi.mock("@/server/data/ads-read", () => ({ adsSummary: vi.fn() }));
vi.mock("@/server/data/search-read", () => ({ searchSummary: vi.fn() }));
vi.mock("@/server/data/post-metrics-read", () => ({ postsWithMetrics: vi.fn() }));

import type { DigestBody } from "@/shared";
import type { PermissionKey } from "@/server/auth/permissions.catalog";
import { adsSummary } from "@/server/data/ads-read";
import { postsWithMetrics } from "@/server/data/post-metrics-read";
import { salesSummary } from "@/server/data/sales-read";
import { searchSummary } from "@/server/data/search-read";
import { zoneToday } from "@/server/data/sources";
import { brandSections, clearSectionMemo, endedWeek, refilterDigest } from "@/server/digest/build";

const scope = { workspaceId: "w", brandId: "b" };
const WEEK = { from: "2026-11-16", to: "2026-11-22" };
const NOW = new Date("2026-11-23T08:00:00Z");
const ZERO = { clicks: 0, impressions: 0, ctr: null, position: null };
const totals = (c: string, n: number) => ({ currency: c, totals: { orders: n, gross: "0.00", discounts: "0.00", netSales: `${n}0.00`, total: "0.00", refunded: "0.00" }, previous: {}, days: [] });
const MANAGER = new Set<string>(["brand.read", "analytics.read", "crm.read", "ads.read", "tasks.read"]);

beforeEach(() => {
  vi.clearAllMocks();
  clearSectionMemo();
  db.$queryRaw.mockResolvedValue([{ published: 2, scheduled: 1, awaitingApproval: 0 }]);
  db.dataSource.findFirst.mockResolvedValue({ syncedThrough: new Date("2026-11-20T00:00:00Z"), lastResult: null });
  vi.mocked(salesSummary).mockResolvedValue({ currencies: [totals("EUR", 3), totals("USD", 1)] } as never);
  vi.mocked(adsSummary).mockResolvedValue({ totals: [], previous: [], previousRange: WEEK, budget: null });
  vi.mocked(searchSummary).mockResolvedValue({ hasSite: true, daysIn: "America/Los_Angeles", range: WEEK, previousRange: WEEK, totals: { ...ZERO, impressions: 5 }, previous: ZERO, days: [] });
  vi.mocked(postsWithMetrics).mockResolvedValue([]);
});

describe("the digest's week", () => {
  it("is the Monday–Sunday that ended before today's week", () => {
    expect(endedWeek("2026-11-23")).toEqual(WEEK); // a Monday
    expect(endedWeek("2026-11-29")).toEqual(WEEK); // the Sunday after
  });

  it("a brand in Asia/Kolkata and one in Europe/Paris each use their own ended week", () => {
    const sundayEvening = new Date("2026-11-22T20:00:00Z"); // Monday 01:30 in Kolkata, still Sunday in Paris
    expect(endedWeek(zoneToday("Asia/Kolkata", sundayEvening))).toEqual(WEEK);
    expect(endedWeek(zoneToday("Europe/Paris", sundayEvening))).toEqual({ from: "2026-11-09", to: "2026-11-15" });
  });
});

describe("brandSections", () => {
  it("is computed once per brand and set of keys, again for another set", async () => {
    await brandSections(scope, MANAGER, WEEK, "UTC", NOW);
    await brandSections(scope, new Set([...MANAGER, "inbox.read"]), WEEK, "UTC", NOW); // inbox.read changes no shared section
    expect(salesSummary).toHaveBeenCalledTimes(1);
    await brandSections(scope, new Set(["brand.read", "analytics.read"]), WEEK, "UTC", NOW);
    expect(salesSummary).toHaveBeenCalledTimes(1);
    expect(searchSummary).toHaveBeenCalledTimes(2);
  });

  it("a viewer's keys give content, SEO and posts only", async () => {
    const kinds = (await brandSections(scope, new Set(["brand.read", "analytics.read", "tasks.read"]), WEEK, "UTC", NOW)).map((s) => s.kind);
    expect(kinds).toEqual(["content", "seo", "posts"]);
  });

  it("SEO reads the 7 complete days ending at the last synced day", async () => {
    const seo = (await brandSections(scope, MANAGER, WEEK, "UTC", NOW)).find((s) => s.kind === "seo");
    expect(searchSummary).toHaveBeenCalledWith(scope, { from: "2026-11-14", to: "2026-11-20" }, { manage: false });
    expect(seo).toMatchObject({ data: { range: { from: "2026-11-14", to: "2026-11-20" } } });
  });

  it("a never-synced source is No data yet (null), not 0", async () => {
    db.dataSource.findFirst.mockResolvedValue(null);
    const sections = await brandSections(scope, MANAGER, WEEK, "UTC", NOW);
    expect(sections.find((s) => s.kind === "sales")).toMatchObject({ data: null });
    expect(sections.find((s) => s.kind === "seo")).toMatchObject({ data: null });
    expect(salesSummary).not.toHaveBeenCalled();
  });

  it("two currencies stay apart", async () => {
    const sales = (await brandSections(scope, MANAGER, WEEK, "UTC", NOW)).find((s) => s.kind === "sales");
    expect(sales).toMatchObject({ data: [{ currency: "EUR", orders: 3, netSales: "30.00" }, { currency: "USD", orders: 1, netSales: "10.00" }] });
  });

  it("a failing section drops only itself", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(salesSummary).mockRejectedValue(new Error("boom"));
    const kinds = (await brandSections(scope, MANAGER, WEEK, "UTC", NOW)).map((s) => s.kind);
    expect(kinds).toEqual(["content", "seo", "posts", "ads"]);
  });
});

describe("refilterDigest", () => {
  const body: DigestBody = {
    brands: [
      {
        brandId: "b",
        brandName: "Old name",
        week: WEEK,
        sections: [
          { kind: "content", key: "brand.read", published: 1, scheduled: 0, awaitingApproval: 0 },
          { kind: "tasks", key: "tasks.read", crm: true, done: 1, open: 2, overdue: 0, overdueTitles: [] },
          { kind: "sales", key: "crm.read", data: [] },
        ],
      },
      { brandId: "gone", brandName: "Gone", week: WEEK, sections: [{ kind: "content", key: "brand.read", published: 1, scheduled: 0, awaitingApproval: 0 }] },
    ],
  };
  const access = (keys: string[]) => new Map([["b", { brandName: "B", perms: new Set(keys as PermissionKey[]), clientReviewer: false }]]);

  it("drops sections whose key was lost, brands no longer reached, and CRM-counted tasks without the keys", () => {
    expect(refilterDigest(body, access(["brand.read", "tasks.read", "crm.read", "inbox.read"])).brands.map((b) => [b.brandName, b.sections.map((s) => s.kind)])).toEqual([["B", ["content", "tasks", "sales"]]]);
    expect(refilterDigest(body, access(["brand.read", "tasks.read"])).brands[0]!.sections.map((s) => s.kind)).toEqual(["content"]);
  });
});
