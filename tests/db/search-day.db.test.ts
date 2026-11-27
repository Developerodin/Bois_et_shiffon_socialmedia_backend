import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchDayResult, SearchWindow } from "@/server/data/search-console";

const auth = vi.hoisted(() => ({ perms: new Set<string>(), brandId: "sc-a", userId: "" }));
const google = vi.hoisted(() => ({
  sites: [] as { siteUrl: string; permissionLevel: string }[],
  window: null as null | ((from: string, to: string) => SearchWindow),
}));
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
vi.mock("@/server/services/connections", async (orig) => ({ ...(await orig<object>()), accessToken: vi.fn(async () => "tok") }));
vi.mock("@/server/data/search-console", async (orig) => ({
  ...(await orig<object>()),
  listSites: vi.fn(async () => google.sites),
  fetchSearchWindow: vi.fn(async (_t: string, _s: string, from: string, to: string) => google.window!(from, to)),
}));

import { prisma } from "@/server/db/prisma";
import { DATA_SYNC_JOB, runDataSync } from "@/server/data/sources";
import "@/server/data/search-sync";
import { ReconnectNeeded } from "@/server/services/connections";
import { GET as getSites } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/google/sites/route";
import { PUT as chooseSite } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/data-sources/search-console/route";
import { GET as getSummary } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/search/summary/route";
import { GET as getPages } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/search/pages/route";
import { GET as getSources } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/data-sources/route";

/** Search Console against Postgres: the SEARCH_CONSOLE runner's writes, the site picker's checks and the reads. */
let ws: string;
let userId: string;
const SITE = "https://a.test/";
const lease = { jobId: "no-job", leasedBy: null };
const params = Promise.resolve({ workspaceId: "w", brandId: "b" });

async function brand(id: string, timeZone?: string) {
  await prisma.brand.create({ data: { id, workspaceId: ws, slug: id, displayName: id } });
  await prisma.brandProfile.create({ data: { workspaceId: ws, brandId: id, websiteUrl: `https://${id}.test`, timeZone } });
}
const connection = (brandId: string, provider: "GOOGLE" | "GOOGLE_BUSINESS" = "GOOGLE") =>
  prisma.integrationConnection.create({
    data: { workspaceId: ws, brandId, provider, externalAccountId: `${brandId}-${provider}`, displayName: "G", scopes: [], status: "ACTIVE", credentialKeyVersion: 1, connectedByUserId: userId, encryptedCredentials: "x" },
  });
const day = (d: string, pages: [string, number][], complete = true, queries: [string, string, number][] | null = []): SearchDayResult => {
  const q = (query: string, page: string, clicks: number) => ({ query, page, clicks, impressions: clicks * 10, positionSum: clicks * 20 });
  return {
    day: d,
    site: { clicks: 100, impressions: 1000, positionSum: 5000 },
    pages: pages.map(([page, clicks]) => ({ page, clicks, impressions: clicks * 10, positionSum: clicks * 20 })),
    skippedPages: 0,
    complete,
    // [query, page, clicks]: page "" is a QUERY row, else QUERY_PAGE; null = the day's query calls failed.
    queries: (queries ?? []).filter(([, p]) => !p).map(([query, , clicks]) => q(query, "", clicks)),
    queryPages: (queries ?? []).filter(([, p]) => p).map(([query, page, clicks]) => q(query, page, clicks)),
    skippedQueries: 0,
    queriesComplete: queries !== null,
  };
};
const queryRows = (brandId = "sc-a") =>
  prisma.searchQueryDay.findMany({
    where: { brandId },
    orderBy: [{ day: "asc" }, { dimension: "asc" }, { query: "asc" }, { page: "asc" }],
    select: { day: true, dimension: true, query: true, page: true, clicks: true },
  });
const dayOf = (r: { day: Date }) => r.day.toISOString().slice(0, 10);
const rows = (brandId = "sc-a") =>
  prisma.searchDay.findMany({
    where: { brandId },
    orderBy: [{ day: "asc" }, { dimension: "asc" }, { page: "asc" }],
    select: { day: true, dimension: true, page: true, clicks: true, impressions: true, positionSum: true, siteUrl: true },
  });

const searchSource = (brandId: string, connectionId: string) =>
  prisma.dataSource.create({ data: { workspaceId: ws, brandId, kind: "SEARCH_CONSOLE", externalId: SITE, connectionId } });
const backfill = (s: { id: string; workspaceId: string; brandId: string }, from: string, to: string) =>
  ({ dataSourceId: s.id, workspaceId: s.workspaceId, brandId: s.brandId, kind: "SEARCH_CONSOLE", mode: "backfill", from, to, end: to });

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-search-day" } })).id;
  userId = (await prisma.user.create({ data: { email: "u@search-day.test", name: "u" } })).id;
  auth.userId = userId;
  await brand("sc-a", "Europe/Paris");
  await brand("sc-b");
});
beforeEach(async () => {
  auth.brandId = "sc-a";
  auth.perms = new Set(["integrations.manage", "analytics.read", "brand.read"]);
  google.sites = [{ siteUrl: SITE, permissionLevel: "siteOwner" }];
  google.window = null;
  await prisma.searchDay.deleteMany({});
  await prisma.searchQueryDay.deleteMany({});
  await prisma.job.deleteMany({});
  await prisma.dataSource.deleteMany({});
  await prisma.integrationConnection.deleteMany({});
  await prisma.rateLimitBucket.deleteMany({});
});

describe("SEARCH_CONSOLE sync", () => {
  it("replaces each day: the same job twice writes the same rows, and a page Google dropped is gone", async () => {
    const s = await searchSource("sc-a", (await connection("sc-a")).id);
    google.window = () => ({ days: [day("2026-11-01", [["https://a.test/x", 5], ["https://a.test/y", 3]]), day("2026-11-02", [["https://a.test/x", 4]])] });
    await runDataSync(backfill(s, "2026-11-01", "2026-11-02"), lease);
    const first = await rows();
    expect(first).toHaveLength(5); // 2 SITE + 3 PAGE
    await runDataSync(backfill(s, "2026-11-01", "2026-11-02"), lease);
    expect(await rows()).toEqual(first);

    google.window = () => ({ days: [day("2026-11-01", [["https://a.test/x", 6]]), day("2026-11-02", [["https://a.test/x", 4]])] });
    await runDataSync(backfill(s, "2026-11-01", "2026-11-02"), lease);
    const pages = (await rows()).filter((r) => r.dimension === "PAGE" && r.day.toISOString().startsWith("2026-11-01"));
    expect(pages).toEqual([expect.objectContaining({ page: "https://a.test/x", clicks: 6, positionSum: 120 })]);
    const src = await prisma.dataSource.findUniqueOrThrow({ where: { id: s.id } });
    expect(src.syncedThrough?.toISOString().slice(0, 10)).toBe("2026-11-02");
    expect(src.lastResult).toMatchObject({ reason: null, count: 4 });
  });

  it("a rate-limit stop writes only the complete days, keeps syncedThrough and retries the window later", async () => {
    const s = await searchSource("sc-a", (await connection("sc-a")).id);
    google.window = () => ({ days: [day("2026-11-01", [["https://a.test/x", 5]]), day("2026-11-02", [["https://a.test/x", 9]], false)], stoppedReason: "rate_limited" });
    await runDataSync(backfill(s, "2026-11-01", "2026-11-02"), lease);
    expect((await rows()).map((r) => r.day.toISOString().slice(0, 10))).toEqual(["2026-11-01", "2026-11-01"]);
    const src = await prisma.dataSource.findUniqueOrThrow({ where: { id: s.id } });
    expect(src.syncedThrough).toBeNull();
    expect(src.lastResult).toMatchObject({ reason: "rate_limited" });
    const retry = await prisma.job.findMany({ where: { type: DATA_SYNC_JOB } });
    expect(retry).toHaveLength(1);
    expect(retry[0].payload).toMatchObject({ from: "2026-11-01", to: "2026-11-02", retry: 1 });
  });

  it("a permission stop writes nothing; a reconnect stop throws ReconnectNeeded and writes nothing", async () => {
    const s = await searchSource("sc-a", (await connection("sc-a")).id);
    google.window = () => ({ days: [day("2026-11-01", [["https://a.test/x", 5]])], stoppedReason: "permission" });
    await runDataSync(backfill(s, "2026-11-01", "2026-11-01"), lease);
    expect(await rows()).toEqual([]);
    expect(await prisma.dataSource.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ status: "ERROR", lastResult: expect.objectContaining({ reason: "permission" }) });

    vi.spyOn(console, "warn").mockImplementation(() => {});
    google.window = () => ({ days: [day("2026-11-01", [["https://a.test/x", 5]])], stoppedReason: "reconnect" });
    await expect(runDataSync(backfill(s, "2026-11-01", "2026-11-01"), lease)).rejects.toBeInstanceOf(ReconnectNeeded);
    expect(await rows()).toEqual([]);
  });

  it("writes only this brand's rows and leaves another brand's same-site rows alone", async () => {
    const other = await searchSource("sc-b", (await connection("sc-b")).id);
    google.window = () => ({ days: [day("2026-11-01", [])] });
    await runDataSync(backfill(other, "2026-11-01", "2026-11-01"), lease);
    const s = await searchSource("sc-a", (await connection("sc-a")).id);
    google.window = () => ({ days: [day("2026-11-01", [["https://a.test/x", 1]])] });
    await runDataSync(backfill(s, "2026-11-01", "2026-11-01"), lease);
    expect(await rows("sc-b")).toHaveLength(1);
    expect(await rows("sc-a")).toHaveLength(2);
  });
});

describe("SEARCH_CONSOLE sync: queries", () => {
  it("replaces a day's query rows when its query calls succeeded, and keeps them when they failed", async () => {
    const s = await searchSource("sc-a", (await connection("sc-a")).id);
    google.window = () => ({
      days: [
        day("2026-11-01", [], true, [["oak table", "", 5], ["oak chair", "", 2], ["oak table", "https://a.test/x", 4]]),
        day("2026-11-02", [], true, [["pine", "", 1]]),
      ],
    });
    await runDataSync(backfill(s, "2026-11-01", "2026-11-02"), lease);
    expect((await queryRows()).map((r) => [dayOf(r), r.dimension, r.query, r.page])).toEqual([
      ["2026-11-01", "QUERY", "oak chair", ""],
      ["2026-11-01", "QUERY", "oak table", ""],
      ["2026-11-01", "QUERY_PAGE", "oak table", "https://a.test/x"],
      ["2026-11-02", "QUERY", "pine", ""],
    ]);
    expect((await prisma.dataSource.findUniqueOrThrow({ where: { id: s.id } })).lastResult).toMatchObject({ count: 2 + 4 });

    // Day 1 read again: "oak chair" dropped by Google is gone. Day 2's query calls failed: its rows stay.
    google.window = () => ({ days: [day("2026-11-01", [], true, [["oak table", "", 6]]), day("2026-11-02", [], true, null)] });
    await runDataSync(backfill(s, "2026-11-01", "2026-11-02"), lease);
    expect((await queryRows()).map((r) => [dayOf(r), r.dimension, r.query, r.clicks])).toEqual([
      ["2026-11-01", "QUERY", "oak table", 6],
      ["2026-11-02", "QUERY", "pine", 1],
    ]);
  });

  it("leaves other brands' query rows alone", async () => {
    const other = await searchSource("sc-b", (await connection("sc-b")).id);
    google.window = () => ({ days: [day("2026-11-01", [], true, [["b only", "", 1]])] });
    await runDataSync(backfill(other, "2026-11-01", "2026-11-01"), lease);
    const s = await searchSource("sc-a", (await connection("sc-a")).id);
    google.window = () => ({ days: [day("2026-11-01", [], true, [["a only", "", 1]])] });
    await runDataSync(backfill(s, "2026-11-01", "2026-11-01"), lease);
    expect((await queryRows("sc-b")).map((r) => r.query)).toEqual(["b only"]);
    expect((await queryRows("sc-a")).map((r) => r.query)).toEqual(["a only"]);
  });

  it("writes one transaction per day: a write failing on day 3 keeps days 1 and 2", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await searchSource("sc-a", (await connection("sc-a")).id);
    google.window = () => ({
      days: [
        day("2026-11-01", [["https://a.test/x", 1]], true, [["q", "", 1]]),
        day("2026-11-02", [["https://a.test/x", 1]], true, [["q", "", 1]]),
        // The same query twice breaks the unique key: the day's insert throws.
        day("2026-11-03", [["https://a.test/x", 1]], true, [["q", "", 1], ["q", "", 2]]),
      ],
    });
    await expect(runDataSync(backfill(s, "2026-11-01", "2026-11-03"), lease)).rejects.toThrow();
    expect([...new Set((await rows()).map(dayOf))]).toEqual(["2026-11-01", "2026-11-02"]);
    expect([...new Set((await queryRows()).map(dayOf))]).toEqual(["2026-11-01", "2026-11-02"]);
  });

  it("halves a backfill window still capped after its retries (halveOnCap)", async () => {
    const plan = { start: "2026-08-01", end: "2026-10-29", days: 30 };
    const conn = await connection("sc-a");
    const s = await prisma.dataSource.create({
      data: { workspaceId: ws, brandId: "sc-a", kind: "SEARCH_CONSOLE", externalId: SITE, connectionId: conn.id, settings: { reportsIn: "America/Los_Angeles", backfill: plan } },
    });
    google.window = (from) => ({ days: [day(from, [])], stoppedReason: "capped" });
    await runDataSync({ ...backfill(s, "2026-08-01", "2026-08-30"), end: plan.end, retry: 3 }, lease);
    const [next] = await prisma.job.findMany({ where: { type: DATA_SYNC_JOB } });
    expect(next.payload).toMatchObject({ from: "2026-08-01", to: "2026-08-15" });
  });

  it("housekeeping deletes query rows older than 400 days only", async () => {
    const { pruneOldRows } = await vi.importActual<typeof import("@/server/jobs/runner")>("@/server/jobs/runner");
    const ago = (days: number) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - days * 86_400_000);
    for (const [query, d] of [["old", ago(402)], ["kept", ago(398)]] as const) {
      await prisma.searchQueryDay.create({ data: { workspaceId: ws, brandId: "sc-a", siteUrl: SITE, dimension: "QUERY", day: d, query, page: "", clicks: 1, impressions: 1, positionSum: 1 } });
    }
    await pruneOldRows();
    expect((await queryRows()).map((r) => r.query)).toEqual(["kept"]);
  });
});

describe("site picker", () => {
  const sites = (connectionId: string) => getSites(new Request(`http://x/api?connectionId=${connectionId}`), { params });
  const put = (body: unknown) => chooseSite(new Request("http://x/api", { method: "PUT", body: JSON.stringify(body) }), { params });

  it("lists the live sites and the chosen one", async () => {
    const conn = await connection("sc-a");
    const res = await sites(conn.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sites: [{ siteUrl: SITE, permissionLevel: "siteOwner" }], chosen: null });
  });

  it("another brand's connection, or this brand's non-Google one, is 404 on GET and PUT", async () => {
    const theirs = await connection("sc-b");
    const business = await connection("sc-a", "GOOGLE_BUSINESS");
    expect((await sites(theirs.id)).status).toBe(404);
    expect((await sites(business.id)).status).toBe(404);
    expect((await put({ connectionId: theirs.id, siteUrl: SITE })).status).toBe(404);
    expect(await prisma.dataSource.count()).toBe(0);
  });

  it("a site not in the live list is 400 and creates nothing", async () => {
    const conn = await connection("sc-a");
    const res = await put({ connectionId: conn.id, siteUrl: "https://not-mine.test/" });
    expect(res.status).toBe(400);
    expect(await prisma.dataSource.count()).toBe(0);
  });

  it("needs integrations.manage", async () => {
    const conn = await connection("sc-a");
    auth.perms = new Set(["analytics.read", "brand.read"]);
    expect((await sites(conn.id)).status).toBe(403);
    expect((await put({ connectionId: conn.id, siteUrl: SITE })).status).toBe(403);
  });

  it("choosing a site upserts its source, switches the previous site off and queues the first 30-day backfill window", async () => {
    const conn = await connection("sc-a");
    const old = await prisma.dataSource.create({ data: { workspaceId: ws, brandId: "sc-a", kind: "SEARCH_CONSOLE", externalId: "https://old.test/", connectionId: conn.id } });
    const res = await put({ connectionId: conn.id, siteUrl: SITE });
    expect(res.status).toBe(200);
    const source = await prisma.dataSource.findFirstOrThrow({ where: { brandId: "sc-a", externalId: SITE } });
    expect(await res.json()).toMatchObject({ source: { id: source.id, kind: "SEARCH_CONSOLE", status: "ACTIVE" } });
    expect(source).toMatchObject({ status: "ACTIVE", connectionId: conn.id, settings: { reportsIn: "America/Los_Angeles", backfill: { days: 30 } }, syncedThrough: null });
    expect((await prisma.dataSource.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("OFF");
    const jobs = await prisma.job.findMany({ where: { type: DATA_SYNC_JOB } });
    expect(jobs).toHaveLength(1);
    const p = jobs[0].payload as { mode: string; from: string; to: string; end: string; dataSourceId: string };
    expect(p).toMatchObject({ mode: "backfill", dataSourceId: source.id });
    expect((Date.parse(p.to) - Date.parse(p.from)) / 86_400_000 + 1).toBe(30);
    expect((Date.parse(p.end) - Date.parse(p.from)) / 86_400_000 + 1).toBe(90);
    expect(JSON.stringify(jobs[0].payload)).not.toContain("tok");
  });

  it("is rate-limited per brand and person", async () => {
    const conn = await connection("sc-a");
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await sites(conn.id)).status;
    expect(last).toBe(429);
  });
});

describe("search reads", () => {
  const summary = (q: string) => getSummary(new Request(`http://x/api?${q}`), { params });
  const pages = (q: string) => getPages(new Request(`http://x/api?${q}`), { params });
  async function seed(brandId: string, siteUrl: string, d: string, clicks: number, impressions: number, positionSum: number, page = "") {
    await prisma.searchDay.create({
      data: { workspaceId: ws, brandId, siteUrl, day: new Date(`${d}T00:00:00Z`), dimension: page ? "PAGE" : "SITE", page, clicks, impressions, positionSum },
    });
  }

  it("totals, the previous range and daily rows from the chosen site only, positions weighted by impressions", async () => {
    await searchSource("sc-a", (await connection("sc-a")).id);
    await prisma.dataSource.create({ data: { workspaceId: ws, brandId: "sc-a", kind: "SEARCH_CONSOLE", externalId: "https://old.test/", status: "OFF" } });
    await seed("sc-a", SITE, "2026-11-08", 10, 100, 200); // position 2
    await seed("sc-a", SITE, "2026-11-09", 30, 300, 3000); // position 10
    await seed("sc-a", SITE, "2026-11-02", 5, 50, 250); // previous range
    await seed("sc-a", "https://old.test/", "2026-11-08", 999, 999, 999);
    await seed("sc-b", SITE, "2026-11-08", 777, 777, 777);
    const res = await summary("from=2026-11-08&to=2026-11-14");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totals).toEqual({ clicks: 40, impressions: 400, ctr: 0.1, position: 8 });
    expect(body.previous).toEqual({ clicks: 5, impressions: 50, ctr: 0.1, position: 5 });
    expect(body.previousRange).toEqual({ from: "2026-11-01", to: "2026-11-07" });
    expect(body.days).toEqual([
      { day: "2026-11-08", clicks: 10, impressions: 100, ctr: 0.1, position: 2 },
      { day: "2026-11-09", clicks: 30, impressions: 300, ctr: 0.1, position: 10 },
    ]);
    expect(body).toMatchObject({ hasSite: true, siteUrl: SITE });
    // The site's URL only for people who manage integrations.
    auth.perms = new Set(["analytics.read", "brand.read"]);
    const plain = await (await summary("from=2026-11-08&to=2026-11-14")).json();
    expect(plain.hasSite).toBe(true);
    expect(plain).not.toHaveProperty("siteUrl");
    expect(plain.totals).toEqual(body.totals);
  });

  it("no site chosen: zeros, no rows", async () => {
    const body = await (await summary("from=2026-11-08&to=2026-11-14")).json();
    expect(body).toMatchObject({ hasSite: false, siteUrl: null, days: [], totals: { clicks: 0, position: null } });
  });

  it("top pages summed over the range, 50 a page with a cursor, this brand only", async () => {
    await searchSource("sc-a", (await connection("sc-a")).id);
    for (let i = 0; i < 55; i++) await seed("sc-a", SITE, "2026-11-08", 100 - i, 1000, 1000, `https://a.test/p${String(i).padStart(2, "0")}`);
    await seed("sc-a", SITE, "2026-11-09", 50, 100, 300, "https://a.test/p54"); // p54: 46 + 50 = 96
    await seed("sc-b", SITE, "2026-11-08", 9999, 9999, 9999, "https://b.test/secret");
    const first = await (await pages("from=2026-11-08&to=2026-11-14&sort=clicks")).json();
    expect(first.pages).toHaveLength(50);
    expect(first.pages[0]).toMatchObject({ page: "https://a.test/p00", clicks: 100 });
    expect(first.pages.find((p: { page: string }) => p.page === "https://a.test/p54")).toMatchObject({ clicks: 96, impressions: 1100, position: 1300 / 1100 });
    expect(JSON.stringify(first)).not.toContain("b.test");
    const second = await (await pages(`from=2026-11-08&to=2026-11-14&sort=clicks&cursor=${first.nextCursor}`)).json();
    expect(second.pages).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect((await pages(`from=2026-11-08&to=2026-11-14&sort=impressions&cursor=${first.nextCursor}`)).status).toBe(422);
  });

  it("over 90 days is 422; without analytics.read is 403", async () => {
    expect((await summary("from=2026-01-01&to=2026-11-14")).status).toBe(422);
    expect((await pages("from=2026-01-01&to=2026-11-14")).status).toBe(422);
    auth.perms = new Set(["brand.read", "integrations.manage"]);
    expect((await summary("from=2026-11-08&to=2026-11-14")).status).toBe(403);
    expect((await pages("from=2026-11-08&to=2026-11-14")).status).toBe(403);
  });
});

describe("GET data-sources", () => {
  it("returns the brand's time zone, or the default", async () => {
    expect(await (await getSources(new Request("http://x/api"), { params })).json()).toEqual({ sources: [], timeZone: "Europe/Paris" });
    auth.brandId = "sc-b";
    expect((await (await getSources(new Request("http://x/api"), { params })).json()).timeZone).toBe("UTC");
  });
});
