import { call, ProviderError } from "@/server/integrations/providers";
import type { SyncStop } from "@/server/data/sync-stop";

/**
 * Search Console API client (webmasters v3). Pure: it takes an access token (from `accessToken(conn)`) and returns
 * buffered rows; it never writes to the database. The caller writes only days with `complete: true`.
 *
 * Days are Google's days (Pacific time), passed and returned as "YYYY-MM-DD" exactly as Google reports them.
 *
 * Failure modes:
 * - 401 or invalid_grant → "reconnect" (token revoked, or the Google app is unverified and refresh tokens die after
 *   7 days in Testing mode). Not retried.
 * - 403 → "permission" (the site was removed from this Google account); the connection itself stays fine.
 * - 429 or a 403 quota/rate error → "rate_limited": stop, return what is complete so far (a partial window).
 * - 5xx, a network error or a timeout → "failed", also keeping the days already complete.
 * - The run passed MAX_MS → "capped", keeping the days already complete.
 * - The last ~2 days are preliminary (`dataState: "all"`), which is why the daily job re-reads 3.
 * - A failed query call (QUERY or QUERY_PAGE) marks only that day's queries incomplete and skips the query calls of
 *   the run's later days (a load-quota error would repeat); SITE and PAGE go on.
 * Request URLs are never logged and the token is scrubbed from any logged provider text (it rides in a header, but
 * Google's error text is not ours to trust).
 */

/*
 * Google's limits and behaviour, read from Google's documentation on 2026-11-26 (not from memory):
 * - https://developers.google.com/webmaster-tools/limits : Search Analytics 1,200 queries per minute per site and per
 *   user, 40,000 per minute and 30,000,000 per day per project. A separate "load" quota, short-term (10-minute chunks)
 *   and long-term (1-day chunks): "Queries are expensive when you group and/or filter by either page or query string.
 *   Queries grouped/filtered by page AND query string are the most expensive", and load grows with the date range,
 *   so every page and query call here asks for one day. Exceeding it returns "quota exceeded"; Google says wait 15
 *   minutes (the backfill chain's retry does that). A daily run makes 1 + 3 × 3 = 10 calls, a 30-day window 91.
 * - https://developers.google.com/webmaster-tools/v1/searchanalytics/query : rowLimit 1–25,000 (default 1,000), paging
 *   by startRow, so 500 rows need one request. "Results are sorted by click count, in descending order, unless you
 *   group by date": the top 500 are the 500 most-clicked rows (ties arbitrary), which declines.ts's cap floor relies
 *   on. dataState "all" includes fresh data; "All values after the first_incomplete_date may still change".
 * - https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data : at most 50K rows per day per search type,
 *   sorted by clicks; "Data is typically available after 2-3 days"; grouping by page and/or query "may drop some data".
 * - https://developers.google.com/search/blog/2022/10/performance-data-deep-dive : "the actual anonymized queries are
 *   always omitted from the tables", so query sums sit below the site total.
 * - Not stated anywhere read: whether IDN hosts come back as punycode or Unicode; urlKey (shared/seo-url.ts) folds both.
 */
const API = "https://www.googleapis.com/webmasters/v3";
export const SEARCH_CONSOLE_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

/** Top pages kept per day, read in one request. Google orders rows by clicks, so this is the top 500 by clicks; page sums sit below the site total. */
export const PAGES_PER_DAY = 500;
const MAX_MS = 4 * 60_000;
/** Longer page URLs are skipped and counted, so the stored key stays bounded. */
export const MAX_PAGE_KEY = 1000;
/** Top queries and top query-page pairs kept per day, one request each (sorted by clicks, as pages). */
export const QUERIES_PER_DAY = 500;
/** Longer query text is skipped and counted. */
export const MAX_QUERY_KEY = 200;
/** UTF-8 bytes of siteUrl + query + page: Postgres refuses a btree entry over ~2,700 bytes and the INCLUDE columns add a little. */
export const MAX_QUERY_ROW_KEY_BYTES = 2_000;

export type StopReason = Exclude<SyncStop, "missing_scope">;

/** Message is the stop itself: the routes word it (search-sync liveSites). */
export class SearchConsoleError extends Error {
  constructor(readonly reason: StopReason) {
    super(`Search Console ${reason}`);
  }
}

export type Metrics = { clicks: number; impressions: number; positionSum: number };
export type PageMetrics = Metrics & { page: string };
export type QueryMetrics = Metrics & { query: string; page: string };
/**
 * `complete`: SITE and PAGE were read. `queriesComplete`: both query calls were read too (the caller replaces a
 * day's query rows only then). `queries` have page "".
 */
export type SearchDayResult = {
  day: string;
  site: Metrics;
  pages: PageMetrics[];
  skippedPages: number;
  complete: boolean;
  queries: QueryMetrics[];
  queryPages: QueryMetrics[];
  skippedQueries: number;
  queriesComplete: boolean;
};
export type SearchWindow = { days: SearchDayResult[]; stoppedReason?: StopReason };

type Row = { keys?: string[]; clicks?: number; impressions?: number; position?: number };

function reasonOf(e: ProviderError): StopReason {
  const status = e.status;
  if (status === 401 || /invalid_grant/.test(e.message)) return "reconnect";
  if (status === 429 || (status === 403 && /quota|rate/i.test(e.message))) return "rate_limited";
  if (status === 403) return "permission";
  return "failed";
}

async function google<T>(token: string, url: string, body?: unknown): Promise<T> {
  try {
    return await call<T>(url, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // fetch's own failures (network, the 15 s timeout): the error can carry the URL, so only its name is logged.
    if (e instanceof TypeError || (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"))) {
      console.error("[search-console] failed", e.name);
      throw new SearchConsoleError("failed");
    }
    if (!(e instanceof ProviderError)) throw e;
    const reason = reasonOf(e);
    console.error("[search-console]", reason, e.message.split(token).join("[token]"));
    throw new SearchConsoleError(reason);
  }
}

/** Sites this Google account can read, verified ones only. A connection granted without the Search Console scope must reconnect. */
export async function listSites(token: string, grantedScopes: string[]): Promise<{ siteUrl: string; permissionLevel: string }[]> {
  if (!grantedScopes.includes(SEARCH_CONSOLE_SCOPE)) throw new SearchConsoleError("reconnect");
  const r = await google<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>(token, `${API}/sites`);
  return (r.siteEntry ?? []).filter((s) => s.permissionLevel !== "siteUnverifiedUser");
}

const metrics = (r: Row): Metrics => {
  const impressions = r.impressions ?? 0;
  return { clicks: r.clicks ?? 0, impressions, positionSum: (r.position ?? 0) * impressions };
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function daysBetween(from: string, to: string): string[] {
  if (!DAY.test(from) || !DAY.test(to) || from > to) throw new Error("from/to must be YYYY-MM-DD with from <= to");
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

/**
 * Site totals and top pages for each Google day in [from, to], all buffered before returning. SITE comes from one
 * windowed call (`dimensions: ["date"]`); PAGE is one request per day (top PAGES_PER_DAY). A day is `complete` only
 * when the SITE call and its PAGE request succeeded. On the first failure, or once the run passes MAX_MS, the walk
 * stops: the failing day and all later days come back incomplete, with `stoppedReason`. A bug still throws.
 */
export async function fetchSearchWindow(token: string, siteUrl: string, from: string, to: string): Promise<SearchWindow> {
  const days = daysBetween(from, to);
  const url = `${API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const empty = (day: string): SearchDayResult => ({
    day,
    site: { clicks: 0, impressions: 0, positionSum: 0 },
    pages: [],
    skippedPages: 0,
    complete: false,
    queries: [],
    queryPages: [],
    skippedQueries: 0,
    queriesComplete: false,
  });
  const result = days.map(empty);
  const started = Date.now();
  let queriesOn = true;
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  const queryRows = async (day: string, dimensions: string[], out: QueryMetrics[]) => {
    let skipped = 0;
    const r = await google<{ rows?: Row[] }>(token, url, { startDate: day, endDate: day, dimensions, dataState: "all", rowLimit: QUERIES_PER_DAY });
    for (const row of r.rows ?? []) {
      const query = row.keys?.[0] ?? "";
      const page = dimensions.length > 1 ? (row.keys?.[1] ?? "") : "";
      const bad = !query || query.length > MAX_QUERY_KEY || (dimensions.length > 1 && (!page || page.length > MAX_PAGE_KEY));
      if (bad || bytes(siteUrl + query + page) > MAX_QUERY_ROW_KEY_BYTES) skipped++;
      else out.push({ query, page, ...metrics(row) });
    }
    return skipped;
  };

  try {
    const site = await google<{ rows?: Row[] }>(token, url, { startDate: from, endDate: to, dimensions: ["date"], dataState: "all", rowLimit: days.length });
    // A day Google has no row for had no impressions: it stays zero.
    const byDay = new Map((site.rows ?? []).map((r) => [r.keys?.[0], metrics(r)]));
    for (const d of result) d.site = byDay.get(d.day) ?? d.site;

    for (const d of result) {
      if (Date.now() - started > MAX_MS) return { days: result, stoppedReason: "capped" };
      const pages: PageMetrics[] = [];
      let skipped = 0;
      const r = await google<{ rows?: Row[] }>(token, url, { startDate: d.day, endDate: d.day, dimensions: ["page"], dataState: "all", rowLimit: PAGES_PER_DAY });
      for (const row of r.rows ?? []) {
        const page = row.keys?.[0] ?? "";
        if (!page || page.length > MAX_PAGE_KEY) skipped++;
        else pages.push({ page, ...metrics(row) });
      }
      d.pages = pages;
      d.skippedPages = skipped;
      d.complete = true;
      if (!queriesOn) continue;
      try {
        const queries: QueryMetrics[] = [];
        const queryPages: QueryMetrics[] = [];
        const skippedQueries = (await queryRows(d.day, ["query"], queries)) + (await queryRows(d.day, ["query", "page"], queryPages));
        Object.assign(d, { queries, queryPages, skippedQueries, queriesComplete: true });
      } catch (e) {
        if (!(e instanceof SearchConsoleError)) throw e;
        queriesOn = false; // this day's and later days' queries stay incomplete; their SITE and PAGE rows still count
      }
    }
    return { days: result };
  } catch (e) {
    if (!(e instanceof SearchConsoleError)) throw e;
    return { days: result, stoppedReason: e.reason };
  }
}
