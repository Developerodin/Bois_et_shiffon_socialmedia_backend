import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { fileFindingTasks } from "@/server/seo/finding-tasks";
import { taskProblem } from "@/server/tasks/errors";

type Params = { params: Promise<BrandRouteParams & { reportId: string }> };

/**
 * "Make all tasks" on a report (tasks.manage): a task for each finding that hasn't got one, with the same skips as the
 * job that runs after each report. 404 when the report isn't this brand's latest of its kind.
 */
export async function POST(request: Request, context: Params) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.manage");
    if (scope instanceof Response) return scope;
    const { reportId } = await context.params;
    const made = await fileFindingTasks({ workspaceId: scope.workspaceId, brandId: scope.brandId, reportId }, scope.userId);
    if (made === null) return problemResponse({ type: "https://api.brandpilot/errors/not-found", title: "Report not found", status: 404, detail: "This report was replaced by a newer one. Reload the page." });
    return Response.json({ made });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}
