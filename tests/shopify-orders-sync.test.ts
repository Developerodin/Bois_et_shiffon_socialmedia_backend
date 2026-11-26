import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  fetchOrders: vi.fn(),
  fetchAskCartOrders: vi.fn(),
  executeRaw: vi.fn(async () => 0),
  queryRaw: vi.fn(async (): Promise<object[]> => []),
  markReconnect: vi.fn(async () => undefined),
  grantedScopes: vi.fn(async (): Promise<{ name: string; scopes: string[] }> => ({ name: "Shop", scopes: ["read_orders"] })),
}));
vi.mock("@/server/catalog/shopify", async (orig) => ({ ...(await orig<object>()), grantedScopes: m.grantedScopes }));
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
// Scopes checked today: the token path's once-a-day read_all_orders check stays out of these tests.
const ctx = (cursor: string | null) => ({ source: { workspaceId: "w", brandId: "b", cursor, settings: { scopesCheckedAt: now.toISOString() } }, connection: conn, signal: new AbortController().signal });
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
    m.queryRaw.mockReset();
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

  it("an order AskCart sent incomplete, or with lines we skipped, keeps its other stored lines (no delete); its sent lines are still written", async () => {
    m.queryRaw.mockResolvedValueOnce([{ shopifyId: "gid://shopify/Order/1" }, { shopifyId: "gid://shopify/Order/2" }]);
    await upsertOrders(scope, [{ ...order(1), lines: [line("a")], lineItemsTruncated: true }, { ...order(2), lines: [line("b")], linesSkipped: 1 }]);
    expect(m.executeRaw).toHaveBeenCalledTimes(1);
    expect(sqlOf(m.executeRaw.mock.calls[0] as unknown[]).sql).toContain('INSERT INTO "ShopOrderLine"');
    expect(pageOf(m.executeRaw.mock.calls[0] as unknown[]).map((l: { line_id: string }) => l.line_id)).toEqual(["gid://shopify/LineItem/a", "gid://shopify/LineItem/b"]);
  });

  it("a line id twice in a page is written once (the last read), so the page can't fail", async () => {
    m.queryRaw.mockResolvedValueOnce([{ shopifyId: "gid://shopify/Order/1" }, { shopifyId: "gid://shopify/Order/2" }]);
    await upsertOrders(scope, [{ ...order(1), lines: [line("a")] }, { ...order(2), lines: [{ ...line("a"), quantity: 5 }] }]);
    const ins = m.executeRaw.mock.calls.at(-1) as unknown[];
    expect(pageOf(ins)).toEqual([expect.objectContaining({ line_id: "gid://shopify/LineItem/a", order_id: "gid://shopify/Order/2", quantity: 5 })]);
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

  it.each(["capped", "rate_limited"] as const)("a run that stopped %s moves the cursor on, never back to the held order", async (stoppedReason) => {
    m.fetchAskCartOrders.mockResolvedValueOnce({ orders: [order(1)], cursorEnd, stoppedReason });
    m.queryRaw.mockResolvedValue([{ at: "2026-11-23T09:30:00.000Z" }]);
    expect(await syncShopifyOrders(askCart, now)).toMatchObject({ cursor: cursorEnd.toISOString() });
    expect(m.queryRaw).not.toHaveBeenCalled();
    m.queryRaw.mockReset();
  });

  it("looks only at this connection's orders", async () => {
    m.fetchAskCartOrders.mockResolvedValueOnce({ orders: [], cursorEnd });
    await syncShopifyOrders(askCart, now);
    expect(m.queryRaw.mock.calls[0]).toContain("c2");
  });

  it("the job's deadline between write pages stops as partial, the cursor at the last page written", async () => {
    const ac = new AbortController();
    const orders = Array.from({ length: 150 }, (_, i) => ({ ...order(i), shopifyUpdatedAt: new Date(Date.parse("2026-11-20T00:00:00Z") + i * 60_000) }));
    m.fetchAskCartOrders.mockResolvedValueOnce({ orders, cursorEnd });
    m.executeRaw.mockImplementationOnce(async () => (ac.abort(), 0));
    m.queryRaw.mockResolvedValue([{ at: "2026-11-19T09:30:00.000Z" }]); // a held order earlier than every page
    const out = await syncShopifyOrders({ ...askCart, signal: ac.signal }, now);
    expect(out).toMatchObject({ count: 100, reason: "partial", cursor: orders[99].shopifyUpdatedAt.toISOString() });
    expect(m.executeRaw).toHaveBeenCalledTimes(1);
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

describe("syncShopifyOrders: order history past 60 days", () => {
  const askCart = { id: "c2", externalAccountId: "askcart" } as IntegrationConnection;
  const daily = (connection: IntegrationConnection, settings: object = {}, syncedThrough: Date | null = null) =>
    ({ source: { workspaceId: "w", brandId: "b", cursor: null, settings, syncedThrough }, connection, signal: new AbortController().signal });
  const history = (connection: IntegrationConnection) => ({ ...daily(connection), window: { from: "2025-01-01", to: "2025-01-14" } });

  it("AskCart warning → allOrders false and visibleSince saved, no plan", async () => {
    m.fetchAskCartOrders.mockResolvedValueOnce({ orders: [], cursorEnd, allOrders: false, visibleSince: "2026-09-25T00:00:00Z" });
    const out = await syncShopifyOrders(daily(askCart), now);
    expect(out.settings).toEqual({ set: { allOrders: false, visibleSince: "2026-09-25T00:00:00Z" } });
  });

  it("no warning → allOrders true and a 24-month plan of 14-day windows; an existing plan is left alone", async () => {
    m.fetchAskCartOrders.mockResolvedValueOnce({ orders: [], cursorEnd, allOrders: true });
    expect((await syncShopifyOrders(daily(askCart), now)).settings).toEqual({
      set: { allOrders: true, backfill: { start: "2024-11-23", end: "2026-11-22", days: 14 } }, unset: ["visibleSince"],
    });
    m.fetchAskCartOrders.mockResolvedValueOnce({ orders: [], cursorEnd, allOrders: true });
    const plan = { start: "2024-11-23", end: "2026-11-22", days: 14 };
    expect((await syncShopifyOrders(daily(askCart, { backfill: plan }), now)).settings).toEqual({ set: { allOrders: true }, unset: ["visibleSince"] });
  });

  it("a read that says nothing (rate limited and empty) saves nothing", async () => {
    m.fetchAskCartOrders.mockResolvedValueOnce({ orders: [], cursorEnd, stoppedReason: "rate_limited" });
    expect(await syncShopifyOrders(daily(askCart), now)).not.toHaveProperty("settings");
  });

  it("re-plan after a quiet stop: starts the day after the history already held", async () => {
    m.fetchAskCartOrders.mockResolvedValueOnce({ orders: [], cursorEnd, allOrders: true });
    const out = await syncShopifyOrders(daily(askCart, {}, new Date("2024-06-30T00:00:00Z")), now);
    expect(out.settings?.set?.backfill).toEqual({ start: "2024-07-01", end: "2026-11-22", days: 14 });
  });

  it("token path: plan only with read_all_orders, its scopes asked once a day", async () => {
    m.fetchOrders.mockResolvedValue({ orders: [], cursorEnd });
    m.grantedScopes.mockResolvedValueOnce({ name: "Shop", scopes: ["read_orders"] });
    expect((await syncShopifyOrders(daily(conn), now)).settings).toEqual({ set: { scopesCheckedAt: now.toISOString(), allOrders: false } });
    m.grantedScopes.mockResolvedValueOnce({ name: "Shop", scopes: ["read_orders", "read_all_orders"] });
    expect((await syncShopifyOrders(daily(conn), now)).settings).toEqual({
      set: { scopesCheckedAt: now.toISOString(), allOrders: true, backfill: { start: "2024-11-23", end: "2026-11-22", days: 30 } },
    });
    m.grantedScopes.mockClear();
    expect(await syncShopifyOrders(daily(conn, { scopesCheckedAt: new Date(now.getTime() - 3_600_000).toISOString() }), now)).not.toHaveProperty("settings");
    expect(m.grantedScopes).not.toHaveBeenCalled();
  });

  it("history window: AskCart createdFrom/createdTo; complete only without a stop; never a cursor (no follow-up)", async () => {
    m.fetchAskCartOrders.mockResolvedValueOnce({ orders: [order(1)], cursorEnd: new Date(0) });
    expect(await syncShopifyOrders(history(askCart), now)).toEqual({ count: 1, reason: null, complete: true });
    expect(m.fetchAskCartOrders).toHaveBeenCalledWith("askcart_token", { createdFrom: "2025-01-01", createdTo: "2025-01-14" }, expect.anything());
    m.fetchAskCartOrders.mockResolvedValueOnce({ orders: [order(1)], cursorEnd: new Date(0), stoppedReason: "capped" });
    expect(await syncShopifyOrders(history(askCart), now)).toEqual({ count: 1, reason: "partial", complete: false });
    m.fetchAskCartOrders.mockResolvedValueOnce({ orders: [], cursorEnd: new Date(0), stoppedReason: "rate_limited" });
    expect(await syncShopifyOrders(history(askCart), now)).toEqual({ count: 0, reason: "rate_limited", complete: false });
    m.fetchOrders.mockResolvedValueOnce({ orders: [order(2)], cursorEnd: new Date(0) });
    expect(await syncShopifyOrders(history(conn), now)).toEqual({ count: 1, reason: null, complete: true });
    expect(m.fetchOrders).toHaveBeenLastCalledWith(expect.anything(), { createdFrom: "2025-01-01", createdTo: "2025-01-14" }, expect.anything());
  });

  it("403 read_all_orders_pending → quiet stop: plan cleared, allOrders false, no reason", async () => {
    m.fetchAskCartOrders.mockResolvedValueOnce({ orders: [], cursorEnd: new Date(0), historyPending: true, visibleSince: "2026-09-25T00:00:00Z" });
    expect(await syncShopifyOrders(history(askCart), now)).toEqual({
      count: 0, reason: null, stopChain: true, settings: { set: { allOrders: false, visibleSince: "2026-09-25T00:00:00Z" }, unset: ["backfill"] },
    });
  });
});
