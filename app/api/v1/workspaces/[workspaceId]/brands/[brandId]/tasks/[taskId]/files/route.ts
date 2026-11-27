import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { taskViewer } from "@/server/tasks/access";
import { taskProblem } from "@/server/tasks/errors";
import { createFileSlot } from "@/server/tasks/files";

type Params = { params: Promise<BrandRouteParams & { taskId: string }> };

/**
 * A place to upload one document `{ fileName, contentType, bytes }` → `{ fileId, url, headers }`; the browser PUTs the
 * file there and then POSTs files/:fileId (tasks.read; staff who may edit the task: its owner, or tasks.manage).
 */
export async function POST(request: Request, context: Params) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.read");
    if (scope instanceof Response) return scope;
    const { taskId } = await context.params;
    const slot = await createFileSlot(scope, taskViewer(scope), taskId, await request.json().catch(() => null));
    return Response.json(slot, { status: 201 });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}
