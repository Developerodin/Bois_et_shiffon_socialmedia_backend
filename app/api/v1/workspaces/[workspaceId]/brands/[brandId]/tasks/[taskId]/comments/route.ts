import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { taskViewer } from "@/server/tasks/access";
import { addComment, listComments } from "@/server/tasks/comments";
import { taskProblem } from "@/server/tasks/errors";
import { limitTaskWrites } from "@/server/tasks/service";

type Params = { params: Promise<BrandRouteParams & { taskId: string }> };

/** A task's comments the caller may read (tasks.read; a client never gets internal ones). */
export async function GET(request: Request, context: Params) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.read");
    if (scope instanceof Response) return scope;
    const { taskId } = await context.params;
    return Response.json({ comments: await listComments(scope, taskViewer(scope), taskId) });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}

/** Comment on a task (tasks.read). `{ body, shareWithClient? }`; staff comments stay internal unless shared. */
export async function POST(request: Request, context: Params) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.read");
    if (scope instanceof Response) return scope;
    await limitTaskWrites("comment", scope.userId);
    const { taskId } = await context.params;
    const comment = await addComment(scope, taskViewer(scope), taskId, await request.json().catch(() => null));
    return Response.json({ comment }, { status: 201 });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}
