import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { problemResponse } from "@/server/api/http-error";
import { toSearchProblem } from "@/server/data/search-problem";
import { listSearchSites } from "@/server/data/search-sync";

/**
 * Search Console site picker: the verified sites of one of this brand's Google connections, read live from Google.
 * integrations.manage; a connection of another brand or provider is 404; rate-limited per brand and person.
 */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "integrations.manage");
    if (scope instanceof Response) return scope;
    const connectionId = new URL(request.url).searchParams.get("connectionId");
    if (!connectionId) {
      return problemResponse({ type: "https://api.brandpilot/errors/invalid-query", title: "connectionId is required", status: 400, detail: "connectionId is required" });
    }
    return Response.json(await listSearchSites(scope, connectionId));
  } catch (error) {
    return toSearchProblem(error);
  }
}
