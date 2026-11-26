import { afterEach, describe, expect, it, vi } from "vitest";
import { THROTTLE_RETRIES } from "@/server/catalog/shopify";
import { MAX_QUERY_COST, ORDER_FIELDS, ORDER_NODE_COST, ORDERS_PAGE, ORDERS_QUERY, fetchOrders, mapAskCartOrder, shippingTaxesOf } from "@/server/data/shopify-orders";

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
    expect(sentVariables(fetchMock.mock.calls[0])).toEqual({ after: null, query: "updated_at:>='2026-11-19T23:00:00.000Z'", sortKey: "UPDATED_AT" });
    expect(sentVariables(fetchMock.mock.calls[1]).after).toBe("c1");
  });

  it("history: created_at window and CREATED_AT through the one ORDERS_QUERY; bad days refused", async () => {
    const fetchMock = stubFetch({ body: page([REFUNDED], null) });
    const r = await fetchOrders(CONN, { createdFrom: "2025-01-01", createdTo: "2025-01-30" });
    expect(r.stoppedReason).toBeUndefined();
    expect(sentVariables(fetchMock.mock.calls[0])).toEqual({
      after: null, sortKey: "CREATED_AT", query: "created_at:>='2025-01-01T00:00:00Z' AND created_at:<'2025-01-31T00:00:00Z'",
    });
    await expect(fetchOrders(CONN, { createdFrom: "2025-01-01' OR x", createdTo: "2025-01-30" })).rejects.toThrow();
  });

  it("stops as partial when Shopify keeps throttling, keeping only finished pages", async () => {
    stubFetch({ body: page([REFUNDED], "c1") }, ...Array.from({ length: THROTTLE_RETRIES + 1 }, () => ({ body: throttled })));
    const { orders, cursorEnd, stoppedReason } = await fetchOrders(CONN, SINCE);
    expect(stoppedReason).toBe("rate_limited");
    expect(orders.map((o) => o.name)).toEqual(["#1001"]);
    expect(cursorEnd).toEqual(new Date("2026-11-21T09:00:00Z"));
  });

  it("a refused token returns reconnect and no orders", async () => {
    stubFetch({ body: page([REFUNDED], "c1") }, { status: 401, body: {} });
    expect(await fetchOrders(CONN, SINCE)).toEqual({ orders: [], cursorEnd: SINCE, stoppedReason: "reconnect" });
  });

  it("ACCESS_DENIED (no read_orders) is a missing scope, not a reconnect", async () => {
    stubFetch({ body: { errors: [{ message: "Access denied for orders field.", extensions: { code: "ACCESS_DENIED" } }] } });
    expect(await fetchOrders(CONN, SINCE)).toEqual({ orders: [], cursorEnd: SINCE, stoppedReason: "missing_scope" });
  });

  it("stops as capped after 50 pages, keeping them all", async () => {
    stubFetch(...Array.from({ length: 50 }, (_, i) => ({ body: page([{ ...REFUNDED, id: `gid://shopify/Order/${i}` }], `c${i}`) })));
    const { orders, stoppedReason } = await fetchOrders(CONN, SINCE);
    expect(stoppedReason).toBe("capped");
    expect(orders).toHaveLength(50);
  });

  it("stops as capped after 4 minutes, keeping the pages read", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(4 * 60_000 + 1);
    const fetchMock = stubFetch({ body: page([REFUNDED], "c1") }, { body: page([DISCOUNTED], null) });
    const { orders, cursorEnd, stoppedReason } = await fetchOrders(CONN, SINCE);
    expect(stoppedReason).toBe("capped");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(orders.map((o) => o.name)).toEqual(["#1001"]);
    expect(cursorEnd).toEqual(new Date("2026-11-21T09:00:00Z"));
  });

  it("never puts the token in a result or log, even when Shopify echoes it in errors[].message", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch({ body: { errors: [{ message: `Invalid API key or access token (unrecognized login or wrong password): ${TOKEN}` }] } });
    const r = await fetchOrders(CONN, SINCE);
    expect(r.stoppedReason).toBe("failed");
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify([r, error.mock.calls])).not.toContain(TOKEN);
  });

  it("a 5xx returns failed and no orders, without throwing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch({ body: page([REFUNDED], "c1") }, { status: 500, body: { errors: [{ message: "Internal error", extensions: { code: "INTERNAL_SERVER_ERROR" } }] } });
    expect(await fetchOrders(CONN, SINCE)).toEqual({ orders: [], cursorEnd: SINCE, stoppedReason: "failed" });
  });
});

describe("shipping tax (Task 2)", () => {
  const ship = (discounted: string, ...taxes: string[]) => ({ discountedPriceSet: money(discounted), taxLines: taxes.map((t) => ({ priceSet: money(t) })) });

  it("no customer field in ORDER_FIELDS: the allow-list is exactly this", () => {
    expect(ORDER_FIELDS.replace(/\s+/g, " ")).toBe(
      "id name processedAt cancelledAt test updatedAt taxesIncluded sourceName currentSubtotalPriceSet { shopMoney { amount currencyCode } } " +
      "currentTotalDiscountsSet { shopMoney { amount } } currentShippingPriceSet { shopMoney { amount } } currentTotalPriceSet { shopMoney { amount } } " +
      "totalRefundedSet { shopMoney { amount } } currentTaxLines { priceSet { shopMoney { amount } } } " +
      "shippingLines(first: 5) { nodes { discountedPriceSet { shopMoney { amount } } taxLines { priceSet { shopMoney { amount } } } } }",
    );
  });

  it("query cost constant under limit, and the page size follows it", () => {
    expect(2 + ORDERS_PAGE * ORDER_NODE_COST).toBeLessThanOrEqual(MAX_QUERY_COST);
    expect(ORDERS_PAGE).toBeGreaterThan(0);
    expect(ORDERS_QUERY).toContain(`orders(first: ${ORDERS_PAGE},`);
  });

  it("the shipping lines' tax, scaled by what is still charged; refunded shipping removes its tax", () => {
    expect(shippingTaxesOf([ship("10.00", "1.67")], money("10.00"))).toBe("1.67");
    expect(shippingTaxesOf([ship("10.00", "1.67")], money("5.00"))).toBe("0.84");
    expect(shippingTaxesOf([ship("6.00", "1.00"), ship("4.00", "0.50", "0.17")], money("10.00"))).toBe("1.67");
  });

  it("free shipping (charged 0) → 0, no division; no shipping line → 0; fully refunded order → 0", () => {
    expect(shippingTaxesOf([ship("0.00", "0.00")], money("0.00"))).toBe("0.00");
    expect(shippingTaxesOf([ship("0.00", "1.00")], money("0.00"))).toBe("0.00");
    expect(shippingTaxesOf([], money("0.00"))).toBe("0.00");
    expect(shippingTaxesOf([ship("10.00", "2.00")], money("0.00"))).toBe("0.00");
    expect(shippingTaxesOf([ship("10.00", "2.00")], null)).toBe("0.00");
  });

  it("never more than the lines' own tax; an unreadable amount → null (unknown, never 0)", () => {
    expect(shippingTaxesOf([ship("10.00", "2.00")], money("12.00"))).toBe("2.00");
    expect(shippingTaxesOf([ship("abc", "2.00")], money("10.00"))).toBeNull();
    expect(shippingTaxesOf([ship("10.00", "1e3")], money("10.00"))).toBeNull();
    expect(shippingTaxesOf([{ discountedPriceSet: null, taxLines: [] }], money("10.00"))).toBeNull();
    expect(shippingTaxesOf([{ discountedPriceSet: money("1.00"), taxLines: null }], money("10.00"))).toBeNull();
    expect(shippingTaxesOf(null, money("10.00"))).toBeNull();
  });

  it("token path: every order carries shippingTaxes from its shippingLines", async () => {
    stubFetch({ body: page([{ ...REFUNDED, shippingLines: { nodes: [ship("10.0", "1.67")] } }, FREE_SHIPPING], null) });
    const { orders } = await fetchOrders(CONN, SINCE);
    expect(orders[0].shippingTaxes).toBe("0.84");
    // A node without the field (not asked for): left out, so the stored value would stay.
    expect(orders[1]).not.toHaveProperty("shippingTaxes");
  });
});

describe("mapAskCartOrder: AskCart's optional line items and statuses", () => {
  const m = (amount: string, currencyCode = "EUR") => ({ amount, currencyCode });
  const ORDER = {
    id: "gid://shopify/Order/2001", name: "#2001", processedAt: "2026-11-20T10:00:00Z", createdAt: "2026-11-20T10:00:00Z",
    updatedAt: "2026-11-21T09:00:00Z", cancelledAt: null, test: false, taxesIncluded: true, sourceName: "web",
    currentSubtotalPriceSet: m("100.00"), currentTotalDiscountsSet: m("0.00"), currentShippingPriceSet: m("0.00"),
    currentTotalPriceSet: m("100.00"), totalRefundedSet: m("0.00"), currentTaxLines: [],
  };
  const LINE = {
    id: "gid://shopify/LineItem/1", title: "Oak table", variantTitle: "Large", sku: "OAK-L", quantity: 2, currentQuantity: 2,
    productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/11",
    originalUnitPriceSet: m("50.0"), discountedTotalSet: m("90.0"), discountedUnitPriceAfterAllDiscountsSet: m("40.5"),
  };

  it("AskCart shippingLines mapped: tax scaled by current ÷ discounted price; unreadable or null → null", () => {
    const line = (discounted: string, tax: string) => ({ title: "Colissimo", originalPriceSet: m("12.00"), discountedPriceSet: m(discounted), taxLines: [{ title: "TVA", rate: 0.2, priceSet: m(tax) }] });
    const order = (shippingLines: unknown, shipping = "10.00") => mapAskCartOrder({ ...ORDER, currentShippingPriceSet: m(shipping), shippingLines } as never)!;
    expect(order([line("10.00", "1.67")]).shippingTaxes).toBe("1.67");
    expect(order([line("10.00", "1.67")], "0.00").shippingTaxes).toBe("0.00");
    expect(order([]).shippingTaxes).toBe("0.00");
    expect(order([line("ten", "1.67")]).shippingTaxes).toBeNull();
    expect(order([{ ...line("10.00", "1.67"), taxLines: [{ priceSet: { amount: 1.67 } }] }]).shippingTaxes).toBeNull();
    expect(order(null).shippingTaxes).toBeNull();
    expect(order("x").shippingTaxes).toBeNull();
  });

  it("an order without the new fields leaves them undefined, so the stored lines and statuses are kept", () => {
    const row = mapAskCartOrder(ORDER as never)!;
    for (const k of ["lines", "lineItemsTruncated", "fulfillmentStatus", "financialStatus", "discountCodes", "shippingTaxes"]) expect(row).not.toHaveProperty(k);
  });

  it("maps line items, statuses and codes; amounts as exact fixed-2 strings", () => {
    const row = mapAskCartOrder({ ...ORDER, displayFulfillmentStatus: "FULFILLED", displayFinancialStatus: "PAID", discountCodes: ["XMAS", 7, "", "XMAS"], lineItems: [LINE], lineItemsTruncated: false } as never)!;
    expect(row).toMatchObject({ fulfillmentStatus: "FULFILLED", financialStatus: "PAID", discountCodes: ["XMAS"], lineItemsTruncated: false });
    expect(row.lines).toEqual([{
      lineShopifyId: "gid://shopify/LineItem/1", productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/11",
      title: "Oak table", variantTitle: "Large", sku: "OAK-L", quantity: 2, currentQuantity: 2, unitPrice: "50.00", discountedTotal: "90.00",
      netUnitPrice: "40.50", currency: "EUR",
    }]);
  });

  it("a status sent as null is kept as null (it clears); one not sent stays undefined (kept)", () => {
    const row = mapAskCartOrder({ ...ORDER, displayFinancialStatus: null } as never)!;
    expect(row.financialStatus).toBeNull();
    expect(row).not.toHaveProperty("fulfillmentStatus");
  });

  it("keeps a line without a product: no title (AskCart withholds it), amounts and quantities still there", () => {
    const row = mapAskCartOrder({ ...ORDER, lineItems: [{ ...LINE, title: null, variantTitle: null, productId: null, variantId: null }] } as never)!;
    expect(row.lines).toMatchObject([{ title: null, variantTitle: null, productId: null, quantity: 2, netUnitPrice: "40.50" }]);
    expect(row.lineItemsTruncated).toBe(false);
  });

  it("an AskCart that doesn't send the net unit price yet leaves it null", () => {
    const { discountedUnitPriceAfterAllDiscountsSet: _, ...old } = LINE;
    expect(mapAskCartOrder({ ...ORDER, lineItems: [old] } as never)!.lines![0].netUnitPrice).toBeNull();
  });

  it("an empty lineItems list replaces the stored lines with none", () => {
    expect(mapAskCartOrder({ ...ORDER, lineItems: [] } as never)).toMatchObject({ lines: [], lineItemsTruncated: false });
  });

  it("keeps a deleted product's line (null ids), a refunded line and a missing currentQuantity", () => {
    const row = mapAskCartOrder({ ...ORDER, lineItems: [
      { ...LINE, id: "gid://shopify/LineItem/2", productId: null, variantId: null, sku: null },
      { ...LINE, id: "gid://shopify/LineItem/3", quantity: 3, currentQuantity: 1 },
      { ...LINE, id: "gid://shopify/LineItem/4", currentQuantity: undefined },
    ] } as never)!;
    expect(row.lines!.map((l) => [l.productId, l.variantId, l.sku, l.quantity, l.currentQuantity])).toEqual([
      [null, null, null, 2, 2], ["gid://shopify/Product/1", "gid://shopify/ProductVariant/11", "OAK-L", 3, 1], ["gid://shopify/Product/1", "gid://shopify/ProductVariant/11", "OAK-L", 2, null],
    ]);
    expect(row.lineItemsTruncated).toBe(false);
  });

  it("passes AskCart's truncated flag through", () => {
    expect(mapAskCartOrder({ ...ORDER, lineItems: [LINE], lineItemsTruncated: true } as never)!.lineItemsTruncated).toBe(true);
  });

  it("skips a malformed line item (counted, not flagged truncated: a re-read can't fix it) instead of failing the order; a repeated id keeps its first", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const row = mapAskCartOrder({ ...ORDER, lineItems: [
      LINE,
      { ...LINE, id: "gid://shopify/LineItem/5", discountedTotalSet: m("12,50") },
      { ...LINE, id: "gid://shopify/LineItem/6", quantity: -1 },
      { ...LINE, id: undefined },
      { ...LINE, id: "gid://shopify/LineItem/7", originalUnitPriceSet: null },
      // more than 2 decimals (could round past numeric(14,2)), and an unreadable net price
      { ...LINE, id: "gid://shopify/LineItem/8", discountedTotalSet: m("999999999999.999") },
      { ...LINE, id: "gid://shopify/LineItem/9", discountedUnitPriceAfterAllDiscountsSet: m("abc") },
      null,
      { ...LINE, title: "Duplicate" },
    ] } as never)!;
    expect(row).not.toBeNull();
    expect(row.lines!.map((l) => l.title)).toEqual(["Oak table"]);
    expect(row.lineItemsTruncated).toBe(false);
    expect(row.linesSkipped).toBe(7);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("takes up to 4 decimals (KWD, an approximate net price), rounded half-up to 2", () => {
    const row = mapAskCartOrder({ ...ORDER, lineItems: [{
      ...LINE, originalUnitPriceSet: m("12.345", "KWD"), discountedTotalSet: m("24.6949", "KWD"), discountedUnitPriceAfterAllDiscountsSet: m("99999999999.9999", "KWD"),
    }] } as never)!;
    expect(row.lines![0]).toMatchObject({ unitPrice: "12.35", discountedTotal: "24.69", netUnitPrice: "100000000000.00", currency: "KWD" });
    expect(row.linesSkipped).toBeUndefined();
  });

  it("refuses a quantity past the int column and a currency that isn't a code", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const row = mapAskCartOrder({
      ...ORDER, currentSubtotalPriceSet: m("100.00", "eur<script>"),
      lineItems: [{ ...LINE, quantity: 2 ** 31 }, { ...LINE, id: "gid://shopify/LineItem/2", discountedTotalSet: m("1.00", "EURO") }],
    } as never)!;
    expect(row.currency).toBe("");
    expect(row.linesSkipped).toBe(1);
    expect(row.lines!.map((l) => l.currency)).toEqual([""]);
  });

  it("a non-array lineItems is treated as not sent", () => {
    expect(mapAskCartOrder({ ...ORDER, lineItems: null } as never)).not.toHaveProperty("lines");
  });
});
