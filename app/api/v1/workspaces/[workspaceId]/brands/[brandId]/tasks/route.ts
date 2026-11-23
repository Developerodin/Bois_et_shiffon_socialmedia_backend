import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { taskViewer } from "@/server/tasks/access";
import { taskProblem } from "@/server/tasks/errors";
import { createTask, TaskInput } from "@/server/tasks/service";

/** Create a task (tasks.manage). With a requestId, a retry returns the first task. */
export async function POST(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.manage");
    if (scope instanceof Response) return scope;
    const body = TaskInput.safeParse(await request.json().catch(() => null));
    if (!body.success) return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid task", status: 400, detail: body.error.issues[0]?.message });
    return Response.json({ task: await createTask(scope, taskViewer(scope), body.data) }, { status: 201 });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}
