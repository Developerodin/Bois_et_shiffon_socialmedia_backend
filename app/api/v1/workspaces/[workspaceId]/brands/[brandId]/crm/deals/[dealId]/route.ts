import { DealPatch, getDeal, updateDeal } from "@/server/crm/deals";
import { bodyOf, crmRoute, json } from "@/server/crm/route";

type Params = { workspaceId: string; brandId: string; dealId: string };

export const GET = crmRoute<Params>(["crm.manage"], async (scope, p) => json({ deal: await getDeal(scope, p.dealId) }));

/** Edits and stage moves on the `updatedAt` read; Won and Lost need `closedReason`. */
export const PATCH = crmRoute<Params>(["crm.manage"], async (scope, p, request) => {
  const body = await bodyOf(request, DealPatch);
  if (body instanceof Response) return body;
  return json({ deal: await updateDeal(scope, p.dealId, body) });
});
