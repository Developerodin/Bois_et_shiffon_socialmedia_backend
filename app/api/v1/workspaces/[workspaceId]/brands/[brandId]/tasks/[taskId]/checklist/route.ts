import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { taskViewer } from "@/server/tasks/access";
import { addChecklistItem } from "@/server/tasks/checklist";
import { taskProblem } from "@/server/tasks/errors";

type Params = { params: Promise<BrandRouteParams & { taskId: string }> };

/** Add a checklist line (tasks.read; the owner or tasks.manage). */
export async function POST(request: Request, context: Params) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.read");
    if (scope instanceof Response) return scope;
    const { taskId } = await context.params;
    const item = await addChecklistItem(scope, taskViewer(scope), taskId, await request.json().catch(() => null));
    return Response.json({ item }, { status: 201 });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}
