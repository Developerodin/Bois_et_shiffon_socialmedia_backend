import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { badRange, toSearchProblem } from "@/server/data/search-problem";
import { parseSearchRange, searchSummary } from "@/server/data/search-read";

/** Search Console totals, the previous equal range and daily rows, from our own rows only. analytics.read; the site's URL only with integrations.manage. */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "analytics.read");
    if (scope instanceof Response) return scope;
    const range = parseSearchRange(new URL(request.url).searchParams);
    if (!range) return badRange();
    return Response.json(await searchSummary(scope, range, { manage: scope.perms.has("integrations.manage") }));
  } catch (error) {
    return toSearchProblem(error);
  }
}
