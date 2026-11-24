import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ brandId: "mcp-a", perms: new Set(["integrations.manage"]) }));
const safeFetchBytes = vi.hoisted(() => vi.fn());
vi.mock("@/server/api/brand-route", async () => {
  const { AccessDeniedError } = await import("@/server/auth/errors");
  return {
    authorizeBrandRoute: vi.fn(async (_r: Request, _p: unknown, key: string) => {
      if (!auth.perms.has(key)) throw new AccessDeniedError(`Missing permission ${key}`);
      return { userId: user, workspaceId: ws, brandId: auth.brandId, perms: auth.perms, clientReviewer: false };
    }),
  };
});
vi.mock("@/server/jobs/runner", () => ({ kickRunner: vi.fn(), kickIfDue: vi.fn(async () => undefined) }));
// The store's answers: the SSRF-guarded fetch is the only way out to the store.
vi.mock("@/server/research/crawl", async (orig) => ({ ...(await orig<object>()), safeFetchBytes }));

import { prisma } from "@/server/db/prisma";
import { pickShopifyBlog, shopifyBlogs } from "@/server/blog/shopify-articles";
import { syncQuoteStatus } from "@/server/quotes/status-sync";
import { CrawlError } from "@/server/research/crawl";
import { MCP_ONLY } from "@/server/shopify/writes";
import { fakeShopify } from "../fixtures/shopify-fake";
import { runCatalogSync } from "@/server/catalog/sync";
import { turnOnShopifyOrders } from "@/server/data/shopify-orders-sync";
import { listConnections, toConnectionDto } from "@/server/services/connections";
import { POST } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/integrations/shopify/mcp/route";
import { DELETE } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/connections/[connectionId]/route";
import { RECORDED_PROFILE_UNREACHABLE, RECORDED_SEARCH, RECORDED_TOOLS, SEARCH_CATALOG_INPUT } from "../fixtures/catalog-mcp";

/**
 * Connecting a brand's Shopify store through the Storefront Catalog MCP against Postgres: who may, what is saved (no
 * secret, MCP marker), brand isolation, the catalogue sync filling products from it, orders refused, disconnect.
 */
let ws: string;
let user: string;
const params = Promise.resolve({ workspaceId: "w", brandId: "b" });
const connect = (brandId: string, body: unknown) => ((auth.brandId = brandId), POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), { params }));
const answer = (body: unknown, status = 200) => ({ url: new URL("https://x/api/ucp/mcp"), status, bytes: new TextEncoder().encode(JSON.stringify(body)), contentType: "application/json", truncated: false, headers: new Headers() });
const TOOLS = answer({ jsonrpc: "2.0", id: 1, result: { tools: RECORDED_TOOLS.map((name) => ({ name, inputSchema: name === "search_catalog" ? { properties: { catalog: SEARCH_CATALOG_INPUT } } : {} })) } });
const search = (products: unknown[]) => answer({ jsonrpc: "2.0", id: 2, result: { structuredContent: { products, pagination: { has_next_page: false } } } });
const live = async (brandId: string) => (await prisma.product.findMany({ where: { brandId, archivedAt: null } })).map((p) => p.externalId).sort();

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-mcp" } })).id;
  user = (await prisma.user.create({ data: { email: "u@mcp.test", name: "u" } })).id;
  for (const id of ["mcp-a", "mcp-b"]) {
    await prisma.brand.create({ data: { id, workspaceId: ws, slug: id, displayName: id } });
    await prisma.brandProfile.create({ data: { workspaceId: ws, brandId: id } });
  }
});
beforeEach(async () => {
  vi.stubEnv("UCP_PROFILE_URL", "https://app.example/api/v1/ucp/profile");
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", Buffer.alloc(32, 5).toString("base64"));
  auth.perms = new Set(["integrations.manage"]);
  safeFetchBytes.mockReset();
  await prisma.product.deleteMany({});
  await prisma.job.deleteMany({});
  await prisma.rateLimitBucket.deleteMany({});
  await prisma.integrationConnection.deleteMany({});
});
afterEach(() => vi.unstubAllEnvs());

describe("connect", () => {
  it("someone without integrations.manage gets 403 and the store is never called", async () => {
    auth.perms = new Set(["catalog.view"]);
    const res = await connect("mcp-a", { shop: "bc.myshopify.com" });
    expect(res.status).toBe(403);
    expect(safeFetchBytes).not.toHaveBeenCalled();
    expect(await prisma.integrationConnection.count()).toBe(0);
  });

  it("checks the store, saves a SHOPIFY connection marked mcp with no secret on this brand only, and queues a sync", async () => {
    safeFetchBytes.mockResolvedValueOnce(TOOLS).mockResolvedValueOnce(search([]));
    const res = await connect("mcp-a", { shop: "https://www.BoisEtChiffons.fr/" });
    expect(res.status).toBe(201);
    const { connection } = (await res.json()) as { connection: { displayName: string; via?: string } };
    expect(connection).toMatchObject({ displayName: "www.boisetchiffons.fr", via: "mcp" });
    expect(safeFetchBytes.mock.calls[0][0]).toBe("https://www.boisetchiffons.fr/api/ucp/mcp");

    const row = await prisma.integrationConnection.findFirstOrThrow({ where: { brandId: "mcp-a" } });
    expect(row).toMatchObject({ provider: "SHOPIFY", externalAccountId: "www.boisetchiffons.fr", scopes: ["mcp"], status: "ACTIVE" });
    expect(await listConnections(ws, "mcp-b")).toEqual([]);
    expect(await prisma.job.count({ where: { type: "catalog.sync", payload: { path: ["brandId"], equals: "mcp-a" } } })).toBe(1);
  });

  it("a bad address, a store that isn't one, or Shopify refusing our profile save nothing", async () => {
    expect((await connect("mcp-a", { shop: "10.0.0.1" })).status).toBe(422);
    safeFetchBytes.mockResolvedValueOnce(answer({ not: "rpc" }, 404));
    const notShop = await connect("mcp-a", { shop: "example.com" });
    expect(notShop.status).toBe(422);
    safeFetchBytes.mockResolvedValueOnce(answer(RECORDED_PROFILE_UNREACHABLE, 422));
    const profile = await connect("mcp-a", { shop: "bc.myshopify.com" });
    expect(profile.status).toBe(502);
    expect(((await profile.json()) as { detail: string }).detail).toMatch(/UCP_PROFILE_URL/);
    expect(await prisma.integrationConnection.count()).toBe(0);
  });

  it("a store busy after the retry is 502; a custom domain redirecting elsewhere asks for the myshopify address", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      safeFetchBytes.mockResolvedValueOnce(answer("busy", 503)).mockResolvedValueOnce(answer("busy", 503));
      const pending = connect("mcp-a", { shop: "bc.myshopify.com" });
      await vi.advanceTimersByTimeAsync(2000);
      const busy = await pending;
      expect(busy.status).toBe(502);
      expect(((await busy.json()) as { title: string }).title).toBe("The store is busy");
    } finally {
      vi.useRealTimers();
    }
    safeFetchBytes.mockRejectedValueOnce(new CrawlError("Redirected to another site"));
    const moved = await connect("mcp-a", { shop: "shop.example.fr" });
    expect(moved.status).toBe(422);
    expect(((await moved.json()) as { detail: string }).detail).toMatch(/myshopify\.com address instead/);
    expect(await prisma.integrationConnection.count()).toBe(0);
  });

  it("without a public https profile URL the option isn't set up (422), and the store isn't called", async () => {
    vi.stubEnv("UCP_PROFILE_URL", "http://localhost:3100/api/v1/ucp/profile");
    expect((await connect("mcp-a", { shop: "bc.myshopify.com" })).status).toBe(422);
    expect(safeFetchBytes).not.toHaveBeenCalled();
  });

  it("the same address already connected through a token is 409, not replaced; another brand may connect it", async () => {
    await prisma.integrationConnection.create({
      data: { workspaceId: ws, brandId: "mcp-a", provider: "SHOPIFY", externalAccountId: "bc.myshopify.com", displayName: "bc", scopes: ["read_products"], status: "ACTIVE", credentialKeyVersion: 1, connectedByUserId: user },
    });
    safeFetchBytes.mockResolvedValueOnce(TOOLS).mockResolvedValueOnce(search([]));
    expect((await connect("mcp-a", { shop: "bc" })).status).toBe(409);
    expect((await prisma.integrationConnection.findFirstOrThrow({ where: { brandId: "mcp-a" } })).scopes).toEqual(["read_products"]);
    safeFetchBytes.mockReset().mockResolvedValueOnce(TOOLS).mockResolvedValueOnce(search([]));
    expect((await connect("mcp-b", { shop: "bc" })).status).toBe(201);
  });
});

describe("after connecting", () => {
  async function connected(brandId = "mcp-a") {
    safeFetchBytes.mockResolvedValueOnce(TOOLS).mockResolvedValueOnce(search([]));
    expect((await connect(brandId, { shop: "www.boisetchiffons.fr" })).status).toBe(201);
    return prisma.integrationConnection.findFirstOrThrow({ where: { brandId } });
  }

  it("the catalogue sync fills the brand's products from the MCP (available and unavailable walks)", async () => {
    await connected();
    const sold = { ...(RECORDED_SEARCH.products[0] as object), id: "gid://shopify/Product/2", variants: [{ id: "gid://shopify/ProductVariant/2", title: "Default Title", availability: { available: false }, price: { amount: 100, currency: "EUR" } }] };
    safeFetchBytes.mockResolvedValueOnce(TOOLS).mockResolvedValueOnce(search(RECORDED_SEARCH.products)).mockResolvedValueOnce(search([sold]));
    await runCatalogSync({ workspaceId: ws, brandId: "mcp-a" });
    expect(await live("mcp-a")).toEqual(["gid://shopify/ProductVariant/2", "gid://shopify/ProductVariant/44096216924336"]);
    const p = await prisma.product.findFirstOrThrow({ where: { brandId: "mcp-a", sku: "BC001055" } });
    expect({ source: p.source, price: p.price?.toString(), currency: p.currency, inStock: p.inStock }).toEqual({ source: "SHOPIFY", price: "539.58", currency: "EUR", inStock: true });
    expect(await live("mcp-b")).toEqual([]);

    // The product left the store: a complete walk archives it.
    safeFetchBytes.mockResolvedValueOnce(TOOLS).mockResolvedValueOnce(search(RECORDED_SEARCH.products)).mockResolvedValueOnce(search([]));
    await runCatalogSync({ workspaceId: ws, brandId: "mcp-a" });
    expect(await live("mcp-a")).toEqual(["gid://shopify/ProductVariant/44096216924336"]);
  });

  it("an empty catalogue archives nothing the first time, and only on the second empty run in a row", async () => {
    await connected();
    const sync = (products: unknown[]) => {
      safeFetchBytes.mockResolvedValueOnce(TOOLS).mockResolvedValueOnce(search(products)).mockResolvedValueOnce(search([]));
      return runCatalogSync({ workspaceId: ws, brandId: "mcp-a" });
    };
    const reason = async () => ((await prisma.brandProfile.findFirstOrThrow({ where: { brandId: "mcp-a" } })).catalogSync as { reason: string | null; count: number });
    await sync(RECORDED_SEARCH.products);
    await sync([]);
    expect(await live("mcp-a")).toHaveLength(1);
    expect(await reason()).toMatchObject({ reason: "partial", count: 1 });
    // A full run in between resets the count: the next empty one is a first again.
    await sync(RECORDED_SEARCH.products);
    await sync([]);
    expect(await live("mcp-a")).toHaveLength(1);
    await sync([]);
    expect(await live("mcp-a")).toEqual([]);
  });

  it("a product the store sends that can't be read archives nothing, and the note says how many", async () => {
    await connected();
    safeFetchBytes.mockResolvedValueOnce(TOOLS).mockResolvedValueOnce(search(RECORDED_SEARCH.products)).mockResolvedValueOnce(search([]));
    await runCatalogSync({ workspaceId: ws, brandId: "mcp-a" });
    safeFetchBytes.mockResolvedValueOnce(TOOLS).mockResolvedValueOnce(search([{ title: 5 }])).mockResolvedValueOnce(search([]));
    await runCatalogSync({ workspaceId: ws, brandId: "mcp-a" });
    expect(await live("mcp-a")).toHaveLength(1);
    expect((await prisma.brandProfile.findFirstOrThrow({ where: { brandId: "mcp-a" } })).catalogSync).toMatchObject({ reason: "partial", error: expect.stringMatching(/^1 products or variants/) });
  });

  it("blog and quote writes stop before the write adapter, asking for AskCart", async () => {
    await connected();
    const shop = fakeShopify({ scopes: ["write_content", "write_draft_orders"] });
    const calls = [vi.spyOn(shop.adapter, "listBlogs"), vi.spyOn(shop.adapter, "lookupDraftOrder")];
    const scope = { workspaceId: ws, brandId: "mcp-a" };
    expect(await shopifyBlogs(scope, shop.adapter)).toMatchObject({ blogs: [], connected: false });
    await expect(pickShopifyBlog({ ...scope, userId: user }, "gid://shopify/Blog/1", shop.adapter)).rejects.toMatchObject({ message: MCP_ONLY, status: 422 });
    expect(await syncQuoteStatus(scope, shop.adapter)).toEqual({ count: 0, reason: "permission" });
    for (const c of calls) expect(c).not.toHaveBeenCalled();
  });

  it("a failed read archives nothing and leaves the connection connected", async () => {
    await connected();
    safeFetchBytes.mockResolvedValueOnce(TOOLS).mockResolvedValueOnce(search(RECORDED_SEARCH.products)).mockResolvedValueOnce(search([]));
    await runCatalogSync({ workspaceId: ws, brandId: "mcp-a" });
    safeFetchBytes.mockResolvedValue(answer({ nope: true }, 404));
    await expect(runCatalogSync({ workspaceId: ws, brandId: "mcp-a" })).rejects.toThrow(/not_mcp/);
    expect(await live("mcp-a")).toHaveLength(1);
    expect((await prisma.integrationConnection.findFirstOrThrow({ where: { brandId: "mcp-a" } })).status).toBe("ACTIVE");
  });

  it("orders are refused: they need AskCart", async () => {
    const conn = await connected();
    expect(await turnOnShopifyOrders({ workspaceId: ws, brandId: "mcp-a" }, conn.id)).toEqual({ ok: false, problem: "needs-askcart" });
    expect(await prisma.dataSource.count()).toBe(0);
  });

  it("disconnect works like the others, and only within the brand", async () => {
    const conn = await connected();
    auth.brandId = "mcp-b";
    const other = await DELETE(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ workspaceId: ws, brandId: "mcp-b", connectionId: conn.id }) });
    expect(other.status).toBe(404);
    auth.brandId = "mcp-a";
    const res = await DELETE(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ workspaceId: ws, brandId: "mcp-a", connectionId: conn.id }) });
    expect(res.status).toBe(200);
    expect(toConnectionDto(await prisma.integrationConnection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe("REVOKED");
  });
});
