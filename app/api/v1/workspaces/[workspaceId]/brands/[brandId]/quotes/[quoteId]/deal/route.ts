import { QuoteDealInput, setQuoteDeal } from "@/server/crm/deals";
import { bodyOf, crmRoute, json } from "@/server/crm/route";
import { toQuoteDto } from "@/server/quotes/quotes";

type Params = { workspaceId: string; brandId: string; quoteId: string };

/** `{ dealId }` links the quote to a pipeline deal (null unlinks); an already-sent or accepted quote moves the deal forward. */
export const POST = crmRoute<Params>(["crm.manage"], async (scope, p, request) => {
  const body = await bodyOf(request, QuoteDealInput);
  if (body instanceof Response) return body;
  return json({ quote: toQuoteDto(await setQuoteDeal(scope, p.quoteId, body)) });
});
