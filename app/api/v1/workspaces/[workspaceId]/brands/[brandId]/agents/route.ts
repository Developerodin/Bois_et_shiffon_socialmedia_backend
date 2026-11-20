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

    const shown = AGENTS.filter((a) => !a.internal);
    const [configs, lastRuns] = await Promise.all([
      prisma.brandAgentConfig.findMany({ where: { workspaceId, brandId } }),
      // Each agent's newest run, one round trip: for each key a single index lookup (the [brandId, agentKey, createdAt]
      // index, read backwards, stops at the first row), so the cost is the number of agents, not the brand's run history.
      // "id" breaks a tie between runs made in the same instant.
      prisma.$queryRaw<{ id: string; agentKey: string; status: string; startedAt: Date | null; finishedAt: Date | null; error: string | null }[]>`
        SELECT r."id", r."agentKey", r."status", r."startedAt", r."finishedAt", r."error"
        FROM unnest(${shown.map((a) => a.key)}::text[]) AS k("key")
        CROSS JOIN LATERAL (
          SELECT "id", "agentKey", "status", "startedAt", "finishedAt", "error" FROM "AgentRun"
          WHERE "workspaceId" = ${workspaceId} AND "brandId" = ${brandId} AND "agentKey" = k."key"
          ORDER BY "createdAt" DESC, "id" DESC LIMIT 1
        ) r`,
    ]);

    const agents = shown.map((a) => {
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
