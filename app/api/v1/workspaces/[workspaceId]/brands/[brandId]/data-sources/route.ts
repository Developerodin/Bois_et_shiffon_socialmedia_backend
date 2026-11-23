import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { listDataSources } from "@/server/data/sources";

/**
 * The brand's data sources and their last sync. Each row only for people holding its kind's read key (READ_KEY: a
 * shop's orders need crm.read, ad accounts ads.read); the shop domain or ad account name only for integrations.manage.
 */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "brand.read");
    if (scope instanceof Response) return scope;
    return Response.json({ sources: await listDataSources(scope, scope.perms) });
  } catch (error) {
    return fromAccessError(error);
  }
}
