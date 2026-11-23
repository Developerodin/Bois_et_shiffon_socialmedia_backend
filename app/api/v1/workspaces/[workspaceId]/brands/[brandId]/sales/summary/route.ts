import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { MAX_SALES_DAYS, salesRange, salesSummary } from "@/server/data/sales-read";

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
    const range = salesRange(params.get("from"), params.get("to"));
    if (!range) {
      return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Pick a date range", status: 422, detail: `Pick a range of up to ${MAX_SALES_DAYS} days.` });
    }
    return Response.json(await salesSummary(scope, range), { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return fromAccessError(error);
  }
}
