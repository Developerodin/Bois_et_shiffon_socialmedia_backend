import { CompanyPatch, getCompany, updateCompany } from "@/server/crm/companies";
import { bodyOf, crmRoute, json } from "@/server/crm/route";

type Params = { workspaceId: string; brandId: string; companyId: string };

export const GET = crmRoute<Params>(["crm.manage"], async (scope, p) => json({ company: await getCompany(scope, p.companyId) }));

export const PATCH = crmRoute<Params>(["crm.manage"], async (scope, p, request) => {
  const body = await bodyOf(request, CompanyPatch);
  if (body instanceof Response) return body;
  return json({ company: await updateCompany(scope, p.companyId, body) });
});
