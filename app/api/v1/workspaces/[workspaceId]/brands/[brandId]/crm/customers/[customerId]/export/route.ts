import { exportCustomer } from "@/server/crm/export";
import { crmRoute, NO_STORE } from "@/server/crm/route";

type Params = { workspaceId: string; brandId: string; customerId: string };

/** Everything held about one customer as a JSON download (GDPR Art. 15): crm.manage and a workspace owner or admin. */
export const GET = crmRoute<Params>(["crm.manage"], async (scope, p) => {
  const data = await exportCustomer(scope, p.customerId);
  return new Response(JSON.stringify(data, null, 2), {
    headers: { ...NO_STORE, "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="customer-${p.customerId.replace(/[^\w-]/g, "")}.json"` },
  });
});
