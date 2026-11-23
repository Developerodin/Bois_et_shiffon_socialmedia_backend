import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { taskViewer } from "@/server/tasks/access";
import { taskProblem } from "@/server/tasks/errors";
import { patchMilestone, removeMilestone } from "@/server/tasks/projects";

type Params = { params: Promise<BrandRouteParams & { projectId: string; milestoneId: string }> };

/** Rename, re-date, tick or move a milestone (tasks.manage). */
export async function PATCH(request: Request, context: Params) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.manage");
    if (scope instanceof Response) return scope;
    const { projectId, milestoneId } = await context.params;
    return Response.json({ milestone: await patchMilestone(scope, taskViewer(scope), projectId, milestoneId, await request.json().catch(() => null)) });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}

/** Remove a milestone (tasks.manage). */
export async function DELETE(request: Request, context: Params) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.manage");
    if (scope instanceof Response) return scope;
    const { projectId, milestoneId } = await context.params;
    await removeMilestone(scope, taskViewer(scope), projectId, milestoneId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}
