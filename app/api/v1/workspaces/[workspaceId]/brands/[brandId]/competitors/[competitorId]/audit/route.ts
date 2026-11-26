import { Prisma } from "@prisma/client";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { AgentStartError } from "@/server/agents/engine";
import { kickRunner } from "@/server/jobs/runner";
import { startCompetitorAudit } from "@/server/services/competitor-audits";

// Queued work runs after the response (kickRunner); give it room to finish.
export const maxDuration = 300;

/** Run a fresh audit of this competitor's website, paid with this workspace's credits. */
export async function POST(request: Request, context: { params: Promise<BrandRouteParams & { competitorId: string }> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "agents.run");
    if (scope instanceof Response) return scope;
    const { competitorId } = await context.params;
    const result = await startCompetitorAudit({ ...scope, competitorId });
    if (result.status === "insufficient-credits") {
      return Response.json(
        { type: "https://api.brandpilot/errors/insufficient-credits", title: "Not enough credits", status: 402, detail: `This audit needs ${result.needed} credits; you have ${result.balance}.`, insufficientCredits: true, balance: result.balance, needed: result.needed },
        { status: 402 },
      );
    }
    // Nothing was charged. The code lets the page tell this from other 409s and reload to show when to try again.
    if (result.status === "blocked") {
      return problemResponse({
        type: "https://api.brandpilot/errors/site-blocked",
        title: "Site blocks automated readers",
        status: 409,
        detail: "This site blocked automated readers on your last audit, so another would fail the same way. No credits were spent.",
        code: "audit.siteBlocked",
        until: result.until,
      });
    }
    if (result.status === "started") kickRunner();
    return Response.json(result, { status: result.status === "started" ? 202 : 200 });
  } catch (error) {
    // The charge was already refunded; say why it didn't start (daily limit, bad domain…).
    if (error instanceof AgentStartError) {
      return problemResponse({ type: "https://api.brandpilot/errors/agent-start", title: "Audit could not start", status: error.status, detail: error.message });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return problemResponse({ type: "https://api.brandpilot/errors/not-found", title: "Not found", status: 404 });
    }
    return fromAccessError(error);
  }
}
