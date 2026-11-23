import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { toSearchProblem } from "@/server/data/search-problem";
import { badRange, parseDayRange } from "@/server/data/sources";
import { SEARCH_RANGE_MAX_DAYS } from "@/shared";
import { parsePagesQuery, searchPages } from "@/server/data/search-read";

/** Search Console top pages over a range, 50 at a time by clicks or impressions. analytics.read. */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "analytics.read");
    if (scope instanceof Response) return scope;
    const params = new URL(request.url).searchParams;
    const range = parseDayRange(params, SEARCH_RANGE_MAX_DAYS);
    if (!range) return badRange(SEARCH_RANGE_MAX_DAYS);
    const query = parsePagesQuery(params);
    if (!query) return badRange(SEARCH_RANGE_MAX_DAYS, "sort must be clicks or impressions, and cursor must come from the same sort.");
    return Response.json(await searchPages(scope, range, query));
  } catch (error) {
    return toSearchProblem(error);
  }
}
