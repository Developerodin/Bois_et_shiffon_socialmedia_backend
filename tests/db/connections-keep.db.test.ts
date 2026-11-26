import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ perms: new Set<string>(), userId: "u1" }));
vi.mock("@/server/api/brand-route", async () => {
  const { AccessDeniedError } = await import("@/server/auth/errors");
  return {
    authorizeBrandRoute: vi.fn(async (_r: Request, _p: unknown, key: string) => {
      if (!auth.perms.has(key)) throw new AccessDeniedError(`Missing permission ${key}`);
      return { userId: auth.userId, workspaceId: ws, brandId: B, perms: auth.perms, clientReviewer: false };
    }),
  };
});
const meta = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock("@/server/integrations/meta-ads-token", async (orig) => ({ ...(await orig<object>()), checkSystemToken: meta.check }));
vi.mock("@/server/jobs/runner", () => ({ kickRunner: vi.fn() }));

import { prisma } from "@/server/db/prisma";
import { SYSTEM_ROLES } from "@/server/auth/permissions.catalog";
import { decryptCredentials } from "@/server/crypto/credentials";
import { SystemTokenRefused } from "@/server/integrations/meta-ads-token";
import { metaAccountsToConnections, type MetaAdAccount } from "@/server/integrations/providers";
import { saveConnections } from "@/server/services/connections";
import { POST } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/integrations/meta-ads/system-token/route";

/** The Meta system user token against Postgres: the keep rule (also under two real parallel transactions) and the route. */
let ws: string;
const B = "ck-a";
const SYSTEM = "EAABsystemtoken0123456789abcdef";
const PERSONAL = "EAABpersonaltoken0123456789abcdef";
const params = Promise.resolve({ workspaceId: "w", brandId: "b" });
const roleKeys = (slug: string) => new Set<string>(SYSTEM_ROLES.find((r) => r.slug === slug)!.permissions);
const account = (id: string): MetaAdAccount => ({ id, name: `Ads ${id}`, currency: "EUR", timezone_name: "Europe/Paris", account_status: 1 });
const in60 = () => new Date(Date.now() + 60 * 86_400_000);

const save = (token: string, ids: string[], opts: { keep?: true; expires?: Date | null } = {}) =>
  saveConnections({
    workspaceId: ws, brandId: B, provider: "META_ADS", userId: "u1",
    accounts: metaAccountsToConnections(ids.map(account), token, opts.expires === undefined ? in60() : opts.expires, ["ads_read"]),
    ...(opts.keep ? { keep: true as const } : {}),
  });
const tokenOf = async (id: string) => {
  const c = await prisma.integrationConnection.findFirstOrThrow({ where: { brandId: B, provider: "META_ADS", externalAccountId: id } });
  return { token: decryptCredentials<{ accessToken: string }>(c.encryptedCredentials!).accessToken, expires: c.tokenExpiresAt, id: c.id };
};
const post = (token: unknown) => POST(new Request("http://x", { method: "POST", body: JSON.stringify({ token }) }), { params });

beforeAll(async () => {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-connections-keep" } })).id;
  await prisma.brand.create({ data: { id: B, workspaceId: ws, slug: B, displayName: B } });
});
beforeEach(async () => {
  auth.perms = roleKeys("manager");
  meta.check.mockReset();
  await prisma.dataSource.deleteMany({});
  await prisma.integrationConnection.deleteMany({});
  await prisma.auditEvent.deleteMany({});
  await prisma.rateLimitBucket.deleteMany({});
});

describe("saveConnections keep (personal Meta Ads logins)", () => {
  it("a personal login later keeps a working system token; others are written", async () => {
    await save(SYSTEM, ["act_1"], { expires: null });
    const rows = await save(PERSONAL, ["act_1", "act_2"], { keep: true });
    expect(rows.map((r) => r.externalAccountId)).toEqual(["act_2"]);
    expect(rows.kept).toEqual(["act_1"]);
    expect(await tokenOf("act_1")).toMatchObject({ token: SYSTEM, expires: null });
    expect((await tokenOf("act_2")).token).toBe(PERSONAL);
  });

  it("a system token stopped at permission (or reconnect) → the personal login replaces it", async () => {
    await save(SYSTEM, ["act_1"], { expires: null });
    const { id } = await tokenOf("act_1");
    // A stop the sync recorded after the system token was saved.
    const at = new Date(Date.now() + 1000).toISOString();
    await prisma.dataSource.create({ data: { workspaceId: ws, brandId: B, kind: "META_ADS", externalId: "act_1", connectionId: id, lastResult: { at, okAt: null, reason: "permission", count: 0, error: "e" } } });
    const rows = await save(PERSONAL, ["act_1"], { keep: true });
    expect(rows.kept).toEqual([]);
    expect(await tokenOf("act_1")).toMatchObject({ token: PERSONAL, id });
    expect((await tokenOf("act_1")).expires).toBeInstanceOf(Date);
  });

  it("all accounts kept → the audit names the kept connection", async () => {
    await save(SYSTEM, ["act_1"], { expires: null });
    const { id } = await tokenOf("act_1");
    await prisma.auditEvent.deleteMany({});
    const rows = await save(PERSONAL, ["act_1"], { keep: true });
    expect(rows).toHaveLength(0);
    const [audit] = await prisma.auditEvent.findMany({ where: { workspaceId: ws } });
    expect(audit).toMatchObject({ entityId: id, action: "integration.connected" });
    expect(audit.metadata).toMatchObject({ kept: ["Ads act_1"], accounts: [] });
  });

  it("a stop recorded before the system token was saved doesn't let a personal login replace it", async () => {
    await save(PERSONAL, ["act_1"]);
    const { id } = await tokenOf("act_1");
    await prisma.dataSource.create({ data: { workspaceId: ws, brandId: B, kind: "META_ADS", externalId: "act_1", connectionId: id, lastResult: { at: new Date(Date.now() - 60_000).toISOString(), okAt: null, reason: "reconnect", count: 0, error: "e" } } });
    await save(SYSTEM, ["act_1"], { expires: null });
    expect((await save(PERSONAL, ["act_1"], { keep: true })).kept).toEqual(["act_1"]);
    expect(await tokenOf("act_1")).toMatchObject({ token: SYSTEM, expires: null });
  });

  it("paste and OAuth at once: the login waits on the paste's open transaction, then keeps the system token", async () => {
    await save(PERSONAL, ["act_1"]);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let pasted!: () => void;
    const written = new Promise<void>((r) => (pasted = r));
    // The paste writes its row, then holds its transaction open (row locked) until released.
    const paste = saveConnections({
      workspaceId: ws, brandId: B, provider: "META_ADS", userId: "u1", accounts: metaAccountsToConnections([account("act_1")], SYSTEM, null, ["ads_read"]),
      after: async () => {
        pasted();
        await held;
      },
    });
    await written;
    const login = save(PERSONAL, ["act_1"], { keep: true });
    // Release only once the login's statement is waiting on the paste's row lock.
    for (let i = 0; i < 100; i++) {
      const [w] = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO "IntegrationConnection"%'`;
      if (w.n > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    release();
    await paste;
    const rows = await login;
    expect(rows.kept).toEqual(["act_1"]);
    expect(rows).toHaveLength(0);
    expect(await tokenOf("act_1")).toMatchObject({ token: SYSTEM, expires: null });
  });

  it("without keep: today's upsert, [conn] still works and kept is empty", async () => {
    const [conn] = await saveConnections({
      workspaceId: ws, brandId: B, provider: "SHOPIFY", userId: "u1",
      accounts: [{ externalAccountId: "shop.myshopify.com", displayName: "Shop", credentials: { accessToken: "shpat_x" }, tokenExpiresAt: null, scopes: ["read_products"] }],
    });
    expect(conn.externalAccountId).toBe("shop.myshopify.com");
    expect((await saveConnections({ workspaceId: ws, brandId: B, provider: "SHOPIFY", userId: "u1", accounts: [{ externalAccountId: "shop.myshopify.com", displayName: "Shop 2", credentials: { accessToken: "shpat_y" }, tokenExpiresAt: null, scopes: [] }] })).kept).toEqual([]);
  });
});

describe("POST integrations/meta-ads/system-token", () => {
  it("clears the old token's stop on its sources (reason and ERROR) in the save", async () => {
    await save(PERSONAL, ["act_1"]);
    const { id } = await tokenOf("act_1");
    const okAt = "2026-11-20T00:00:00.000Z";
    const src = await prisma.dataSource.create({
      data: { workspaceId: ws, brandId: B, kind: "META_ADS", externalId: "act_1", connectionId: id, status: "ERROR", settings: { currency: "EUR" },
        lastResult: { at: new Date().toISOString(), okAt, reason: "reconnect", count: 0, error: "e" } },
    });
    meta.check.mockResolvedValue({ scopes: ["ads_read"], accounts: [account("act_1")] });
    expect((await post(SYSTEM)).status).toBe(201);
    const after = await prisma.dataSource.findUniqueOrThrow({ where: { id: src.id } });
    expect(after.status).toBe("ACTIVE");
    expect(after.lastResult).toMatchObject({ reason: null, error: null, okAt });
    // A personal login right after keeps the fresh system token.
    expect((await save(PERSONAL, ["act_1"], { keep: true })).kept).toEqual(["act_1"]);
  });

  it("a valid token saves the accounts with no expiry, replacing a personal login in place; token never in the response", async () => {
    await save(PERSONAL, ["act_1"]);
    const before = await tokenOf("act_1");
    meta.check.mockResolvedValue({ scopes: ["ads_read"], accounts: [account("act_1"), account("act_2")] });
    const res = await post(`  ${SYSTEM}  `);
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(SYSTEM);
    expect(meta.check).toHaveBeenCalledWith(SYSTEM);
    expect(await tokenOf("act_1")).toMatchObject({ token: SYSTEM, expires: null, id: before.id });
    expect(await tokenOf("act_2")).toMatchObject({ token: SYSTEM, expires: null });
    const audit = await prisma.auditEvent.findFirst({ where: { workspaceId: ws, action: "integration.connected" }, orderBy: { createdAt: "desc" } });
    expect(audit!.metadata).toMatchObject({ kind: "system_user", replaced: ["act_1"] });
    expect(JSON.stringify(audit)).not.toContain(SYSTEM);
  });

  it("a refused token → its fixed message, nothing saved", async () => {
    meta.check.mockRejectedValue(new SystemTokenRefused(422, "This is a personal token, not a system user token"));
    const res = await post(SYSTEM);
    expect(res.status).toBe(422);
    expect((await res.json()).detail).toBe("This is a personal token, not a system user token");
    expect(await prisma.integrationConnection.count()).toBe(0);
  });

  it("a malformed token is refused before any Meta call; the rate limit counts failed checks", async () => {
    expect((await post("short")).status).toBe(422);
    expect((await post("has spaces inside the token value!!")).status).toBe(422);
    meta.check.mockRejectedValue(new SystemTokenRefused(422, "This token can't read ads"));
    for (let i = 0; i < 3; i++) expect((await post(SYSTEM)).status).toBe(422);
    expect((await post(SYSTEM)).status).toBe(429);
    expect(meta.check).toHaveBeenCalledTimes(3);
  });

  it("client reviewer → 403", async () => {
    auth.perms = roleKeys("client-reviewer");
    expect((await post(SYSTEM)).status).toBe(403);
    expect(meta.check).not.toHaveBeenCalled();
  });
});
