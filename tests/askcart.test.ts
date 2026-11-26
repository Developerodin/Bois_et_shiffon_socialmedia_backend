import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Waits return at once (Retry-After values are checked on the calls, not by waiting them out).
vi.mock("node:timers/promises", async (orig) => {
  const real = await orig<typeof import("node:timers/promises")>();
  return { ...real, setTimeout: vi.fn((_ms: number, value?: unknown, opts?: object) => real.setTimeout(0, value, opts)) };
});

vi.mock("@/server/db/prisma", () => ({ prisma: {} }));
vi.mock("@/server/jobs/queue", () => ({ enqueueJob: vi.fn() }));

import { sameRow, shopifyRows } from "@/server/catalog/sync";
import { fetchAskCartOrders } from "@/server/data/shopify-orders";
import { ReconnectNeeded } from "@/server/services/reconnect-needed";
import {
  ASKCART_KEY_REFUSED, ASKCART_REFUSED, ASKCART_SCOPE_MISSING, AskCartError, isAskCartStoreLapsed, askCartCatalog, askCartConfig, askCartVariants, askCartOrders, askCartReason, askCartRequest, askCartRevoke,
  askCartShop, askCartTokenRequest, isAskCart,
} from "@/server/shopify/askcart";

// Shapes from the AskCart repo's docs/partner-api.md (2026-11-24).
const SECRET = "askcart_partner_secret_xyz";
const money = (amount: string) => ({ amount, currencyCode: "INR" });
const ORDER = {
  id: "gid://shopify/Order/1001", name: "#1001", processedAt: "2026-11-02T10:00:00Z", createdAt: "2026-11-02T10:00:00Z",
  updatedAt: "2026-11-03T10:00:00Z", cancelledAt: null, test: false, taxesIncluded: true, sourceName: "web",
  currentSubtotalPriceSet: money("100.00"), currentTotalDiscountsSet: money("10.00"), currentShippingPriceSet: money("5.00"),
  currentTotalPriceSet: money("95.00"), totalRefundedSet: money("0.00"),
  currentTaxLines: [{ title: "GST", rate: 0.18, priceSet: money("14.49") }, { title: "Cess", rate: 0.01, priceSet: money("0.51") }],
  shippingLines: [{ title: "Standard", originalPriceSet: money("5.00"), discountedPriceSet: money("5.00"), taxLines: [] }],
};
const order = (id: number, updatedAt: string) => ({ ...ORDER, id: `gid://shopify/Order/${id}`, name: `#${id}`, updatedAt });
const PRODUCT = {
  id: "gid://shopify/Product/1", title: "Linen shirt", handle: "linen-shirt", onlineStoreUrl: "https://store.example/products/linen-shirt",
  productType: "Shirt", description: "Plain text description.", status: "ACTIVE", featuredImageUrl: "https://cdn.shopify.com/a.jpg",
  variants: [
    { id: "gid://shopify/ProductVariant/11", sku: "LS-M", title: "M", price: money("499.00"), compareAtPrice: money("599.00"), inventoryQuantity: 7, availableForSale: true },
    { id: "gid://shopify/ProductVariant/12", sku: null, title: "Default Title", price: money("499.5"), compareAtPrice: null, inventoryQuantity: null, availableForSale: false },
  ],
};
const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({ items, nextCursor: null, complete: true, ...extra });

type Res = { status?: number; body: unknown; headers?: Record<string, string> };
function stubFetch(...responses: Res[]) {
  const fetchMock = vi.fn();
  for (const r of responses) {
    fetchMock.mockResolvedValueOnce(new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers }));
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const urlOf = (call: unknown[]) => new URL(call[0] as string);
const error = (status: number, code: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>): Res => ({ status, body: { error: code, ...extra }, headers });

beforeEach(() => {
  vi.stubEnv("ASKCART_URL", "https://askcart.test/");
  vi.stubEnv("ASKCART_SECRET", SECRET);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Every error a call throws, with the secret checked absent from its message. */
async function thrown(p: Promise<unknown>) {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(Error);
  expect((e as Error).message).not.toContain(SECRET);
  return e as Error;
}

describe("askCartGet", () => {
  it("sends the secret as a Bearer header, refuses redirects and returns the body", async () => {
    const f = stubFetch({ body: { name: "B&C", currencyCode: "INR" } });
    expect(await askCartShop(SECRET)).toEqual({ name: "B&C", currencyCode: "INR" });
    expect(urlOf(f.mock.calls[0]).toString()).toBe("https://askcart.test/api/partner/shop");
    const init = f.mock.calls[0][1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(init.redirect).toBe("error");
  });

  it("without ASKCART_URL or ASKCART_SECRET calls nothing", async () => {
    vi.stubEnv("ASKCART_SECRET", "");
    const f = stubFetch();
    expect(await thrown(askCartShop(SECRET))).toMatchObject({ code: "not_configured" });
    expect(f).not.toHaveBeenCalled();
  });

  it.each([
    [error(401, "unauthorized"), ASKCART_KEY_REFUSED],
    [error(503, "store_not_connected", {}, { "retry-after": "60" }), ASKCART_REFUSED],
    [error(403, "insufficient_scope", { scope: "read:orders" }), ASKCART_SCOPE_MISSING],
  ])("%j → ReconnectNeeded with a readable reason", async (res, reason) => {
    stubFetch(res);
    const e = await thrown(askCartShop(SECRET));
    expect(e).toBeInstanceOf(ReconnectNeeded);
    expect(askCartReason(e)).toBe(reason);
  });

  it("503 store_reconnect_needed is temporary: an AskCartError (our token stays valid), not ReconnectNeeded, and not waited on", async () => {
    const f = stubFetch(error(503, "store_reconnect_needed", {}, { "retry-after": "5" }));
    const e = await thrown(askCartShop(SECRET));
    expect(e).not.toBeInstanceOf(ReconnectNeeded);
    expect(isAskCartStoreLapsed(e)).toBe(true);
    expect(f).toHaveBeenCalledOnce();
  });

  it("429 waits Retry-After and retries, then succeeds", async () => {
    const f = stubFetch(error(429, "rate_limited", {}, { "retry-after": "0" }), { body: { name: "B&C", currencyCode: "INR" } });
    expect(await askCartShop(SECRET)).toMatchObject({ name: "B&C" });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("429 or shopify_throttled still there after two retries → rateLimited AskCartError", async () => {
    const f = stubFetch(...Array.from({ length: 3 }, () => error(503, "shopify_throttled", {}, { "retry-after": "0" })));
    expect(await thrown(askCartShop(SECRET))).toMatchObject({ rateLimited: true, status: 503 });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("a Retry-After longer than 30 s isn't waited for", async () => {
    const f = stubFetch(error(429, "rate_limited", {}, { "retry-after": "120" }));
    expect(await thrown(askCartShop(SECRET))).toMatchObject({ rateLimited: true, status: 429 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("403 read_all_orders_pending carries visibleSince; 502 and 400 are plain errors", async () => {
    stubFetch(error(403, "read_all_orders_pending", { visibleSince: "2026-09-25T00:00:00Z" }), error(502, "upstream_error"), error(400, "one_mode_only"));
    expect(await thrown(askCartShop(SECRET))).toMatchObject({ status: 403, code: "read_all_orders_pending", visibleSince: "2026-09-25T00:00:00Z" });
    expect(await thrown(askCartShop(SECRET))).toMatchObject({ status: 502, code: "upstream_error", rateLimited: false });
    expect(await thrown(askCartShop(SECRET))).toMatchObject({ status: 400, code: "one_mode_only" });
  });

  it("an HTML error page or a non-JSON 200 never reaches the message", async () => {
    stubFetch({ status: 500, body: "<html>secret stuff</html>" }, { body: "not json" });
    expect((await thrown(askCartShop(SECRET))).message).toBe("AskCart 500");
    expect(await thrown(askCartShop(SECRET))).toMatchObject({ status: 502, code: "bad_body" });
  });

  it("a body over 10 MB is refused", async () => {
    stubFetch({ body: "x".repeat(10_000_001) });
    expect(await thrown(askCartRequest("shop", { bearer: SECRET }))).toMatchObject({ code: "too_large" });
  });
});

describe("askCartOrders", () => {
  it("sends exactly one mode, and the cursor with the same filters", async () => {
    const f = stubFetch({ body: page([]) }, { body: page([]) });
    await askCartOrders(SECRET, { updatedSince: new Date("2026-11-01T00:00:00Z") }, null);
    await askCartOrders(SECRET, { createdFrom: "2026-10-01", createdTo: "2026-10-31" }, "abc");
    expect(Object.fromEntries(urlOf(f.mock.calls[0]).searchParams)).toEqual({ updatedSince: "2026-11-01T00:00:00.000Z" });
    expect(Object.fromEntries(urlOf(f.mock.calls[1]).searchParams)).toEqual({ createdFrom: "2026-10-01", createdTo: "2026-10-31", cursor: "abc" });
  });
});

describe("fetchAskCartOrders", () => {
  const SINCE = new Date("2026-11-02T00:00:00Z");

  it("maps an order to the ShopOrder row the token path writes", async () => {
    const f = stubFetch({ body: page([ORDER]) });
    const { orders, cursorEnd, stoppedReason } = await fetchAskCartOrders(SECRET, SINCE);
    expect(stoppedReason).toBeUndefined();
    expect(urlOf(f.mock.calls[0]).searchParams.get("updatedSince")).toBe("2026-11-01T23:00:00.000Z"); // 1 h overlap
    expect(orders).toEqual([{
      shopifyId: "gid://shopify/Order/1001", name: "#1001", processedAt: new Date("2026-11-02T10:00:00Z"), cancelledAt: null, test: false,
      currency: "INR", netSales: "100.00", discounts: "10.00", gross: "110.00", shipping: "5.00", taxes: "15.00", taxesIncluded: true,
      total: "95.00", refunded: "0.00", sourceName: "web", shopifyUpdatedAt: new Date("2026-11-03T10:00:00Z"),
    }]);
    expect(cursorEnd).toEqual(new Date("2026-11-03T10:00:00Z"));
  });

  it("walks the cursor, keeps an order seen twice once, and logs the read_all_orders warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = stubFetch(
      { body: page([order(1, "2026-11-03T10:00:00Z"), order(2, "2026-11-04T10:00:00Z")], { complete: false, nextCursor: "c1", warning: { code: "read_all_orders_pending", visibleSince: "2026-09-25T00:00:00Z" } }) },
      { body: page([order(2, "2026-11-04T10:00:00Z"), order(3, "2026-11-05T10:00:00Z")]) },
    );
    const { orders, cursorEnd, stoppedReason } = await fetchAskCartOrders(SECRET, SINCE);
    expect(stoppedReason).toBeUndefined();
    expect(orders.map((o) => o.name)).toEqual(["#1", "#2", "#3"]);
    expect(cursorEnd).toEqual(new Date("2026-11-05T10:00:00Z"));
    expect(Object.fromEntries(urlOf(f.mock.calls[1]).searchParams)).toEqual({ updatedSince: "2026-11-01T23:00:00.000Z", cursor: "c1" });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns orders oldest update first, an order re-read with a newer update moving to its new place", async () => {
    stubFetch(
      { body: page([order(1, "2026-11-03T10:00:00Z"), order(2, "2026-11-04T10:00:00Z")], { complete: false, nextCursor: "c1" }) },
      { body: page([order(1, "2026-11-05T10:00:00Z"), order(3, "2026-11-04T12:00:00Z")]) },
    );
    const { orders } = await fetchAskCartOrders(SECRET, SINCE);
    expect(orders.map((o) => o.name)).toEqual(["#2", "#3", "#1"]);
  });

  it("a page AskCart cut short (rateLimited) is normal: it waits the page's Retry-After and resumes from nextCursor", async () => {
    vi.mocked(sleep).mockClear();
    const f = stubFetch(
      { body: page([order(1, "2026-11-03T10:00:00Z")], { complete: false, nextCursor: "c1", rateLimited: true }), headers: { "retry-after": "5" } },
      // an empty partial page: nothing read, so the same cursor is asked again
      { body: page([], { complete: false, nextCursor: null, rateLimited: true }), headers: { "retry-after": "2" } },
      { body: page([order(2, "2026-11-04T10:00:00Z")]) },
    );
    const { orders, stoppedReason } = await fetchAskCartOrders(SECRET, SINCE);
    expect(stoppedReason).toBeUndefined();
    expect(orders.map((o) => o.name)).toEqual(["#1", "#2"]);
    // waited exactly what each page said (the sleep is stubbed to return at once)
    expect(vi.mocked(sleep).mock.calls.map((c) => c[0])).toEqual([5_000, 2_000]);
    expect(urlOf(f.mock.calls[1]).searchParams.get("cursor")).toBe("c1");
    expect(urlOf(f.mock.calls[2]).searchParams.get("cursor")).toBe("c1");
  });

  it("a Retry-After of 0 still waits a second", async () => {
    vi.mocked(sleep).mockClear();
    stubFetch(
      { body: page([order(1, "2026-11-03T10:00:00Z")], { complete: false, nextCursor: "c1", rateLimited: true }), headers: { "retry-after": "0" } },
      { body: page([]) },
    );
    await fetchAskCartOrders(SECRET, SINCE);
    expect(vi.mocked(sleep).mock.calls.map((c) => c[0])).toEqual([1_000]);
  });

  it("a Retry-After over 30 s stops as rate_limited with the orders read so far", async () => {
    stubFetch({ body: page([order(1, "2026-11-03T10:00:00Z")], { complete: false, nextCursor: "c1", rateLimited: true }), headers: { "retry-after": "31" } });
    const { orders, cursorEnd, stoppedReason } = await fetchAskCartOrders(SECRET, SINCE);
    expect(stoppedReason).toBe("rate_limited");
    expect(orders).toHaveLength(1);
    expect(cursorEnd).toEqual(new Date("2026-11-03T10:00:00Z"));
  });

  it("a 429 after the retries keeps the earlier pages", async () => {
    stubFetch(
      { body: page([order(1, "2026-11-03T10:00:00Z")], { complete: false, nextCursor: "c1" }) },
      error(429, "rate_limited", {}, { "retry-after": "120" }),
    );
    const { orders, stoppedReason } = await fetchAskCartOrders(SECRET, SINCE);
    expect(stoppedReason).toBe("rate_limited");
    expect(orders).toHaveLength(1);
  });

  it.each([error(401, "unauthorized"), error(403, "insufficient_scope"), error(503, "store_not_connected")])(
    "%j throws ReconnectNeeded for the caller to mark the connection",
    async (res) => {
      stubFetch({ body: page([order(1, "2026-11-03T10:00:00Z")], { complete: false, nextCursor: "c1" }) }, res);
      expect(await thrown(fetchAskCartOrders(SECRET, SINCE))).toBeInstanceOf(ReconnectNeeded);
    },
  );

  it.each([
    [error(403, "access_denied"), "missing_scope"],
    [error(502, "upstream_error"), "failed"],
    [error(404, "not_found"), "failed"],
  ])("%j → %s with no orders", async (res, reason) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch({ body: page([order(1, "2026-11-03T10:00:00Z")], { complete: false, nextCursor: "c1" }) }, res);
    expect(await fetchAskCartOrders(SECRET, SINCE)).toEqual({ orders: [], cursorEnd: SINCE, stoppedReason: reason });
  });

  it("an order without its totals stops the run as failed, nothing written", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch({ body: page([order(1, "2026-11-03T10:00:00Z"), { ...ORDER, currentTotalPriceSet: null }]) });
    expect(await fetchAskCartOrders(SECRET, SINCE)).toEqual({ orders: [], cursorEnd: SINCE, stoppedReason: "failed" });
  });

  it("a network failure is failed, not a crash", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    expect(await fetchAskCartOrders(SECRET, SINCE)).toMatchObject({ orders: [], stoppedReason: "failed" });
  });
});

describe("askCartCatalog", () => {
  it("maps products to the rows the token path writes, complete only on AskCart's complete", async () => {
    const f = stubFetch({ body: page([PRODUCT], { complete: false, nextCursor: "p1" }) }, { body: page([{ ...PRODUCT, id: "gid://shopify/Product/2", variants: [] }]) });
    const { variants, currency, complete } = await askCartCatalog(SECRET, null, 5000);
    expect(complete).toBe(true);
    expect(urlOf(f.mock.calls[1]).searchParams.get("cursor")).toBe("p1");
    expect(shopifyRows(variants, currency)).toEqual([
      {
        externalId: "gid://shopify/ProductVariant/11", sku: "LS-M", title: "Linen shirt — M", url: "https://store.example/products/linen-shirt",
        category: "Shirt", description: "Plain text description.", price: "499.00", compareAtPrice: "599.00", currency: "INR",
        inStock: true, stockQuantity: 7, imageUrl: "https://cdn.shopify.com/a.jpg",
      },
      {
        externalId: "gid://shopify/ProductVariant/12", sku: null, title: "Linen shirt", url: "https://store.example/products/linen-shirt",
        category: "Shirt", description: "Plain text description.", price: "499.50", compareAtPrice: null, currency: "INR",
        inStock: false, stockQuantity: null, imageUrl: "https://cdn.shopify.com/a.jpg",
      },
    ]);
  });

  it("carries AskCart's vendor, tags and collections onto every variant's row, cleaned; absent keys stay out", async () => {
    const extras = {
      vendor: " Atelier ", tags: ["linen", "", 3, "linen", "summer"],
      collections: [{ id: "gid://shopify/Collection/1", title: "Shirts", handle: "shirts" }, { id: "gid://shopify/Collection/2" }, null, { id: "c3", title: "Sale" }],
    };
    stubFetch({ body: page([{ ...PRODUCT, ...extras }]) });
    const { variants, currency } = await askCartCatalog(SECRET, null, 5000);
    for (const row of shopifyRows(variants, currency)) {
      expect(row).toMatchObject({
        vendor: "Atelier", tags: ["linen", "summer"],
        collections: [{ id: "c3", title: "Sale", handle: null }, { id: "gid://shopify/Collection/1", title: "Shirts", handle: "shirts" }],
      });
    }
    stubFetch({ body: page([{ ...PRODUCT, vendor: null, tags: null, collections: "x" }]) });
    const again = await askCartCatalog(SECRET, null, 5000);
    expect(shopifyRows(again.variants, again.currency)[0]).toMatchObject({ vendor: null, tags: [], collections: [] });
  });

  it("sameRow compares tags and collections by value (jsonb reorders object keys)", () => {
    const [row] = shopifyRows(askCartVariants({ ...PRODUCT, tags: ["a"], collections: [{ id: "c1", title: "T", handle: "t" }] } as never), "INR");
    const stored = { ...row, archivedAt: null, collections: [{ handle: "t", id: "c1", title: "T" }], price: "499.0", compareAtPrice: "599" };
    expect(sameRow(stored, row)).toBe(true);
    expect(sameRow({ ...stored, tags: ["a", "b"] }, row)).toBe(false);
    // a row without the extras (another source, or an AskCart that doesn't send them) doesn't compare them
    const plain = shopifyRows(askCartVariants(PRODUCT as never), "INR")[0];
    expect(sameRow({ ...stored, vendor: "X", tags: ["z"] }, plain)).toBe(true);
  });

  it("counts (and logs) products AskCart sent without all their variants", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch({ body: page([{ ...PRODUCT, variantsTruncated: true }, { ...PRODUCT, id: "gid://shopify/Product/2", variants: [] }]) });
    expect(await askCartCatalog(SECRET, null, 5000)).toMatchObject({ complete: true, truncated: 1 });
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("orders tags and collections, so AskCart's order never counts as a change", () => {
    const rows = (tags: string[], ids: string[]) =>
      shopifyRows(askCartVariants({ ...PRODUCT, tags, collections: ids.map((id) => ({ id, title: id, handle: id })) } as never), "INR")[0];
    expect(rows(["b", "a"], ["c2", "c1"])).toMatchObject({ tags: ["a", "b"], collections: [{ id: "c1" }, { id: "c2" }] });
    expect(sameRow({ ...rows(["a", "b"], ["c1", "c2"]), archivedAt: null }, rows(["b", "a"], ["c2", "c1"]))).toBe(true);
  });

  it("a page cut short by Shopify's throttle stops as partial and keeps the cursor", async () => {
    const f = stubFetch({ body: page([PRODUCT], { complete: false, nextCursor: "p1", rateLimited: true }) });
    expect(await askCartCatalog(SECRET, null, 5000)).toMatchObject({ complete: false, cursor: "p1" });
    expect(f).toHaveBeenCalledOnce();
  });

  it("a refused store throws ReconnectNeeded, as the token path does", async () => {
    stubFetch(error(503, "store_not_connected"));
    expect(await thrown(askCartCatalog(SECRET, null, 5000))).toBeInstanceOf(ReconnectNeeded);
  });

  it("an AskCart connection is told apart by its account id", () => {
    expect(isAskCart({ externalAccountId: "askcart" })).toBe(true);
    expect(isAskCart({ externalAccountId: "shop.myshopify.com" })).toBe(false);
  });
});

it("AskCartError's message is the status and code only", () => {
  expect(new AskCartError(502, "upstream_error").message).toBe("AskCart 502 upstream_error");
});

describe("modes and the token endpoint", () => {
  it("per-brand when the client id and secret are set; single-store (interim) on ASKCART_SECRET alone; a lone client id is nothing", () => {
    expect(askCartConfig()).toEqual({ mode: "single-store", url: "https://askcart.test", secret: SECRET });
    vi.stubEnv("ASKCART_CLIENT_ID", "portal");
    expect(askCartConfig()).toBeNull();
    vi.stubEnv("ASKCART_CLIENT_SECRET", "client_secret_abc");
    expect(askCartConfig()).toEqual({ mode: "per-brand", url: "https://askcart.test", clientId: "portal", clientSecret: "client_secret_abc" });
  });

  it("exchanges a code with our client credentials and the PKCE verifier; a refused code is an AskCartError, never a reconnect", async () => {
    vi.stubEnv("ASKCART_CLIENT_ID", "portal");
    vi.stubEnv("ASKCART_CLIENT_SECRET", "client_secret_abc");
    const f = stubFetch(
      { body: { access_token: "tok_1", refresh_token: "ref_1", expires_in: 3600, shop: { domain: "bc.myshopify.com", name: "B&C" }, scopes: ["read_orders"] } },
      error(400, "invalid_grant"),
      { body: { shop: { domain: "bc.myshopify.com" } } },
    );
    const grant = { grant_type: "authorization_code" as const, code: "c1", redirect_uri: "http://localhost:3100/cb", code_verifier: "v1" };
    expect(await askCartTokenRequest(grant)).toMatchObject({ access_token: "tok_1" });
    const init = f.mock.calls[0][1] as RequestInit & { headers: Record<string, string> };
    expect(urlOf(f.mock.calls[0]).pathname).toBe("/api/partner/token");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({ ...grant, client_id: "portal", client_secret: "client_secret_abc" });
    const refused = await thrown(askCartTokenRequest(grant));
    expect(refused).toBeInstanceOf(AskCartError);
    expect(refused.message).not.toContain("client_secret_abc");
    expect(await thrown(askCartTokenRequest(grant))).toMatchObject({ code: "bad_body" });
  });

  it("single-store mode has no token endpoint", async () => {
    const f = stubFetch();
    expect(await thrown(askCartTokenRequest({ grant_type: "refresh_token", refresh_token: "r" }))).toMatchObject({ code: "not_configured" });
    expect(f).not.toHaveBeenCalled();
  });

  it("revoke sends DELETE with the brand's token; 204 is fine", async () => {
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", f);
    expect(await askCartRevoke("tok_1")).toBeNull();
    const init = f.mock.calls[0][1] as RequestInit & { headers: Record<string, string> };
    expect(init.method).toBe("DELETE");
    expect(init.headers.authorization).toBe("Bearer tok_1");
  });
});

describe("askCartCatalog across runs", () => {
  it("starts from a saved cursor and stops between pages once it holds maxVariants, returning where to resume", async () => {
    const f = stubFetch({ body: page([PRODUCT], { complete: false, nextCursor: "p2" }) }, { body: page([PRODUCT], { complete: false, nextCursor: "p3" }) });
    expect(await askCartCatalog(SECRET, "p1", 3)).toMatchObject({ complete: false, cursor: "p3" });
    expect(f).toHaveBeenCalledTimes(2);
    expect(urlOf(f.mock.calls[0]).searchParams.get("cursor")).toBe("p1");
  });

  it("a throttled first page with no cursor keeps the cursor it started from", async () => {
    stubFetch({ body: page([], { complete: false, nextCursor: null, rateLimited: true }) });
    expect(await askCartCatalog(SECRET, "p7", 5000)).toMatchObject({ complete: false, cursor: "p7" });
  });

  it("an AskCart connection is marked in its scopes (per-brand) or by the interim account id", () => {
    expect(isAskCart({ externalAccountId: "bc.myshopify.com", scopes: ["askcart", "read_orders"] })).toBe(true);
    expect(isAskCart({ externalAccountId: "bc.myshopify.com", scopes: ["read_products"] })).toBe(false);
  });
});
