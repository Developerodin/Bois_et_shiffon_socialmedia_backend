import {
  SEARCH_CONSOLE_ZONE, SEARCH_PAGE_SORTS, SEARCH_PAGES_LIMIT, type DateRange, type SearchMetrics, type SearchPageSort, type SearchPagesDto,
  type SearchSummaryDto,
} from "@/shared";
import { prisma } from "@/server/db/prisma";
import { previousRange } from "@/server/data/sources";

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

/** The brand's chosen site (its source that isn't OFF), or null. */
async function chosenSite(scope: Scope) {
  const source = await prisma.dataSource.findFirst({
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId, kind: "SEARCH_CONSOLE", status: { not: "OFF" } },
    select: { externalId: true },
  });
  return source?.externalId ?? null;
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

// The cursor is the offset, tagged with its sort so a cursor from another sort is refused.
const encodeCursor = (sort: SearchPageSort, offset: number) => Buffer.from(`${sort}:${offset}`).toString("base64url");
function decodeCursor(cursor: string, sort: SearchPageSort): number | null {
  const m = /^([a-z]+):(\d{1,6})$/.exec(Buffer.from(cursor, "base64url").toString());
  return m && m[1] === sort ? Number(m[2]) : null;
}

/** `?sort&cursor` → { sort, offset }, or null for an unknown sort or a cursor that isn't this sort's. */
export function parsePagesQuery(params: URLSearchParams): { sort: SearchPageSort; offset: number } | null {
  const sort = (params.get("sort") ?? "clicks") as SearchPageSort;
  if (!SEARCH_PAGE_SORTS.includes(sort)) return null;
  const cursor = params.get("cursor");
  if (!cursor) return { sort, offset: 0 };
  const offset = decodeCursor(cursor, sort);
  return offset === null ? null : { sort, offset };
}

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
    nextCursor: more ? encodeCursor(q.sort, q.offset + SEARCH_PAGES_LIMIT) : null,
  };
}
