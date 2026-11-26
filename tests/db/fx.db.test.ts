import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/jobs/runner", () => ({ kickRunner: vi.fn() }));

import { prisma } from "@/server/db/prisma";
import { saveRates, syncFxRates } from "@/server/data/fx";

/** fx.sync against Postgres: which currencies are read, the forward read, the one-currency back-fill, reruns. */
let ws: string;
const NOW = new Date("2026-11-26T03:00:00Z");
const HEADER = "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE";
type Call = { currency: string; from: string; to: string };
let calls: Call[];
let failing: Set<string>;

/** A fake ECB: one rate per weekday of the asked window, value 100 + day of month. */
const ecb = vi.fn(async (url: string | URL | Request) => {
  const u = new URL(String(url));
  const currency = u.pathname.split("/").pop()!.split(".")[1];
  const from = u.searchParams.get("startPeriod")!;
  const to = u.searchParams.get("endPeriod")!;
  calls.push({ currency, from, to });
  if (failing.has(currency)) return new Response("boom", { status: 503 });
  const lines = [HEADER];
  for (let d = Date.parse(`${from}T00:00:00Z`); d <= Date.parse(`${to}T00:00:00Z`); d += 86_400_000) {
    const day = new Date(d);
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    lines.push(`EXR.D.${currency}.EUR.SP00.A,D,${currency},EUR,SP00,A,${day.toISOString().slice(0, 10)},${100 + day.getUTCDate()}`);
  }
  return new Response(lines.join("\n"), { status: 200 });
});
const run = () => syncFxRates(NOW, ecb as unknown as typeof fetch);

async function adSource(brandId: string, externalId: string, currency: string) {
  return prisma.dataSource.create({ data: { workspaceId: ws, brandId, kind: "META_ADS", externalId, settings: { currency, reportsIn: "Asia/Kolkata" } } });
}
async function adDay(brandId: string, day: string, currency: string) {
  await prisma.adDay.create({
    data: { workspaceId: ws, brandId, platform: "META", accountId: "act_1", campaignId: `c-${day}`, campaignName: "C", day: new Date(`${day}T00:00:00Z`),
      currency, spend: "10.00", impressions: 1, clicks: 1, purchases: 0, purchaseValue: "0" },
  });
}

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-fx" } })).id;
  for (const id of ["fx-a", "fx-b"]) await prisma.brand.create({ data: { id, workspaceId: ws, slug: id, displayName: id } });
});
beforeEach(async () => {
  calls = [];
  failing = new Set();
  ecb.mockClear();
  await prisma.fxRate.deleteMany({});
  await prisma.adDay.deleteMany({});
  await prisma.shopOrder.deleteMany({});
  await prisma.dataSource.deleteMany({});
});

describe("fx.sync", () => {
  it("reads the ad accounts' and recent orders' currencies; EUR and currencies outside ECB_CURRENCIES never fetched", async () => {
    await adSource("fx-a", "act_1", "INR");
    await adSource("fx-a", "act_2", "EUR");
    await adSource("fx-b", "act_3", "XYZ");
    await prisma.dataSource.create({ data: { workspaceId: ws, brandId: "fx-b", kind: "SHOPIFY_ORDERS", externalId: "shop" } });
    const order = (id: string, currency: string, at: string) => prisma.shopOrder.create({
      data: { workspaceId: ws, brandId: "fx-b", connectionId: "c", shopifyId: id, name: id, processedAt: new Date(at), test: false, currency,
        netSales: "1", discounts: "0", shipping: "0", taxes: "0", taxesIncluded: true, total: "1", refunded: "0", shopifyUpdatedAt: new Date(at) },
    });
    await order("o1", "USD", "2026-11-20T00:00:00Z");
    await order("o2", "GBP", "2026-08-01T00:00:00Z"); // older than 60 days: not in use

    await run();
    expect([...new Set(calls.map((c) => c.currency))].sort()).toEqual(["INR", "USD"]);
    expect(calls.find((c) => c.currency === "INR")).toEqual({ currency: "INR", from: "2026-11-12", to: "2026-11-26" });
    expect(await prisma.fxRate.count({ where: { currency: "EUR" } })).toBe(0);
    expect(await prisma.fxRate.count({ where: { currency: "INR" } })).toBeGreaterThan(5);
  });

  it("one currency failing still saves the others", async () => {
    await adSource("fx-a", "act_1", "INR");
    await adSource("fx-b", "act_2", "USD");
    failing.add("INR");
    await run();
    expect(await prisma.fxRate.count({ where: { currency: "INR" } })).toBe(0);
    expect(await prisma.fxRate.count({ where: { currency: "USD" } })).toBeGreaterThan(0);
  });

  it("forward read starts a week before the newest rate held", async () => {
    await adSource("fx-a", "act_1", "INR");
    await saveRates("INR", [{ day: "2026-11-02", perEur: "100" }, { day: "2026-11-20", perEur: "101" }]);
    await run();
    expect(calls).toEqual([{ currency: "INR", from: "2026-11-13", to: "2026-11-26" }]);
  });

  it("older AdDay triggers a back-fill once, one currency per run", async () => {
    await adSource("fx-a", "act_1", "INR");
    await adSource("fx-b", "act_2", "USD");
    await adDay("fx-a", "2026-06-01", "INR");
    await adDay("fx-b", "2026-07-01", "USD");

    await run();
    const back = calls.filter((c) => c.from < "2026-11-01");
    expect(back).toEqual([{ currency: "INR", from: "2026-05-25", to: "2026-11-11" }]);
    const oldest = await prisma.fxRate.findFirst({ where: { currency: "INR" }, orderBy: { day: "asc" } });
    expect(oldest!.day.toISOString().slice(0, 10) <= "2026-06-01").toBe(true);

    calls = [];
    await run();
    expect(calls.filter((c) => c.from < "2026-11-01")).toEqual([{ currency: "USD", from: "2026-06-24", to: "2026-11-11" }]);
    calls = [];
    await run();
    expect(calls.filter((c) => c.from < "2026-11-01")).toEqual([]);
  });

  it("back-fill never reaches past 3 years", async () => {
    await adSource("fx-a", "act_1", "INR");
    await adDay("fx-a", "2020-01-06", "INR");
    await run();
    const back = calls.find((c) => c.from < "2026-11-01")!;
    expect(back.from).toBe("2023-11-27");
    calls = [];
    await run();
    expect(calls.filter((c) => c.from < "2026-11-01")).toEqual([]);
  });
});

describe("saveRates", () => {
  it("rerun same window → same rows; a corrected rate overwrites", async () => {
    const rates = [{ day: "2026-11-02", perEur: "106.4505" }, { day: "2026-11-03", perEur: "105.9155" }];
    await saveRates("INR", rates);
    await saveRates("INR", rates);
    const rows = await prisma.fxRate.findMany({ orderBy: { day: "asc" } });
    expect(rows.map((r) => [r.day.toISOString().slice(0, 10), r.perEur.toString()])).toEqual([["2026-11-02", "106.4505"], ["2026-11-03", "105.9155"]]);
    await saveRates("INR", [{ day: "2026-11-03", perEur: "106" }]);
    expect((await prisma.fxRate.findFirst({ where: { day: new Date("2026-11-03T00:00:00Z") } }))!.perEur.toString()).toBe("106");
    expect(await saveRates("EUR", rates)).toBe(0);
  });
});
