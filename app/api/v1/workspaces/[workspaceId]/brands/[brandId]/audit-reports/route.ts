import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { prisma } from "@/server/db/prisma";
import { latestAuditReports, toAuditDto } from "@/server/services/audit-reports";
import { taskViewer, visibleTaskSql } from "@/server/tasks/access";
import { openTaskSql } from "@/server/tasks/sql";

/**
 * Latest SEO and GEO reports for the Performance page. With tasks.read (staff), each report also lists its findings'
 * open tasks the caller can see (`openTasks`: finding id → task id, visibleTaskSql), so the page shows "Open task"
 * instead of "Make a task"; a finding whose task they can't see gets a 409 from "Make a task" (taskFromFinding).
 */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "analytics.read");
    if (scope instanceof Response) return scope;
    const { seo, geo } = await latestAuditReports(scope.workspaceId, scope.brandId);
    const open =
      scope.perms.has("tasks.read") && !scope.clientReviewer
        ? await prisma.$queryRaw<{ id: string; findingKind: "SEO" | "GEO"; findingId: string }[]>`SELECT t.id, t."findingKind"::text AS "findingKind", t."findingId" FROM "Task" t
            WHERE ${visibleTaskSql(taskViewer(scope))} AND ${openTaskSql} AND t."findingKind" IS NOT NULL AND t."findingId" IS NOT NULL`
        : [];
    const openTasks = (kind: "SEO" | "GEO") => Object.fromEntries(open.filter((t) => t.findingKind === kind).map((t) => [t.findingId, t.id]));
    return Response.json({ seo: seo && { ...toAuditDto(seo), openTasks: openTasks("SEO") }, geo: geo && { ...toAuditDto(geo), openTasks: openTasks("GEO") } });
  } catch (error) {
    return fromAccessError(error);
  }
}
