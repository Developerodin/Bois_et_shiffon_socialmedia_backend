import { createDeal, DealCreate, pipeline } from "@/server/crm/deals";
import { bodyOf, crmRoute, json } from "@/server/crm/route";

/** The pipeline board: every stage with its deals and per-currency totals (crm.manage). */
export const GET = crmRoute(["crm.manage"], async (scope) => json({ pipeline: await pipeline(scope) }));

export const POST = crmRoute(["crm.manage"], async (scope, _p, request) => {
  const body = await bodyOf(request, DealCreate);
  if (body instanceof Response) return body;
  return json({ deal: await createDeal(scope, body) }, 201);
});
