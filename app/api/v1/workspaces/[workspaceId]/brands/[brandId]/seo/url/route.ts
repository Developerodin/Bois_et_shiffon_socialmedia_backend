import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { pageNotOnSite, toSearchProblem } from "@/server/data/search-problem";
import { pageOnBrandSite } from "@/server/data/search-read";
import { badRange, parseDayRange } from "@/server/data/sources";
import { urlHistory, urlHistoryRange } from "@/server/seo/url-history";
import { SEARCH_RANGE_MAX_DAYS, type DateRange } from "@/shared";

/**
 * One URL's SEO story (search numbers, findings, tasks, articles). analytics.read, as the Search tab; tasks need
 * tasks.read too and articles brand.read. `u` must be an http(s) URL of at most 2,000 characters on the brand's own
 * website or Search Console site, else 400, so a crafted URL can't read another site's rows. Without from and to,
 * the last 90 synced days.
 */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "analytics.read");
    if (scope instanceof Response) return scope;
    const params = new URL(request.url).searchParams;
    const u = params.get("u") ?? "";
    if (!u || u.length > 2_000 || !(await pageOnBrandSite(scope, u))) return pageNotOnSite();
    let asked: DateRange | null = null;
    if (params.has("from") || params.has("to")) {
      asked = parseDayRange(params, SEARCH_RANGE_MAX_DAYS);
      if (!asked) return badRange(SEARCH_RANGE_MAX_DAYS);
    }
    return Response.json(await urlHistory(scope, u, await urlHistoryRange(scope, asked)));
  } catch (error) {
    return toSearchProblem(error);
  }
}
