import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { AccessDeniedError } from "@/server/auth/errors";
import { taskViewer } from "@/server/tasks/access";
import { AssignInput, assignTasks } from "@/server/tasks/assign";
import { taskProblem } from "@/server/tasks/errors";
import { limitTaskWrites } from "@/server/tasks/service";

/** Give up to 100 tasks to one person, one role or nobody, all or nothing (tasks.manage and tasks.all). */
export async function POST(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.manage");
    if (scope instanceof Response) return scope;
    const v = taskViewer(scope);
    if (!v.all) throw new AccessDeniedError("Missing permission tasks.all");
    await limitTaskWrites("batch", scope.userId);
    const body = AssignInput.safeParse(await request.json().catch(() => null));
    if (!body.success) return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid request", status: 400, detail: body.error.issues[0]?.message });
    return Response.json(await assignTasks(scope, v, body.data));
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}
