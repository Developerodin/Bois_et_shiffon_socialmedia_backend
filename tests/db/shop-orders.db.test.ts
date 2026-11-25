import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ perms: new Set<string>(), brandId: "so-a" }));
vi.mock("@/server/api/brand-route", async () => {
  const { AccessDeniedError } = await import("@/server/auth/errors");
  return {
    authorizeBrandRoute: vi.fn(async (_r: Request, _p: unknown, key: string) => {
      if (!auth.perms.has(key)) throw new AccessDeniedError(`Missing permission ${key}`);
      return { userId: "u1", workspaceId: ws, brandId: auth.brandId, perms: auth.perms, clientReviewer: false };
    }),
  };
});
vi.mock("@/server/jobs/runner", () => ({ kickRunner: vi.fn() }));
const shop = vi.hoisted(() => ({ scopes: ["read_orders", "read_products"], tokens: [] as string[] }));
vi.mock("@/server/catalog/shopify", async (orig) => ({
  ...(await orig<object>()),
  grantedScopes: vi.fn(async (_shop: string, token: string) => (shop.tokens.push(token), { name: "Shop", scopes: shop.scopes })),
}));
vi.mock("@/server/services/connections", async (orig) => ({ ...(await orig<object>()), accessToken: async () => "stored-token" }));

import { prisma } from "@/server/db/prisma";
import { SYSTEM_ROLES } from "@/server/auth/permissions.catalog";
import { DATA_SYNC_JOB } from "@/server/data/sources";
import { upsertOrders } from "@/server/data/shopify-orders-sync";
import type { ShopOrderLineRow, ShopOrderRow } from "@/server/data/shopify-orders";
import { PUT } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/data-sources/shopify-orders/route";
import { GET } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/sales/summary/route";

/**
 * Shopify orders against Postgres: the per-page upsert, the Sales summary's brand-local days and exclusions, and the
 * turn-on and summary routes' permission checks.
 */
let ws: string;
const params = Promise.resolve({ workspaceId: "w", brandId: "b" });
const roleKeys = (slug: string) => new Set<string>(SYSTEM_ROLES.find((r) => r.slug === slug)!.permissions);

async function brand(id: string, timeZone: string | null) {
  await prisma.brand.create({ data: { id, workspaceId: ws, slug: id, displayName: id } });
  await prisma.brandProfile.create({ data: { workspaceId: ws, brandId: id, websiteUrl: `https://${id}.test`, timeZone } });
}
const row = (id: string, at: string, extra: Partial<ShopOrderRow> = {}): ShopOrderRow => ({
  shopifyId: `gid://shopify/Order/${id}`, name: `#${id}`, processedAt: new Date(at), cancelledAt: null, test: false, currency: "EUR",
  netSales: "90.00", discounts: "10.00", gross: "100.00", shipping: "5.00", taxes: "15.00", taxesIncluded: true, total: "95.00",
  refunded: "0.00", sourceName: "web", shopifyUpdatedAt: new Date(at), ...extra,
});
const put = (body: unknown) => PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body) }), { params });
const summary = (from: string, to: string) => GET(new Request(`http://x?from=${from}&to=${to}`), { params });

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-shop-orders" } })).id;
  await brand("so-a", "Europe/Paris");
  await brand("so-b", null);
});
beforeEach(async () => {
  auth.perms = new Set(["crm.read", "integrations.manage", "brand.read"]);
  auth.brandId = "so-a";
  shop.scopes = ["read_orders", "read_products"];
  shop.tokens = [];
  await prisma.shopOrder.deleteMany({});
  await prisma.dataSource.deleteMany({});
  await prisma.job.deleteMany({});
  await prisma.integrationConnection.deleteMany({});
});

const scopeA = () => ({ workspaceId: ws, brandId: "so-a", connectionId: "c1" });

describe("upsertOrders", () => {
  it("the same page twice leaves the same rows; a newer update overwrites, an older one doesn't", async () => {
    const page = [row("1", "2026-11-20T10:00:00Z"), row("2", "2026-11-20T11:00:00Z", { cancelledAt: new Date("2026-11-21T00:00:00Z") })];
    await upsertOrders(scopeA(), page);
    const first = await prisma.shopOrder.findMany({ orderBy: { shopifyId: "asc" } });
    await upsertOrders(scopeA(), page);
    const again = await prisma.shopOrder.findMany({ orderBy: { shopifyId: "asc" } });
    expect(again).toHaveLength(2);
    expect(again.map((r) => ({ ...r, updatedAt: null }))).toEqual(first.map((r) => ({ ...r, updatedAt: null })));
    expect(first[0].netSales.toFixed(2)).toBe("90.00");
    expect(first[0].processedAt.toISOString()).toBe("2026-11-20T10:00:00.000Z");
    expect(first[1].cancelledAt?.toISOString()).toBe("2026-11-21T00:00:00.000Z");

    const refunded = row("1", "2026-11-20T10:00:00Z", { netSales: "40.00", refunded: "50.00", shopifyUpdatedAt: new Date("2026-11-22T00:00:00Z") });
    await upsertOrders(scopeA(), [refunded]);
    await upsertOrders(scopeA(), [row("1", "2026-11-20T10:00:00Z", { netSales: "1.00" })]); // a stale re-read
    const one = await prisma.shopOrder.findFirstOrThrow({ where: { shopifyId: "gid://shopify/Order/1" } });
    expect([one.netSales.toFixed(2), one.refunded.toFixed(2)]).toEqual(["40.00", "50.00"]);
  });
});

describe("upsertOrders: AskCart line items", () => {
  const line = (id: string, extra: Partial<ShopOrderLineRow> = {}): ShopOrderLineRow => ({
    lineShopifyId: `gid://shopify/LineItem/${id}`, productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/1",
    title: "Oak", variantTitle: null, sku: null, quantity: 1, currentQuantity: 1, unitPrice: "10.00", discountedTotal: "10.00",
    netUnitPrice: "9.00", currency: "EUR", ...extra,
  });
  const at = (iso: string) => ({ shopifyUpdatedAt: new Date(iso) });
  const ids = async () => (await prisma.shopOrderLine.findMany({ orderBy: { lineShopifyId: "asc" } })).map((l) => l.lineShopifyId.slice(-1));
  beforeEach(() => prisma.shopOrderLine.deleteMany({}));

  it("a stale read never touches lines; one without line items keeps them; [] clears them; a line gone is deleted", async () => {
    const o = row("1", "2026-11-20T10:00:00Z");
    await upsertOrders(scopeA(), [{ ...o, ...at("2026-11-21T00:00:00Z"), lines: [line("a"), line("b")], lineItemsTruncated: false }]);
    await upsertOrders(scopeA(), [{ ...o, ...at("2026-11-20T12:00:00Z"), lines: [line("z")], lineItemsTruncated: false }]);
    expect(await ids()).toEqual(["a", "b"]);
    await upsertOrders(scopeA(), [{ ...o, ...at("2026-11-22T00:00:00Z") }]);
    expect(await ids()).toEqual(["a", "b"]);
    await upsertOrders(scopeA(), [{ ...o, ...at("2026-11-23T00:00:00Z"), lines: [line("a", { currentQuantity: 0 })], lineItemsTruncated: false }]);
    expect(await prisma.shopOrderLine.findMany({ select: { lineShopifyId: true, currentQuantity: true } })).toEqual([{ lineShopifyId: "gid://shopify/LineItem/a", currentQuantity: 0 }]);
    await upsertOrders(scopeA(), [{ ...o, ...at("2026-11-24T00:00:00Z"), lines: [], lineItemsTruncated: false }]);
    expect(await ids()).toEqual([]);
  });

  it("a read AskCart paused mid-order adds its lines but deletes none (nor does one with lines we skipped)", async () => {
    const o = row("1", "2026-11-20T10:00:00Z");
    await upsertOrders(scopeA(), [{ ...o, ...at("2026-11-21T00:00:00Z"), lines: [line("a"), line("b"), line("c")], lineItemsTruncated: false }]);
    await upsertOrders(scopeA(), [{ ...o, ...at("2026-11-22T00:00:00Z"), lines: [line("a", { currentQuantity: 0 }), line("d")], lineItemsTruncated: true }]);
    expect(await ids()).toEqual(["a", "b", "c", "d"]);
    expect((await prisma.shopOrderLine.findFirstOrThrow({ where: { lineShopifyId: "gid://shopify/LineItem/a" } })).currentQuantity).toBe(0);
    await upsertOrders(scopeA(), [{ ...o, ...at("2026-11-23T00:00:00Z"), lines: [line("a")], lineItemsTruncated: false, linesSkipped: 1 }]);
    expect(await ids()).toEqual(["a", "b", "c", "d"]);
    expect((await prisma.shopOrder.findFirstOrThrow({ where: { shopifyId: o.shopifyId } })).lineItemsTruncated).toBe(false);
  });

  it("a status not sent keeps the stored one; one sent as null clears it", async () => {
    const o = row("1", "2026-11-20T10:00:00Z");
    await upsertOrders(scopeA(), [{ ...o, ...at("2026-11-21T00:00:00Z"), financialStatus: "PAID", fulfillmentStatus: "FULFILLED", discountCodes: ["XMAS"] }]);
    await upsertOrders(scopeA(), [{ ...o, ...at("2026-11-22T00:00:00Z") }]);
    const kept = await prisma.shopOrder.findFirstOrThrow({ select: { financialStatus: true, fulfillmentStatus: true, discountCodes: true } });
    expect(kept).toEqual({ financialStatus: "PAID", fulfillmentStatus: "FULFILLED", discountCodes: ["XMAS"] });
    await upsertOrders(scopeA(), [{ ...o, ...at("2026-11-23T00:00:00Z"), financialStatus: null }]);
    expect(await prisma.shopOrder.findFirstOrThrow({ select: { financialStatus: true, fulfillmentStatus: true } })).toEqual({ financialStatus: null, fulfillmentStatus: "FULFILLED" });
  });
});

describe("GET sales/summary", () => {
  it("a 23:30 UTC order is the next day in Europe/Paris; test and cancelled orders are left out", async () => {
    await upsertOrders(scopeA(), [
      row("late", "2026-11-23T23:30:00Z"),
      row("test", "2026-11-23T12:00:00Z", { test: true }),
      row("cancelled", "2026-11-23T12:00:00Z", { cancelledAt: new Date("2026-11-23T13:00:00Z") }),
      row("before", "2026-11-22T22:59:00Z"), // 23:59 on the 22nd in Paris: outside 23..24
    ]);
    const res = await summary("2026-11-23", "2026-11-24");
    expect(res.status).toBe(200);
    const { currencies } = await res.json();
    expect(currencies).toHaveLength(1);
    expect(currencies[0].days).toEqual([{ day: "2026-11-24", orders: 1, gross: "100.00", discounts: "10.00", netSales: "90.00", total: "95.00", refunded: "0.00" }]);
    expect(currencies[0].totals.orders).toBe(1);
    // The previous period is 21..22 in Paris: holds the 23:59 order.
    expect(currencies[0].previous).toEqual({ orders: 1, gross: "100.00", discounts: "10.00", netSales: "90.00", total: "95.00", refunded: "0.00" });
  });

  it("two currencies stay apart; another brand's orders never count; no shop domain in the JSON", async () => {
    await upsertOrders(scopeA(), [row("e", "2026-11-23T10:00:00Z"), row("u", "2026-11-23T10:00:00Z", { currency: "USD", netSales: "1.50", discounts: "0.25" })]);
    await upsertOrders({ workspaceId: ws, brandId: "so-b", connectionId: "c2" }, [row("other", "2026-11-23T10:00:00Z")]);
    const res = await summary("2026-11-23", "2026-11-23");
    const body = await res.json();
    expect(body.currencies.map((c: { currency: string; totals: { orders: number; gross: string } }) => [c.currency, c.totals.orders, c.totals.gross])).toEqual([
      ["EUR", 1, "100.00"],
      ["USD", 1, "1.75"],
    ]);
    expect(JSON.stringify(body)).not.toContain("myshopify");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("needs crm.read: a client reviewer and a viewer get 403 and no sales fields", async () => {
    await upsertOrders(scopeA(), [row("1", "2026-11-23T10:00:00Z")]);
    for (const slug of ["client-reviewer", "viewer"]) {
      auth.perms = roleKeys(slug);
      expect(auth.perms.has("crm.read")).toBe(false);
      const res = await summary("2026-11-23", "2026-11-23");
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).not.toMatch(/netSales|currencies/);
    }
  });

  it("a bad range is 422", async () => {
    expect((await summary("2026-11-24", "2026-11-23")).status).toBe(422);
  });
});

describe("PUT data-sources/shopify-orders", () => {
  async function connection(brandId: string, provider: "SHOPIFY" | "GOOGLE" = "SHOPIFY") {
    const user = await prisma.user.upsert({ where: { email: "c@shop-orders.test" }, update: {}, create: { email: "c@shop-orders.test", name: "c" } });
    return prisma.integrationConnection.create({
      data: { workspaceId: ws, brandId, provider, externalAccountId: `${brandId}-${provider}.myshopify.com`, displayName: "Shop", scopes: ["read_products"], status: "ACTIVE", credentialKeyVersion: 1, connectedByUserId: user.id },
    });
  }

  it("is limited to 10 presses a minute per brand and person (429)", async () => {
    await prisma.rateLimitBucket.deleteMany({});
    for (let i = 0; i < 10; i++) expect((await put({ connectionId: "missing" })).status).toBe(404);
    expect((await put({ connectionId: "missing" })).status).toBe(429);
    await prisma.rateLimitBucket.deleteMany({});
  });

  it("turns the sync on with the stored token, ignoring a token in the body, and queues the first run", async () => {
    const c = await connection("so-a");
    const res = await put({ connectionId: c.id, accessToken: "shpat_from_body" });
    expect(res.status).toBe(200);
    expect(shop.tokens).toEqual(["stored-token"]);
    const source = await prisma.dataSource.findFirstOrThrow({ where: { brandId: "so-a", kind: "SHOPIFY_ORDERS" } });
    expect(source).toMatchObject({ connectionId: c.id, externalId: c.externalAccountId, status: "ACTIVE" });
    const jobs = await prisma.job.findMany({ where: { type: DATA_SYNC_JOB } });
    expect(jobs).toHaveLength(1);
    expect(JSON.stringify(jobs)).not.toContain("shpat_from_body");
    expect(JSON.stringify(jobs)).not.toContain("stored-token");
    expect((await prisma.integrationConnection.findUniqueOrThrow({ where: { id: c.id } })).scopes).toEqual(["read_orders", "read_products"]);
  });

  it("without read_orders: 422 with what to do, nothing created", async () => {
    shop.scopes = ["read_products"];
    const res = await put({ connectionId: (await connection("so-a")).id });
    expect(res.status).toBe(422);
    expect((await res.json()).detail).toBe("Add read_orders to the app in Shopify, reinstall it and paste the new token.");
    expect(await prisma.dataSource.count()).toBe(0);
  });

  it("another brand's or another provider's connection is 404", async () => {
    expect((await put({ connectionId: (await connection("so-b")).id })).status).toBe(404);
    expect((await put({ connectionId: (await connection("so-a", "GOOGLE")).id })).status).toBe(404);
    expect(await prisma.dataSource.count()).toBe(0);
  });

  it("needs integrations.manage: a client reviewer gets 403", async () => {
    auth.perms = roleKeys("client-reviewer");
    expect((await put({ connectionId: (await connection("so-a")).id })).status).toBe(403);
  });
});
