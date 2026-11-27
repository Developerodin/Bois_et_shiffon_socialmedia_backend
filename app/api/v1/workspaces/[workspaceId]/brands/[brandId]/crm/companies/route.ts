import { CompanyCreate, createCompany, listCompanies } from "@/server/crm/companies";
import { bodyOf, crmRoute, json } from "@/server/crm/route";

export const GET = crmRoute(["crm.manage"], async (scope) => json({ companies: await listCompanies(scope) }));

export const POST = crmRoute(["crm.manage"], async (scope, _p, request) => {
  const body = await bodyOf(request, CompanyCreate);
  if (body instanceof Response) return body;
  return json({ company: await createCompany(scope, body) }, 201);
});
