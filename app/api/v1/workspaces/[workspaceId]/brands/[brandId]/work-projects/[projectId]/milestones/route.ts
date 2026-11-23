import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { taskViewer } from "@/server/tasks/access";
import { taskProblem } from "@/server/tasks/errors";
import { addMilestone } from "@/server/tasks/projects";

type Params = { params: Promise<BrandRouteParams & { projectId: string }> };

/** Add a milestone at the end of a project (tasks.manage). */
export async function POST(request: Request, context: Params) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.manage");
    if (scope instanceof Response) return scope;
    const { projectId } = await context.params;
    return Response.json({ milestone: await addMilestone(scope, taskViewer(scope), projectId, await request.json().catch(() => null)) }, { status: 201 });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}
