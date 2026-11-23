import { afterEach, describe, expect, it, vi } from "vitest";
import { ORDERS_QUERY, fetchOrders } from "@/server/data/shopify-orders";

// recorded 2026-11-23, Shopify Admin GraphQL (shape from docs)
const money = (amount: string, currencyCode = "EUR") => ({ shopMoney: { amount, currencyCode } });
// Refunded: 100.00 subtotal, 40.00 refunded → 60.00 net; VAT included; 5.00 shipping → 65.00 total.
const REFUNDED = {
  id: "gid://shopify/Order/1001", name: "#1001", processedAt: "2026-11-20T10:00:00Z", cancelledAt: null, test: false,
  updatedAt: "2026-11-21T09:00:00Z", taxesIncluded: true, sourceName: "web",
  currentSubtotalPriceSet: money("60.0"), currentTotalDiscountsSet: money("0.0"), currentShippingPriceSet: money("5.0"),
  currentTotalPriceSet: money("65.0"), totalRefundedSet: money("40.0"),
  currentTaxLines: [{ priceSet: money("10.0") }],
};
// Discounted: 90.00 list, 18.00 off → 72.00 net, 90.00 gross; VAT on top 12.00 + 2.40; 4.90 shipping → 91.30 total.
const DISCOUNTED = {
  id: "gid://shopify/Order/1002", name: "#1002", processedAt: "2026-11-21T23:30:00Z", cancelledAt: null, test: false,
  updatedAt: "2026-11-22T08:00:00Z", taxesIncluded: false, sourceName: null,
  currentSubtotalPriceSet: money("72.0"), currentTotalDiscountsSet: money("18.0"), currentShippingPriceSet: money("4.9"),
  currentTotalPriceSet: money("91.3"), totalRefundedSet: money("0.0"),
  currentTaxLines: [{ priceSet: money("12.0") }, { priceSet: money("2.4") }],
};
// Free shipping: 50.00 subtotal, shipping 5.00 waived by a free-shipping code → 0.00 shipping, 50.00 total. Shopify
// documents currentTotalDiscountsSet as order and line level discounts, so the waived shipping is not in it here.
const FREE_SHIPPING = {
  id: "gid://shopify/Order/1003", name: "#1003", processedAt: "2026-11-22T12:00:00Z", cancelledAt: null, test: false,
  updatedAt: "2026-11-22T12:00:00Z", taxesIncluded: true, sourceName: "web",
  currentSubtotalPriceSet: money("50.0"), currentTotalDiscountsSet: money("0.0"), currentShippingPriceSet: money("0.0"),
  currentTotalPriceSet: money("50.0"), totalRefundedSet: money("0.0"),
  currentTaxLines: [{ priceSet: money("8.33") }],
};
const COST = { requestedQueryCost: 10, actualQueryCost: 10, throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } };
const page = (nodes: unknown[], endCursor: string | null) => ({
  data: { orders: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes } },
  extensions: { cost: COST },
});
const throttled = { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: { cost: COST } };

const TOKEN = "shpat_secret_token_123";
const CONN = { shop: "my-store.myshopify.com", accessToken: TOKEN };
const SINCE = new Date("2026-11-20T00:00:00Z");

function stubFetch(...responses: { status?: number; body: unknown }[]) {
  const fetchMock = vi.fn();
  for (const r of responses) fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(r.body), { status: r.status ?? 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const sentVariables = (call: unknown[]) => JSON.parse((call[1] as { body: string }).body).variables;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchOrders", () => {
  it("query asks for none of the personal fields", () => {
    for (const banned of ["customer", "email", "shippingAddress", "billingAddress", "phone", "lineItems"]) {
      expect(ORDERS_QUERY.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it("maps a refunded and a discounted order to hand-computed net, gross and total", async () => {
    stubFetch({ body: page([REFUNDED, DISCOUNTED], null) });
    const { orders, cursorEnd, stoppedReason } = await fetchOrders(CONN, SINCE);
    expect(stoppedReason).toBeUndefined();
    expect(cursorEnd).toEqual(new Date("2026-11-22T08:00:00Z"));
    expect(orders[0]).toMatchObject({
      shopifyId: "gid://shopify/Order/1001", currency: "EUR", netSales: "60.00", discounts: "0.00", gross: "60.00",
      shipping: "5.00", taxes: "10.00", taxesIncluded: true, total: "65.00", refunded: "40.00",
    });
    expect(orders[1]).toMatchObject({
      netSales: "72.00", discounts: "18.00", gross: "90.00", shipping: "4.90", taxes: "14.40", taxesIncluded: false,
      total: "91.30", refunded: "0.00", processedAt: new Date("2026-11-21T23:30:00Z"),
    });
  });

  it("a free-shipping order: gross is merchandise only, shipping 0.00", async () => {
    stubFetch({ body: page([FREE_SHIPPING], null) });
    const { orders } = await fetchOrders(CONN, SINCE);
    expect(orders[0]).toMatchObject({ netSales: "50.00", discounts: "0.00", gross: "50.00", shipping: "0.00", taxes: "8.33", total: "50.00" });
  });

  it("filters from one hour before the cursor and follows endCursor across pages", async () => {
    const fetchMock = stubFetch({ body: page([REFUNDED], "c1") }, { body: page([DISCOUNTED], null) });
    const { orders, stoppedReason } = await fetchOrders(CONN, SINCE);
    expect(stoppedReason).toBeUndefined();
    expect(orders.map((o) => o.name)).toEqual(["#1001", "#1002"]);
    expect(sentVariables(fetchMock.mock.calls[0])).toEqual({ after: null, query: "updated_at:>='2026-11-19T23:00:00.000Z'" });
    expect(sentVariables(fetchMock.mock.calls[1]).after).toBe("c1");
  });

  it("stops as partial when Shopify keeps throttling, keeping only finished pages", async () => {
    stubFetch({ body: page([REFUNDED], "c1") }, ...Array.from({ length: 6 }, () => ({ body: throttled })));
    const { orders, cursorEnd, stoppedReason } = await fetchOrders(CONN, SINCE);
    expect(stoppedReason).toBe("rate_limited");
    expect(orders.map((o) => o.name)).toEqual(["#1001"]);
    expect(cursorEnd).toEqual(new Date("2026-11-21T09:00:00Z"));
  });

  it("a refused token returns reconnect and no orders", async () => {
    stubFetch({ body: page([REFUNDED], "c1") }, { status: 401, body: {} });
    expect(await fetchOrders(CONN, SINCE)).toEqual({ orders: [], cursorEnd: SINCE, stoppedReason: "reconnect" });
  });

  it("a 5xx returns failed and no orders, without throwing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch({ body: page([REFUNDED], "c1") }, { status: 500, body: { errors: [{ message: "Internal error", extensions: { code: "INTERNAL_SERVER_ERROR" } }] } });
    expect(await fetchOrders(CONN, SINCE)).toEqual({ orders: [], cursorEnd: SINCE, stoppedReason: "failed" });
  });
});
