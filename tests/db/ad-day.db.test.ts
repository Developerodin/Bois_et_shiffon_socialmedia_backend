import { unzipSync, strFromU8 } from "fflate";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ perms: new Set<string>(), brandId: "ad-a", userId: "u1" }));
vi.mock("@/server/api/brand-route", async () => {
  const { AccessDeniedError } = await import("@/server/auth/errors");
  return {
    authorizeBrandRoute: vi.fn(async (_r: Request, _p: unknown, key: string) => {
      if (!auth.perms.has(key)) throw new AccessDeniedError(`Missing permission ${key}`);
      return { userId: auth.userId, workspaceId: ws, brandId: auth.brandId, perms: auth.perms, clientReviewer: false };
    }),
  };
});
vi.mock("@/server/jobs/runner", () => ({ kickRunner: vi.fn() }));
const meta = vi.hoisted(() => ({ fetchAdWindow: vi.fn(), metaAdAccounts: vi.fn() }));
vi.mock("@/server/data/meta-ads", async (orig) => ({ ...(await orig<object>()), fetchAdWindow: meta.fetchAdWindow }));
vi.mock("@/server/integrations/providers", async (orig) => ({ ...(await orig<object>()), metaAdAccounts: meta.metaAdAccounts }));
vi.mock("@/server/services/connections", async (orig) => ({ ...(await orig<object>()), accessToken: vi.fn(async () => "EAAB-secret") }));

import type { DataSource, IntegrationConnection } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { brandAccess } from "@/server/auth/access";
import { ensureSystemRoles } from "@/server/auth/permissions";
import { DATA_SYNC_JOB, runSync, type SyncContext } from "@/server/data/sources";
import type { AdWindow, CampaignDay } from "@/server/data/meta-ads";
import "@/server/data/meta-ads-sync";
import { chooseMetaAdAccount } from "@/server/integrations/meta-ads";
import { GET as summary } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/ads/summary/route";
import { GET as campaigns } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/ads/campaigns/route";
import { GET as exportAds } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/ads/export/route";

/**
 * Meta Ads against Postgres: choosing an account saves its source and queues one backfill, the runner's range
 * replace, and the ads routes' permission, currency and export rules.
 */
let ws: string;
let conn: IntegrationConnection;
const params = Promise.resolve({ workspaceId: "w", brandId: "b" });
const req = (path: string) => new Request(`http://x/api/${path}`);

const camp = (campaignId: string, spend: string, purchases = 0, purchaseValue = "0", name = `Campaign ${campaignId}`): CampaignDay => ({
  campaignId, name, spend, impressions: 100, clicks: 10, purchases, purchaseValue,
});
const window = (days: AdWindow["days"], extra: Partial<AdWindow> = {}): AdWindow => ({ days, currency: "EUR", timeZone: "Europe/Paris", ...extra });

async function adSource(brandId: string, externalId: string, currency = "EUR") {
  return prisma.dataSource.create({
    data: { workspaceId: ws, brandId, kind: "META_ADS", connectionId: conn.id, externalId, label: "Acct", settings: { currency, timeZone: "Europe/Paris" } },
  });
}
const ctx = (source: DataSource, w?: { from: string; to: string }): SyncContext => ({
  source, connection: conn, mode: w ? "backfill" : "daily", window: w, lease: { jobId: "j", leasedBy: null }, signal: new AbortController().signal,
});
const rows = (brandId: string) =>
  prisma.adDay.findMany({ where: { brandId }, orderBy: [{ accountId: "asc" }, { day: "asc" }, { campaignId: "asc" }] });

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-ad-day" } })).id;
  for (const id of ["ad-a", "ad-b"]) await prisma.brand.create({ data: { id, workspaceId: ws, slug: id, displayName: id } });
  conn = await prisma.integrationConnection.create({
    data: { workspaceId: ws, brandId: "ad-a", provider: "META_ADS", externalAccountId: "act_1", displayName: "Acct", scopes: ["ads_read"], encryptedCredentials: "x", credentialKeyVersion: 1, connectedByUserId: "u1" },
  });
});
beforeEach(async () => {
  vi.clearAllMocks();
  await prisma.adDay.deleteMany({});
  await prisma.dataSource.deleteMany({});
  await prisma.job.deleteMany({});
  await prisma.rateLimitBucket.deleteMany({});
  auth.perms = new Set(["ads.read"]);
  auth.brandId = "ad-a";
});

describe("choosing an ad account", () => {
  it("creates the META_ADS data source and queues its first backfill window once", async () => {
    meta.metaAdAccounts.mockResolvedValue([{ id: "act_1", name: "Shop ads", currency: "EUR", timezone_name: "Europe/Paris", account_status: 1 }]);
    await chooseMetaAdAccount({ workspaceId: ws, brandId: "ad-a", userId: "u1" }, conn.id);
    const sources = await prisma.dataSource.findMany({ where: { brandId: "ad-a" } });
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ kind: "META_ADS", externalId: "act_1", connectionId: conn.id, label: "Shop ads", settings: { currency: "EUR", timeZone: "Europe/Paris" }, status: "ACTIVE" });
    const jobs = await prisma.job.findMany({ where: { type: DATA_SYNC_JOB } });
    expect(jobs).toHaveLength(1);
    const p = jobs[0]!.payload as { mode: string; from: string; to: string; end: string; dataSourceId: string };
    expect(p).toMatchObject({ mode: "backfill", dataSourceId: sources[0]!.id });
    // 90 days ending yesterday, 7-day windows oldest first
    expect((Date.parse(p.end) - Date.parse(p.from)) / 86_400_000 + 1).toBe(90);
    expect((Date.parse(p.to) - Date.parse(p.from)) / 86_400_000 + 1).toBe(7);
    expect(JSON.stringify(p)).not.toContain("EAAB");

    // Choosing it again keeps one source, switches it back on and starts the backfill over.
    await prisma.dataSource.update({ where: { id: sources[0]!.id }, data: { status: "OFF", syncedThrough: new Date("2026-01-01") } });
    await chooseMetaAdAccount({ workspaceId: ws, brandId: "ad-a", userId: "u1" }, conn.id);
    const again = await prisma.dataSource.findMany({ where: { brandId: "ad-a" } });
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ status: "ACTIVE", syncedThrough: null });
  });
});

describe("META_ADS sync", () => {
  it("replaces a day range: the same window twice writes the same rows, a dropped campaign is gone, others untouched", async () => {
    const s = await adSource("ad-a", "act_1");
    const other = await adSource("ad-a", "act_2");
    await prisma.adDay.create({
      data: { workspaceId: ws, brandId: "ad-a", platform: "META", accountId: "act_2", campaignId: "x", campaignName: "x", day: new Date("2026-11-02"), currency: "EUR", spend: "1", impressions: 0, clicks: 0, purchases: 0, purchaseValue: "0" },
    });
    const days = [
      { day: "2026-11-01", campaigns: [camp("c1", "12.30", 2, "40.00"), camp("c2", "5")] },
      { day: "2026-11-02", campaigns: [camp("c1", "1.10")] },
    ];
    meta.fetchAdWindow.mockResolvedValue(window(days));
    expect(await runSync("META_ADS", ctx(s, { from: "2026-11-01", to: "2026-11-02" }))).toEqual({ count: 3, complete: true, reason: null });
    const first = await rows("ad-a");
    meta.fetchAdWindow.mockResolvedValue(window(days));
    await runSync("META_ADS", ctx(s, { from: "2026-11-01", to: "2026-11-02" }));
    const second = await rows("ad-a");
    expect(second.map(({ id: _, ...r }) => r)).toEqual(first.map(({ id: _, ...r }) => r));
    expect(second.find((r) => r.campaignId === "c1" && r.day.toISOString().startsWith("2026-11-01"))?.spend.toString()).toBe("12.3");
    expect(meta.fetchAdWindow).toHaveBeenCalledWith("EAAB-secret", "1", "2026-11-01", "2026-11-02");

    meta.fetchAdWindow.mockResolvedValue(window([{ day: "2026-11-01", campaigns: [camp("c1", "12.30", 2, "40.00")] }, { day: "2026-11-02", campaigns: [] }]));
    await runSync("META_ADS", ctx(s, { from: "2026-11-01", to: "2026-11-02" }));
    const after = await rows("ad-a");
    expect(after.filter((r) => r.accountId === "act_1").map((r) => r.campaignId)).toEqual(["c1"]);
    expect(after.filter((r) => r.accountId === "act_2")).toHaveLength(1); // the other account's day is kept
    expect(other.id).toBeTruthy();
  });

  it("a daily run re-reads the last 7 account days", async () => {
    const s = await adSource("ad-a", "act_1");
    meta.fetchAdWindow.mockResolvedValue(window([]));
    await runSync("META_ADS", ctx(s));
    const [, , from, to] = meta.fetchAdWindow.mock.calls[0]!;
    expect((Date.parse(to) - Date.parse(from)) / 86_400_000 + 1).toBe(7);
  });

  it("a rate-limited window keeps the chunks read and is partial; a disabled account is permission and writes nothing", async () => {
    const s = await adSource("ad-a", "act_1");
    meta.fetchAdWindow.mockResolvedValue(window([{ day: "2026-11-01", campaigns: [camp("c1", "3")] }], { stoppedReason: "rate_limited" }));
    expect(await runSync("META_ADS", ctx(s, { from: "2026-11-01", to: "2026-11-10" }))).toEqual({ count: 1, complete: false, reason: "rate-limited" });
    await prisma.adDay.deleteMany({});
    meta.fetchAdWindow.mockResolvedValue(window([{ day: "2026-11-01", campaigns: [camp("c1", "3")] }], { stoppedReason: "permission", disabled: true }));
    expect(await runSync("META_ADS", ctx(s, { from: "2026-11-01", to: "2026-11-01" }))).toEqual({ count: 0, complete: false, reason: "permission" });
    expect(await rows("ad-a")).toHaveLength(0);
  });

  it("a currency change at Meta writes nothing and throws; a refused token marks the connection", async () => {
    const s = await adSource("ad-a", "act_1");
    meta.fetchAdWindow.mockResolvedValue(window([{ day: "2026-11-01", campaigns: [camp("c1", "3")] }], { currency: "USD" }));
    await expect(runSync("META_ADS", ctx(s, { from: "2026-11-01", to: "2026-11-01" }))).rejects.toThrow();
    expect(await rows("ad-a")).toHaveLength(0);
    meta.fetchAdWindow.mockResolvedValue(window([], { stoppedReason: "reconnect" }));
    await expect(runSync("META_ADS", ctx(s))).rejects.toThrow();
    expect((await prisma.integrationConnection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe("ERROR");
    await prisma.integrationConnection.update({ where: { id: conn.id }, data: { status: "ACTIVE", lastError: null } });
  });
});

describe("ads routes", () => {
  async function seedDays() {
    const base = { workspaceId: ws, platform: "META" as const, impressions: 100, clicks: 5 };
    await prisma.adDay.createMany({
      data: [
        { ...base, brandId: "ad-a", accountId: "act_1", campaignId: "c1", campaignName: "Old name", day: new Date("2026-11-01"), currency: "EUR", spend: "10.00", purchases: 2, purchaseValue: "50.00" },
        { ...base, brandId: "ad-a", accountId: "act_1", campaignId: "c1", campaignName: "=HYPERLINK(\"http://evil\",\"x\")", day: new Date("2026-11-02"), currency: "EUR", spend: "5.50", purchases: 1, purchaseValue: "0.00" },
        { ...base, brandId: "ad-a", accountId: "act_9", campaignId: "c9", campaignName: "India", day: new Date("2026-11-01"), currency: "INR", spend: "0.00", purchases: 0, purchaseValue: "0.00" },
        { ...base, brandId: "ad-a", accountId: "act_1", campaignId: "c1", campaignName: "Before", day: new Date("2026-10-30"), currency: "EUR", spend: "4.00", purchases: 0, purchaseValue: "8.00" },
        { ...base, brandId: "ad-b", accountId: "act_5", campaignId: "c5", campaignName: "Other brand", day: new Date("2026-11-01"), currency: "EUR", spend: "999.00", purchases: 9, purchaseValue: "999.00" },
      ],
    });
  }

  it("summary: one total per currency, never summed; ROAS and CPP null on zero; the previous period; other brands never", async () => {
    await seedDays();
    const res = await summary(req("ads/summary?from=2026-11-01&to=2026-11-02"), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      totals: [
        { currency: "EUR", spend: "15.50", purchases: 3, purchaseValue: "50.00", roas: 3.23, costPerPurchase: "5.17" },
        { currency: "INR", spend: "0.00", purchases: 0, purchaseValue: "0.00", roas: null, costPerPurchase: null },
      ],
      previous: [{ currency: "EUR", spend: "4.00", purchases: 0, purchaseValue: "8.00", roas: 2, costPerPurchase: null }],
      previousRange: { from: "2026-10-30", to: "2026-10-31" },
      budget: null,
    });
  });

  it("campaigns: per campaign and currency with the latest name, highest spend first", async () => {
    await seedDays();
    const body = await (await campaigns(req("ads/campaigns?from=2026-11-01&to=2026-11-02"), { params })).json();
    expect(body.campaigns).toEqual([
      { accountId: "act_1", campaignId: "c1", campaignName: "=HYPERLINK(\"http://evil\",\"x\")", currency: "EUR", spend: "15.50", purchases: 3, purchaseValue: "50.00", roas: 3.23, costPerPurchase: "5.17", impressions: 200, clicks: 10 },
      { accountId: "act_9", campaignId: "c9", campaignName: "India", currency: "INR", spend: "0.00", purchases: 0, purchaseValue: "0.00", roas: null, costPerPurchase: null, impressions: 100, clicks: 5 },
    ]);
  });

  it("needs ads.read: a client reviewer and a viewer get 403 on every ads route", async () => {
    await seedDays();
    await ensureSystemRoles(ws);
    const role = Object.fromEntries((await prisma.role.findMany({ where: { workspaceId: ws } })).map((r) => [r.slug, r.id]));
    for (const slug of ["client-reviewer", "viewer"]) {
      const u = (await prisma.user.create({ data: { email: `${slug}@ad-day.test`, name: slug } })).id;
      await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: u, roleId: role.member! } });
      await prisma.brandMember.create({ data: { workspaceId: ws, brandId: "ad-a", userId: u, roleId: role[slug]! } });
      auth.perms = new Set((await brandAccess(ws, "ad-a", u)).perms);
      expect(auth.perms.has("brand.read")).toBe(true);
      for (const res of [
        await summary(req("ads/summary?from=2026-11-01&to=2026-11-02"), { params }),
        await campaigns(req("ads/campaigns?from=2026-11-01&to=2026-11-02"), { params }),
        await exportAds(req("ads/export?format=csv&from=2026-11-01&to=2026-11-02"), { params }),
      ]) {
        expect(res.status, slug).toBe(403);
        expect(await res.text()).not.toMatch(/spend|HYPERLINK|15\.50/);
      }
    }
  });

  it("bad dates, too long a range or a bad format → 400", async () => {
    for (const q of ["", "from=2026-11-01", "from=2026-11-31&to=2026-12-01", "from=2026-11-02&to=2026-11-01", "from=2025-01-01&to=2026-01-02", "from=2026-1-1&to=2026-01-02", "from=x&to=y"]) {
      expect((await summary(req(`ads/summary?${q}`), { params })).status, q).toBe(400);
      expect((await campaigns(req(`ads/campaigns?${q}`), { params })).status, q).toBe(400);
      expect((await exportAds(req(`ads/export?format=xlsx&${q}`), { params })).status, q).toBe(400);
    }
    expect((await exportAds(req("ads/export?format=pdf&from=2026-11-01&to=2026-11-02"), { params })).status).toBe(400);
    expect((await summary(req("ads/summary?from=2025-01-01&to=2026-01-01"), { params })).status).toBe(200); // 366 days
  });

  it("xlsx: numbers are numeric cells, a =HYPERLINK(...) campaign name is a string cell; filename from the days", async () => {
    await seedDays();
    const res = await exportAds(req("ads/export?format=xlsx&from=2026-11-01&to=2026-11-02"), { params });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="ads-2026-11-01-2026-11-02.xlsx"');
    const sheet = strFromU8(unzipSync(new Uint8Array(await res.arrayBuffer()))["xl/worksheets/sheet1.xml"]!);
    expect(sheet).not.toContain("<f>");
    expect(sheet).toMatch(/t="inlineStr"><is><t xml:space="preserve">=HYPERLINK\(&quot;http:\/\/evil&quot;,&quot;x&quot;\)<\/t>/);
    expect(sheet).toContain("<v>5.5</v>"); // spend
    expect(sheet).toContain("<v>10</v>");
    expect(sheet).not.toContain("Other brand");
  });

  it("csv: a name starting with = is escaped; numbers stay plain; the 20-an-hour export limit applies", async () => {
    await seedDays();
    const res = await exportAds(req("ads/export?format=csv&from=2026-11-01&to=2026-11-02"), { params });
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="ads-2026-11-01-2026-11-02.csv"');
    const csv = await res.text();
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csv).toContain("2026-11-01,act_1,Old name,EUR,10,100,5,2,50,5,5");
    for (let i = 1; i < 20; i++) await exportAds(req("ads/export?format=csv&from=2026-11-01&to=2026-11-02"), { params });
    expect((await exportAds(req("ads/export?format=csv&from=2026-11-01&to=2026-11-02"), { params })).status).toBe(429);
  });
});
