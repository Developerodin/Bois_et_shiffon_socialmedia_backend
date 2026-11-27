import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { taskViewer } from "@/server/tasks/access";
import { taskProblem } from "@/server/tasks/errors";
import { removeFile, verifyFile } from "@/server/tasks/files";

type Params = { params: Promise<BrandRouteParams & { taskId: string; fileId: string }> };

/** The upload is done: check the file and keep it → `{ file }`; a refused file is gone and the 400 says why (tasks.read; as POST files). */
export async function POST(request: Request, context: Params) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.read");
    if (scope instanceof Response) return scope;
    const { taskId, fileId } = await context.params;
    return Response.json({ file: await verifyFile(scope, taskViewer(scope), taskId, fileId) }, { status: 201 });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}

/** Take a document off a task; the file is deleted (tasks.read; as POST files). */
export async function DELETE(request: Request, context: Params) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.read");
    if (scope instanceof Response) return scope;
    const { taskId, fileId } = await context.params;
    await removeFile(scope, taskViewer(scope), taskId, fileId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}
