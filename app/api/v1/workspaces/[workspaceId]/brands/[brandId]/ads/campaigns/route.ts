import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { badExport as badRequest } from "@/server/api/csv-export";
import { ADS_MAX_DAYS, adsCampaigns } from "@/server/data/ads-read";
import { parseRange } from "@/shared";

/** Each campaign's numbers over `?from&to`, highest spend first, one row per currency. */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "ads.read");
    if (scope instanceof Response) return scope;
    const q = new URL(request.url).searchParams;
    const range = parseRange(q.get("from"), q.get("to"), ADS_MAX_DAYS);
    if (!range) return badRequest(`from and to must be YYYY-MM-DD days, from ≤ to, at most ${ADS_MAX_DAYS} days`);
    return Response.json({ campaigns: await adsCampaigns(scope, range) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return fromAccessError(error);
  }
}
