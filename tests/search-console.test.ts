// recorded 2026-11-23, Search Console API v1 (shape from docs)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSearchWindow, listSites, MAX_PAGE_KEY, PAGES_PER_DAY, SEARCH_CONSOLE_SCOPE, SearchConsoleError } from "@/server/data/search-console";

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

let logs: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logs = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  logs.mockRestore();
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
      [200, { rows: [] }],
    ]);
    const w = await fetchSearchWindow(TOKEN, SITE, "2026-11-01", "2026-11-02");
    expect(requests[0].body).toMatchObject({ startDate: "2026-11-01", endDate: "2026-11-02", dimensions: ["date"], dataState: "all" });
    expect(requests[0].url).toContain(encodeURIComponent(SITE));
    expect(w.stoppedReason).toBeUndefined();
    expect(w.days).toEqual([
      { day: "2026-11-01", site: { clicks: 5, impressions: 100, positionSum: 350 }, pages: [{ page: "https://example.com/p0", clicks: 1, impressions: 10, positionSum: 20 }, { page: "https://example.com/p1", clicks: 1, impressions: 10, positionSum: 20 }], skippedPages: 0, complete: true },
      { day: "2026-11-02", site: { clicks: 0, impressions: 0, positionSum: 0 }, pages: [], skippedPages: 0, complete: true },
    ]);
  });

  it("reads each day's top 500 pages in one request, skipping over-long page keys", async () => {
    const long = { keys: [`https://example.com/${"x".repeat(MAX_PAGE_KEY)}`], clicks: 1, impressions: 1, position: 1 };
    stub([
      [200, { rows: [] }],
      [200, { rows: [...pageRows(499), long] }],
    ]);
    const w = await fetchSearchWindow(TOKEN, SITE, "2026-11-01", "2026-11-01");
    expect(requests.slice(1).map((r) => [r.body?.dimensions, r.body?.startRow, r.body?.rowLimit])).toEqual([[["page"], undefined, PAGES_PER_DAY]]);
    expect(w.days[0]).toMatchObject({ complete: true, skippedPages: 1 });
    expect(w.days[0].pages).toHaveLength(499);
  });

  it("stops as partial on 429: earlier days complete, the failing day and later days not", async () => {
    stub([
      [200, { rows: [] }],
      [200, { rows: pageRows(1) }], // day 1 done
      [429, { error: { code: 429, message: "Quota exceeded" } }], // day 2
    ]);
    const w = await fetchSearchWindow(TOKEN, SITE, "2026-11-01", "2026-11-03");
    expect(w.stoppedReason).toBe("rate_limited");
    expect(w.days.map((d) => d.complete)).toEqual([true, false, false]);
    expect(w.days[1].pages).toEqual([]);
    expect(requests).toHaveLength(3);
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
