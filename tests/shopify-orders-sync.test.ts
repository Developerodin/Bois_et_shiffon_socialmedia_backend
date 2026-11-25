import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  fetchOrders: vi.fn(),
  fetchAskCartOrders: vi.fn(),
  executeRaw: vi.fn(async () => 0),
  queryRaw: vi.fn(async (): Promise<object[]> => []),
  markReconnect: vi.fn(async () => undefined),
}));
vi.mock("@/server/data/shopify-orders", async (orig) => ({ ...(await orig<object>()), fetchOrders: m.fetchOrders, fetchAskCartOrders: m.fetchAskCartOrders }));
vi.mock("@/server/shopify/askcart-token", () => ({ askCartToken: async () => "askcart_token" }));
vi.mock("@/server/db/prisma", () => {
  const prisma = { $executeRaw: m.executeRaw, $queryRaw: m.queryRaw, $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)) };
  return { prisma };
});
vi.mock("@/server/services/connections", async (orig) => ({ ...(await orig<object>()), accessToken: async () => "shpat_secret", markReconnect: m.markReconnect }));

import { Prisma, type IntegrationConnection } from "@prisma/client";
import type { ShopOrderRow } from "@/server/data/shopify-orders";
import { FIRST_RUN_DAYS, REFETCH_HOURS, syncShopifyOrders, upsertOrders } from "@/server/data/shopify-orders-sync";
import { prisma } from "@/server/db/prisma";
import { parseRange } from "@/shared";
import { ReconnectNeeded } from "@/server/services/connections";
import { ASKCART_KEY_REFUSED } from "@/server/shopify/askcart";

const conn = { id: "c1", externalAccountId: "shop.myshopify.com" } as IntegrationConnection;
const now = new Date("2026-11-23T12:00:00Z");
const order = (i: number): ShopOrderRow => ({
  shopifyId: `gid://shopify/Order/${i}`, name: `#${i}`, processedAt: now, cancelledAt: null, test: false, currency: "EUR",
  netSales: "10.00", discounts: "0.00", gross: "10.00", shipping: "0.00", taxes: "0.00", taxesIncluded: true, total: "10.00",
  refunded: "0.00", sourceName: "web", shopifyUpdatedAt: now,
});
const ctx = (cursor: string | null) => ({ source: { workspaceId: "w", brandId: "b", cursor }, connection: conn, signal: new AbortController().signal });
const cursorEnd = new Date("2026-11-23T11:00:00Z");

beforeEach(() => vi.clearAllMocks());

describe("syncShopifyOrders", () => {
  it("a first run reads the last 60 days; later runs from the saved cursor", async () => {
    m.fetchOrders.mockResolvedValue({ orders: [], cursorEnd });
    await syncShopifyOrders(ctx(null), now);
    expect(m.fetchOrders.mock.calls[0][1]).toEqual(new Date(now.getTime() - FIRST_RUN_DAYS * 86_400_000));
    expect(m.fetchOrders.mock.calls[0][0]).toEqual({ shop: "shop.myshopify.com", accessToken: "shpat_secret" });
    await syncShopifyOrders(ctx("2026-11-20T00:00:00.000Z"), now);
    expect(m.fetchOrders.mock.calls[1][1]).toEqual(new Date("2026-11-20T00:00:00.000Z"));
  });

  it("writes one statement per 100 orders and moves the cursor", async () => {
    m.fetchOrders.mockResolvedValue({ orders: Array.from({ length: 250 }, (_, i) => order(i)), cursorEnd });
    expect(await syncShopifyOrders(ctx(null), now)).toEqual({ count: 250, reason: null, cursor: cursorEnd.toISOString() });
    expect(m.executeRaw).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["capped", "partial"],
    ["rate_limited", "rate_limited"],
  ])("a %s stop still writes what was read and moves the cursor", async (stoppedReason, reason) => {
    m.fetchOrders.mockResolvedValue({ orders: [order(1)], cursorEnd, stoppedReason });
    expect(await syncShopifyOrders(ctx(null), now)).toEqual({ count: 1, reason, cursor: cursorEnd.toISOString() });
    expect(m.executeRaw).toHaveBeenCalledTimes(1);
  });

  it("a refused token marks the connection, writes nothing and throws ReconnectNeeded", async () => {
    m.fetchOrders.mockResolvedValue({ orders: [], cursorEnd, stoppedReason: "reconnect" });
    await expect(syncShopifyOrders(ctx(null), now)).rejects.toBeInstanceOf(ReconnectNeeded);
    expect(m.markReconnect).toHaveBeenCalledWith("c1", expect.any(String));
    expect(m.executeRaw).not.toHaveBeenCalled();
  });

  it("the token never reaches the SQL written", async () => {
    m.fetchOrders.mockResolvedValue({ orders: [order(1)], cursorEnd });
    await syncShopifyOrders(ctx(null), now);
    expect(JSON.stringify(m.executeRaw.mock.calls)).not.toContain("shpat_secret");
  });

  it("an AskCart connection reads through AskCart (no token) and a refusal says to reconnect AskCart", async () => {
    const askCart = { ...ctx(null), connection: { id: "c2", externalAccountId: "askcart" } as IntegrationConnection };
    m.fetchAskCartOrders.mockResolvedValueOnce({ orders: [order(1)], cursorEnd, stoppedReason: "rate_limited" });
    expect(await syncShopifyOrders(askCart, now)).toEqual({ count: 1, reason: "rate_limited", cursor: cursorEnd.toISOString() });
    expect(m.fetchAskCartOrders).toHaveBeenCalledWith("askcart_token", new Date(now.getTime() - FIRST_RUN_DAYS * 86_400_000), askCart.signal);
    expect(m.fetchOrders).not.toHaveBeenCalled();
    m.fetchAskCartOrders.mockRejectedValueOnce(new ReconnectNeeded("AskCart 401 unauthorized"));
    await expect(syncShopifyOrders(askCart, now)).rejects.toBeInstanceOf(ReconnectNeeded);
    expect(m.markReconnect).toHaveBeenCalledWith("c2", ASKCART_KEY_REFUSED);
  });
});

describe("upsertOrders: AskCart line items", () => {
  const scope = { workspaceId: "w", brandId: "b", connectionId: "c1" };
  const line = (id: string) => ({
    lineShopifyId: `gid://shopify/LineItem/${id}`, productId: null, variantId: null, title: "Oak", variantTitle: null, sku: null,
    quantity: 1, currentQuantity: 1, unitPrice: "10.00", discountedTotal: "10.00", netUnitPrice: "9.00", currency: "EUR",
  });
  // A raw call as one Prisma.Sql: a tagged template's (strings, ...values), or a prebuilt Sql passed as is.
  const sqlOf = (call: unknown[]) => (Array.isArray(call[0]) ? Prisma.sql(call[0] as unknown as TemplateStringsArray, ...call.slice(1)) : (call[0] as Prisma.Sql));
  const pageOf = (call: unknown[]) => JSON.parse(sqlOf(call).values.find((v): v is string => typeof v === "string" && v.startsWith("[{"))!);

  it("a page without line items is one statement, as before, with no line writes and the optional fields left out", async () => {
    await upsertOrders(scope, [order(1), order(2)]);
    expect(m.executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(m.queryRaw).not.toHaveBeenCalled();
    const sql = JSON.stringify(m.executeRaw.mock.calls[0]);
    expect(sql).not.toContain("ShopOrderLine");
    // left out of the JSON → NULL → the stored value is kept; the statuses say they weren't sent
    const sent = pageOf(m.executeRaw.mock.calls[0])[0];
    for (const k of ["fulfillment_status", "discount_codes", "line_items_truncated"]) expect(sent).not.toHaveProperty(k);
    expect(sent).toMatchObject({ fulfillment_sent: false, financial_sent: false });
  });

  it("a status sent as null is marked sent, so it clears the stored one", async () => {
    await upsertOrders(scope, [{ ...order(1), financialStatus: null }]);
    expect(pageOf(m.executeRaw.mock.calls[0])[0]).toMatchObject({ financial_status: null, financial_sent: true, fulfillment_sent: false });
  });

  it("replaces lines only for the orders the upsert actually wrote, in one transaction", async () => {
    m.queryRaw.mockResolvedValueOnce([{ shopifyId: "gid://shopify/Order/1" }, { shopifyId: "gid://shopify/Order/3" }]);
    const written = await upsertOrders(scope, [
      { ...order(1), lines: [line("a"), line("b")], lineItemsTruncated: false, discountCodes: ["XMAS"] },
      // older than stored: the upsert doesn't return it, so its lines stay as they are
      { ...order(2), lines: [line("c")] },
      // sent without line items: written, but its lines are kept
      order(3),
    ]);
    expect(written).toBe(2);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.$transaction).mock.calls[0][1]).toEqual({ timeout: 60_000, maxWait: 10_000 });
    expect(sqlOf(m.queryRaw.mock.calls[0]).sql).toMatch(/RETURNING "shopifyId"$/);
    expect(pageOf(m.queryRaw.mock.calls[0])[0]).toMatchObject({ discount_codes: ["XMAS"], line_items_truncated: false });
    const [del, ins] = m.executeRaw.mock.calls as unknown as unknown[][];
    expect(sqlOf(del).sql).toContain('DELETE FROM "ShopOrderLine"');
    expect(sqlOf(ins).sql).toContain('INSERT INTO "ShopOrderLine"');
    // Only order 1's lines are written: order 2 lost to a newer row, order 3 sent no lines.
    expect(pageOf(ins).map((l: { line_id: string; order_id: string }) => [l.order_id, l.line_id])).toEqual([
      ["gid://shopify/Order/1", "gid://shopify/LineItem/a"], ["gid://shopify/Order/1", "gid://shopify/LineItem/b"],
    ]);
    // ...and only the lines of order 1 that aren't among those sent are deleted
    expect(sqlOf(del).values).toContainEqual(["gid://shopify/Order/1"]);
    expect(sqlOf(del).values).toContainEqual(["gid://shopify/LineItem/a", "gid://shopify/LineItem/b"]);
  });

  it("writes an order's lines 2,000 at a time", async () => {
    m.queryRaw.mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => ({ shopifyId: `gid://shopify/Order/${i}` })));
    await upsertOrders(scope, Array.from({ length: 50 }, (_, i) => ({ ...order(i), lines: Array.from({ length: 100 }, (_, j) => line(`${i}-${j}`)) })));
    // one delete, then 5,000 lines in 3 statements
    expect(m.executeRaw).toHaveBeenCalledTimes(4);
    expect(m.executeRaw.mock.calls.slice(1).map((c) => pageOf(c as unknown[]).length)).toEqual([2000, 2000, 1000]);
  });

  it("writes no lines when the upsert wrote none of the orders that carried them", async () => {
    m.queryRaw.mockResolvedValueOnce([]);
    await upsertOrders(scope, [{ ...order(1), lines: [line("a")] }]);
    expect(m.executeRaw).not.toHaveBeenCalled();
  });
});

describe("syncShopifyOrders: orders AskCart sent with incomplete lines", () => {
  const askCart = { ...ctx(null), connection: { id: "c2", externalAccountId: "askcart" } as IntegrationConnection };

  it("holds the cursor at the earliest one, so the next run reads it again", async () => {
    m.fetchAskCartOrders.mockResolvedValueOnce({ orders: [order(1)], cursorEnd });
    m.queryRaw.mockResolvedValueOnce([{ at: "2026-11-23T09:30:00.000Z" }]);
    expect(await syncShopifyOrders(askCart, now)).toMatchObject({ cursor: "2026-11-23T09:30:00.000Z" });
  });

  it("never moves the cursor forward, and only looks back REFETCH_HOURS", async () => {
    m.fetchAskCartOrders.mockResolvedValueOnce({ orders: [order(1)], cursorEnd });
    m.queryRaw.mockResolvedValueOnce([{ at: "2026-11-23T11:30:00.000Z" }]);
    expect(await syncShopifyOrders(askCart, now)).toMatchObject({ cursor: cursorEnd.toISOString() });
    const since = new Date(now.getTime() - REFETCH_HOURS * 3_600_000).toISOString();
    expect(m.queryRaw.mock.calls[0]).toContain(since);
  });

  it("the pasted-token path doesn't look", async () => {
    m.fetchOrders.mockResolvedValueOnce({ orders: [order(1)], cursorEnd });
    expect(await syncShopifyOrders(ctx(null), now)).toMatchObject({ cursor: cursorEnd.toISOString() });
    expect(m.queryRaw).not.toHaveBeenCalled();
  });
});

describe("parseRange (sales, 366 days)", () => {
  it("takes real brand-local days, in order, up to a year", () => {
    expect(parseRange("2026-11-01", "2026-11-30", 366)).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(parseRange("2026-11-23", "2026-11-23", 366)).toEqual({ from: "2026-11-23", to: "2026-11-23" });
    expect(parseRange("2026-11-30", "2026-11-01", 366)).toBeNull();
    expect(parseRange("2026-02-30", "2026-03-01", 366)).toBeNull();
    expect(parseRange("2025-01-01", "2026-11-01", 366)).toBeNull();
    expect(parseRange(null, "2026-11-01", 366)).toBeNull();
    expect(parseRange("2026-11-01'", "2026-11-02", 366)).toBeNull();
  });
});
