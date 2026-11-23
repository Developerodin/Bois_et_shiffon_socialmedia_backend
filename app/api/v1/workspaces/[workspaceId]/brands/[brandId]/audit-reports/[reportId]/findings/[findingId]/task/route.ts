import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { taskFromFinding } from "@/server/seo/finding-tasks";
import { taskViewer } from "@/server/tasks/access";
import { taskProblem } from "@/server/tasks/errors";

type Params = { params: Promise<BrandRouteParams & { reportId: string; findingId: string }> };

/** "Make a task" on an audit finding (tasks.manage): the open task for it if there is one (200), else a new one (201). */
export async function POST(request: Request, context: Params) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.manage");
    if (scope instanceof Response) return scope;
    const { reportId, findingId } = await context.params;
    const { task, existed } = await taskFromFinding(scope, taskViewer(scope), reportId, findingId);
    return Response.json({ task, existed }, { status: existed ? 200 : 201 });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}
