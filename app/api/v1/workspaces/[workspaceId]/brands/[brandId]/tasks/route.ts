import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { taskViewer } from "@/server/tasks/access";
import { taskProblem } from "@/server/tasks/errors";
import { ListQuery, listTasks, todayTasks } from "@/server/tasks/list";
import { createTask, TaskInput } from "@/server/tasks/service";

/** A view of the tasks the caller can see, 50 a page (tasks.read); `view=today` gives Today's counts and first rows. */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.read");
    if (scope instanceof Response) return scope;
    const params = Object.fromEntries(new URL(request.url).searchParams);
    if (params.view === "today") return Response.json(await todayTasks(scope, taskViewer(scope)));
    const q = ListQuery.safeParse(params);
    if (!q.success) return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid request", status: 400, detail: q.error.issues[0]?.message });
    return Response.json(await listTasks(scope, taskViewer(scope), q.data));
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}

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
