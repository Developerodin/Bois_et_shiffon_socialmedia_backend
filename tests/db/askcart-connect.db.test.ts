import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ brandId: "ac-a", perms: new Set(["integrations.manage"]), denied: false }));
vi.mock("@/server/api/brand-route", async () => {
  const { AccessDeniedError } = await import("@/server/auth/errors");
  return {
    authorizeBrandRoute: vi.fn(async (_r: Request, _p: unknown, key: string) => {
      if (!auth.perms.has(key)) throw new AccessDeniedError(`Missing permission ${key}`);
      return { userId: user, workspaceId: ws, brandId: auth.brandId, perms: auth.perms, clientReviewer: false };
    }),
  };
});
// The callback re-checks access with the real helpers elsewhere; here a flag stands in for a role revoked mid-flow.
vi.mock("@/server/auth/access", async (orig) => ({
  ...(await orig<object>()),
  requireBrandAccess: vi.fn(async () => {
    if (auth.denied) throw new (await import("@/server/auth/errors")).AccessDeniedError("no access");
  }),
}));
vi.mock("@/server/auth/permissions", async (orig) => ({ ...(await orig<object>()), requirePermission: vi.fn(async () => undefined) }));
vi.mock("@/server/jobs/runner", () => ({ kickRunner: vi.fn(), kickIfDue: vi.fn(async () => undefined) }));

import { createHash } from "node:crypto";
import { prisma } from "@/server/db/prisma";
import { decryptCredentials } from "@/server/crypto/credentials";
import { runCatalogSync } from "@/server/catalog/sync";
import { ConnectionError, disconnect } from "@/server/services/connections";
import { ReconnectNeeded } from "@/server/services/reconnect-needed";
import { ASKCART_MODE_CHANGED, ASKCART_STORE_LAPSED } from "@/server/shopify/askcart";
import { completeAskCartConnect } from "@/server/shopify/askcart-connect";
import { askCartToken } from "@/server/shopify/askcart-token";
import { POST } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/integrations/shopify/askcart/route";
import { DELETE } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/connections/[connectionId]/route";
import { GET as products } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/products/route";

/**
 * Connecting a brand's Shopify through AskCart against Postgres, in both modes: per-brand (portal-initiated, PKCE,
 * encrypted per-store token, refresh, revoke on disconnect) and the INTERIM single-store mode (one brand per
 * deployment, no secret stored); and the catalogue sync reading through AskCart, its walk resuming across runs.
 */
const SECRET = "askcart_partner_secret_xyz";
const CLIENT_SECRET = "askcart_client_secret_abc";
let ws: string;
let user: string;
const params = Promise.resolve({ workspaceId: "w", brandId: "b" });
const connect = (brandId: string, body?: unknown) =>
  ((auth.brandId = brandId), POST(new Request("http://x", { method: "POST", ...(body !== undefined && { body: JSON.stringify(body) }) }), { params }));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const PRODUCT = (id: number) => ({
  id: `gid://shopify/Product/${id}`, title: `Shirt ${id}`, handle: `shirt-${id}`, onlineStoreUrl: null, productType: "Shirt", description: "", status: "ACTIVE",
  featuredImageUrl: null, variants: [{ id: `gid://shopify/ProductVariant/${id}`, sku: null, title: "Default Title", price: { amount: "10.00", currencyCode: "INR" }, compareAtPrice: null, inventoryQuantity: 1, availableForSale: true }],
});
const conn = (brandId: string) => prisma.integrationConnection.findFirstOrThrow({ where: { brandId, status: { not: "REVOKED" } } });
const live = async (brandId: string) => (await prisma.product.findMany({ where: { brandId, archivedAt: null } })).map((p) => p.externalId).sort();
const lastSync = async (brandId: string) => (await prisma.brandProfile.findFirstOrThrow({ where: { brandId } })).catalogSync as Record<string, unknown>;

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
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", Buffer.alloc(32, 5).toString("base64"));
  await prisma.product.deleteMany({});
  await prisma.job.deleteMany({});
  await prisma.oAuthStateTransaction.deleteMany({});
  await prisma.integrationConnection.deleteMany({});
  await prisma.brandProfile.updateMany({ data: { catalogSync: undefined } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("per-brand mode", () => {
  beforeEach(() => {
    vi.stubEnv("ASKCART_CLIENT_ID", "portal");
    vi.stubEnv("ASKCART_CLIENT_SECRET", CLIENT_SECRET);
    vi.stubEnv("ASKCART_SECRET", SECRET); // ignored once a client id is set
  });

  /** Start a connect for `brandId` and return its state and the PKCE verifier stored beside it. */
  async function start(brandId: string, shop = "BC-Store.myshopify.com") {
    const res = await connect(brandId, { shop });
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { url: string }).url);
    const state = url.searchParams.get("state")!;
    const row = await prisma.oAuthStateTransaction.findFirstOrThrow({ where: { brandId }, orderBy: { createdAt: "desc" } });
    // Kept encrypted, never as the raw verifier.
    expect(row.codeVerifier).toMatch(/^v1:/);
    return { url, state, verifier: decryptCredentials<string>(row.codeVerifier!) };
  }
  const tokenAnswer = (domain = "bc-store.myshopify.com", extra: object = {}) =>
    json({ access_token: `tok_${domain}`, shop: { domain, name: "B&C", currencyCode: "INR" }, scopes: ["read_products", "read_orders"], ...extra });

  it("start: validates the shop and sends AskCart the state, our callback, client id and an S256 challenge of the stored verifier", async () => {
    expect((await connect("ac-a", { shop: "not a shop" })).status).toBe(422);
    const { url, verifier } = await start("ac-a");
    expect(`${url.origin}${url.pathname}`).toBe("https://askcart.test/partner/connect");
    expect(url.searchParams.get("shop")).toBe("bc-store.myshopify.com");
    expect(url.searchParams.get("client_id")).toBe("portal");
    expect(url.searchParams.get("redirect_uri")).toMatch(/\/api\/v1\/integrations\/askcart\/callback$/);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(url.toString()).not.toContain(verifier);
    expect(url.toString()).not.toContain(CLIENT_SECRET);
  });

  it("callback: exchanges the code with the verifier, stores the per-store token encrypted, queues a sync; the state works once", async () => {
    const { state, verifier } = await start("ac-a");
    const f = vi.fn(async () => tokenAnswer());
    vi.stubGlobal("fetch", f);
    const done = await completeAskCartConnect({ state, code: "code1", shop: "bc-store.myshopify.com", userId: user });
    expect(done.brandId).toBe("ac-a");
    const sent = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent).toMatchObject({ grant_type: "authorization_code", code: "code1", code_verifier: verifier, client_id: "portal", client_secret: CLIENT_SECRET });

    const c = await conn("ac-a");
    expect(c).toMatchObject({ provider: "SHOPIFY", externalAccountId: "bc-store.myshopify.com", displayName: "B&C", status: "ACTIVE", tokenExpiresAt: null });
    expect(c.scopes).toEqual(["askcart", "read_products", "read_orders"]);
    expect(c.encryptedCredentials).not.toContain("tok_");
    expect(decryptCredentials<{ accessToken: string }>(c.encryptedCredentials!).accessToken).toBe("tok_bc-store.myshopify.com");
    expect(await prisma.job.count({ where: { type: "catalog.sync", brandId: "ac-a" } })).toBe(1);

    // Another person, or a second use after the replay window, gets nothing.
    await expect(completeAskCartConnect({ state, code: "code1", shop: null, userId: "someone-else" })).rejects.toBeInstanceOf(ConnectionError);
  });

  it("every brand connects its own store; there's no one-brand rule", async () => {
    for (const [brandId, domain] of [["ac-a", "a.myshopify.com"], ["ac-b", "b.myshopify.com"]] as const) {
      const { state } = await start(brandId, domain);
      vi.stubGlobal("fetch", vi.fn(async () => tokenAnswer(domain)));
      await completeAskCartConnect({ state, code: "c", shop: domain, userId: user });
    }
    expect((await conn("ac-a")).externalAccountId).toBe("a.myshopify.com");
    expect((await conn("ac-b")).externalAccountId).toBe("b.myshopify.com");
  });

  it("a token for another shop, a refused code, or a role revoked mid-flow saves nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let { state } = await start("ac-a");
    vi.stubGlobal("fetch", vi.fn(async () => tokenAnswer("other.myshopify.com")));
    await expect(completeAskCartConnect({ state, code: "c", shop: "bc-store.myshopify.com", userId: user })).rejects.toThrow("different store");
    ({ state } = await start("ac-a"));
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "invalid_grant" }, 400)));
    await expect(completeAskCartConnect({ state, code: "c", shop: null, userId: user })).rejects.toThrow("Couldn't finish connecting");
    ({ state } = await start("ac-a"));
    auth.denied = true;
    try {
      await expect(completeAskCartConnect({ state, code: "c", shop: null, userId: user })).rejects.toThrow("no access");
    } finally {
      auth.denied = false;
    }
    expect(await prisma.integrationConnection.count()).toBe(0);
  });

  it("an access token with a lifetime is refreshed near its end; a refused refresh asks for a reconnect", async () => {
    const { state } = await start("ac-a");
    vi.stubGlobal("fetch", vi.fn(async () => tokenAnswer("bc-store.myshopify.com", { refresh_token: "ref_1", expires_in: 60 })));
    await completeAskCartConnect({ state, code: "c", shop: null, userId: user });
    let c = await conn("ac-a");
    expect(c.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    const f = vi.fn(async () => json({ access_token: "tok_2", expires_in: 3600 }));
    vi.stubGlobal("fetch", f);
    expect(await askCartToken(c)).toBe("tok_2");
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ grant_type: "refresh_token", refresh_token: "ref_1" });
    c = await conn("ac-a");
    expect(decryptCredentials<{ accessToken: string; refreshToken: string }>(c.encryptedCredentials!)).toEqual({ accessToken: "tok_2", refreshToken: "ref_1" });

    await prisma.integrationConnection.update({ where: { id: c.id }, data: { tokenExpiresAt: new Date(Date.now() - 1000) } });
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "invalid_grant" }, 400)));
    await expect(askCartToken(await conn("ac-a"))).rejects.toBeInstanceOf(ReconnectNeeded);
    expect(await conn("ac-a")).toMatchObject({ status: "ERROR" });
  });

  it("reads with the brand's own token; Disconnect asks AskCart to forget it first, and still disconnects when AskCart is down", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { state } = await start("ac-a");
    vi.stubGlobal("fetch", vi.fn(async () => tokenAnswer()));
    await completeAskCartConnect({ state, code: "c", shop: null, userId: user });

    const reads = vi.fn(async () => json({ items: [PRODUCT(1)], nextCursor: null, complete: true }));
    vi.stubGlobal("fetch", reads);
    await runCatalogSync({ workspaceId: ws, brandId: "ac-a" });
    expect((reads.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }])[1].headers.authorization).toBe("Bearer tok_bc-store.myshopify.com");
    expect(await live("ac-a")).toEqual(["gid://shopify/ProductVariant/1"]);

    const c = await conn("ac-a");
    const revoke = vi.fn(async () => json({ error: "upstream_error" }, 502));
    vi.stubGlobal("fetch", revoke);
    auth.brandId = "ac-a";
    const res = await DELETE(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ workspaceId: "w", brandId: "b", connectionId: c.id }) });
    expect(res.status).toBe(200);
    const [url, init] = revoke.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://askcart.test/api/partner/token");
    expect(init.method).toBe("DELETE");
    expect(init.headers.authorization).toBe("Bearer tok_bc-store.myshopify.com");
    expect(await prisma.integrationConnection.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: "REVOKED", encryptedCredentials: null });
  });

  it("disconnects first, then asks AskCart once, with a short deadline and no rate-limit wait", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { state } = await start("ac-b");
    vi.stubGlobal("fetch", vi.fn(async () => tokenAnswer()));
    await completeAskCartConnect({ state, code: "c", shop: null, userId: user });
    const c = await conn("ac-b");
    let statusAtRevoke: string | null = null;
    const revoke = vi.fn(async (_url: string, init: RequestInit) => {
      statusAtRevoke = (await prisma.integrationConnection.findUniqueOrThrow({ where: { id: c.id } })).status;
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "retry-after": "1" } });
    });
    vi.stubGlobal("fetch", revoke);
    auth.brandId = "ac-b";
    const res = await DELETE(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ workspaceId: "w", brandId: "b", connectionId: c.id }) });
    expect(res.status).toBe(200);
    expect(statusAtRevoke).toBe("REVOKED");
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});

describe("per-brand mode: review fixes", () => {
  beforeEach(() => {
    vi.stubEnv("ASKCART_CLIENT_ID", "portal");
    vi.stubEnv("ASKCART_CLIENT_SECRET", CLIENT_SECRET);
  });
  async function startState(brandId: string, shop: string) {
    const res = await connect(brandId, { shop });
    return new URL(((await res.json()) as { url: string }).url).searchParams.get("state")!;
  }

  it("the typed shop is kept with the state: a token answer for another store is refused even without a callback shop", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const state = await startState("ac-a", "a.myshopify.com");
    expect(await prisma.oAuthStateTransaction.findFirstOrThrow({ where: { brandId: "ac-a" } })).toMatchObject({ shop: "a.myshopify.com" });
    vi.stubGlobal("fetch", vi.fn(async () => json({ access_token: "t", shop: { domain: "b.myshopify.com", name: "B" } })));
    await expect(completeAskCartConnect({ state, code: "c", shop: null, userId: user })).rejects.toThrow("different store");
    expect(await prisma.integrationConnection.count()).toBe(0);
  });

  it("the PKCE verifier is cleared when the state is used", async () => {
    const state = await startState("ac-a", "a.myshopify.com");
    vi.stubGlobal("fetch", vi.fn(async () => json({ access_token: "t", shop: { domain: "a.myshopify.com", name: "A" } })));
    await completeAskCartConnect({ state, code: "c", shop: null, userId: user });
    expect(await prisma.oAuthStateTransaction.findFirstOrThrow({ where: { brandId: "ac-a" } })).toMatchObject({ codeVerifier: null });
  });

  it("two reads at once refresh once: the second waits and uses the new token, never marking the connection", async () => {
    const state = await startState("ac-a", "a.myshopify.com");
    vi.stubGlobal("fetch", vi.fn(async () => json({ access_token: "tok_1", refresh_token: "ref_1", expires_in: 60, shop: { domain: "a.myshopify.com", name: "A" } })));
    await completeAskCartConnect({ state, code: "c", shop: null, userId: user });
    const c = await conn("ac-a");
    // AskCart rotates refresh tokens: ref_1 works once, a second use is refused.
    let used = false;
    const f = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      if (used) return json({ error: "invalid_grant" }, 400);
      used = true;
      return json({ access_token: "tok_2", refresh_token: "ref_2", expires_in: 3600 });
    });
    vi.stubGlobal("fetch", f);
    expect(await Promise.all([askCartToken(c), askCartToken(c)])).toEqual(["tok_2", "tok_2"]);
    expect(f).toHaveBeenCalledOnce();
    expect(await conn("ac-a")).toMatchObject({ status: "ACTIVE" });
  });

  it("a single-store connection left after switching to per-brand asks to connect again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await prisma.integrationConnection.create({
      data: { workspaceId: ws, brandId: "ac-a", provider: "SHOPIFY", externalAccountId: "askcart", displayName: "B&C", scopes: ["askcart"], credentialKeyVersion: 1, encryptedCredentials: "x", connectedByUserId: user },
    });
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(runCatalogSync({ workspaceId: ws, brandId: "ac-a" })).rejects.toBeInstanceOf(ReconnectNeeded);
    expect(f).not.toHaveBeenCalled();
    expect(await conn("ac-a")).toMatchObject({ status: "ERROR", lastError: ASKCART_MODE_CHANGED });
  });
});

describe("INTERIM single-store mode", () => {
  beforeEach(() => vi.stubEnv("ASKCART_SECRET", SECRET));

  it("saves the shop's name with no secret, and queues a catalogue sync", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ name: "B&C", currencyCode: "INR" })));
    const res = await connect("ac-a");
    expect(res.status).toBe(201);
    const c = await conn("ac-a");
    expect(c).toMatchObject({ provider: "SHOPIFY", externalAccountId: "askcart", displayName: "B&C", status: "ACTIVE", scopes: ["askcart"] });
    expect(JSON.stringify(c)).not.toContain(SECRET);
    expect(decryptCredentials<{ accessToken: string }>(c.encryptedCredentials!).accessToken).toBe("");
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

    await disconnect({ workspaceId: ws, brandId: "ac-a", connectionId: (await conn("ac-a")).id, userId: user });
    expect((await connect("ac-b")).status).toBe(201);
  });

  it("AskCart refusing or unreachable saves nothing; unset env is 422; without integrations.manage 403", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "store_reconnect_needed" }, 503)));
    expect((await connect("ac-a")).status).toBe(422);
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "upstream_error" }, 502)));
    expect((await connect("ac-a")).status).toBe(502);
    auth.perms = new Set();
    try {
      expect((await connect("ac-a")).status).toBe(403);
    } finally {
      auth.perms = new Set(["integrations.manage"]);
    }
    vi.stubEnv("ASKCART_URL", "");
    expect((await connect("ac-a")).status).toBe(422);
    expect(await prisma.integrationConnection.count()).toBe(0);
  });

  it("a walk cut short resumes from its cursor next run; the run that completes it archives only what no run saw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ name: "B&C", currencyCode: "INR" })));
    await connect("ac-a");
    await prisma.product.create({ data: { workspaceId: ws, brandId: "ac-a", source: "SHOPIFY", externalId: "gid://shopify/ProductVariant/9", title: "old" } });

    vi.stubGlobal("fetch", vi.fn(async () => json({ items: [PRODUCT(1)], nextCursor: "c1", complete: false, rateLimited: true })));
    await runCatalogSync({ workspaceId: ws, brandId: "ac-a" });
    expect(await lastSync("ac-a")).toMatchObject({ reason: "partial", walk: { cursor: "c1" } });

    // A failing run keeps the walk.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "upstream_error" }, 502)));
    await expect(runCatalogSync({ workspaceId: ws, brandId: "ac-a" })).rejects.toThrow();
    expect(await lastSync("ac-a")).toMatchObject({ reason: "failed", walk: { cursor: "c1" } });

    const f = vi.fn(async () => json({ items: [PRODUCT(2)], nextCursor: null, complete: true }));
    vi.stubGlobal("fetch", f);
    await runCatalogSync({ workspaceId: ws, brandId: "ac-a" });
    expect(new URL((f.mock.calls[0] as unknown as [string])[0]).searchParams.get("cursor")).toBe("c1");
    expect(await live("ac-a")).toEqual(["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/2"]);
    const done = await lastSync("ac-a");
    expect(done).toMatchObject({ source: "SHOPIFY", count: 2, error: null });
    expect(done.walk).toBeUndefined();
  });

  it("a walk is ignored by another connection, dropped when AskCart refuses its cursor, and never shown on the products route", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => json({ name: "B&C", currencyCode: "INR" })));
    await connect("ac-a");
    const c = await conn("ac-a");
    const stale = { cursor: "other", startedAt: new Date().toISOString(), connectionId: "another" };
    await prisma.brandProfile.updateMany({ where: { brandId: "ac-a" }, data: { catalogSync: { at: "x", source: "SHOPIFY", count: 1, error: null, walk: stale } } });
    let f = vi.fn(async () => json({ items: [PRODUCT(1)], nextCursor: "c1", complete: false, rateLimited: true }));
    vi.stubGlobal("fetch", f);
    await runCatalogSync({ workspaceId: ws, brandId: "ac-a" });
    expect(new URL((f.mock.calls[0] as unknown as [string])[0]).searchParams.get("cursor")).toBeNull();
    expect(await lastSync("ac-a")).toMatchObject({ walk: { cursor: "c1", connectionId: c.id } });

    auth.perms = new Set(["integrations.manage", "brand.read"]);
    try {
      const body = (await (await products(new Request("http://x?status=1"), { params })).json()) as { catalogSync: Record<string, unknown> };
      expect(body.catalogSync).toMatchObject({ source: "SHOPIFY" });
      expect(body.catalogSync.walk).toBeUndefined();
    } finally {
      auth.perms = new Set(["integrations.manage"]);
    }

    f = vi.fn(async () => json({ error: "invalid_cursor" }, 400));
    vi.stubGlobal("fetch", f);
    await expect(runCatalogSync({ workspaceId: ws, brandId: "ac-a" })).rejects.toThrow("AskCart 400 invalid_cursor");
    expect((await lastSync("ac-a")).walk).toBeUndefined();
  });

  it("store_reconnect_needed leaves the connection active and tells the merchant to open AskCart", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => json({ name: "B&C", currencyCode: "INR" })));
    await connect("ac-a");
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "store_reconnect_needed" }, 503)));
    await expect(runCatalogSync({ workspaceId: ws, brandId: "ac-a" })).rejects.toThrow("AskCart 503 store_reconnect_needed");
    expect(await conn("ac-a")).toMatchObject({ status: "ACTIVE" });
    expect(await lastSync("ac-a")).toMatchObject({ reason: "failed", error: ASKCART_STORE_LAPSED });
  });
});
