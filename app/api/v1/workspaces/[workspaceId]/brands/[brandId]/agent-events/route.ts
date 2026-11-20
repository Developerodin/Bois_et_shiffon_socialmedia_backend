import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { AGENTS } from "@/server/agents/registry";
import { prisma } from "@/server/db/prisma";
import { RUN_ID_PATTERN } from "@/shared";

/** Agent Log feed for one brand (REQ-PLAT-005). Poll with ?after=<last id>. */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "agents.read");
    if (scope instanceof Response) return scope;
    const url = new URL(request.url);
    const after = Number.parseInt(url.searchParams.get("after") ?? "", 10);
    const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 1), 200);

    const where = { workspaceId: scope.workspaceId, brandId: scope.brandId };
    // ?runId= reads one run's events, oldest first (a run's log is short; no cursor). ?agentKey= is read only with
    // runId (ignored without it); it must be a known agent key (else 400) and narrows that run's events to that
    // agent's, so a run id from another agent's page shows nothing.
    const runId = url.searchParams.get("runId");
    if (runId !== null && !RUN_ID_PATTERN.test(runId)) return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid request", status: 400, detail: "runId: up to 40 letters, digits, - or _" });
    const agentKey = url.searchParams.get("agentKey");
    if (agentKey !== null && !AGENTS.some((a) => a.key === agentKey)) return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid request", status: 400, detail: "agentKey: not an agent" });
    // First load: latest `limit` events; later polls: everything after the cursor.
    const rows = runId !== null
      // ponytail: the first 200 events of a run; a longer run is cut. Upgrade: page by ?after= like the unscoped feed.
      ? await prisma.agentEvent.findMany({ where: { ...where, runId, ...(agentKey !== null ? { agentKey } : {}) }, orderBy: { id: "asc" }, take: 200 })
      : Number.isFinite(after)
      ? await prisma.agentEvent.findMany({ where: { ...where, id: { gt: after } }, orderBy: { id: "asc" }, take: limit })
      : (await prisma.agentEvent.findMany({ where, orderBy: { id: "desc" }, take: limit })).reverse();

    return Response.json({
      events: rows.map((e) => ({
        id: String(e.id),
        runId: e.runId,
        agentKey: e.agentKey,
        createdAt: e.createdAt.toISOString(),
        level: e.level,
        message: e.message,
        entityType: e.entityType,
        entityId: e.entityId,
      })),
    });
  } catch (error) {
    return fromAccessError(error);
  }
}
