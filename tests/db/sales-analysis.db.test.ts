import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const read = vi.hoisted(() => ({ fetchAskCartOrders: vi.fn() }));
vi.mock("@/server/shopify/askcart-token", () => ({ askCartToken: async () => "token" }));
vi.mock("@/server/data/shopify-orders", async (orig) => ({ ...(await orig<object>()), fetchAskCartOrders: read.fetchAskCartOrders }));

import type { IntegrationConnection } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { mapAskCartOrder } from "@/server/data/shopify-orders";
import { syncShopifyOrders, upsertOrders } from "@/server/data/shopify-orders-sync";
import { productSales, salesBreakdown, stockRisk, topProducts, truncatedOrders } from "@/server/data/sales-analysis";
import { salesSummary } from "@/server/data/sales-read";
import { saveRows, shopifyRows } from "@/server/catalog/sync";
import { askCartVariants } from "@/server/shopify/askcart";

/**
 * The chat's sales analysis, the AskCart cursor hold and the catalogue's AskCart extras against Postgres: brand-local
 * days, net revenue, grouping, capping and privacy rules that only the real SQL can show.
 */
let ws: string;
const B = "sa-a";
const scope = () => ({ workspaceId: ws, brandId: B, connectionId: "c-sa" });
const m = (amount: string, currencyCode = "EUR") => ({ amount, currencyCode });
const order = (id: string, updatedAt: string, extra: Record<string, unknown> = {}) => mapAskCartOrder({
  id: `gid://shopify/Order/${id}`, name: `#${id}`, processedAt: "2026-11-20T10:00:00Z", createdAt: "2026-11-20T10:00:00Z", updatedAt,
  cancelledAt: null, test: false, taxesIncluded: true, sourceName: "web",
  currentSubtotalPriceSet: m("100.00"), currentTotalDiscountsSet: m("10.00"), currentShippingPriceSet: m("5.00"),
  currentTotalPriceSet: m("105.00"), totalRefundedSet: m("0.00"), currentTaxLines: [], ...extra,
} as never)!;
/** A line of variant `variant` (null: a custom line, no product and no title). */
const line = (id: string, variant: string | null, qty: number, total: string, extra: object = {}) => ({
  id: `gid://shopify/LineItem/${id}`, title: variant ? "Oak table" : null, variantTitle: variant ? "Large" : null, sku: variant ? `SKU-${variant}` : null,
  quantity: qty, currentQuantity: qty,
  productId: variant ? "gid://shopify/Product/1" : null, variantId: variant ? `gid://shopify/ProductVariant/${variant}` : null,
  originalUnitPriceSet: m("50.00"), discountedTotalSet: m(total), ...extra,
});
const range = { from: "2026-11-01", to: "2026-11-30" };
const brandScope = () => ({ workspaceId: ws, brandId: B });

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-sales-analysis" } })).id;
  await prisma.brand.create({ data: { id: B, workspaceId: ws, slug: B, displayName: B } });
  await prisma.brandProfile.create({ data: { workspaceId: ws, brandId: B, websiteUrl: "https://sa.test", timeZone: "Europe/Paris" } });
});
beforeEach(async () => {
  await prisma.shopOrderLine.deleteMany({});
  await prisma.shopOrder.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.product.createMany({
    data: [
      // Two collections titled "Sale": the product counts once under it.
      { workspaceId: ws, brandId: B, source: "SHOPIFY", externalId: "gid://shopify/ProductVariant/11", title: "Oak table — Large", price: "50", currency: "EUR", inStock: true, stockQuantity: 4, vendor: "Acme",
        collections: [{ id: "c1", title: "Tables", handle: "tables" }, { id: "c2", title: "Sale", handle: "sale" }, { id: "c3", title: "Sale", handle: "sale-2" }] },
      { workspaceId: ws, brandId: B, source: "SHOPIFY", externalId: "gid://shopify/ProductVariant/99", title: "Slow lamp", price: "20", currency: "EUR", inStock: true, stockQuantity: 300 },
    ],
  });
});

describe("sales analysis", () => {
  // 1: 23:30 UTC on 30 Nov is 1 Dec in Paris. 2: refunded line (2 ordered, 1 left at 40.00 net). 3: custom line and two
  // one-time codes. 4: a code shared with 2. 5: USD, flagged incomplete by AskCart.
  beforeEach(async () => {
    await upsertOrders(scope(), [
      order("1", "2026-12-01T00:00:00Z", { processedAt: "2026-11-30T23:30:00Z", lineItems: [line("x", "11", 1, "50.00")] }),
      order("2", "2026-11-21T00:00:00Z", { processedAt: "2026-11-02T10:00:00Z", discountCodes: ["SHARED"],
        lineItems: [line("a", "11", 2, "90.00", { currentQuantity: 1, discountedUnitPriceAfterAllDiscountsSet: m("40.00") })] }),
      order("3", "2026-11-21T00:00:00Z", { processedAt: "2026-11-10T10:00:00Z", discountCodes: ["ALICE-ONE-TIME", "BOB-ONE-TIME"],
        lineItems: [line("c", null, 3, "30.00")] }),
      order("4", "2026-11-21T00:00:00Z", { processedAt: "2026-11-24T10:00:00Z", discountCodes: ["SHARED"] }),
      order("5", "2026-11-21T00:00:00Z", { processedAt: "2026-11-25T10:00:00Z", sourceName: "pos",
        currentSubtotalPriceSet: m("20.00", "USD"), currentTotalPriceSet: m("20.00", "USD"), currentTotalDiscountsSet: m("0.00", "USD"),
        lineItems: [line("u", "11", 1, "20.00", { discountedTotalSet: m("20.00", "USD") })], lineItemsTruncated: true }),
    ]);
  });

  it("23:30 UTC on 30 Nov is a December sale in Paris", async () => {
    const nov = await salesSummary(brandScope(), range);
    expect(nov.currencies.map((c) => [c.currency, c.totals.orders])).toEqual([["EUR", 3], ["USD", 1]]);
    expect((await salesSummary(brandScope(), { from: "2026-12-01", to: "2026-12-01" })).currencies[0].totals.orders).toBe(1);
  });

  it("the monthly breakdown equals the Sales tab's totals", async () => {
    const s = await salesSummary(brandScope(), range);
    const b = await salesBreakdown(brandScope(), range, "month");
    for (const c of s.currencies) {
      expect(b.rows.find((r) => r[1] === c.currency)!.slice(2, 8)).toEqual([c.totals.orders, c.totals.gross, c.totals.discounts, c.totals.netSales, c.totals.total, c.totals.refunded]);
    }
  });

  it("revenue is net of refunds and every discount; lines without a product are one Other group", async () => {
    const top = await topProducts(brandScope(), range, "revenue", "product", 10);
    expect(top.rows).toEqual([
      ["Oak table", "EUR", 1, "40.00", 1],
      ["Other / custom items", "EUR", 3, "30.00", 1],
      ["Oak table", "USD", 1, "20.00", 1],
    ]);
  });

  it("collections: two with one title count once; a line not in the catalogue has its own group", async () => {
    const b = await salesBreakdown(brandScope(), range, "collection");
    expect(b.rows.filter((r) => r[1] === "EUR")).toEqual([
      ["Sale", "EUR", 1, 1, "40.00"],
      ["Tables", "EUR", 1, 1, "40.00"],
      ["(not in catalogue)", "EUR", 1, 3, "30.00"],
    ]);
    expect((await salesBreakdown(brandScope(), range, "vendor")).rows).toContainEqual(["Acme", "EUR", 1, 1, "40.00"]);
  });

  it("a code used on one order rolls into (other codes), the order counted once; codes never shown alone", async () => {
    const b = await salesBreakdown(brandScope(), range, "discountCode");
    expect(b.rows.map((r) => r.slice(0, 3))).toEqual(expect.arrayContaining([["SHARED", "EUR", 2], ["(other codes)", "EUR", 1]]));
    expect(JSON.stringify(b.rows)).not.toMatch(/ALICE|BOB/);
  });

  it("every currency shows when capped, and the hidden groups are counted", async () => {
    const b = await salesBreakdown(brandScope(), range, "day", 2);
    expect(new Set(b.rows.map((r) => r[1]))).toEqual(new Set(["EUR", "USD"]));
    expect(b.rows.length + b.moreGroups).toBe(4);
  });

  it("time groups keep the newest, shown oldest first", async () => {
    const b = await salesBreakdown(brandScope(), range, "day", 4);
    expect(b.rows.filter((r) => r[1] === "EUR").map((r) => r[0])).toEqual(["2026-11-10", "2026-11-24"]);
  });

  it("counts incomplete orders; productSales and stockRisk read the live catalogue", async () => {
    expect(await truncatedOrders(brandScope(), range)).toBe(1);
    const ps = await productSales(brandScope(), range, "oak");
    expect(ps.variants.find((v) => v.currency === "EUR")).toMatchObject({ title: "Oak table — Large", units: 1, in_catalogue: true, stock_quantity: 4 });
    expect((await productSales(brandScope(), range, "100%_")).variants).toEqual([]);
    // A line removed to quantity 0, read without a net price: revenue 0, never NULL (the tool formats it).
    await upsertOrders(scope(), [order("6", "2026-11-22T00:00:00Z", { lineItems: [line("z", "12", 0, "0.00")] })]);
    const zero = (await productSales(brandScope(), range, "")).variants.find((v) => v.units === 0);
    expect(zero && String(zero.revenue)).toBe("0");
    const sr = await stockRisk(brandScope(), range, 10);
    expect(sr.sellers.map((s) => s.title)).toContain("Other / custom items");
    expect(sr.slow[0]).toMatchObject({ title: "Slow lamp", units: 0 });
  });
});

describe("net sales without VAT (Task 2)", () => {
  const shipLine = (price: string, tax: string) => ({ title: "Colissimo", originalPriceSet: m(price), discountedPriceSet: m(price), taxLines: [{ title: "TVA", rate: 0.2, priceSet: m(tax) }] });
  // Tax-included: 120.00 items incl. 20.00 VAT, 6.00 shipping incl. 1.00 VAT → taxes 21.00, shippingTaxes 1.00.
  const incl = (id: string, processedAt: string, extra: Record<string, unknown> = {}) => order(id, "2026-11-21T00:00:00Z", {
    processedAt, currentSubtotalPriceSet: m("120.00"), currentShippingPriceSet: m("6.00"), currentTotalPriceSet: m("126.00"),
    currentTaxLines: [{ title: "TVA", rate: 0.2, priceSet: m("21.00") }], shippingLines: [shipLine("6.00", "1.00")], ...extra,
  });
  // Tax-excluded: 100.00 items, 5.00 shipping, 21.00 VAT on top.
  const excl = (id: string, processedAt: string) => order(id, "2026-11-21T00:00:00Z", {
    processedAt, taxesIncluded: false, currentSubtotalPriceSet: m("100.00"), currentShippingPriceSet: m("5.00"), currentTotalPriceSet: m("126.00"),
    currentTaxLines: [{ title: "TVA", rate: 0.2, priceSet: m("21.00") }], shippingLines: [shipLine("5.00", "1.00")],
  });
  /** As if read by the code before shippingTaxes existed: no value, written before SHIPPING_TAXES_SINCE. */
  const readBefore = (id: string) => prisma.$executeRaw`
    UPDATE "ShopOrder" SET "shippingTaxes" = NULL, "updatedAt" = '2026-11-25 23:59:00' WHERE "shopifyId" = ${`gid://shopify/Order/${id}`}`;
  const eur = async (r = range) => (await salesSummary(brandScope(), r)).currencies.find((c) => c.currency === "EUR")!;

  it("tax-included order: VAT comes off (item VAT only, shipping tax was never in netSales); tax-excluded order untouched", async () => {
    await upsertOrders(scope(), [incl("v1", "2026-11-05T10:00:00Z"), excl("v2", "2026-11-06T10:00:00Z")]);
    expect((await prisma.shopOrder.findFirst({ where: { shopifyId: "gid://shopify/Order/v1" } }))!.shippingTaxes!.toFixed(2)).toBe("1.00");
    // 120 − (21 − 1) = 100; + 100
    expect(await eur()).toMatchObject({ netExVat: "200.00", exVatFrom: null, exVatMissing: 0, totals: { netSales: "220.00" } });
  });

  it("pre-change rows → exVatFrom the day after the last of them; only later orders counted", async () => {
    await upsertOrders(scope(), [incl("v1", "2026-11-05T10:00:00Z"), incl("v2", "2026-11-08T10:00:00Z"), incl("v3", "2026-11-12T10:00:00Z"), excl("v4", "2026-11-10T10:00:00Z")]);
    await readBefore("v1");
    await readBefore("v2");
    // A tax-excluded row read before the change doesn't matter: its netSales has no VAT.
    await readBefore("v4");
    expect(await eur()).toMatchObject({ netExVat: "200.00", exVatFrom: "2026-11-09", exVatMissing: 0 });
  });

  it("exVatFrom only looks inside the range", async () => {
    await upsertOrders(scope(), [incl("v1", "2026-10-20T10:00:00Z"), incl("v2", "2026-11-12T10:00:00Z")]);
    await readBefore("v1");
    expect(await eur()).toMatchObject({ netExVat: "100.00", exVatFrom: null });
  });

  it("an old row on the range's last day leaves no ex-VAT figure", async () => {
    await upsertOrders(scope(), [incl("v1", "2026-11-30T10:00:00Z")]);
    await readBefore("v1");
    expect(await eur()).toMatchObject({ netExVat: null, exVatFrom: "2026-12-01", exVatMissing: 0 });
  });

  it("null after SHIPPING_TAXES_SINCE (lines sent unreadable) → counted in exVatMissing, exVatFrom unchanged", async () => {
    await upsertOrders(scope(), [incl("v1", "2026-11-05T10:00:00Z", { shippingLines: [shipLine("6.00", "x")] }), incl("v2", "2026-11-12T10:00:00Z")]);
    expect(await eur()).toMatchObject({ netExVat: "100.00", exVatFrom: null, exVatMissing: 1 });
  });

  it("unreadable history row (old shopifyUpdatedAt, written now) → exVatMissing, exVatFrom unchanged", async () => {
    await upsertOrders(scope(), [
      order("h1", "2025-01-10T00:00:00Z", { processedAt: "2026-11-03T10:00:00Z", currentTaxLines: [{ title: "TVA", rate: 0.2, priceSet: m("21.00") }], shippingLines: null }),
      incl("v2", "2026-11-12T10:00:00Z"),
    ]);
    expect(await eur()).toMatchObject({ netExVat: "100.00", exVatFrom: null, exVatMissing: 1 });
  });

  it("upsert fills shippingTaxes on re-read", async () => {
    await upsertOrders(scope(), [incl("v1", "2026-11-05T10:00:00Z")]);
    await readBefore("v1");
    expect((await eur()).exVatFrom).toBe("2026-11-06");
    await upsertOrders(scope(), [incl("v1", "2026-11-05T10:00:00Z")]);
    expect(await eur()).toMatchObject({ netExVat: "100.00", exVatFrom: null });
  });
});

describe("syncShopifyOrders: re-reading orders AskCart sent incomplete", () => {
  it("holds the cursor at a recent one, not at one with 100 lines, an old one or another connection's", async () => {
    const now = new Date("2026-11-23T12:00:00Z");
    const many = Array.from({ length: 100 }, (_, i) => line(`m${i}`, "11", 1, "1.00"));
    await upsertOrders(scope(), [
      order("1", "2026-11-23T08:00:00Z", { lineItems: [line("a", "11", 1, "45.00")], lineItemsTruncated: true }),
      order("2", "2026-11-23T07:00:00Z", { lineItems: many, lineItemsTruncated: true }),
      order("3", "2026-11-22T07:00:00Z", { lineItems: [line("b", "11", 1, "45.00")], lineItemsTruncated: true }),
    ]);
    await upsertOrders({ ...scope(), connectionId: "other" }, [order("4", "2026-11-23T06:00:00Z", { lineItems: [line("d", "11", 1, "1.00")], lineItemsTruncated: true })]);
    read.fetchAskCartOrders.mockResolvedValue({ orders: [], cursorEnd: new Date("2026-11-23T11:00:00Z") });
    const conn = { id: "c-sa", externalAccountId: "askcart" } as IntegrationConnection;
    const out = await syncShopifyOrders({ source: { workspaceId: ws, brandId: B, cursor: null }, connection: conn, signal: new AbortController().signal }, now);
    expect(out.cursor).toBe("2026-11-23T08:00:00.000Z");
  });
});

describe("catalogue: AskCart's vendor, tags and collections", () => {
  const product = (extra: object) => ({
    id: "gid://shopify/Product/1", title: "Oak table", handle: "oak", onlineStoreUrl: null, productType: "Tables", description: "", status: "ACTIVE", featuredImageUrl: null,
    variants: [{ id: "gid://shopify/ProductVariant/11", sku: "SKU-11", title: "Large", price: m("55.00"), compareAtPrice: null, inventoryQuantity: 4, availableForSale: true }],
    ...extra,
  });
  const save = (extra: object) =>
    prisma.$transaction((tx) => saveRows(tx, brandScope(), "SHOPIFY", { rows: shopifyRows(askCartVariants(product(extra) as never), "EUR"), complete: false }));
  const stored = () => prisma.product.findFirstOrThrow({ where: { externalId: "gid://shopify/ProductVariant/11" }, select: { vendor: true, tags: true, collections: true } });

  it("writes sent extras sorted, keeps them when not sent, clears them when sent empty; reordering isn't a change", async () => {
    await save({ vendor: "Maker", tags: ["oak", "new", ""], collections: [{ id: "c9", title: "New in", handle: "new-in" }, { id: "c1", title: "A", handle: "a" }, { title: "no id" }] });
    const sent = { vendor: "Maker", tags: ["new", "oak"], collections: [{ id: "c1", title: "A", handle: "a" }, { id: "c9", title: "New in", handle: "new-in" }] };
    expect(await stored()).toEqual(sent);
    expect((await save({ vendor: "Maker", tags: ["oak", "new"], collections: [{ id: "c9", title: "New in", handle: "new-in" }, { id: "c1", title: "A", handle: "a" }] })).updated).toBe(0);
    await save({});
    expect(await stored()).toEqual(sent);
    await save({ vendor: null, tags: [], collections: [] });
    expect(await stored()).toEqual({ vendor: null, tags: [], collections: [] });
  });
});
