import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { taskViewer } from "@/server/tasks/access";
import { taskProblem } from "@/server/tasks/errors";
import { getProject, patchProject } from "@/server/tasks/projects";

type Params = { params: Promise<BrandRouteParams & { projectId: string }> };

/** One project with milestones, task counts and its campaign's posts (tasks.read; 404 for a client unless shared). */
export async function GET(request: Request, context: Params) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.read");
    if (scope instanceof Response) return scope;
    const { projectId } = await context.params;
    return Response.json({ project: await getProject(scope, taskViewer(scope), projectId) });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}

/** Edit or archive (status ARCHIVED) a project (tasks.manage). */
export async function PATCH(request: Request, context: Params) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.manage");
    if (scope instanceof Response) return scope;
    const { projectId } = await context.params;
    return Response.json({ project: await patchProject(scope, taskViewer(scope), projectId, await request.json().catch(() => null)) });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}
