import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ perms: new Set<string>(["analytics.read"]), brandId: "sq-a" }));
vi.mock("@/server/api/brand-route", async () => {
  const { AccessDeniedError } = await import("@/server/auth/errors");
  return {
    authorizeBrandRoute: vi.fn(async (_r: Request, _p: unknown, key: string) => {
      if (!auth.perms.has(key)) throw new AccessDeniedError(`Missing permission ${key}`);
      return { userId: "u", workspaceId: ws, brandId: auth.brandId, perms: auth.perms, clientReviewer: false };
    }),
  };
});

import { prisma } from "@/server/db/prisma";
import { GET } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/search/queries/route";

/** GET search/queries against Postgres: grouping, sorts, cursors, coverage, `since`, the page filter and scoping. */
let ws: string;
const SITE = "sc-domain:a.test";
const params = Promise.resolve({ workspaceId: "w", brandId: "b" });
const get = async (q: string) => GET(new Request(`http://x/api?${q}`), { params });
const json = async (q: string) => (await get(q)).json();
const at = (d: string) => new Date(`${d}T00:00:00Z`);

async function query(d: string, query: string, clicks: number, opts: { page?: string; brandId?: string; siteUrl?: string; impressions?: number } = {}) {
  await prisma.searchQueryDay.create({
    data: {
      workspaceId: ws, brandId: opts.brandId ?? "sq-a", siteUrl: opts.siteUrl ?? SITE, day: at(d), dimension: opts.page ? "QUERY_PAGE" : "QUERY",
      query, page: opts.page ?? "", clicks, impressions: opts.impressions ?? clicks * 10, positionSum: clicks * 20,
    },
  });
}
async function total(d: string, clicks: number, impressions: number, page = "") {
  await prisma.searchDay.create({ data: { workspaceId: ws, brandId: "sq-a", siteUrl: SITE, day: at(d), dimension: page ? "PAGE" : "SITE", page, clicks, impressions, positionSum: 0 } });
}

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-search-queries" } })).id;
  for (const id of ["sq-a", "sq-b"]) {
    await prisma.brand.create({ data: { id, workspaceId: ws, slug: id, displayName: id } });
    await prisma.brandProfile.create({ data: { workspaceId: ws, brandId: id, websiteUrl: `https://www.${id === "sq-a" ? "a" : "b"}.test` } });
  }
  await prisma.dataSource.create({ data: { workspaceId: ws, brandId: "sq-a", kind: "SEARCH_CONSOLE", externalId: SITE } });
  await prisma.dataSource.create({ data: { workspaceId: ws, brandId: "sq-a", kind: "SEARCH_CONSOLE", externalId: "https://old.a.test/", status: "OFF" } });
  await prisma.dataSource.create({ data: { workspaceId: ws, brandId: "sq-b", kind: "SEARCH_CONSOLE", externalId: SITE } });
});
beforeEach(async () => {
  auth.perms = new Set(["analytics.read"]);
  await prisma.searchQueryDay.deleteMany({});
  await prisma.searchDay.deleteMany({});
});

describe("GET search/queries", () => {
  it("sums each query over the range, by clicks or impressions, from the chosen site of this brand only", async () => {
    await query("2026-11-08", "oak table", 5, { impressions: 10 });
    await query("2026-11-09", "oak table", 4, { impressions: 10 });
    await query("2026-11-08", "pine chair", 6, { impressions: 500 });
    await query("2026-11-08", "old site", 999, { siteUrl: "https://old.a.test/" });
    await query("2026-11-08", "other brand", 999, { brandId: "sq-b" });
    const byClicks = await json("from=2026-11-08&to=2026-11-14");
    expect(byClicks.queries.map((r: { query: string; clicks: number }) => [r.query, r.clicks])).toEqual([["oak table", 9], ["pine chair", 6]]);
    const byImpressions = await json("from=2026-11-08&to=2026-11-14&sort=impressions");
    expect(byImpressions.queries.map((r: { query: string }) => r.query)).toEqual(["pine chair", "oak table"]);
  });

  it("pages 50 at a time and refuses a cursor from the other sort or from the pages list", async () => {
    for (let i = 0; i < 52; i++) await query("2026-11-08", `q${String(i).padStart(2, "0")}`, 100 - i);
    const first = await json("from=2026-11-08&to=2026-11-14");
    expect(first.queries).toHaveLength(50);
    const second = await json(`from=2026-11-08&to=2026-11-14&cursor=${first.nextCursor}`);
    expect(second.queries.map((r: { query: string }) => r.query)).toEqual(["q50", "q51"]);
    expect(second.nextCursor).toBeNull();
    expect((await get(`from=2026-11-08&to=2026-11-14&sort=impressions&cursor=${first.nextCursor}`)).status).toBe(422);
    expect((await get(`from=2026-11-08&to=2026-11-14&cursor=${Buffer.from("clicks:50").toString("base64url")}`)).status).toBe(422);
  });

  it("coverage divides by the site total over the days that have query rows only; since is the first query day", async () => {
    await total("2026-11-07", 1000, 1000); // before queries were synced: left out
    await total("2026-11-08", 100, 1000);
    await total("2026-11-09", 100, 1000);
    await query("2026-11-08", "a", 60, { impressions: 400 });
    await query("2026-11-09", "a", 20, { impressions: 100 });
    const body = await json("from=2026-11-07&to=2026-11-14");
    expect(body.coverage).toEqual({ clicks: 0.4, impressions: 0.25 });
    expect(body.since).toBe("2026-11-08");
  });

  it("coverage is null when the site had no clicks; since is null without query rows", async () => {
    await total("2026-11-08", 0, 0);
    await query("2026-11-08", "a", 0, { impressions: 0 });
    expect((await json("from=2026-11-08&to=2026-11-14")).coverage).toEqual({ clicks: null, impressions: null });
    await prisma.searchQueryDay.deleteMany({});
    expect(await json("from=2026-11-08&to=2026-11-14")).toMatchObject({ queries: [], since: null });
  });

  it("with page: every spelling of the URL counts, no other page does, and coverage is the page's", async () => {
    for (const page of ["https://a.test/p", "http://www.a.test/p/", "https://www.a.test/p"]) await query("2026-11-08", "oak", 1, { page });
    await query("2026-11-08", "oak", 50, { page: "https://a.test/p/other" });
    await query("2026-11-08", "pine", 50, { page: "https://a.test/q" });
    await total("2026-11-08", 6, 60, "https://a.test/p");
    await query("2026-11-08", "oak", 1); // the QUERY row marks the day as read
    const body = await json(`from=2026-11-08&to=2026-11-14&page=${encodeURIComponent("https://www.a.test/p?variant=2")}`);
    expect(body.queries.map((r: { query: string; clicks: number }) => [r.query, r.clicks])).toEqual([["oak", 3]]);
    expect(body.coverage.clicks).toBe(0.5);
  });

  it("refuses a page on another host, a non-http page and needs analytics.read", async () => {
    for (const page of ["https://b.test/p", "javascript:alert(1)", "https://a.test.evil.com/p"]) {
      expect((await get(`from=2026-11-08&to=2026-11-14&page=${encodeURIComponent(page)}`)).status, page).toBe(400);
    }
    auth.perms = new Set(["brand.read"]);
    expect((await get("from=2026-11-08&to=2026-11-14")).status).toBe(403);
  });
});
