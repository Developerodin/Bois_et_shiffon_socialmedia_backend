import { z } from "zod";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { prisma } from "@/server/db/prisma";
import { kickIfDue } from "@/server/jobs/runner";
import { listCompetitors } from "@/server/services/competitor-audits";
import { domainOf } from "@/shared";

/** Competitors with the latest shared audit of each domain, plus this workspace's credits for someone who may run audits. */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "brand.read");
    if (scope instanceof Response) return scope;
    // The page polls this while audits start: where the API runs jobs, an Audit all job can end its runner's time
    // budget with the agent runs it queued still waiting, and this picks them up.
    await kickIfDue().catch(() => {});
    return Response.json(await listCompetitors(scope.workspaceId, scope.brandId, { withCredits: scope.perms.has("agents.run") }));
  } catch (error) {
    return fromAccessError(error);
  }
}

const Body = z.object({ name: z.string().trim().min(1).max(80), website: z.string().trim().min(3).max(300) });

/** Add a competitor by hand. */
export async function POST(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "agents.run");
    if (scope instanceof Response) return scope;
    const body = Body.safeParse(await request.json().catch(() => null));
    const domain = body.success ? domainOf(body.data.website) : null;
    if (!body.success || !domain) {
      return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid competitor", status: 422, detail: "Enter a name and a website like tikamoon.com." });
    }
    const row = await prisma.competitor.upsert({
      where: { brandId_domain: { brandId: scope.brandId, domain } },
      create: { workspaceId: scope.workspaceId, brandId: scope.brandId, name: body.data.name, domain, source: "manual" },
      update: { name: body.data.name },
    });
    return Response.json({ competitor: { id: row.id, name: row.name, domain: row.domain } }, { status: 201 });
  } catch (error) {
    return fromAccessError(error);
  }
}
