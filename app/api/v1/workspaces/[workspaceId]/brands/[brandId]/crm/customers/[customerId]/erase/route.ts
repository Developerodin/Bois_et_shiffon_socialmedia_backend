import { eraseCustomer } from "@/server/crm/erase";
import { crmRoute } from "@/server/crm/route";

type Params = { workspaceId: string; brandId: string; customerId: string };

/** Erase one customer's data (GDPR Art. 17): crm.manage and a workspace owner or admin. 204. */
export const POST = crmRoute<Params>(["crm.manage"], async (scope, p) => {
  await eraseCustomer(scope, p.customerId);
  return new Response(null, { status: 204 });
});
