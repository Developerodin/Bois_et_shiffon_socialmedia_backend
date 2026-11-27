import { z } from "zod";
import { invalidBody } from "@/server/crm/common";
import { listCustomers } from "@/server/crm/customers";
import { bodyOf, crmRoute, json } from "@/server/crm/route";
import { CRM_LIMITS } from "@/shared";

/**
 * Customer search with the term in the body, not the URL: a search is often an email or a phone number, and a proxy's
 * access log keeps query strings. At least 2 characters, 20 results, 60 a minute per person. crm.manage.
 */
const SearchBody = z.object({ q: z.string().max(100) });
export const POST = crmRoute(["crm.manage"], async (scope, _p, request) => {
  const body = await bodyOf(request, SearchBody);
  if (body instanceof Response) return body;
  if (body.q.trim().length < CRM_LIMITS.searchMin) return invalidBody(`Type at least ${CRM_LIMITS.searchMin} characters to search`);
  return json(await listCustomers(scope, { q: body.q }));
});
