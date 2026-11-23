import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { taskViewer } from "@/server/tasks/access";
import { patchChecklistItem, removeChecklistItem } from "@/server/tasks/checklist";
import { taskProblem } from "@/server/tasks/errors";

type Params = { params: Promise<BrandRouteParams & { taskId: string; itemId: string }> };

/** Edit, tick or move a checklist line (tasks.read; the owner or tasks.manage). */
export async function PATCH(request: Request, context: Params) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.read");
    if (scope instanceof Response) return scope;
    const { taskId, itemId } = await context.params;
    return Response.json({ item: await patchChecklistItem(scope, taskViewer(scope), taskId, itemId, await request.json().catch(() => null)) });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}

/** Remove a checklist line (tasks.read; the owner or tasks.manage). */
export async function DELETE(request: Request, context: Params) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.read");
    if (scope instanceof Response) return scope;
    const { taskId, itemId } = await context.params;
    await removeChecklistItem(scope, taskViewer(scope), taskId, itemId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}
