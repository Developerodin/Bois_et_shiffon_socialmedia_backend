import { z } from "zod";
import { invalidBody } from "@/server/api/ai-model-route";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { toSearchProblem } from "@/server/data/search-problem";
import { chooseSearchSite } from "@/server/data/search-sync";
import { kickRunner } from "@/server/jobs/runner";

// The first backfill window runs after the response (kickRunner); give it room to finish.
export const maxDuration = 300;

const Body = z.object({ connectionId: z.string().min(1).max(100), siteUrl: z.string().min(1).max(2048) });

/**
 * Choose the brand's Search Console site: integrations.manage; the connection must be this brand's Google one (else
 * 404) and the site in its live list (else 400). Starts syncing it: 90 days back, then daily.
 */
export async function PUT(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "integrations.manage");
    if (scope instanceof Response) return scope;
    const body = Body.safeParse(await request.json().catch(() => null));
    if (!body.success) return invalidBody(body.error);
    const source = await chooseSearchSite(scope, body.data);
    kickRunner();
    return Response.json({ id: source.id, siteUrl: source.externalId }, { status: 200 });
  } catch (error) {
    return toSearchProblem(error);
  }
}
