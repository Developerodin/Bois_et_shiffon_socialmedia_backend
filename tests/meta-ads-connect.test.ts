// recorded 2026-11-23, Graph API v23.0 (shapes from docs)
import { ContentChannel } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  oAuthStateTransaction: { create: vi.fn(async () => ({})) },
  integrationConnection: { findFirst: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
  dataSource: { upsert: vi.fn(async () => ({ id: "ds1" })) },
}));
const backfill = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@/server/data/meta-ads-sync", () => ({ enqueueAdsBackfill: backfill }));
const rate = vi.hoisted(() => vi.fn(async () => ({ allowed: true })));
vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/auth/rate-limit", () => ({ hitRateLimit: rate }));
vi.mock("@/server/crypto/credentials", () => ({ currentKeyVersion: () => 1, encryptCredentials: () => "sealed", decryptCredentials: () => ({ accessToken: "EAAB-long-lived-secret" }) }));

import { chooseMetaAdAccount, listMetaAdAccounts } from "@/server/integrations/meta-ads";
import { PROVIDER_SLUGS, PROVIDERS } from "@/server/integrations/providers";
import { PUBLISHERS } from "@/server/integrations/publishers";
import { startConnect } from "@/server/services/connections";
import { publishRequirements } from "@/server/services/publishing";

const TOKEN = "EAAB-long-lived-secret";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const account = (id: string, status = 1) => ({ id, name: `Account ${id}`, currency: "EUR", timezone_name: "Europe/Paris", account_status: status });
const granted = { data: [{ permission: "ads_read", status: "granted" }, { permission: "public_profile", status: "granted" }] };

/** Graph stub: answers by path, records every request. */
function graph(routes: Record<string, unknown[]>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const left = Object.fromEntries(Object.entries(routes).map(([k, v]) => [k, [...v]]));
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname.replace("/v23.0", "");
    const next = left[path]?.shift();
    if (next === undefined) throw new Error(`unexpected ${path}`);
    return next instanceof Response ? next : json(next);
  });
  vi.stubGlobal("fetch", f);
  return calls;
}

const exchange = () =>
  PROVIDERS.META_ADS.exchange({ code: "code", clientId: "app", secret: "shh", redirectUri: "https://x/api/v1/integrations/meta_ads/callback" });

beforeEach(() => {
  vi.clearAllMocks();
  rate.mockResolvedValue({ allowed: true });
  process.env.META_APP_ID = "app";
  process.env.META_APP_SECRET = "shh";
});
afterEach(() => vi.unstubAllGlobals());

describe("Meta Ads login", () => {
  it("consent URL asks ads_read only, on the Meta app, with its own callback", async () => {
    const url = new URL(await startConnect({ workspaceId: "w1", brandId: "b1", userId: "u1", provider: "META_ADS" }));
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v23.0/dialog/oauth");
    expect(url.searchParams.get("scope")).toBe("ads_read");
    expect(url.searchParams.get("client_id")).toBe("app");
    expect(url.searchParams.get("redirect_uri")).toMatch(/\/integrations\/meta_ads\/callback$/);
    expect(db.oAuthStateTransaction.create).toHaveBeenCalledWith({ data: expect.objectContaining({ provider: "META_ADS" }) });
    expect(PROVIDER_SLUGS.meta_ads).toBe("META_ADS");
  });

  it("META connect scopes unchanged: Facebook Pages logins never ask for ad access", () => {
    expect(PROVIDERS.META.scopes).toEqual(["pages_show_list", "pages_manage_posts", "pages_read_engagement", "read_insights", "business_management", "pages_messaging"]);
    expect(Object.entries(PROVIDERS).filter(([, a]) => a.scopes.some((s) => s.startsWith("ads_"))).map(([p]) => p)).toEqual(["META_ADS"]);
  });

  it("one connection per active ad account, across pages built from the after cursor", async () => {
    const calls = graph({
      "/oauth/access_token": [{ access_token: "short" }, { access_token: TOKEN, expires_in: 5_184_000 }],
      "/me/permissions": [granted],
      "/me/adaccounts": [
        { data: [account("act_1"), account("act_2", 2)], paging: { cursors: { after: "CUR1" }, next: `https://graph.facebook.com/v23.0/me/adaccounts?access_token=${TOKEN}&after=CUR1` } },
        { data: [account("act_3")], paging: { cursors: { after: "CUR2" } } },
      ],
    });
    const accounts = await exchange();
    expect(accounts.map((a) => [a.externalAccountId, a.displayName])).toEqual([["act_1", "Account act_1"], ["act_3", "Account act_3"]]);
    expect(accounts.every((a) => a.scopes.join() === "ads_read" && a.credentials.accessToken === TOKEN)).toBe(true);
    const days = (accounts[0].tokenExpiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(59.9);
    const pages = calls.filter((c) => c.url.includes("/me/adaccounts"));
    expect(pages).toHaveLength(2);
    expect(new URL(pages[1].url).searchParams.get("after")).toBe("CUR1");
    // The token rides in a header, never in an account-listing URL, and paging.next is never fetched.
    for (const p of [...pages, ...calls.filter((c) => c.url.includes("/me/permissions"))]) {
      expect(p.url).not.toContain(TOKEN);
      expect(new Headers(p.init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("declined ads_read → a readable error, no accounts read", async () => {
    const calls = graph({
      "/oauth/access_token": [{ access_token: "short" }, { access_token: TOKEN, expires_in: 5_184_000 }],
      "/me/permissions": [{ data: [{ permission: "ads_read", status: "declined" }] }],
    });
    await expect(exchange()).rejects.toThrow("Meta didn't grant ad access");
    expect(calls.some((c) => c.url.includes("/me/adaccounts"))).toBe(false);
  });

  it("no active ad accounts → a readable error", async () => {
    graph({
      "/oauth/access_token": [{ access_token: "short" }, { access_token: TOKEN }],
      "/me/permissions": [granted],
      "/me/adaccounts": [{ data: [account("act_9", 101)] }],
    });
    await expect(exchange()).rejects.toThrow("no active ad accounts");
  });
});

describe("publishing", () => {
  it("can't pick a META_ADS connection: no channel publishes to it and it has no publisher", () => {
    for (const c of Object.values(ContentChannel)) expect(publishRequirements(c).provider).not.toBe("META_ADS");
    expect(PUBLISHERS.META_ADS).toBeUndefined();
  });
});

describe("ad account picker", () => {
  const scope = { workspaceId: "w1", brandId: "b1", userId: "u1" };
  const conn = { id: "c1", workspaceId: "w1", brandId: "b1", provider: "META_ADS", status: "ACTIVE", displayName: "Account act_1", externalAccountId: "act_1", encryptedCredentials: "x", tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000) };

  it("cross-brand connectionId → 404, looked up with brand, workspace and provider", async () => {
    db.integrationConnection.findFirst.mockResolvedValue(null);
    await expect(listMetaAdAccounts(scope, "other-brands-conn")).rejects.toMatchObject({ status: 404 });
    await expect(chooseMetaAdAccount(scope, "other-brands-conn")).rejects.toMatchObject({ status: 404 });
    expect(db.integrationConnection.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "other-brands-conn", brandId: "b1", workspaceId: "w1", provider: "META_ADS" }),
    });
  });

  it("lists the live accounts and chooses the connection's account with its currency and zone", async () => {
    db.integrationConnection.findFirst.mockResolvedValue(conn);
    graph({ "/me/adaccounts": [{ data: [account("act_1"), account("act_3")] }, { data: [account("act_1")] }] });
    expect(await listMetaAdAccounts(scope, "c1")).toEqual([
      { id: "act_1", name: "Account act_1", currency: "EUR", timeZone: "Europe/Paris" },
      { id: "act_3", name: "Account act_3", currency: "EUR", timeZone: "Europe/Paris" },
    ]);
    expect(await chooseMetaAdAccount(scope, "c1")).toEqual({ connectionId: "c1", externalId: "act_1", label: "Account act_1", settings: { currency: "EUR", timeZone: "Europe/Paris" } });
    expect(db.dataSource.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { brandId_kind_externalId: { brandId: "b1", kind: "META_ADS", externalId: "act_1" } },
      create: expect.objectContaining({ workspaceId: "w1", brandId: "b1", kind: "META_ADS", connectionId: "c1" }),
    }));
    expect(backfill).toHaveBeenCalledTimes(1);
    expect(backfill).toHaveBeenCalledWith({ id: "ds1" });
    expect(rate).toHaveBeenCalledWith("meta-ads:accounts:b1:u1", expect.any(Number), 60_000);
  });

  it("an account no longer in the live list can't be chosen", async () => {
    db.integrationConnection.findFirst.mockResolvedValue(conn);
    graph({ "/me/adaccounts": [{ data: [account("act_3")] }] });
    await expect(chooseMetaAdAccount(scope, "c1")).rejects.toMatchObject({ status: 409 });
    expect(db.dataSource.upsert).not.toHaveBeenCalled();
    expect(backfill).not.toHaveBeenCalled();
  });

  it("rate limited per brand + user", async () => {
    db.integrationConnection.findFirst.mockResolvedValue(conn);
    rate.mockResolvedValue({ allowed: false });
    await expect(listMetaAdAccounts(scope, "c1")).rejects.toMatchObject({ status: 429 });
  });

  it("an expired token (190) marks the connection for reconnect; nothing of Meta's text or the URL is logged", async () => {
    db.integrationConnection.findFirst.mockResolvedValue(conn);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    graph({ "/me/adaccounts": [json({ error: { message: "Error validating access token: Session has expired", code: 190 } }, 400)] });
    await expect(listMetaAdAccounts(scope, "c1")).rejects.toThrow("access expired");
    expect(db.integrationConnection.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "c1", status: "ACTIVE" }, data: expect.objectContaining({ status: "ERROR" }) }));
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("graph.facebook.com");
    expect(logged).not.toContain("Session");
    warn.mockRestore();
  });
});
