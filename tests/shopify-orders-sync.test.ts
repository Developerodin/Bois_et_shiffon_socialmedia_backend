import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  fetchOrders: vi.fn(),
  fetchAskCartOrders: vi.fn(),
  executeRaw: vi.fn(async () => 0),
  markReconnect: vi.fn(async () => undefined),
}));
vi.mock("@/server/data/shopify-orders", async (orig) => ({ ...(await orig<object>()), fetchOrders: m.fetchOrders, fetchAskCartOrders: m.fetchAskCartOrders }));
vi.mock("@/server/shopify/askcart-token", () => ({ askCartToken: async () => "askcart_token" }));
vi.mock("@/server/db/prisma", () => ({ prisma: { $executeRaw: m.executeRaw } }));
vi.mock("@/server/services/connections", async (orig) => ({ ...(await orig<object>()), accessToken: async () => "shpat_secret", markReconnect: m.markReconnect }));

import type { IntegrationConnection } from "@prisma/client";
import type { ShopOrderRow } from "@/server/data/shopify-orders";
import { FIRST_RUN_DAYS, syncShopifyOrders } from "@/server/data/shopify-orders-sync";
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
