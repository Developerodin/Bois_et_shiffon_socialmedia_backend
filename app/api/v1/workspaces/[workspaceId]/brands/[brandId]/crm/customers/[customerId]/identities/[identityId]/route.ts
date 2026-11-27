import { removeIdentity } from "@/server/crm/customers";
import { crmRoute, json } from "@/server/crm/route";

type Params = { workspaceId: string; brandId: string; customerId: string; identityId: string };

export const DELETE = crmRoute<Params>(["crm.manage"], async (scope, p) => json({ customer: await removeIdentity(scope, p.customerId, p.identityId) }));
