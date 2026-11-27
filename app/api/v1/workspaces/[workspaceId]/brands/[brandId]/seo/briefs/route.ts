import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { SeoBriefBody, writeSeoBrief } from "@/server/seo/briefs";
import { taskViewer } from "@/server/tasks/access";
import { taskProblem } from "@/server/tasks/errors";

// One AI call in the request.
export const maxDuration = 120;

/**
 * "Write a brief" (2 credits): one AI brief over a finding's pages or the checked declining pages, written into a task.
 * tasks.manage and analytics.read: the brief reads search numbers and writes a task. 201 for a new task, 200 when it
 * went into the finding's open task.
 */
export async function POST(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.manage");
    if (scope instanceof Response) return scope;
    if (!scope.perms.has("analytics.read")) {
      return problemResponse({ type: "https://api.brandpilot/errors/forbidden", title: "Forbidden", status: 403, detail: "You can't see search numbers." });
    }
    const body = SeoBriefBody.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid request", status: 400, detail: body.error.issues[0]?.message ?? "Invalid brief request" });
    }
    const result = await writeSeoBrief(scope, taskViewer(scope), body.data);
    return Response.json(result, { status: result.existed ? 200 : 201 });
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}
