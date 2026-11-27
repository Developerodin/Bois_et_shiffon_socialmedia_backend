import { mergeCustomers, MergeInput, mergeSuggestions } from "@/server/crm/merge";
import { bodyOf, crmRoute, json } from "@/server/crm/route";

type Params = { workspaceId: string; brandId: string; customerId: string };

/** Customers that look like duplicates of this one (same name). crm.manage. */
export const GET = crmRoute<Params>(["crm.manage"], async (scope, p) => json({ suggestions: await mergeSuggestions(scope, p.customerId) }));

/** Merge `otherId` into this customer, both as last read (`updatedAt`s); no un-merge. crm.manage. */
export const POST = crmRoute<Params>(["crm.manage"], async (scope, p, request) => {
  const body = await bodyOf(request, MergeInput);
  if (body instanceof Response) return body;
  return json({ customer: await mergeCustomers(scope, p.customerId, body) });
});
