import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import type { DataSourcesDto } from "@/shared";
import { brandTimeZone, listDataSources } from "@/server/data/sources";

/**
 * The brand's data sources and their last sync. Each row only for people holding its kind's read key (READ_KEY: a
 * shop's orders need crm.read, ad accounts ads.read); the shop domain or ad account name only for integrations.manage.
 * `timeZone`: the brand's zone, so a screen can say when a provider's days differ from it.
 */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "brand.read");
    if (scope instanceof Response) return scope;
    const [sources, timeZone] = await Promise.all([listDataSources(scope, scope.perms), brandTimeZone(scope)]);
    return Response.json({ sources, timeZone } satisfies DataSourcesDto);
  } catch (error) {
    return fromAccessError(error);
  }
}
