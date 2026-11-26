import { z } from "zod";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { kickRunner } from "@/server/jobs/runner";
import { queueAuditAll } from "@/server/services/competitor-audits";

// Queued work runs after the response (kickRunner); give it room to finish.
export const maxDuration = 300;

/**
 * The ids in the order to start them (the page's plan: most named by AI first), capped so one job stays short, and the
 * press's own id, so a press sent twice queues one job.
 */
const Body = z.object({ competitorIds: z.array(z.string().min(1).max(64)).min(1).max(50), pressId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) });

/**
 * Queue Audit all for the given competitors and answer at once (202): a background job starts them in order with this
 * workspace's credits, until they run out. The answer lists the queued ids and the ones this brand doesn't track.
 */
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
    const result = await queueAuditAll({ workspaceId: scope.workspaceId, brandId: scope.brandId, userId: scope.userId, ...body.data });
    if (result.queued.length) kickRunner();
    return Response.json(result, { status: result.queued.length ? 202 : 200 });
  } catch (error) {
    return fromAccessError(error);
  }
}
