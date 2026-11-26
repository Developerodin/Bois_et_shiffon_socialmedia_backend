import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { pageNotOnSite, toSearchProblem } from "@/server/data/search-problem";
import { badRange, parseDayRange } from "@/server/data/sources";
import { SEARCH_RANGE_MAX_DAYS } from "@/shared";
import { pageOnBrandSite, parsePagesQuery, QUERY_CURSOR, searchQueries } from "@/server/data/search-read";

/**
 * Search Console top queries over a range, 50 at a time by clicks or impressions; with `page`, the queries that led
 * to that page (which must be on the brand's own site, else 400). analytics.read.
 */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "analytics.read");
    if (scope instanceof Response) return scope;
    const params = new URL(request.url).searchParams;
    const range = parseDayRange(params, SEARCH_RANGE_MAX_DAYS);
    if (!range) return badRange(SEARCH_RANGE_MAX_DAYS);
    const query = parsePagesQuery(params, QUERY_CURSOR);
    if (!query) return badRange(SEARCH_RANGE_MAX_DAYS, "sort must be clicks or impressions, and cursor must come from the same sort.");
    const page = params.get("page");
    if (page !== null && (page.length > 2_000 || !(await pageOnBrandSite(scope, page)))) {
      return pageNotOnSite();
    }
    return Response.json(await searchQueries(scope, range, { ...query, ...(page !== null ? { page } : {}) }));
  } catch (error) {
    return toSearchProblem(error);
  }
}
