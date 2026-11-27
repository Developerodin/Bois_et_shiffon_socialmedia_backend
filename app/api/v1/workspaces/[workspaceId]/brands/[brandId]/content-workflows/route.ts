import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { paidStart } from "@/server/api/client";
import { listWorkflows, startWorkflow, workflowProblem } from "@/server/content/workflow";
import { kickRunner } from "@/server/jobs/runner";
import { PlanRequiredError, requirePlan } from "@/server/services/subscriptions";

// Queued work runs after the response (kickRunner); give it room to finish.
export const maxDuration = 300;

/** The brand's latest content workflows. */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "agents.read");
    if (scope instanceof Response) return scope;
    return Response.json({ workflows: await listWorkflows(scope) });
  } catch (error) {
    return workflowProblem(error);
  }
}

/**
 * Starts a content workflow (shared/contract/content-workflow.ts StartWorkflowRequest): 201 with the workflow, or 200
 * with the one a repeated requestId made (nothing charged or started again). Paid like a Planner run, plan required.
 */
export async function POST(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "agents.run");
    if (scope instanceof Response) return scope;
    const body: unknown = await request.json().catch(() => null);
    const requestId = (body as { requestId?: unknown } | null)?.requestId;
    return paidStart(request, { feature: "content-workflow", workspaceId: scope.workspaceId, refId: typeof requestId === "string" ? requestId : null }, async () => {
      try {
        await requirePlan(scope.workspaceId);
      } catch (e) {
        if (e instanceof PlanRequiredError) return Response.json({ planRequired: true, title: e.message }, { status: 402 });
        throw e;
      }
      const { workflow, repeated } = await startWorkflow(scope, scope.userId, body);
      if (!repeated) kickRunner();
      return Response.json({ workflow, repeated }, { status: repeated ? 200 : 201 });
    }, workflowProblem);
  } catch (error) {
    return workflowProblem(error);
  }
}
