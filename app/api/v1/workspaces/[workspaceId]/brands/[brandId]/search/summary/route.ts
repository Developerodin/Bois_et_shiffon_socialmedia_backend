import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { toSearchProblem } from "@/server/data/search-problem";
import { badRange, parseDayRange } from "@/server/data/sources";
import { SEARCH_RANGE_MAX_DAYS } from "@/shared";
import { searchSummary } from "@/server/data/search-read";

/** Search Console totals, the previous equal range and daily rows, from our own rows only. analytics.read; the site's URL only with integrations.manage. */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "analytics.read");
    if (scope instanceof Response) return scope;
    const range = parseDayRange(new URL(request.url).searchParams, SEARCH_RANGE_MAX_DAYS);
    if (!range) return badRange(SEARCH_RANGE_MAX_DAYS);
    return Response.json(await searchSummary(scope, range, { manage: scope.perms.has("integrations.manage") }));
  } catch (error) {
    return toSearchProblem(error);
  }
}
