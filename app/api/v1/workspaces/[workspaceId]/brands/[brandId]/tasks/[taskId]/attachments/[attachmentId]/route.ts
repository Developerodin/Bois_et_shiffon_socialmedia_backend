import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { taskViewer } from "@/server/tasks/access";
import { removeAttachment } from "@/server/tasks/attachments";
import { taskProblem } from "@/server/tasks/errors";

type Params = { params: Promise<BrandRouteParams & { taskId: string; attachmentId: string }> };

/** Take a photo off a task; the upload stays (tasks.read; the owner with content.create, or tasks.manage). */
export async function DELETE(request: Request, context: Params) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.read");
    if (scope instanceof Response) return scope;
    const { taskId, attachmentId } = await context.params;
    await removeAttachment(scope, taskViewer(scope), taskId, attachmentId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}
