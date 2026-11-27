import { problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { paidStart } from "@/server/api/client";
import { approveStage, cancelWorkflow, PatchWorkflowBody, retryStage, workflowProblem, workflowStatus } from "@/server/content/workflow";
import { kickIfDue, kickRunner } from "@/server/jobs/runner";
import { PlanRequiredError, requirePlan } from "@/server/services/subscriptions";

export const maxDuration = 300;

type Params = BrandRouteParams & { workflowId: string };

/** One workflow: its status, each stage's latest run and its posts per status. Polled while it runs. */
export async function GET(request: Request, context: { params: Promise<Params> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "agents.read");
    if (scope instanceof Response) return scope;
    const { workflowId } = await context.params;
    const workflow = await workflowStatus(scope, workflowId);
    // Polled while it waits: start the queue if it stalled (as the runs route does).
    if (workflow.stages.some((s) => s.state === "queued" || s.state === "running")) await kickIfDue().catch(() => {});
    return Response.json({ workflow });
  } catch (error) {
    return workflowProblem(error);
  }
}

/**
 * { action: "cancel" }: its posts not yet written are cancelled and its stages stop chaining.
 * { action: "approve", stage: "plan" | "briefs" }: one approval of the plan or the briefs starts the next agent (200
 *   repeated on a double click, nothing started twice).
 * { action: "retry", stage }: restarts that stage (never past a review gate). Retrying the Planner is paid again.
 */
export async function PATCH(request: Request, context: { params: Promise<Params> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "agents.run");
    if (scope instanceof Response) return scope;
    const { workflowId } = await context.params;
    const parsed = PatchWorkflowBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return problemResponse({ type: "https://api.brandpilot/errors/content-workflow", title: "Invalid request", status: 422, detail: parsed.error.message });
    const body = parsed.data;
    if (body.action === "cancel") return Response.json({ workflow: await cancelWorkflow(scope, workflowId) });
    if (body.action === "approve") {
      const { workflow, runId, repeated } = await approveStage(scope, scope.userId, workflowId, body.stage);
      if (!repeated) kickRunner();
      return Response.json({ workflow, runId, repeated }, { status: repeated ? 200 : 202 });
    }
    const retry = async () => {
      const { workflow, runId } = await retryStage(scope, scope.userId, workflowId, body.stage);
      kickRunner();
      return Response.json({ workflow, runId }, { status: 202 });
    };
    if (body.stage !== "planner") return await retry();
    return paidStart(request, { feature: "content-workflow:planner", workspaceId: scope.workspaceId, refId: workflowId }, async () => {
      try {
        await requirePlan(scope.workspaceId);
      } catch (e) {
        if (e instanceof PlanRequiredError) return Response.json({ planRequired: true, title: e.message }, { status: 402 });
        throw e;
      }
      return retry();
    }, workflowProblem);
  } catch (error) {
    return workflowProblem(error);
  }
}
