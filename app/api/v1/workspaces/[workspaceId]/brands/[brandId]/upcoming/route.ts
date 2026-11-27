import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { taskViewer } from "@/server/tasks/access";
import { taskProblem } from "@/server/tasks/errors";
import { upcomingWork } from "@/server/tasks/upcoming";

/** The Overview's next 7 days: website tasks due and project milestones, as the caller may see them (tasks.read). */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.read");
    if (scope instanceof Response) return scope;
    return Response.json(await upcomingWork(scope, taskViewer(scope)), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}
