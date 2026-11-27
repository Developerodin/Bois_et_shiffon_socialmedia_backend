import { eraseCompany } from "@/server/crm/erase";
import { crmRoute } from "@/server/crm/route";

type Params = { workspaceId: string; brandId: string; companyId: string };

/** Erase a company record (a sole trader's is personal data): crm.manage and a workspace owner or admin. 204. */
export const POST = crmRoute<Params>(["crm.manage"], async (scope, p) => {
  await eraseCompany(scope, p.companyId);
  return new Response(null, { status: 204 });
});
