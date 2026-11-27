import {
  SEARCH_CONSOLE_ZONE, SEARCH_PAGE_SORTS, SEARCH_PAGES_LIMIT, SEARCH_QUERIES_LIMIT, urlVariants, type DateRange, type SearchMetrics, type SearchPageSort,
  type SearchPagesDto, type SearchQueriesDto, type SearchSummaryDto,
} from "@/shared";
import { prisma } from "@/server/db/prisma";
import { previousRange } from "@/server/data/sources";
import { sameSite } from "@/server/research/crawl";

/**
 * Search Console reads for the Performance page: only SearchDay, never Google. Every query is scoped to the brand and
 * to its chosen site (the source that isn't OFF), so another brand's rows or a previously chosen site never show.
 */

type Sums = { clicks: number | null; impressions: number | null; positionSum: number | null };
export function metrics(s: Sums): SearchMetrics {
  const clicks = s.clicks ?? 0;
  const impressions = s.impressions ?? 0;
  return { clicks, impressions, ctr: impressions ? clicks / impressions : null, position: impressions ? (s.positionSum ?? 0) / impressions : null };
}

const asDate = (day: string) => new Date(`${day}T00:00:00Z`);
type Scope = { workspaceId: string; brandId: string };
const SUM = { clicks: true, impressions: true, positionSum: true } as const;

/** The brand's chosen Search Console source (the one that isn't OFF): its site and the last day it holds, or null. */
export async function chosenSource(scope: Scope): Promise<{ siteUrl: string; syncedThrough: string | null } | null> {
  const source = await prisma.dataSource.findFirst({
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId, kind: "SEARCH_CONSOLE", status: { not: "OFF" } },
    select: { externalId: true, syncedThrough: true },
  });
  return source ? { siteUrl: source.externalId, syncedThrough: source.syncedThrough?.toISOString().slice(0, 10) ?? null } : null;
}

/** The brand's chosen site (its source that isn't OFF), or null. */
export async function chosenSite(scope: Scope) {
  return (await chosenSource(scope))?.siteUrl ?? null;
}
// No workspaceId filter: the brand is already the route's (scoped with its workspace by chosenSite), and the
// (brandId, siteUrl, dimension, day) INCLUDE index then answers index-only.
const rowsOf = (scope: Scope, siteUrl: string, r: DateRange, dimension: "SITE" | "PAGE") =>
  ({ brandId: scope.brandId, siteUrl, dimension, day: { gte: asDate(r.from), lte: asDate(r.to) } });

/** `manage` (integrations.manage): only they see the site's URL; everyone else gets `hasSite`. */
export async function searchSummary(scope: Scope, range: DateRange, opts: { manage: boolean }): Promise<SearchSummaryDto> {
  const prev = previousRange(range);
  const base = { daysIn: SEARCH_CONSOLE_ZONE, range, previousRange: prev } as const;
  const siteUrl = await chosenSite(scope);
  if (!siteUrl) {
    const zero = metrics({ clicks: 0, impressions: 0, positionSum: 0 });
    return { hasSite: false, ...(opts.manage ? { siteUrl: null } : {}), ...base, totals: zero, previous: zero, days: [] };
  }
  const [previous, days] = await Promise.all([
    prisma.searchDay.aggregate({ where: rowsOf(scope, siteUrl, prev, "SITE"), _sum: SUM }),
    prisma.searchDay.findMany({ where: rowsOf(scope, siteUrl, range, "SITE"), orderBy: { day: "asc" }, select: { day: true, clicks: true, impressions: true, positionSum: true } }),
  ]);
  // The range's totals are the sum of its days (at most 90 rows), so they never disagree with the chart.
  const sum = days.reduce((t, d) => ({ clicks: t.clicks + d.clicks, impressions: t.impressions + d.impressions, positionSum: t.positionSum + d.positionSum }), { clicks: 0, impressions: 0, positionSum: 0 });
  return {
    hasSite: true,
    ...(opts.manage ? { siteUrl } : {}),
    ...base,
    totals: metrics(sum),
    previous: metrics(previous._sum),
    days: days.map((d) => ({ day: d.day.toISOString().slice(0, 10), ...metrics(d) })),
  };
}

// The cursor is the offset, tagged with its list ("" for pages, "q-" for queries) and its sort, so a cursor from
// another list or sort is refused.
const encodeCursor = (tag: string, sort: SearchPageSort, offset: number) => Buffer.from(`${tag}${sort}:${offset}`).toString("base64url");
function decodeCursor(cursor: string, tag: string, sort: SearchPageSort): number | null {
  const m = /^([a-z-]+):(\d{1,6})$/.exec(Buffer.from(cursor, "base64url").toString());
  return m && m[1] === tag + sort ? Number(m[2]) : null;
}

/**
 * `?sort&cursor` → { sort, offset }, or null for an unknown sort or a cursor that isn't this list's and sort's.
 * `tag`: "" for pages (the default), QUERY_CURSOR for queries.
 */
export function parsePagesQuery(params: URLSearchParams, tag = ""): { sort: SearchPageSort; offset: number } | null {
  const sort = (params.get("sort") ?? "clicks") as SearchPageSort;
  if (!SEARCH_PAGE_SORTS.includes(sort)) return null;
  const cursor = params.get("cursor");
  if (!cursor) return { sort, offset: 0 };
  const offset = decodeCursor(cursor, tag, sort);
  return offset === null ? null : { sort, offset };
}
export const QUERY_CURSOR = "q-";

/**
 * Pages summed over the range, by the sort, SEARCH_PAGES_LIMIT a call.
 * ponytail: grouped per request with an offset over ≤ 90 days × 500 pages (≤ 45k index-only rows). Precompute per
 * sync if it gets slow.
 */
export async function searchPages(scope: Scope, range: DateRange, q: { sort: SearchPageSort; offset: number }): Promise<SearchPagesDto> {
  const siteUrl = await chosenSite(scope);
  if (!siteUrl) return { pages: [], nextCursor: null };
  const rows = await prisma.searchDay.groupBy({
    by: ["page"],
    where: rowsOf(scope, siteUrl, range, "PAGE"),
    _sum: SUM,
    orderBy: [{ _sum: { [q.sort]: "desc" } }, { page: "asc" }],
    skip: q.offset,
    take: SEARCH_PAGES_LIMIT + 1,
  });
  const more = rows.length > SEARCH_PAGES_LIMIT;
  return {
    pages: rows.slice(0, SEARCH_PAGES_LIMIT).map((p) => ({ page: p.page, ...metrics(p._sum) })),
    nextCursor: more ? encodeCursor("", q.sort, q.offset + SEARCH_PAGES_LIMIT) : null,
  };
}

/**
 * True when `url` is an http(s) URL on the brand's website or its chosen Search Console site (www ignored; a
 * `sc-domain:` property counts by its domain). Reads that take a page from the caller check this first, so a crafted
 * URL can't reach another site's rows.
 */
export async function pageOnBrandSite(scope: Scope, url: string): Promise<boolean> {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    host = u.hostname;
  } catch {
    return false;
  }
  const [profile, site] = await Promise.all([
    prisma.brandProfile.findFirst({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId }, select: { websiteUrl: true } }),
    chosenSite(scope),
  ]);
  const hosts: string[] = [];
  for (const raw of [profile?.websiteUrl, site]) {
    if (!raw) continue;
    if (raw.startsWith("sc-domain:")) hosts.push(raw.slice("sc-domain:".length).toLowerCase());
    else {
      try {
        hosts.push(new URL(raw).hostname);
      } catch {
        // an unparsable stored URL names no host
      }
    }
  }
  return hosts.some((h) => sameSite(h, host));
}

const ratio = (part: number, whole: number | null) => (whole ? part / whole : null);

/**
 * Queries summed over the range, by the sort, SEARCH_QUERIES_LIMIT a call; with `page`, the QUERY_PAGE rows whose
 * page is one of its stored spellings (urlVariants). The caller checks the page is on the brand's site first.
 * Coverage divides by the site's SITE rows (or the page's PAGE rows) over the days that have query rows, so days
 * before queries were synced don't count against it.
 * ponytail: grouped per request with an offset over ≤ 90 days × 500 rows, as searchPages.
 */
export async function searchQueries(scope: Scope, range: DateRange, q: { sort: SearchPageSort; offset: number; page?: string }): Promise<SearchQueriesDto> {
  const none = { queries: [], nextCursor: null, coverage: { clicks: null, impressions: null }, since: null };
  const siteUrl = await chosenSite(scope);
  if (!siteUrl) return none;
  const pages = q.page ? urlVariants(q.page) : null;
  if (pages && !pages.length) return none;
  const days = { gte: asDate(range.from), lte: asDate(range.to) };
  const where = { brandId: scope.brandId, siteUrl, day: days, ...(pages ? { dimension: "QUERY_PAGE" as const, page: { in: pages } } : { dimension: "QUERY" as const }) };
  const [rows, first, queryDays] = await Promise.all([
    prisma.searchQueryDay.groupBy({ by: ["query"], where, _sum: SUM, orderBy: [{ _sum: { [q.sort]: "desc" } }, { query: "asc" }], skip: q.offset, take: SEARCH_QUERIES_LIMIT + 1 }),
    prisma.searchQueryDay.findFirst({ where: { brandId: scope.brandId, siteUrl, dimension: "QUERY" }, orderBy: { day: "asc" }, select: { day: true } }),
    prisma.searchQueryDay.groupBy({ by: ["day"], where: { brandId: scope.brandId, siteUrl, day: days, dimension: "QUERY" } }),
  ]);
  const inDays = { in: queryDays.map((d) => d.day) };
  const [part, whole] = await Promise.all([
    prisma.searchQueryDay.aggregate({ where: { ...where, day: inDays }, _sum: SUM }),
    prisma.searchDay.aggregate({ where: { brandId: scope.brandId, siteUrl, day: inDays, ...(pages ? { dimension: "PAGE" as const, page: { in: pages } } : { dimension: "SITE" as const }) }, _sum: SUM }),
  ]);
  const more = rows.length > SEARCH_QUERIES_LIMIT;
  return {
    queries: rows.slice(0, SEARCH_QUERIES_LIMIT).map((r) => ({ query: r.query, ...metrics(r._sum) })),
    nextCursor: more ? encodeCursor(QUERY_CURSOR, q.sort, q.offset + SEARCH_QUERIES_LIMIT) : null,
    coverage: { clicks: ratio(part._sum.clicks ?? 0, whole._sum.clicks), impressions: ratio(part._sum.impressions ?? 0, whole._sum.impressions) },
    since: first ? first.day.toISOString().slice(0, 10) : null,
  };
}
