import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { toSearchProblem } from "@/server/data/search-problem";
import { listSeoAlerts } from "@/server/seo/declines";
import type { SeoDeclinesDto } from "@/shared";

/** The chosen site's open decline alerts (pages losing search traffic), newest first, at most 50. analytics.read. */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "analytics.read");
    if (scope instanceof Response) return scope;
    const { alerts } = await listSeoAlerts(scope, { open: true }, 50);
    return Response.json({ alerts } satisfies SeoDeclinesDto);
  } catch (error) {
    return toSearchProblem(error);
  }
}
