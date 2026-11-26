import { z } from "zod";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { kickRunner } from "@/server/jobs/runner";
import { auditAllCompetitors } from "@/server/services/competitor-audits";

// Queued work runs after the response (kickRunner); give it room to finish.
export const maxDuration = 300;

/** The ids in the order to start them (the page's plan: most named by AI first). Capped so one call stays short. */
const Body = z.object({ competitorIds: z.array(z.string().min(1).max(64)).min(1).max(50) });

/** Audit the given competitors in order with this workspace's credits, until they run out; says which started and which wait. */
export async function POST(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "agents.run");
    if (scope instanceof Response) return scope;
    const body = Body.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid request", status: 422, detail: "Pick the competitors to audit." });
    }
    // Each call starts several paid runs: a few presses an hour is plenty for one business.
    if (!(await hitRateLimit(`audit-all:${scope.brandId}`, 10, 3_600_000)).allowed) {
      return problemResponse({ type: "https://api.brandpilot/errors/rate-limited", title: "Too many requests", status: 429, detail: "Audit all was pressed too often. Try again in an hour." });
    }
    const result = await auditAllCompetitors({ ...scope, competitorIds: body.data.competitorIds });
    if (result.started.length) kickRunner();
    return Response.json(result, { status: result.started.length ? 202 : 200 });
  } catch (error) {
    return fromAccessError(error);
  }
}
