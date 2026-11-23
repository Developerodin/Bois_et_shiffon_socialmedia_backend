import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { taskViewer } from "@/server/tasks/access";
import { taskProblem } from "@/server/tasks/errors";
import { BatchInput, createTaskBatch } from "@/server/tasks/from-note";
import { limitTaskWrites } from "@/server/tasks/service";

/** Create up to 20 tasks at once, all or nothing (tasks.manage). A retry with the same requestId returns the first rows. */
export async function POST(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.manage");
    if (scope instanceof Response) return scope;
    await limitTaskWrites("batch", scope.userId);
    const body = BatchInput.safeParse(await request.json().catch(() => null));
    if (!body.success) return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid tasks", status: 400, detail: body.error.issues[0]?.message });
    return Response.json(await createTaskBatch(scope, taskViewer(scope), body.data), { status: 201 });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}
