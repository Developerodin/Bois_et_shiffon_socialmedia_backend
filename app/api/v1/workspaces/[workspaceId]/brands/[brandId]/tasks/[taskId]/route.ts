import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { taskViewer } from "@/server/tasks/access";
import { runTaskAction, TaskActionInput } from "@/server/tasks/actions";
import { taskProblem } from "@/server/tasks/errors";
import { getTask, patchTask } from "@/server/tasks/service";

type Params = { params: Promise<BrandRouteParams & { taskId: string }> };

/** One task the caller can see (tasks.read); 404 otherwise. */
export async function GET(request: Request, context: Params) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.read");
    if (scope instanceof Response) return scope;
    const { taskId } = await context.params;
    return Response.json({ task: await getTask(scope, taskViewer(scope), taskId) });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}

/** Edit a task's fields (tasks.manage). Status moves only through the actions; it and other server fields are ignored here. */
export async function PATCH(request: Request, context: Params) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.manage");
    if (scope instanceof Response) return scope;
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid task", status: 400 });
    const { taskId } = await context.params;
    return Response.json({ task: await patchTask(scope, taskViewer(scope), taskId, body as Record<string, unknown>) });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}

/** Run a status action (tasks.read); who may run which (owner, reviewer, manager) is the task rules' call. */
export async function POST(request: Request, context: Params) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.read");
    if (scope instanceof Response) return scope;
    const body = TaskActionInput.safeParse(await request.json().catch(() => null));
    if (!body.success) return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid action", status: 400, detail: body.error.issues[0]?.message });
    const { taskId } = await context.params;
    return Response.json({ task: await runTaskAction(scope, taskViewer(scope), taskId, body.data) });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}
