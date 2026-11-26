import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ perms: new Set<string>(), brandId: "uh-a", userId: "", clientReviewer: false }));
vi.mock("@/server/api/brand-route", async () => {
  const { AccessDeniedError } = await import("@/server/auth/errors");
  return {
    authorizeBrandRoute: vi.fn(async (_r: Request, _p: unknown, key: string) => {
      if (!auth.perms.has(key)) throw new AccessDeniedError(`Missing permission ${key}`);
      return { userId: auth.userId, workspaceId: ws, brandId: auth.brandId, perms: auth.perms, clientReviewer: auth.clientReviewer };
    }),
  };
});

import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { GET } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/seo/url/route";
import type { UrlHistoryDto } from "@/shared";

/** GET seo/url against Postgres: the host check, search sums across spellings, the findings timeline, tasks, articles. */
let ws: string;
let otherWs: string;
let userId: string;
const SITE = "https://a.test/";
const PAGE = "https://www.a.test/products/oak%_table";
const params = Promise.resolve({ workspaceId: "w", brandId: "b" });
const get = (u: string, q = "from=2026-11-01&to=2026-11-07") => GET(new Request(`http://x/api?u=${encodeURIComponent(u)}&${q}`), { params });
const body = async (u = PAGE, q?: string) => (await (await get(u, q)).json()) as UrlHistoryDto;
const STAFF = ["analytics.read", "tasks.read", "tasks.all", "brand.read"];

let clock = Date.parse("2026-06-01T00:00:00Z");
async function report(kind: "SEO" | "GEO", findings: object[], metrics: object, brandId = "uh-a", workspaceId = ws) {
  clock += 86_400_000;
  // createdAt within the last year of the real clock: the tests run after 2026-06.
  const createdAt = new Date(Math.min(clock, Date.now() - 1_000));
  return prisma.auditReport.create({ data: { workspaceId, brandId, kind, score: 50, summary: "", findings: findings as Prisma.InputJsonValue, metrics: metrics as Prisma.InputJsonValue, createdAt } });
}
const finding = (id: string, urls: string[], title = id) => ({ id, category: "x", severity: "high", title, detail: "", fix: "", urls });

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-url-history" } })).id;
  otherWs = (await prisma.workspace.create({ data: { name: "O", slug: "w-url-history-o" } })).id;
  userId = (await prisma.user.create({ data: { email: "u@url-history.test", name: "u" } })).id;
  auth.userId = userId;
  for (const [id, w, site] of [["uh-a", () => ws, "https://www.a.test"], ["uh-b", () => ws, "https://b.test"], ["uh-o", () => otherWs, "https://a.test"]] as const) {
    await prisma.brand.create({ data: { id, workspaceId: w(), slug: id, displayName: id } });
    await prisma.brandProfile.create({ data: { workspaceId: w(), brandId: id, websiteUrl: site } });
  }
  await prisma.dataSource.create({ data: { workspaceId: ws, brandId: "uh-a", kind: "SEARCH_CONSOLE", externalId: SITE } });
});
beforeEach(async () => {
  auth.perms = new Set(STAFF);
  auth.clientReviewer = false;
  auth.brandId = "uh-a";
  await prisma.auditReport.deleteMany({});
  await prisma.searchDay.deleteMany({});
  await prisma.task.deleteMany({});
  await prisma.blogArticle.deleteMany({});
});

describe("GET seo/url: the page asked for", () => {
  it("refuses another host, a non-http URL and an over-long one, and rebuilds the URL it returns", async () => {
    for (const u of ["https://b.test/x", "javascript:alert(1)", "data:text/html,x", "https://a.test.evil.com/", `https://a.test/${"x".repeat(2_000)}`]) {
      expect((await get(u)).status, u.slice(0, 40)).toBe(400);
    }
    const out = await body("http://A.test/products/oak%_table/?utm=1#top");
    expect(out.url).toBe("https://a.test/products/oak%_table");
    expect(out.key).toBe("a.test/products/oak%_table");
  });

  it("needs analytics.read", async () => {
    auth.perms = new Set(["brand.read", "tasks.read"]);
    expect((await get(PAGE)).status).toBe(403);
  });
});

describe("GET seo/url: search", () => {
  it("sums the page's spellings per day and leaves other pages and brands out", async () => {
    const row = (page: string, day: string, clicks: number, brandId = "uh-a") =>
      prisma.searchDay.create({ data: { workspaceId: ws, brandId, siteUrl: SITE, dimension: "PAGE", page, day: new Date(`${day}T00:00:00Z`), clicks, impressions: clicks * 10, positionSum: clicks * 30 } });
    await row("https://a.test/products/oak%_table", "2026-11-02", 3);
    await row("http://www.a.test/products/oak%_table/", "2026-11-02", 2);
    await row("https://a.test/products/oak%_table/more", "2026-11-02", 50);
    await row("https://a.test/products/oak%_table", "2026-10-30", 7); // previous range
    await row("https://a.test/products/oak%_table", "2026-11-02", 99, "uh-b");
    const out = await body();
    expect(out.search?.days).toEqual([{ day: "2026-11-02", clicks: 5, impressions: 50, ctr: 0.1, position: 3 }]);
    expect(out.search?.totals.clicks).toBe(5);
    expect(out.search?.previous.clicks).toBe(7);
  });
});

describe("GET seo/url: findings", () => {
  it("raised, listed again, then cleared by the first report that re-read the page without listing it", async () => {
    const other = "https://a.test/other";
    await report("SEO", [finding("title-missing", ["http://a.test/products/oak%_table/"])], { pagesChecked: [PAGE] });
    await report("SEO", [finding("title-missing", [PAGE, other])], { pagesChecked: [PAGE] });
    await report("SEO", [], { pagesChecked: [other] }); // didn't re-read the page: not cleared
    const cleared = await report("SEO", [], { pagesChecked: ["https://a.test/products/oak%_table"] });
    await report("SEO", [finding("title-missing", [other])], { pagesChecked: [other] });
    const [f, ...rest] = (await body()).findings;
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ kind: "SEO", findingId: "title-missing", open: false, clearedOn: cleared.createdAt.toISOString().slice(0, 10) });
    expect(f.firstSeen < f.lastSeen).toBe(true);
  });

  it("an open finding is listed in the latest report and has no cleared day; not re-read means not cleared", async () => {
    await report("SEO", [finding("h1", [PAGE])], { pagesChecked: [PAGE] });
    await report("GEO", [finding("content-oak", [PAGE], "Oak guide")], { pagesChecked: [] });
    await report("GEO", [], { pagesChecked: [] });
    const out = (await body()).findings;
    expect(out.find((f) => f.kind === "SEO")).toMatchObject({ open: true, clearedOn: null });
    expect(out.find((f) => f.kind === "GEO")).toMatchObject({ open: false, clearedOn: null, title: "Oak guide" });
  });

  it("a links-* finding clears only on a report whose link check was complete", async () => {
    await report("SEO", [finding("links-broken", [PAGE])], { pagesChecked: [], links: { complete: true } });
    await report("SEO", [], { pagesChecked: [PAGE], links: { complete: false } });
    expect((await body()).findings[0]).toMatchObject({ findingId: "links-broken", clearedOn: null });
    const done = await report("SEO", [], { pagesChecked: [], links: { complete: true } });
    expect((await body()).findings[0].clearedOn).toBe(done.createdAt.toISOString().slice(0, 10));
  });

  it("the LIKE pre-filter matches % and _ literally and still finds other spellings", async () => {
    await report("SEO", [finding("lit", ["https://a.test/products/oakX_table", "https://a.test/products/oak%Ytable"])], { pagesChecked: [] });
    await report("SEO", [finding("www", ["http://www.a.test/products/oak%_table"])], { pagesChecked: [] });
    expect((await body()).findings.map((f) => f.findingId)).toEqual(["www"]);
  });

  it("never reads another brand's or another workspace's reports", async () => {
    await report("SEO", [finding("b", [PAGE])], { pagesChecked: [] }, "uh-b");
    await report("SEO", [finding("o", [PAGE])], { pagesChecked: [] }, "uh-o", otherWs);
    expect((await body()).findings).toEqual([]);
  });
});

describe("GET seo/url: tasks and articles", () => {
  async function task(title: string, data: Partial<Prisma.TaskUncheckedCreateInput> = {}) {
    return prisma.task.create({ data: { workspaceId: ws, brandId: "uh-a", title, createdById: userId, ...data } });
  }

  it("lists tasks naming the page by url or findingUrls, any spelling, only of this brand", async () => {
    await task("by url", { url: "http://a.test/products/oak%_table/", changeKind: "PRODUCT_PAGE" });
    await task("by finding", { findingUrls: ["https://www.a.test/products/oak%_table"] });
    await task("other page", { url: "https://a.test/products/pine" });
    await prisma.task.create({ data: { workspaceId: ws, brandId: "uh-b", title: "other brand", url: PAGE } });
    const out = await body();
    expect(out.tasks?.map((t) => t.title).sort()).toEqual(["by finding", "by url"]);
    expect(out.tasks?.find((t) => t.title === "by url")?.changeKind).toBe("PRODUCT_PAGE");
  });

  it("hides tasks without tasks.read, for a client reviewer, and a task the viewer can't see", async () => {
    const other = (await prisma.user.create({ data: { email: "o@url-history.test", name: "o" } })).id;
    await task("mine", { url: PAGE });
    await task("someone else's", { url: PAGE, createdById: other });
    auth.perms = new Set(["analytics.read", "tasks.read", "brand.read"]); // no tasks.all: own tasks only
    expect((await body()).tasks?.map((t) => t.title)).toEqual(["mine"]);
    auth.perms = new Set(["analytics.read", "brand.read"]);
    expect((await body()).tasks).toBeNull();
    auth.perms = new Set(STAFF);
    auth.clientReviewer = true;
    expect((await body()).tasks).toBeNull();
  });

  it("finds a published article by its blog path and articles written for the page's tasks, this brand only", async () => {
    const t = await task("write", { url: PAGE });
    const article = (data: Partial<Prisma.BlogArticleUncheckedCreateInput>) =>
      prisma.blogArticle.create({ data: { workspaceId: ws, brandId: "uh-a", title: "t", handle: "h", blocks: [], ...data } as Prisma.BlogArticleUncheckedCreateInput });
    await article({ title: "for task", handle: "x", taskId: t.id });
    await article({ title: "published", handle: "oak-care", status: "PUBLISHED", publishedAt: new Date() });
    await article({ title: "draft", handle: "oak-care-2" });
    const forTask = await body();
    expect(forTask.articles.map((a) => a.title)).toEqual(["for task"]);
    const byPath = await body("https://a.test/blogs/news/oak-care");
    expect(byPath.articles.map((a) => a.title)).toEqual(["published"]);
  });
});
