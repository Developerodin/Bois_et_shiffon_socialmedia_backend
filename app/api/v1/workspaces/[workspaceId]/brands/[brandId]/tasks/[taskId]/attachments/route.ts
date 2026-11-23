import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { taskViewer } from "@/server/tasks/access";
import { addAttachment } from "@/server/tasks/attachments";
import { taskProblem } from "@/server/tasks/errors";

type Params = { params: Promise<BrandRouteParams & { taskId: string }> };

/** Attach a brand photo `{ mediaUploadId, role }` (tasks.read; the owner with content.create, or tasks.manage). */
export async function POST(request: Request, context: Params) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.read");
    if (scope instanceof Response) return scope;
    const { taskId } = await context.params;
    const attachment = await addAttachment(scope, taskViewer(scope), taskId, await request.json().catch(() => null));
    return Response.json({ attachment }, { status: 201 });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}
