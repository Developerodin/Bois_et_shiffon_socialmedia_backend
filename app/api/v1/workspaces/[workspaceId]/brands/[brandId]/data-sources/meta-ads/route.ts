import { z } from "zod";
import { problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { listDataSources } from "@/server/data/sources";
import { chooseMetaAdAccount, metaAdsProblem } from "@/server/integrations/meta-ads";
import { kickRunner } from "@/server/jobs/runner";

// The first backfill window runs after the response (kickRunner); give it room to finish.
export const maxDuration = 300;

const Body = z.object({ connectionId: z.string().min(1).max(100) }).strict();

/**
 * Choose this connection's ad account as the brand's ad data (integrations.manage): checked against Meta's live list
 * (GET meta-ads/accounts lists it). Returns `{ source }`, the saved source as GET data-sources shows it.
 */
export async function PUT(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "integrations.manage");
    if (scope instanceof Response) return scope;
    const body = Body.safeParse(await request.json().catch(() => null));
    if (!body.success) return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid request", status: 422 });
    const id = await chooseMetaAdAccount(scope, body.data.connectionId);
    kickRunner();
    const source = (await listDataSources(scope, scope.perms)).find((s) => s.id === id) ?? null;
    return Response.json({ source }, { status: 200 });
  } catch (error) {
    return metaAdsProblem(error);
  }
}
