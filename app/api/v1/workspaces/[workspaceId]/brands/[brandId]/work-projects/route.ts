import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { taskViewer } from "@/server/tasks/access";
import { taskProblem } from "@/server/tasks/errors";
import { createProject, ListProjectsQuery, listProjects, WorkProjectInput } from "@/server/tasks/projects";

/** A page of the brand's work projects with progress (tasks.read; a client sees only shared ones). */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.read");
    if (scope instanceof Response) return scope;
    const q = ListProjectsQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!q.success) return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid request", status: 400, detail: q.error.issues[0]?.message });
    return Response.json(await listProjects(scope, taskViewer(scope), q.data));
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}

/** Create a work project (tasks.manage). With a requestId, a retry returns the first project. */
export async function POST(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.manage");
    if (scope instanceof Response) return scope;
    const body = WorkProjectInput.safeParse(await request.json().catch(() => null));
    if (!body.success) return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid project", status: 400, detail: body.error.issues[0]?.message });
    return Response.json({ project: await createProject(scope, taskViewer(scope), body.data) }, { status: 201 });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}
