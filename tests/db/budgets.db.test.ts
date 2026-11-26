import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ perms: new Set<string>(), brandId: "bu-a", userId: "u1" }));
vi.mock("@/server/api/brand-route", async () => {
  const { AccessDeniedError } = await import("@/server/auth/errors");
  return {
    authorizeBrandRoute: vi.fn(async (_r: Request, _p: unknown, key: string) => {
      if (!auth.perms.has(key)) throw new AccessDeniedError(`Missing permission ${key}`);
      return { userId: auth.userId, workspaceId: ws, brandId: auth.brandId, perms: auth.perms, clientReviewer: false };
    }),
  };
});
vi.mock("@/server/jobs/runner", () => ({ kickRunner: vi.fn() }));

import { prisma } from "@/server/db/prisma";
import { SYSTEM_ROLES } from "@/server/auth/permissions.catalog";
import { adsSummary } from "@/server/data/ads-read";
import { saveRates } from "@/server/data/fx";
import { GET as getBudgets, PUT } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/ads/budgets/route";
import { GET as summary } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/ads/summary/route";
import type { AdBudgetsDto } from "@/shared";

/** Budgets, pacing and shop revenue ÷ ad spend against Postgres, with the routes' permission rules. */
let ws: string;
const params = Promise.resolve({ workspaceId: "w", brandId: "b" });
const roleKeys = (slug: string) => new Set<string>(SYSTEM_ROLES.find((r) => r.slug === slug)!.permissions);
const MANAGER = () => roleKeys("manager");
const MONTH = "2026-10";

const put = (body: unknown) => PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body) }), { params });
const get = async (month = MONTH) => (await (await getBudgets(new Request(`http://x?month=${month}`), { params })).json()) as AdBudgetsDto;
async function adSource(externalId: string, syncedThrough: string | null, currency = "EUR", brandId = "bu-a") {
  return prisma.dataSource.create({
    data: { workspaceId: ws, brandId, kind: "META_ADS", externalId, settings: { currency }, syncedThrough: syncedThrough ? new Date(`${syncedThrough}T00:00:00Z`) : null },
  });
}
async function spend(day: string, amount: string, currency = "EUR", campaignId = "c1", brandId = "bu-a") {
  await prisma.adDay.create({
    data: { workspaceId: ws, brandId, platform: "META", accountId: "act_1", campaignId: `${campaignId}-${currency}`, campaignName: "C", day: new Date(`${day}T00:00:00Z`),
      currency, spend: amount, impressions: 1, clicks: 1, purchases: 0, purchaseValue: "0" },
  });
}
async function order(day: string, netSales: string, currency = "EUR") {
  await prisma.shopOrder.create({
    data: { workspaceId: ws, brandId: "bu-a", connectionId: "c", shopifyId: `o-${day}-${currency}-${netSales}`, name: "#1", processedAt: new Date(`${day}T10:00:00Z`), test: false,
      currency, netSales, discounts: "0", shipping: "0", taxes: "0", taxesIncluded: false, total: netSales, refunded: "0", shopifyUpdatedAt: new Date(`${day}T10:00:00Z`) },
  });
}

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-budgets" } })).id;
  for (const id of ["bu-a", "bu-b"]) {
    await prisma.brand.create({ data: { id, workspaceId: ws, slug: id, displayName: id } });
    await prisma.brandProfile.create({ data: { workspaceId: ws, brandId: id, websiteUrl: `https://${id}.test`, timeZone: "UTC" } });
  }
});
beforeEach(async () => {
  auth.perms = MANAGER();
  auth.brandId = "bu-a";
  auth.userId = "u1";
  await prisma.adBudget.deleteMany({});
  await prisma.adDay.deleteMany({});
  await prisma.dataSource.deleteMany({});
  await prisma.shopOrder.deleteMany({});
  await prisma.fxRate.deleteMany({});
  await prisma.rateLimitBucket.deleteMany({});
  await prisma.auditEvent.deleteMany({});
});

describe("PUT / GET ads/budgets", () => {
  it("sets a budget with an audit; amount 0 deletes it and audits cleared with the previous amount", async () => {
    expect((await put({ platform: "META", month: MONTH, amount: "3100", currency: "EUR" })).status).toBe(200);
    expect((await get()).budgets).toEqual([{ platform: "META", month: MONTH, amount: "3100.00", currency: "EUR", updatedAt: expect.any(String) }]);
    await put({ platform: "META", month: MONTH, amount: "2000.50", currency: "EUR" });
    expect((await put({ platform: "META", month: MONTH, amount: "0", currency: "EUR" })).status).toBe(200);
    expect((await get()).budgets).toEqual([]);
    const audits = await prisma.auditEvent.findMany({ where: { workspaceId: ws, entityType: "AdBudget" }, orderBy: { createdAt: "asc" } });
    expect(audits.map((a) => a.action)).toEqual(["ads.budget.set", "ads.budget.set", "ads.budget.cleared"]);
    expect(audits[1].metadata).toMatchObject({ amount: "2000.50", previousAmount: "3100.00", previousCurrency: "EUR" });
    expect(audits[2].metadata).toMatchObject({ amount: "0", previousAmount: "2000.50", previousCurrency: "EUR", platform: "META", month: MONTH });
  });

  it("bad amount, currency or month → 400 on PUT; a bad month → 400 on GET", async () => {
    for (const bad of [{ amount: "1e13" }, { amount: "0.001" }, { currency: "ZZZ" }, { currency: "JPY", amount: "10.5" }, { month: "2026-13" }, { month: "2024-01" }, { month: "2028-01" }]) {
      expect((await put({ platform: "META", month: MONTH, amount: "100", currency: "EUR", ...bad })).status).toBe(400);
    }
    for (const m of ["2026-13", "2024-01", "2028-01", "x"]) expect((await getBudgets(new Request(`http://x?month=${m}`), { params })).status).toBe(400);
  });

  it("400s count toward the 30-an-hour limit", async () => {
    for (let i = 0; i < 30; i++) expect((await put({ platform: "META", month: "bad", amount: "1", currency: "EUR" })).status).toBe(400);
    expect((await put({ platform: "META", month: MONTH, amount: "1", currency: "EUR" })).status).toBe(429);
    expect(await prisma.adBudget.count()).toBe(0);
  });

  it("client reviewer PUT → 403; commercial.manage without ads.read → 403; viewer GET → 403", async () => {
    auth.perms = roleKeys("client-reviewer");
    expect((await put({ platform: "META", month: MONTH, amount: "1", currency: "EUR" })).status).toBe(403);
    auth.perms = new Set([...MANAGER()].filter((k) => k !== "ads.read"));
    expect((await put({ platform: "META", month: MONTH, amount: "1", currency: "EUR" })).status).toBe(403);
    auth.perms = roleKeys("viewer");
    expect((await getBudgets(new Request(`http://x?month=${MONTH}`), { params })).status).toBe(403);
    expect(await prisma.adBudget.count()).toBe(0);
  });

  it("another brand's budget is never returned", async () => {
    auth.brandId = "bu-b";
    await put({ platform: "META", month: MONTH, amount: "500", currency: "EUR" });
    auth.brandId = "bu-a";
    expect((await get()).budgets).toEqual([]);
  });
});

describe("pacing", () => {
  // October: 31 days. 3,100 a month = 100 a day; synced through the 10th → 1,000 expected.
  const setMeta = (currency = "EUR", amount = "3100") => put({ platform: "META", month: MONTH, amount, currency });

  it.each([["1000", "on", 1], ["500", "under", 0.5], ["1500", "over", 1.5]] as const)("spend %s → %s", async (spent, status, ratio) => {
    await adSource("act_1", "2026-10-10");
    await spend("2026-10-05", spent);
    await spend("2026-10-12", "999", "EUR", "c2"); // after `through`: not counted
    await setMeta();
    expect((await get()).pacing).toEqual([{ platform: "META", state: "ok", through: "2026-10-10", spent: `${spent}.00`, expected: "1000.00", ratio, status, currency: "EUR", staleRateFrom: null }]);
  });

  it("no syncedThrough, or before the 1st → no data yet; no ad account → no data yet", async () => {
    await setMeta();
    expect((await get()).pacing[0]).toEqual({ platform: "META", state: "no_data" });
    await adSource("act_1", null);
    expect((await get()).pacing[0]).toEqual({ platform: "META", state: "no_data" });
    await prisma.dataSource.updateMany({ data: { syncedThrough: new Date("2026-09-30T00:00:00Z") } });
    expect((await get()).pacing[0]).toEqual({ platform: "META", state: "no_data" });
  });

  it("two accounts, one lagging → the lagging one's day is used; a month already over is clipped to its end", async () => {
    await adSource("act_1", "2026-11-20");
    await adSource("act_2", "2026-10-05");
    await setMeta();
    expect((await get()).pacing[0]).toMatchObject({ through: "2026-10-05", expected: "500.00" });
    await prisma.dataSource.updateMany({ data: { syncedThrough: new Date("2026-11-20T00:00:00Z") } });
    expect((await get()).pacing[0]).toMatchObject({ through: "2026-10-31", expected: "3100.00" });
  });

  it("INR spend vs EUR budget converted; no rate → no pacing", async () => {
    await adSource("act_1", "2026-10-10", "INR");
    await spend("2026-10-05", "10000", "INR");
    await setMeta();
    expect((await get()).pacing[0]).toEqual({ platform: "META", state: "no_rate" });
    await saveRates("INR", [{ day: "2026-10-02", perEur: "100" }]); // a Friday; Monday the 5th uses it
    expect((await get()).pacing[0]).toMatchObject({ state: "ok", spent: "100.00", ratio: 0.1, status: "under", staleRateFrom: null });
  });

  it("GOOGLE budget: shown, no pacing (spend arrives in Phase 3)", async () => {
    await put({ platform: "GOOGLE", month: MONTH, amount: "800", currency: "EUR" });
    const r = await get();
    expect(r.budgets.map((b) => b.platform)).toEqual(["GOOGLE"]);
    expect(r.pacing).toEqual([{ platform: "GOOGLE", state: "google_later" }]);
  });

  it("the default currency is the ad account's, else the shop's", async () => {
    await order("2026-10-01", "10", "USD");
    expect((await get()).defaultCurrency).toBe("USD");
    await adSource("act_1", null, "INR");
    expect((await get()).defaultCurrency).toBe("INR");
  });
});

describe("shop revenue ÷ ad spend", () => {
  const summaryAs = async (perms: Set<string>) => {
    auth.perms = perms;
    return (await summary(new Request("http://x?from=2026-10-01&to=2026-10-10"), { params })).json();
  };
  beforeEach(async () => {
    await adSource("act_1", "2026-10-10");
  });

  it("with crm.read: net ex-VAT revenue ÷ spend converted to the shop currency; absent without crm.read", async () => {
    await order("2026-10-03", "600");
    await spend("2026-10-03", "10000", "INR");
    await saveRates("INR", [{ day: "2026-10-01", perEur: "50" }]);
    // 10,000 INR / 50 = 200 EUR; 600 / 200 = 3
    expect((await summaryAs(MANAGER())).shopRevenueOverSpend).toEqual({ ratio: 3, currency: "EUR", why: null, staleRateFrom: null });
    expect(await summaryAs(new Set(["ads.read"]))).not.toHaveProperty("shopRevenueOverSpend");
  });

  it("adsSummary without opts (the digest's path) → no ratio", async () => {
    await order("2026-10-03", "600");
    await spend("2026-10-03", "100");
    expect(await adsSummary({ workspaceId: ws, brandId: "bu-a" }, { from: "2026-10-01", to: "2026-10-10" })).not.toHaveProperty("shopRevenueOverSpend");
  });

  it("null when nothing was spent, a rate is missing or the shop has two currencies", async () => {
    await order("2026-10-03", "600");
    expect((await summaryAs(MANAGER())).shopRevenueOverSpend).toMatchObject({ ratio: null, why: "no_spend" });
    await spend("2026-10-03", "100", "INR");
    expect((await summaryAs(MANAGER())).shopRevenueOverSpend).toMatchObject({ ratio: null, why: "no_rate" });
    await order("2026-10-04", "5", "USD");
    expect((await summaryAs(MANAGER())).shopRevenueOverSpend).toMatchObject({ ratio: null, why: "currencies" });
  });

  it("only the range's currencies count (not the previous period's); orders whose VAT couldn't be read → no figure", async () => {
    await order("2026-09-25", "5", "USD"); // the previous period only
    await order("2026-10-03", "600");
    await spend("2026-10-03", "200");
    expect((await summaryAs(MANAGER())).shopRevenueOverSpend).toMatchObject({ ratio: 3, currency: "EUR" });
    // A tax-included order written after the change without its shipping tax: left out of the ex-VAT sum.
    await prisma.shopOrder.create({
      data: { workspaceId: ws, brandId: "bu-a", connectionId: "c", shopifyId: "o-missing", name: "#2", processedAt: new Date("2026-10-04T10:00:00Z"), test: false,
        currency: "EUR", netSales: "100", discounts: "0", shipping: "5", taxes: "21", taxesIncluded: true, total: "105", refunded: "0", shopifyUpdatedAt: new Date("2026-10-04T10:00:00Z") },
    });
    expect((await summaryAs(MANAGER())).shopRevenueOverSpend).toMatchObject({ ratio: null, why: "vat_missing" });
  });

  it("spend of an ad account switched off doesn't count", async () => {
    await order("2026-10-03", "600");
    await spend("2026-10-03", "200");
    await prisma.adDay.create({
      data: { workspaceId: ws, brandId: "bu-a", platform: "META", accountId: "act_off", campaignId: "x", campaignName: "C", day: new Date("2026-10-03T00:00:00Z"),
        currency: "EUR", spend: "400", impressions: 1, clicks: 1, purchases: 0, purchaseValue: "0" },
    });
    await prisma.dataSource.create({ data: { workspaceId: ws, brandId: "bu-a", kind: "META_ADS", externalId: "act_off", status: "OFF", settings: { currency: "EUR" } } });
    expect((await summaryAs(MANAGER())).shopRevenueOverSpend).toMatchObject({ ratio: 3 });
  });
});
