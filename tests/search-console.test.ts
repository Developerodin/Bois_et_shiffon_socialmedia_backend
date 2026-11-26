// recorded 2026-11-23, Search Console API v1 (shape from docs)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchSearchWindow,
  listSites,
  MAX_PAGE_KEY,
  MAX_QUERY_KEY,
  MAX_QUERY_ROW_KEY_BYTES,
  PAGES_PER_DAY,
  QUERIES_PER_DAY,
  SEARCH_CONSOLE_SCOPE,
  SearchConsoleError,
} from "@/server/data/search-console";

const TOKEN = "ya29.secret-token-value";
const SITE = "sc-domain:example.com";

type Req = { url: string; body: Record<string, unknown> | null; auth: string };
let requests: Req[];

/** Each request gets the next reply; a reply is [status, json]. */
function stub(replies: [number, unknown][]) {
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, body: init.body ? JSON.parse(init.body as string) : null, auth: (init.headers as Record<string, string>).authorization });
      const [status, json] = replies.shift() ?? [500, {}];
      return Response.json(json, { status });
    }),
  );
}

const pageRows = (n: number, prefix = "https://example.com/p") =>
  Array.from({ length: n }, (_, i) => ({ keys: [`${prefix}${i}`], clicks: 1, impressions: 10, position: 2 }));
/** The two query replies of a day (QUERY, then QUERY_PAGE), empty. */
const noQueries: [number, unknown][] = [[200, { rows: [] }], [200, { rows: [] }]];
const empties = { queries: [], queryPages: [], skippedQueries: 0, queriesComplete: true };

let logs: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logs = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("listSites", () => {
  it("drops unverified sites", async () => {
    stub([[200, { siteEntry: [{ siteUrl: SITE, permissionLevel: "siteOwner" }, { siteUrl: "https://other.com/", permissionLevel: "siteUnverifiedUser" }] }]]);
    expect(await listSites(TOKEN, [SEARCH_CONSOLE_SCOPE])).toEqual([{ siteUrl: SITE, permissionLevel: "siteOwner" }]);
    expect(requests[0].auth).toBe(`Bearer ${TOKEN}`);
  });

  it("asks to reconnect when the Search Console scope wasn't granted, without calling Google", async () => {
    stub([]);
    await expect(listSites(TOKEN, ["openid"])).rejects.toMatchObject({ reason: "reconnect" });
    expect(requests).toHaveLength(0);
  });
});

describe("fetchSearchWindow", () => {
  it("reads SITE in one windowed date call and stores position weighted by impressions", async () => {
    stub([
      [200, { rows: [{ keys: ["2026-11-01"], clicks: 5, impressions: 100, position: 3.5 }] }], // day 2 has no row
      [200, { rows: pageRows(2) }],
      ...noQueries,
      [200, { rows: [] }],
      ...noQueries,
    ]);
    const w = await fetchSearchWindow(TOKEN, SITE, "2026-11-01", "2026-11-02");
    expect(requests[0].body).toMatchObject({ startDate: "2026-11-01", endDate: "2026-11-02", dimensions: ["date"], dataState: "all" });
    expect(requests[0].url).toContain(encodeURIComponent(SITE));
    expect(w.stoppedReason).toBeUndefined();
    expect(w.days).toEqual([
      { day: "2026-11-01", site: { clicks: 5, impressions: 100, positionSum: 350 }, pages: [{ page: "https://example.com/p0", clicks: 1, impressions: 10, positionSum: 20 }, { page: "https://example.com/p1", clicks: 1, impressions: 10, positionSum: 20 }], skippedPages: 0, complete: true, ...empties },
      { day: "2026-11-02", site: { clicks: 0, impressions: 0, positionSum: 0 }, pages: [], skippedPages: 0, complete: true, ...empties },
    ]);
  });

  it("reads each day's top 500 pages in one request, skipping over-long page keys", async () => {
    const long = { keys: [`https://example.com/${"x".repeat(MAX_PAGE_KEY)}`], clicks: 1, impressions: 1, position: 1 };
    stub([
      [200, { rows: [] }],
      [200, { rows: [...pageRows(499), long] }],
      ...noQueries,
    ]);
    const w = await fetchSearchWindow(TOKEN, SITE, "2026-11-01", "2026-11-01");
    expect(requests.slice(1, 2).map((r) => [r.body?.dimensions, r.body?.startRow, r.body?.rowLimit])).toEqual([[["page"], undefined, PAGES_PER_DAY]]);
    expect(w.days[0]).toMatchObject({ complete: true, skippedPages: 1 });
    expect(w.days[0].pages).toHaveLength(499);
  });

  it("stops as partial on 429: earlier days complete, the failing day and later days not", async () => {
    stub([
      [200, { rows: [] }],
      [200, { rows: pageRows(1) }], // day 1 done
      ...noQueries,
      [429, { error: { code: 429, message: "Quota exceeded" } }], // day 2
    ]);
    const w = await fetchSearchWindow(TOKEN, SITE, "2026-11-01", "2026-11-03");
    expect(w.stoppedReason).toBe("rate_limited");
    expect(w.days.map((d) => d.complete)).toEqual([true, false, false]);
    expect(w.days[1].pages).toEqual([]);
    expect(requests).toHaveLength(5);
  });

  it("a 5xx part way returns failed, keeping the days already read", async () => {
    stub([
      [200, { rows: [] }],
      [200, { rows: pageRows(1) }], // day 1 done
      ...noQueries,
      [503, { error: { code: 503, message: "Backend Error" } }], // day 2
    ]);
    const w = await fetchSearchWindow(TOKEN, SITE, "2026-11-01", "2026-11-03");
    expect(w.stoppedReason).toBe("failed");
    expect(w.days.map((d) => d.complete)).toEqual([true, false, false]);
    expect(w.days[0].pages).toHaveLength(1);
  });

  it("a timeout part way returns failed, keeping the days already read, and logs no URL", async () => {
    stub([[200, { rows: [] }], [200, { rows: pageRows(1) }], ...noQueries]);
    const replies = vi.mocked(fetch);
    const real = replies.getMockImplementation()!;
    let n = 0;
    replies.mockImplementation(async (url, init) => {
      if (++n === 5) throw new DOMException(`The operation was aborted due to timeout: ${String(url)}`, "TimeoutError");
      return real(url, init);
    });
    const w = await fetchSearchWindow(TOKEN, SITE, "2026-11-01", "2026-11-02");
    expect(w.stoppedReason).toBe("failed");
    expect(w.days.map((d) => d.complete)).toEqual([true, false]);
    expect(JSON.stringify(logs.mock.calls)).not.toContain("googleapis.com");
  });

  it("stops as capped once the run passes the time cap, keeping completed days", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(4 * 60_000 + 1);
    stub([[200, { rows: [] }], [200, { rows: pageRows(1) }], ...noQueries]);
    const w = await fetchSearchWindow(TOKEN, SITE, "2026-11-01", "2026-11-03");
    expect(w.stoppedReason).toBe("capped");
    expect(w.days.map((d) => d.complete)).toEqual([true, false, false]);
    expect(requests).toHaveLength(4);
  });

  it("sends the four bodies of a day: SITE by date, PAGE, QUERY and QUERY_PAGE, each the top rows of one day", async () => {
    stub([
      [200, { rows: [] }],
      [200, { rows: pageRows(1) }],
      [200, { rows: [{ keys: ["oak table"], clicks: 4, impressions: 40, position: 3 }] }],
      [200, { rows: [{ keys: ["oak table", "https://example.com/p0"], clicks: 3, impressions: 30, position: 2 }] }],
    ]);
    const w = await fetchSearchWindow(TOKEN, SITE, "2026-11-01", "2026-11-01");
    expect(requests.map((r) => r.body)).toEqual([
      { startDate: "2026-11-01", endDate: "2026-11-01", dimensions: ["date"], dataState: "all", rowLimit: 1 },
      { startDate: "2026-11-01", endDate: "2026-11-01", dimensions: ["page"], dataState: "all", rowLimit: PAGES_PER_DAY },
      { startDate: "2026-11-01", endDate: "2026-11-01", dimensions: ["query"], dataState: "all", rowLimit: QUERIES_PER_DAY },
      { startDate: "2026-11-01", endDate: "2026-11-01", dimensions: ["query", "page"], dataState: "all", rowLimit: QUERIES_PER_DAY },
    ]);
    expect(w.days[0]).toMatchObject({
      complete: true,
      queriesComplete: true,
      queries: [{ query: "oak table", page: "", clicks: 4, impressions: 40, positionSum: 120 }],
      queryPages: [{ query: "oak table", page: "https://example.com/p0", clicks: 3, impressions: 30, positionSum: 60 }],
    });
  });

  it("a failed query call marks only queries incomplete and skips later days' query calls, keeping SITE and PAGE", async () => {
    stub([
      [200, { rows: [] }],
      [200, { rows: pageRows(1) }], // day 1 PAGE
      [403, { error: { code: 403, message: "Quota exceeded for quota metric" } }], // day 1 QUERY
      [200, { rows: pageRows(2) }], // day 2 PAGE: no query calls after it
    ]);
    const w = await fetchSearchWindow(TOKEN, SITE, "2026-11-01", "2026-11-02");
    expect(w.stoppedReason).toBeUndefined();
    expect(w.days.map((d) => [d.complete, d.queriesComplete, d.pages.length])).toEqual([[true, false, 1], [true, false, 2]]);
    expect(requests.map((r) => r.body?.dimensions)).toEqual([["date"], ["page"], ["query"], ["page"]]);
  });

  it("skips and counts empty, over-long and over-byte query keys", async () => {
    const multibyte = "é".repeat(MAX_QUERY_KEY); // 200 chars, 400 bytes: under the char limit
    const longPage = `https://example.com/${"ü".repeat(800)}`; // under MAX_PAGE_KEY chars, ~1,620 bytes
    expect(new TextEncoder().encode(SITE + multibyte + longPage).length).toBeGreaterThan(MAX_QUERY_ROW_KEY_BYTES);
    stub([
      [200, { rows: [] }],
      [200, { rows: [] }],
      [200, { rows: [{ keys: [""], clicks: 1 }, { keys: ["x".repeat(MAX_QUERY_KEY + 1)], clicks: 1 }, { keys: ["ok"], clicks: 1 }] }],
      [200, { rows: [{ keys: [multibyte, longPage], clicks: 1 }, { keys: ["ok", "https://example.com/a"], clicks: 1 }] }],
    ]);
    const w = await fetchSearchWindow(TOKEN, SITE, "2026-11-01", "2026-11-01");
    expect(w.days[0].skippedQueries).toBe(3);
    expect(w.days[0].queries.map((q) => q.query)).toEqual(["ok"]);
    expect(w.days[0].queryPages.map((q) => q.page)).toEqual(["https://example.com/a"]);
  });

  it("401 → reconnect, nothing complete, no further calls", async () => {
    stub([[401, { error: { code: 401, message: "Request had invalid authentication credentials." } }]]);
    const w = await fetchSearchWindow(TOKEN, SITE, "2026-11-01", "2026-11-02");
    expect(w.stoppedReason).toBe("reconnect");
    expect(w.days.every((d) => !d.complete)).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("403 → permission", async () => {
    stub([[403, { error: { code: 403, message: "User does not have sufficient permission for site" } }]]);
    expect((await fetchSearchWindow(TOKEN, SITE, "2026-11-01", "2026-11-01")).stoppedReason).toBe("permission");
  });

  it("never puts the token in thrown errors or logs, even when Google echoes it", async () => {
    stub([[500, { error: { message: `bad token ${TOKEN}` } }]]);
    const err = await listSites(TOKEN, [SEARCH_CONSOLE_SCOPE]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchConsoleError);
    expect(String((err as Error).message) + String((err as Error).stack)).not.toContain(TOKEN);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(logs.mock.calls)).not.toContain("googleapis.com");
  });
});
