import { addIdentity, IdentityInput } from "@/server/crm/customers";
import { bodyOf, crmRoute, json } from "@/server/crm/route";

type Params = { workspaceId: string; brandId: string; customerId: string };

/** Add an email or phone; one already on another customer is 409 naming them. */
export const POST = crmRoute<Params>(["crm.manage"], async (scope, p, request) => {
  const body = await bodyOf(request, IdentityInput);
  if (body instanceof Response) return body;
  return json({ customer: await addIdentity(scope, p.customerId, body) }, 201);
});
