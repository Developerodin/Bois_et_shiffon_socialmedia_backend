import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ brandId: "ac-a", perms: new Set(["integrations.manage"]) }));
vi.mock("@/server/api/brand-route", async () => {
  const { AccessDeniedError } = await import("@/server/auth/errors");
  return {
    authorizeBrandRoute: vi.fn(async (_r: Request, _p: unknown, key: string) => {
      if (!auth.perms.has(key)) throw new AccessDeniedError(`Missing permission ${key}`);
      return { userId: user, workspaceId: ws, brandId: auth.brandId, perms: auth.perms, clientReviewer: false };
    }),
  };
});
vi.mock("@/server/jobs/runner", () => ({ kickRunner: vi.fn() }));

import { prisma } from "@/server/db/prisma";
import { decryptCredentials } from "@/server/crypto/credentials";
import { runCatalogSync } from "@/server/catalog/sync";
import { disconnect } from "@/server/services/connections";
import { ASKCART_REFUSED } from "@/server/shopify/askcart";
import { POST } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/integrations/shopify/askcart/route";

/**
 * Connecting a brand's Shopify through AskCart against Postgres: the one-brand-per-deployment rule, no secret stored,
 * and the catalogue sync reading through AskCart into SHOPIFY rows.
 */
const SECRET = "askcart_partner_secret_xyz";
let ws: string;
let user: string;
const params = Promise.resolve({ workspaceId: "w", brandId: "b" });
const connect = (brandId: string) => ((auth.brandId = brandId), POST(new Request("http://x", { method: "POST" }), { params }));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const PRODUCT = (id: number) => ({
  id: `gid://shopify/Product/${id}`, title: `Shirt ${id}`, handle: `shirt-${id}`, onlineStoreUrl: null, productType: "Shirt", description: "", status: "ACTIVE",
  featuredImageUrl: null, variants: [{ id: `gid://shopify/ProductVariant/${id}`, sku: null, title: "Default Title", price: { amount: "10.00", currencyCode: "INR" }, compareAtPrice: null, inventoryQuantity: 1, availableForSale: true }],
});

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-askcart" } })).id;
  user = (await prisma.user.create({ data: { email: "u@askcart.test", name: "u" } })).id;
  for (const id of ["ac-a", "ac-b"]) {
    await prisma.brand.create({ data: { id, workspaceId: ws, slug: id, displayName: id } });
    await prisma.brandProfile.create({ data: { workspaceId: ws, brandId: id } });
  }
});
beforeEach(async () => {
  vi.stubEnv("ASKCART_URL", "https://askcart.test");
  vi.stubEnv("ASKCART_SECRET", SECRET);
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", Buffer.alloc(32, 5).toString("base64"));
  await prisma.product.deleteMany({});
  await prisma.job.deleteMany({});
  await prisma.integrationConnection.deleteMany({});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Connect via AskCart", () => {
  it("saves the shop's name with no secret, and queues a catalogue sync", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ name: "B&C", currencyCode: "INR" })));
    const res = await connect("ac-a");
    expect(res.status).toBe(201);
    const conn = await prisma.integrationConnection.findFirstOrThrow({ where: { brandId: "ac-a" } });
    expect(conn).toMatchObject({ provider: "SHOPIFY", externalAccountId: "askcart", displayName: "B&C", status: "ACTIVE" });
    expect(JSON.stringify(conn)).not.toContain(SECRET);
    expect(decryptCredentials<{ accessToken: string }>(conn.encryptedCredentials!).accessToken).toBe("");
    expect(await prisma.job.count({ where: { type: "catalog.sync", brandId: "ac-a" } })).toBe(1);
  });

  it("only one brand per deployment: a second brand gets 409 until the first disconnects; the first can reconnect", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ name: "B&C", currencyCode: "INR" })));
    expect((await connect("ac-a")).status).toBe(201);
    expect((await connect("ac-b")).status).toBe(409);
    expect(await prisma.integrationConnection.count({ where: { brandId: "ac-b" } })).toBe(0);
    expect((await connect("ac-a")).status).toBe(201); // reconnect in place
    const [a, b] = await Promise.all([connect("ac-b"), connect("ac-b")]);
    expect([a.status, b.status]).toEqual([409, 409]);

    const conn = await prisma.integrationConnection.findFirstOrThrow({ where: { brandId: "ac-a" } });
    await disconnect({ workspaceId: ws, brandId: "ac-a", connectionId: conn.id, userId: user });
    expect((await connect("ac-b")).status).toBe(201);
  });

  it("AskCart refusing or unreachable saves nothing; unset env is 422", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "store_reconnect_needed" }, 503)));
    expect((await connect("ac-a")).status).toBe(422);
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "upstream_error" }, 502)));
    expect((await connect("ac-a")).status).toBe(502);
    vi.stubEnv("ASKCART_URL", "");
    expect((await connect("ac-a")).status).toBe(422);
    expect(await prisma.integrationConnection.count()).toBe(0);
  });

  it("without integrations.manage: 403", async () => {
    auth.perms = new Set();
    try {
      expect((await connect("ac-a")).status).toBe(403);
    } finally {
      auth.perms = new Set(["integrations.manage"]);
    }
  });
});

describe("catalogue sync through AskCart", () => {
  const scope = () => ({ workspaceId: ws, brandId: "ac-a" });
  const live = async () => (await prisma.product.findMany({ where: { brandId: "ac-a", archivedAt: null } })).map((p) => p.externalId).sort();

  async function connected() {
    vi.stubGlobal("fetch", vi.fn(async () => json({ name: "B&C", currencyCode: "INR" })));
    await connect("ac-a");
  }

  it("a complete walk writes SHOPIFY rows and archives unseen ones; a throttled walk archives nothing", async () => {
    await connected();
    await prisma.product.create({ data: { workspaceId: ws, brandId: "ac-a", source: "SHOPIFY", externalId: "gid://shopify/ProductVariant/9", title: "old" } });
    vi.stubGlobal("fetch", vi.fn(async () => json({ items: [PRODUCT(1), PRODUCT(2)], nextCursor: null, complete: true })));
    await runCatalogSync(scope());
    expect(await live()).toEqual(["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/2"]);
    expect((await prisma.brandProfile.findFirstOrThrow({ where: { brandId: "ac-a" } })).catalogSync).toMatchObject({ source: "SHOPIFY", count: 2, error: null });

    vi.stubGlobal("fetch", vi.fn(async () => json({ items: [PRODUCT(3)], nextCursor: "c1", complete: false, rateLimited: true })));
    await runCatalogSync(scope());
    expect(await live()).toEqual(["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/2", "gid://shopify/ProductVariant/3"]);
    expect((await prisma.brandProfile.findFirstOrThrow({ where: { brandId: "ac-a" } })).catalogSync).toMatchObject({ reason: "partial" });
  });

  it("store_reconnect_needed marks the connection with AskCart's reason, not Shopify's token text", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await connected();
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "store_reconnect_needed" }, 503)));
    await expect(runCatalogSync(scope())).rejects.toThrow("AskCart 503 store_reconnect_needed");
    expect(await prisma.integrationConnection.findFirstOrThrow({ where: { brandId: "ac-a" } })).toMatchObject({ status: "ERROR", lastError: ASKCART_REFUSED });
    expect((await prisma.brandProfile.findFirstOrThrow({ where: { brandId: "ac-a" } })).catalogSync).toMatchObject({ reason: "shopify-refused", error: ASKCART_REFUSED });
  });
});
