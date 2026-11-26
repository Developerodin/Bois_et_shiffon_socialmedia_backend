import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The ads tools over a stubbed data layer: what they let through, refuse, clean and say. adsDays and liveSources
// are checked against a real Postgres in tests/db/ad-day.db.test.ts.
const perms = vi.hoisted(() => ({ set: new Set(["ads.read"]) }));
const data = vi.hoisted(() => ({
  liveSources: vi.fn(),
  adsDays: vi.fn(),
  adsCampaigns: vi.fn(),
  adsSummary: vi.fn(),
  shopRevenueOverSpend: vi.fn(),
  listBudgets: vi.fn(),
  listAlerts: vi.fn(),
  salesSummary: vi.fn(async () => ({ currencies: [] })),
}));

vi.mock("@/server/db/prisma", () => ({ prisma: {} }));
vi.mock("@/server/auth/permissions", () => ({ effectivePermissions: vi.fn(async () => perms.set) }));
vi.mock("@/server/services/audit-reports", () => ({ latestAuditReports: vi.fn() }));
vi.mock("@/server/services/context-docs", () => ({ CONTEXT_DOC_KINDS: [{ kind: "brand-voice" }], listContextDocs: vi.fn() }));
vi.mock("@/server/data/sales-read", () => ({ MAX_SALES_DAYS: 366, salesSummary: data.salesSummary }));
vi.mock("@/server/data/sources", async (orig) => ({ ...(await orig<object>()), liveSources: data.liveSources, brandTimeZone: async () => "Europe/Paris" }));
vi.mock("@/server/data/ads-read", async (orig) => ({
  ...(await orig<object>()),
  adsDays: data.adsDays,
  adsCampaigns: data.adsCampaigns,
  adsSummary: data.adsSummary,
  shopRevenueOverSpend: data.shopRevenueOverSpend,
}));
vi.mock("@/server/data/budgets", async (orig) => ({ ...(await orig<object>()), listBudgets: data.listBudgets }));
vi.mock("@/server/ads/alerts", () => ({ listAlerts: data.listAlerts }));

import { chatTools } from "@/server/chat/tools";
import { MAX_DATA_CALLS, MAX_GROUP_CALLS } from "@/server/chat/turn";

const scope = { workspaceId: "w1", brandId: "b1", userId: "u1" };
type AnyTool = { execute?: (input: never, o: never) => unknown; inputSchema: unknown };
const run = (t: AnyTool, input: object) =>
  t.execute!((t.inputSchema as { parse: (v: unknown) => never }).parse(input), {} as never) as Promise<Record<string, unknown>>;
const parse = (t: AnyTool, input: object) => (t.inputSchema as { safeParse: (v: unknown) => { success: boolean } }).safeParse(input).success;
const d = (v: string) => new Prisma.Decimal(v);
const range = { from: "2026-11-01", to: "2026-11-30" };
const ADS = ["adsSummary", "adCampaigns", "adBudgets"] as const;
const day = (day: string, currency: string, spend: string, extra: Partial<{ impressions: number; clicks: number; purchases: number; purchaseValue: string }> = {}) => ({
  day, currency, spend: d(spend), impressions: extra.impressions ?? 100, clicks: extra.clicks ?? 10, purchases: extra.purchases ?? 1, purchaseValue: d(extra.purchaseValue ?? "50"),
});
const campaign = (campaignId: string, accountId: string, spend: string, purchases: number, roas: number | null, name = `Campaign ${campaignId}`) => ({
  campaignId, accountId, campaignName: name, currency: "EUR", spend, purchases, purchaseValue: "0", roas, costPerPurchase: null, impressions: 10, clicks: 1,
});

beforeEach(() => {
  vi.clearAllMocks();
  perms.set = new Set(["ads.read"]);
  data.liveSources.mockResolvedValue({ externalIds: ["act_1"], syncedThrough: "2026-11-24", offCount: 0 });
  data.adsDays.mockResolvedValue([]);
  data.adsCampaigns.mockResolvedValue([]);
  data.listBudgets.mockResolvedValue({ month: "2026-11", budgets: [], pacing: [], defaultCurrency: "EUR" });
  data.shopRevenueOverSpend.mockResolvedValue({ ratio: 4.2, currency: "EUR", why: null, staleRateFrom: null });
  data.listAlerts.mockResolvedValue({ alerts: [], more: 0 });
});

const reads = () => [data.adsDays, data.adsCampaigns, data.listBudgets, data.shopRevenueOverSpend].some((f) => f.mock.calls.length);

describe("ads tools: access", () => {
  it.each(ADS)("%s refuses without ads.read and reads nothing", async (name) => {
    perms.set = new Set(["crm.read", "analytics.read"]);
    expect(await run(chatTools(scope)[name], {})).toEqual({ error: "Your role can't see ads." });
    expect(reads()).toBe(false);
  });

  it("revenuePerAdSpend needs both ads.read and crm.read", async () => {
    perms.set = new Set(["ads.read"]);
    expect(await run(chatTools(scope).revenuePerAdSpend, {})).toEqual({ error: "Your role can't see sales." });
    perms.set = new Set(["crm.read"]);
    expect(await run(chatTools(scope).revenuePerAdSpend, {})).toEqual({ error: "Your role can't see ads." });
    expect(reads()).toBe(false);
    perms.set = new Set(["ads.read", "crm.read"]);
    expect((await run(chatTools(scope).revenuePerAdSpend, {})).ratio).toBe(4.2);
  });

  it(`runs ${MAX_GROUP_CALLS} sales and 4 ads calls; the ${MAX_DATA_CALLS + 1}th data call is refused with the data limit`, async () => {
    perms.set = new Set(["ads.read", "crm.read"]);
    const tools = chatTools(scope);
    const outs = await Promise.all([
      ...Array.from({ length: MAX_GROUP_CALLS }, () => run(tools.salesSummary, range)),
      ...Array.from({ length: 5 }, () => run(tools.adsSummary, range)),
    ]);
    expect(outs.filter((o) => o.error === "Data tool limit reached for this message.")).toHaveLength(1);
    expect(data.adsDays).toHaveBeenCalledTimes(8); // four adsSummary calls, two reads each
  });

  it("refuses the 9th ads call made in parallel with the ads limit, and a refused call uses up nothing", async () => {
    perms.set = new Set(["ads.read", "crm.read"]);
    const tools = chatTools(scope);
    const outs = await Promise.all(Array.from({ length: MAX_GROUP_CALLS + 2 }, () => run(tools.adCampaigns, range)));
    expect(outs.filter((o) => o.error === "Ads tool limit reached for this message.")).toHaveLength(2);
    expect(data.adsCampaigns).toHaveBeenCalledTimes(MAX_GROUP_CALLS);
    // 8 data calls used: 4 more fit under the total, as the two refused calls used up nothing.
    const sales = await Promise.all(Array.from({ length: 5 }, () => run(tools.salesSummary, range)));
    expect(sales.map((o) => o.error ?? "ran")).toEqual(["ran", "ran", "ran", "ran", "Data tool limit reached for this message."]);
  });
});

describe("adsSummary", () => {
  it("never calls the Ads tab's reader, so the shop ratio can't leak in", async () => {
    perms.set = new Set(["ads.read", "crm.read"]);
    const out = await run(chatTools(scope).adsSummary, range);
    expect(data.adsSummary).not.toHaveBeenCalled();
    expect(data.shopRevenueOverSpend).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toContain("shopRevenueOverSpend");
  });

  it("makes two adsDays reads over the live accounts and folds totals per currency, two currencies kept apart", async () => {
    data.adsDays
      .mockResolvedValueOnce([day("2026-11-01", "EUR", "10.00", { purchases: 1, purchaseValue: "40" }), day("2026-11-01", "INR", "900.00"), day("2026-11-02", "EUR", "30.00", { purchases: 2, purchaseValue: "80" })])
      .mockResolvedValueOnce([day("2026-10-05", "EUR", "20.00")]);
    const out = await run(chatTools(scope).adsSummary, range);
    expect(data.adsDays).toHaveBeenNthCalledWith(1, scope, range, ["act_1"]);
    expect(data.adsDays).toHaveBeenNthCalledWith(2, scope, { from: "2026-10-02", to: "2026-10-31" }, ["act_1"]);
    expect(out.totals).toEqual([
      { currency: "EUR", spend: "40.00", purchases: 3, purchaseValue: "120.00", roas: 3, costPerPurchase: "13.33", impressions: 200, clicks: 20, ctr: 0.1, cpc: "2.00" },
      { currency: "INR", spend: "900.00", purchases: 1, purchaseValue: "50.00", roas: 0.06, costPerPurchase: "900.00", impressions: 100, clicks: 10, ctr: 0.1, cpc: "90.00" },
    ]);
    expect((out.previous as { currency: string }[]).map((t) => t.currency)).toEqual(["EUR"]);
    expect(out.currencyNote).toMatch(/never add currencies/);
    expect(out.alerts).toEqual({ columns: ["kind", "text", "day", "lastSeen", "open"], rows: [] });
    expect(out).not.toHaveProperty("alertsNote");
  });

  it("CTR and cost per click are null at zero", async () => {
    data.adsDays.mockResolvedValueOnce([day("2026-11-01", "EUR", "0", { impressions: 0, clicks: 0, purchases: 0, purchaseValue: "0" })]);
    const [t] = (await run(chatTools(scope).adsSummary, range)).totals as Record<string, unknown>[];
    expect(t).toMatchObject({ ctr: null, cpc: null, roas: null, costPerPurchase: null });
  });

  it("defaults to the 30 days ending at the slowest account's last synced day", async () => {
    data.liveSources.mockResolvedValue({ externalIds: ["act_1", "act_2"], syncedThrough: "2026-11-20", offCount: 0 });
    const out = await run(chatTools(scope).adsSummary, {});
    expect(out).toMatchObject({ from: "2026-10-22", to: "2026-11-20", syncedThrough: "2026-11-20" });
    expect(data.adsDays).toHaveBeenNthCalledWith(1, scope, { from: "2026-10-22", to: "2026-11-20" }, ["act_1", "act_2"]);
  });

  it("says Meta Ads isn't connected when no account has synced, also for a period given", async () => {
    data.liveSources.mockResolvedValue({ externalIds: [], syncedThrough: null, offCount: 0 });
    perms.set = new Set(["ads.read", "crm.read"]);
    const t = chatTools(scope);
    for (const name of ["adsSummary", "adCampaigns", "revenuePerAdSpend"] as const) {
      expect(await run(t[name], {})).toEqual({ note: "Meta Ads isn't connected or hasn't finished its first sync." });
      expect(await run(t[name], range)).toEqual({ note: "Meta Ads isn't connected or hasn't finished its first sync." });
    }
    expect(reads()).toBe(false);
  });

  it("lists days only up to 31 days", async () => {
    data.adsDays.mockResolvedValue([day("2026-11-01", "EUR", "10.00")]);
    const month = await run(chatTools(scope).adsSummary, { from: "2026-11-01", to: "2026-12-01" });
    expect(month.days).toEqual({ columns: ["day", "currency", "spend", "impressions", "clicks", "purchases", "roas"], rows: [["2026-11-01", "EUR", "10.00", 100, 10, 1, 5]] });
    expect(await run(chatTools(scope).adsSummary, { from: "2026-11-01", to: "2026-12-02" })).not.toHaveProperty("days");
  });

  it("names the ads maximum (366 days) in a bad-period refusal", async () => {
    expect((await run(chatTools(scope).adsSummary, { from: "2025-01-01", to: "2026-11-01" })).error).toContain("at most 366 days");
  });
});

describe("adsSummary: recent alerts", () => {
  it("lists the brand's alerts seen in the last 7 days, open ones flagged, with the note", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-26T10:00:00Z"));
    data.listAlerts.mockResolvedValue({
      alerts: [
        { id: "a1", kind: "SPEND_UP", accountId: "act_1", currency: "EUR", firstDay: "2026-11-25", lastDay: "2026-11-25", open: true, text: "Ad spend up 64% on act_1", values: {} },
        { id: "a2", kind: "NO_PURCHASES", accountId: "act_1", currency: "EUR", firstDay: "2026-11-20", lastDay: "2026-11-22", open: true, text: 'Campaign "Spring" spent…', values: {} },
      ],
      more: 3,
    });
    const out = await run(chatTools(scope).adsSummary, range);
    vi.useRealTimers();
    expect(data.listAlerts).toHaveBeenCalledWith({ workspaceId: "w1", brandId: "b1", userId: "u1" }, { recentFrom: "2026-11-19" }, 10);
    expect(out.alerts).toEqual({
      columns: ["kind", "text", "day", "lastSeen", "open"],
      rows: [["SPEND_UP", "Ad spend up 64% on act_1", "2026-11-25", "2026-11-25", true], ["NO_PURCHASES", 'Campaign "Spring" spent…', "2026-11-20", "2026-11-22", true]],
    });
    expect(out.moreAlerts).toBe(3);
    expect(out.alertsNote).toMatch(/3 days back/);
  });

  it("without ads.read the tool is refused and no alert is read", async () => {
    perms.set = new Set(["crm.read"]);
    expect(await run(chatTools(scope).adsSummary, range)).toEqual({ error: "Your role can't see ads." });
    expect(data.listAlerts).not.toHaveBeenCalled();
  });
});

describe("adCampaigns", () => {
  it("leaves a switched-off account's campaigns out and says so", async () => {
    data.liveSources.mockResolvedValue({ externalIds: ["act_1"], syncedThrough: "2026-11-24", offCount: 1 });
    data.adsCampaigns.mockResolvedValue([campaign("c1", "act_1", "10.00", 1, 2), campaign("c2", "act_off", "99.00", 5, 3)]);
    const out = await run(chatTools(scope).adCampaigns, range);
    expect((out.rows as unknown[][]).map((r) => r[0])).toEqual(["Campaign c1"]);
    expect(out.offNote).toBe("Switched-off ad accounts are left out.");
    data.adsDays.mockResolvedValue([]);
    expect((await run(chatTools(scope).adsSummary, range)).offNote).toBe("Switched-off ad accounts are left out.");
  });

  it("caps at 25 rows, counts the rest and cleans campaign names", async () => {
    data.adsCampaigns.mockResolvedValue(Array.from({ length: 70 }, (_, i) => campaign(`c${i}`, "act_1", `${100 - i}.00`, 1, 1, i ? `C${i}` : "Spring\nsale\u202e\u200bpromo")));
    const t = chatTools(scope);
    expect(parse(t.adCampaigns, { limit: 26 })).toBe(false);
    const out = await run(t.adCampaigns, { ...range, limit: 25 });
    expect(out.rows).toHaveLength(25);
    expect(out.moreCampaigns).toBe(45);
    expect((out.rows as unknown[][])[0][0]).toBe("Spring sale promo");
  });

  it("ranks by ROAS with nulls last", async () => {
    data.adsCampaigns.mockResolvedValue([campaign("a", "act_1", "1", 0, null), campaign("b", "act_1", "1", 1, 2), campaign("c", "act_1", "1", 1, 5)]);
    const out = await run(chatTools(scope).adCampaigns, { ...range, rankBy: "roas" });
    expect((out.rows as unknown[][]).map((r) => r[0])).toEqual(["Campaign c", "Campaign b", "Campaign a"]);
  });
});

describe("adBudgets", () => {
  it("refuses month 2026-13 before reading", async () => {
    expect((await run(chatTools(scope).adBudgets, { month: "2026-13" })).error).toMatch(/YYYY-MM/);
    expect(data.listBudgets).not.toHaveBeenCalled();
  });

  it("passes on a stale rate and the no-data state", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-26T10:00:00Z"));
    data.listBudgets.mockResolvedValue({
      month: "2026-11",
      budgets: [{ platform: "META", month: "2026-11", amount: "1000.00", currency: "EUR", updatedAt: "x" }, { platform: "GOOGLE", month: "2026-11", amount: "1.00", currency: "EUR", updatedAt: "x" }],
      pacing: [
        { platform: "META", state: "ok", through: "2026-11-24", spent: "900.00", expected: "800.00", ratio: 1.13, status: "over", currency: "EUR", staleRateFrom: "2026-11-10" },
        { platform: "GOOGLE", state: "google_later" },
      ],
      defaultCurrency: "EUR",
    });
    const out = await run(chatTools(scope).adBudgets, {});
    vi.useRealTimers();
    expect(data.listBudgets).toHaveBeenCalledWith(scope, "2026-11", { externalIds: ["act_1"], syncedThrough: "2026-11-24", offCount: 0 });
    expect(data.liveSources).toHaveBeenCalledTimes(1);
    expect(out.notes).toEqual(["Spend converted at ECB rates; uses a rate from 2026-11-10.", "Google Ads spend arrives in Phase 3."]);
    expect(out.budgets).toEqual([{ platform: "META", amount: "1000.00", currency: "EUR" }, { platform: "GOOGLE", amount: "1.00", currency: "EUR" }]);
  });
});

describe("revenuePerAdSpend", () => {
  beforeEach(() => {
    perms.set = new Set(["ads.read", "crm.read"]);
  });

  it("explains a missing ratio and a stale rate", async () => {
    data.shopRevenueOverSpend.mockResolvedValue({ ratio: null, currency: "EUR", why: "vat_missing", staleRateFrom: "2026-11-02" });
    const out = await run(chatTools(scope).revenuePerAdSpend, range);
    expect(data.shopRevenueOverSpend).toHaveBeenCalledWith(scope, range, ["act_1"]);
    expect(data.liveSources).toHaveBeenCalledTimes(1);
    expect(out.notes).toEqual([
      "Shop net sales without VAT ÷ Meta spend converted to EUR at the ECB daily rates.",
      "Shopify days and ad account days may differ by a few hours.",
      "Uses a rate from 2026-11-02.",
      "Some orders' VAT couldn't be read, so revenue would read low; no ratio given.",
    ]);
  });
});
