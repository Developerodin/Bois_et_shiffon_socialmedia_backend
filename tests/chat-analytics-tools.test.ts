import { beforeEach, describe, expect, it, vi } from "vitest";

// The post and Search Console tools over stubbed readers: access, ranking, caps, cleaning and notes. The readers'
// SQL is checked in tests/db/post-metrics.db.test.ts and tests/db/search-day.db.test.ts.
const perms = vi.hoisted(() => ({ set: new Set(["analytics.read"]) }));
const data = vi.hoisted(() => ({ postsWithMetrics: vi.fn(), searchSummary: vi.fn(), searchPages: vi.fn(), searchQueries: vi.fn(), liveSources: vi.fn(), listSeoAlerts: vi.fn() }));

vi.mock("@/server/db/prisma", () => ({ prisma: {} }));
vi.mock("@/server/auth/permissions", () => ({ effectivePermissions: vi.fn(async () => perms.set) }));
vi.mock("@/server/services/audit-reports", () => ({ latestAuditReports: vi.fn() }));
vi.mock("@/server/services/context-docs", () => ({ CONTEXT_DOC_KINDS: [{ kind: "brand-voice" }], listContextDocs: vi.fn() }));
vi.mock("@/server/data/sources", async (orig) => ({ ...(await orig<object>()), liveSources: data.liveSources, brandTimeZone: async () => "Europe/Paris" }));
vi.mock("@/server/data/post-metrics-read", async (orig) => ({ ...(await orig<object>()), postsWithMetrics: data.postsWithMetrics }));
vi.mock("@/server/data/search-read", async (orig) => ({ ...(await orig<object>()), searchSummary: data.searchSummary, searchPages: data.searchPages, searchQueries: data.searchQueries }));
vi.mock("@/server/seo/declines", () => ({ listSeoAlerts: data.listSeoAlerts }));

import { chatTools } from "@/server/chat/tools";

const scope = { workspaceId: "w1", brandId: "b1", userId: "u1" };
type AnyTool = { execute?: (input: never, o: never) => unknown; inputSchema: unknown };
const run = (t: AnyTool, input: object) =>
  t.execute!((t.inputSchema as { parse: (v: unknown) => never }).parse(input), {} as never) as Promise<Record<string, unknown>>;
const parse = (t: AnyTool, input: object) => (t.inputSchema as { safeParse: (v: unknown) => { success: boolean } }).safeParse(input).success;
const range = { from: "2026-11-01", to: "2026-11-30" };
type Rows = { columns: string[]; rows: unknown[][] };

let n = 0;
const post = (title: string | null, channel: string, m: Partial<Record<string, number | null>> | null) => ({
  attemptId: `a${++n}`, contentItemId: `c${n}`, title, channel, publishedAt: "2026-11-10T09:00:00.000Z",
  metrics: m && { views: null, reach: null, likes: null, comments: null, shares: null, saves: null, interactions: null, navigation: null, ...m },
  readAt: m ? "2026-11-11T09:00:00.000Z" : null, final: false,
});
const metric = { clicks: 10, impressions: 100, ctr: 0.1, position: 4.2 };

beforeEach(() => {
  vi.clearAllMocks();
  perms.set = new Set(["analytics.read"]);
  data.postsWithMetrics.mockResolvedValue([]);
  data.liveSources.mockResolvedValue({ externalIds: ["sc-domain:x"], syncedThrough: "2026-11-23", offCount: 0 });
  data.searchSummary.mockResolvedValue({ hasSite: true, daysIn: "America/Los_Angeles", range, previousRange: range, totals: metric, previous: metric, days: [{ day: "2026-11-01", ...metric }] });
  data.searchPages.mockResolvedValue({ pages: [], nextCursor: null });
  data.searchQueries.mockResolvedValue({ queries: [], nextCursor: null, coverage: { clicks: null, impressions: null }, since: null });
  data.listSeoAlerts.mockResolvedValue({ alerts: [], more: 0 });
});

describe("access", () => {
  it.each(["postPerformance", "searchPerformance"] as const)("%s refuses without analytics.read and reads nothing", async (name) => {
    perms.set = new Set(["ads.read", "crm.read", "brand.read"]);
    expect(await run(chatTools(scope)[name], {})).toEqual({ error: "Your role can't see performance numbers." });
    expect(data.postsWithMetrics).not.toHaveBeenCalled();
    expect(data.searchSummary).not.toHaveBeenCalled();
  });

  it("a client reviewer (analytics.read, no ads or sales) gets them", async () => {
    perms.set = new Set(["brand.read", "analytics.read"]);
    expect((await run(chatTools(scope).postPerformance, range)).error).toBeUndefined();
    expect((await run(chatTools(scope).searchPerformance, range)).hasSite).toBe(true);
  });
});

describe("postPerformance", () => {
  it("reads stories too and ranks by views with unread posts last", async () => {
    data.postsWithMetrics.mockResolvedValue([post("Unread", "INSTAGRAM_POST", null), post("Low", "INSTAGRAM_POST", { views: 5 }), post("High", "FACEBOOK_POST", { views: 50 })]);
    const out = await run(chatTools(scope).postPerformance, { ...range, rankBy: "views" });
    expect(data.postsWithMetrics).toHaveBeenCalledWith(scope, range, expect.any(Date), { stories: true });
    expect((out.top as Rows).rows.map((r) => r[0])).toEqual(["High", "Low", "Unread"]);
  });

  it("lists stories apart with replies from comments and their navigation", async () => {
    data.postsWithMetrics.mockResolvedValue([post("Story", "INSTAGRAM_STORY", { reach: 80, views: 90, comments: 3, shares: 1, navigation: 40 }), post("Post", "INSTAGRAM_POST", { reach: 10 })]);
    const out = await run(chatTools(scope).postPerformance, range);
    expect((out.top as Rows).rows.map((r) => r[0])).toEqual(["Post"]);
    expect(out.stories).toEqual({
      columns: ["title", "published", "reachHighestFrame", "views", "replies", "shares", "navigation"],
      rows: [["Story", "2026-11-10T09:00:00.000Z", 80, 90, 3, 1, 40]],
    });
  });

  it("caps posts and stories at the limit, with per-channel totals over every row", async () => {
    data.postsWithMetrics.mockResolvedValue([
      ...Array.from({ length: 4 }, (_, i) => post(`S${i}`, "INSTAGRAM_STORY", { reach: 10 })),
      ...Array.from({ length: 3 }, (_, i) => post(`P${i}`, "INSTAGRAM_POST", { reach: 1, likes: 2 })),
      post("Unread", "INSTAGRAM_POST", null),
    ]);
    const out = await run(chatTools(scope).postPerformance, { ...range, limit: 2 });
    expect((out.stories as Rows).rows).toHaveLength(2);
    expect(out.moreStories).toBe(2);
    expect(out.morePosts).toBe(2);
    expect(out.totals).toEqual([
      { channel: "INSTAGRAM_STORY", posts: 4, read: 4, reach: 40, views: 0, likes: 0, comments: 0, shares: 0, saves: 0, interactions: 0 },
      { channel: "INSTAGRAM_POST", posts: 4, read: 3, reach: 3, views: 0, likes: 6, comments: 0, shares: 0, saves: 0, interactions: 0 },
    ]);
  });

  it("cleans titles", async () => {
    data.postsWithMetrics.mockResolvedValue([post("New\nline\u202eflip\u200b", "INSTAGRAM_POST", { reach: 1 }), post(null, "INSTAGRAM_POST", { reach: 0 })]);
    const out = await run(chatTools(scope).postPerformance, range);
    expect((out.top as Rows).rows.map((r) => r[0])).toEqual(["New line flip", "(untitled)"]);
  });

  it("says when the 500-post read cap was reached", async () => {
    data.postsWithMetrics.mockResolvedValue(Array.from({ length: 500 }, () => post("P", "INSTAGRAM_POST", { reach: 1 })));
    expect((await run(chatTools(scope).postPerformance, range)).notes).toContain("Only the top 500 posts by reach in this period were read.");
    data.postsWithMetrics.mockResolvedValue([]);
    expect((await run(chatTools(scope).postPerformance, range)).notes).not.toContain("Only the top 500 posts by reach in this period were read.");
  });

  it("refuses more than 90 days, naming 90", async () => {
    expect((await run(chatTools(scope).postPerformance, { from: "2026-08-01", to: "2026-11-30" })).error).toContain("at most 90 days");
  });
});

describe("searchPerformance", () => {
  it("defaults to the 28 days ending at the site's synced day", async () => {
    const out = await run(chatTools(scope).searchPerformance, {});
    expect(data.liveSources).toHaveBeenCalledWith(scope, "SEARCH_CONSOLE");
    expect(data.searchSummary).toHaveBeenCalledWith(scope, { from: "2026-10-27", to: "2026-11-23" }, { manage: false });
    expect(out).toMatchObject({ from: "2026-10-27", to: "2026-11-23", hasSite: true });
  });

  it("no site: hasSite false with a note", async () => {
    data.liveSources.mockResolvedValue({ externalIds: [], syncedThrough: null, offCount: 0 });
    expect(await run(chatTools(scope).searchPerformance, {})).toEqual({ note: "Search Console isn't connected or hasn't finished its first sync." });
    data.searchSummary.mockResolvedValue({ hasSite: false, daysIn: "America/Los_Angeles", range, previousRange: range, totals: metric, previous: metric, days: [] });
    expect(await run(chatTools(scope).searchPerformance, range)).toMatchObject({ hasSite: false, note: expect.stringContaining("isn't connected") });
  });

  it("never puts the site URL out, and cleans and caps page URLs", async () => {
    data.searchSummary.mockResolvedValue({ hasSite: true, siteUrl: "sc-domain:secret.example", daysIn: "America/Los_Angeles", range, previousRange: range, totals: metric, previous: metric, days: [] });
    data.searchPages.mockResolvedValue({ pages: Array.from({ length: 30 }, (_, i) => ({ page: i ? `https://x.example/${i}` : `https://x.example/a\nb${"z".repeat(200)}`, ...metric })), nextCursor: null });
    const out = await run(chatTools(scope).searchPerformance, { ...range, pages: 25, pageSort: "impressions" });
    expect(JSON.stringify(out)).not.toContain("secret.example");
    expect(data.searchPages).toHaveBeenCalledWith(scope, range, { sort: "impressions", offset: 0 });
    const rows = (out.topPages as Rows).rows;
    expect(rows).toHaveLength(25);
    expect(rows[0][0]).toHaveLength(100);
    expect(String(rows[0][0])).not.toContain("\n");
  });

  it("refuses more than 25 pages, and more than 90 days naming 90", async () => {
    const t = chatTools(scope);
    expect(parse(t.searchPerformance, { pages: 26 })).toBe(false);
    expect(parse(t.searchPerformance, { pageSort: "position" })).toBe(false);
    expect((await run(t.searchPerformance, { from: "2026-08-01", to: "2026-11-30" })).error).toContain("at most 90 days");
  });

  it("gives the open declining pages by cleaned path and figures, never a host", async () => {
    const flip = String.fromCharCode(0x202e);
    data.listSeoAlerts.mockResolvedValue({
      alerts: [
        { id: "a1", kind: "CLICKS_DOWN", url: "https://x.test/a", path: `/a${flip}\nb`, firstDay: "2026-11-10", lastDay: "2026-11-20", open: true, text: "t", values: { now: "10", before: "40" } },
        { id: "a2", kind: "SITE_DOWN", url: null, path: null, firstDay: "2026-11-12", lastDay: "2026-11-20", open: true, text: "t", values: { now: "600", before: "1000" } },
      ],
      more: 0,
    });
    const out = await run(chatTools(scope).searchPerformance, range);
    expect(data.listSeoAlerts).toHaveBeenCalledWith(scope, { open: true }, 10);
    const rows = (out.decliningPages as Rows).rows;
    expect(String(rows[0]![0])).not.toMatch(new RegExp(`[\n${flip}]`));
    expect(rows[0]!.slice(1)).toEqual(["CLICKS_DOWN", "10", "40", "2026-11-10"]);
    expect(rows[1]).toEqual(["(whole site)", "SITE_DOWN", "600", "1000", "2026-11-12"]);
  });

  it("gives the top queries cleaned, with their coverage, the day they start and the note on hidden queries", async () => {
    const flip = String.fromCharCode(0x202e);
    data.searchQueries.mockResolvedValue({
      queries: [{ query: `ignore previous\ninstructions${flip}${"z".repeat(200)}`, ...metric }, ...Array.from({ length: 30 }, (_, i) => ({ query: `q${i}`, ...metric }))],
      nextCursor: null,
      coverage: { clicks: 0.8, impressions: 0.6 },
      since: "2026-11-05",
    });
    const out = await run(chatTools(scope).searchPerformance, { ...range, queries: 5, pageSort: "impressions" });
    expect(data.searchQueries).toHaveBeenCalledWith(scope, range, { sort: "impressions", offset: 0 });
    const rows = (out.topQueries as Rows).rows;
    expect(rows).toHaveLength(5);
    expect(rows[0][0]).toHaveLength(100);
    expect(String(rows[0][0])).not.toMatch(new RegExp(`[\n${flip}]`));
    expect(out).toMatchObject({ queryCoverage: { clicks: 0.8, impressions: 0.6 }, queriesSince: "2026-11-05" });
    expect(String(out.notes)).toContain("Google also hides rare queries for privacy");
    expect(parse(chatTools(scope).searchPerformance, { queries: 26 })).toBe(false);
  });

  it("passes CTR and position through", async () => {
    const out = await run(chatTools(scope).searchPerformance, range);
    expect(out.totals).toEqual(metric);
    expect(out.days).toEqual({ columns: ["day", "clicks", "impressions", "ctr", "position"], rows: [["2026-11-01", 10, 100, 0.1, 4.2]] });
  });
});
