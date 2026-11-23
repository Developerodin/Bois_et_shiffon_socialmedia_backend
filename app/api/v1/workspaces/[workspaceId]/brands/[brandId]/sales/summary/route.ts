import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { MAX_SALES_DAYS, salesSummary } from "@/server/data/sales-read";
import { badRange, parseDayRange } from "@/server/data/sources";

/**
 * Sales tab: order totals per currency for `?from&to` (brand-local days, inclusive, up to a year) with the previous
 * period and a daily series. Needs crm.read: sales numbers are computed only for people holding it. Never returns the
 * shop domain or any order detail.
 */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "crm.read");
    if (scope instanceof Response) return scope;
    const params = new URL(request.url).searchParams;
    const range = parseDayRange(params, MAX_SALES_DAYS);
    if (!range) return badRange(MAX_SALES_DAYS);
    return Response.json(await salesSummary(scope, range), { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return fromAccessError(error);
  }
}
