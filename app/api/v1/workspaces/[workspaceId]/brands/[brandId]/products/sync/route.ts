import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { requestCatalogSync } from "@/server/catalog/sync";
import { kickRunner } from "@/server/jobs/runner";

// Queued work runs after the response (kickRunner); give it room to finish.
export const maxDuration = 300;

/** "Sync now": queues a sync unless one is already queued or running (`queued: false`, a double click). */
export async function POST(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "context.edit");
    if (scope instanceof Response) return scope;
    // A press can start a site-reader chain (sitemaps, robots.txt): 6 an hour per person and brand is plenty.
    if (!(await hitRateLimit(`catalog-sync-now:${scope.brandId}:${scope.userId}`, 6, 3_600_000)).allowed) {
      return problemResponse({ type: "https://api.brandpilot/errors/rate-limited", title: "Too many syncs", status: 429, detail: "Too many syncs. Try again in a while." });
    }
    const result = await requestCatalogSync(scope);
    kickRunner();
    return Response.json(result, { status: 202 });
  } catch (error) {
    return fromAccessError(error);
  }
}
