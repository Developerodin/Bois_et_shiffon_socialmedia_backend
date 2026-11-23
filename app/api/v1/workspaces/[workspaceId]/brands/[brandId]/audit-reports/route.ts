import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { prisma } from "@/server/db/prisma";
import { latestAuditReports, toAuditDto } from "@/server/services/audit-reports";
import { OPEN_TASK_STATUSES } from "@/shared";

/**
 * Latest SEO and GEO reports for the Performance page. With tasks.read (staff), each report also lists its findings'
 * open tasks (`openTasks`: finding id → task id), so the page shows "Open task" instead of "Make a task".
 */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "analytics.read");
    if (scope instanceof Response) return scope;
    const { seo, geo } = await latestAuditReports(scope.workspaceId, scope.brandId);
    const open =
      scope.perms.has("tasks.read") && !scope.clientReviewer
        ? await prisma.task.findMany({
            where: { workspaceId: scope.workspaceId, brandId: scope.brandId, findingKind: { not: null }, findingId: { not: null }, status: { in: [...OPEN_TASK_STATUSES] } },
            select: { id: true, findingKind: true, findingId: true },
          })
        : [];
    const openTasks = (kind: "SEO" | "GEO") => Object.fromEntries(open.filter((t) => t.findingKind === kind).map((t) => [t.findingId!, t.id]));
    return Response.json({ seo: seo && { ...toAuditDto(seo), openTasks: openTasks("SEO") }, geo: geo && { ...toAuditDto(geo), openTasks: openTasks("GEO") } });
  } catch (error) {
    return fromAccessError(error);
  }
}
