import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { AGENTS } from "@/server/agents/registry";
import { prisma } from "@/server/db/prisma";
import { kickIfDue } from "@/server/jobs/runner";

// Queued work runs after the response (kickRunner); give it room to finish.
export const maxDuration = 300;

export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "agents.read");
    if (scope instanceof Response) return scope;
    const { workspaceId, brandId } = scope;
    // The open app polls this: use it to run overdue scheduled posts and retries between cron runs.
    await kickIfDue().catch(() => {});

    const [configs, lastRuns] = await Promise.all([
      prisma.brandAgentConfig.findMany({ where: { workspaceId, brandId } }),
      // Each agent's newest run, read in the database (the [brandId, agentKey, createdAt] index), not every run.
      prisma.$queryRaw<{ id: string; agentKey: string; status: string; startedAt: Date | null; finishedAt: Date | null; error: string | null }[]>`
        SELECT DISTINCT ON ("agentKey") "id", "agentKey", "status", "startedAt", "finishedAt", "error"
        FROM "AgentRun" WHERE "workspaceId" = ${workspaceId} AND "brandId" = ${brandId}
        ORDER BY "agentKey", "createdAt" DESC`,
    ]);

    const agents = AGENTS.filter((a) => !a.internal).map((a) => {
      const run = lastRuns.find((r) => r.agentKey === a.key);
      return {
        key: a.key,
        name: a.name,
        description: a.description,
        enabled: configs.find((c) => c.agentKey === a.key)?.enabled ?? true,
        lastRun: run
          ? {
              id: run.id,
              status: run.status,
              startedAt: run.startedAt?.toISOString() ?? null,
              finishedAt: run.finishedAt?.toISOString() ?? null,
              error: run.status === "FAILED" ? (run.error?.slice(0, 300) ?? null) : null,
            }
          : null,
      };
    });
    return Response.json({ agents });
  } catch (error) {
    return fromAccessError(error);
  }
}
