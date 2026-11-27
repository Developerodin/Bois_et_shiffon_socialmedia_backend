import { CustomerPatch, getCustomer, updateCustomer } from "@/server/crm/customers";
import { bodyOf, crmRoute, json } from "@/server/crm/route";

type Params = { workspaceId: string; brandId: string; customerId: string };

/** One customer's page (its conversations only with inbox.read). The view is audited once per hour. */
export const GET = crmRoute<Params>(["crm.manage"], async (scope, p) => json({ customer: await getCustomer(scope, p.customerId) }));

/** Field edits on the `updatedAt` read: 409 when someone saved in between. */
export const PATCH = crmRoute<Params>(["crm.manage"], async (scope, p, request) => {
  const body = await bodyOf(request, CustomerPatch);
  if (body instanceof Response) return body;
  return json({ customer: await updateCustomer(scope, p.customerId, body) });
});
