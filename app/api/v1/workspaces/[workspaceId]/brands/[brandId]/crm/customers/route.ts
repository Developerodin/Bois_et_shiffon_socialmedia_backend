import { createCustomer, CustomerCreate, getCustomer, listCustomers, ListQuery } from "@/server/crm/customers";
import { bodyOf, crmRoute, json } from "@/server/crm/route";
import { invalidBody } from "@/server/crm/common";

/** A page of customers (cursor). Search is POST …/customers/search (the term stays out of URLs and access logs). crm.manage. */
export const GET = crmRoute(["crm.manage"], async (scope, _p, request) => {
  const query = ListQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return invalidBody(query.error.issues[0]?.message);
  return json(await listCustomers(scope, { ...query.data, q: undefined }));
});

/** A new customer with its contact details; one already on another customer is 409 naming them. */
export const POST = crmRoute(["crm.manage"], async (scope, _p, request) => {
  const body = await bodyOf(request, CustomerCreate);
  if (body instanceof Response) return body;
  const c = await createCustomer(scope, body);
  return json({ customer: await getCustomer(scope, c.id) }, 201);
});
