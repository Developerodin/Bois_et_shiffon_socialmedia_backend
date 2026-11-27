import { QuoteCustomerInput, setQuoteCustomer } from "@/server/crm/customers";
import { bodyOf, crmRoute, json } from "@/server/crm/route";
import { toQuoteDto } from "@/server/quotes/quotes";

type Params = { workspaceId: string; brandId: string; quoteId: string };

/** `{ customerId }` links (null unlinks); `{ create: true }` saves the quote's contact as a customer (409 when its email is a customer's). */
export const POST = crmRoute<Params>(["crm.manage"], async (scope, p, request) => {
  const body = await bodyOf(request, QuoteCustomerInput);
  if (body instanceof Response) return body;
  return json({ quote: toQuoteDto(await setQuoteCustomer(scope, p.quoteId, body)) });
});
