import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { deleteQuote, editQuote, invalidQuote, loadQuote, QuoteAction, quoteAction, QuoteEdit, quoteProblem, toQuoteDto } from "@/server/quotes/quotes";

type Params = BrandRouteParams & { quoteId: string };
const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(request: Request, context: { params: Promise<Params> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "crm.manage");
    if (scope instanceof Response) return scope;
    const { quoteId } = await context.params;
    return Response.json({ quote: toQuoteDto(await loadQuote(scope, quoteId)) }, { headers: NO_STORE });
  } catch (error) {
    return quoteProblem(error);
  }
}

/** Edit on the `version` read (DRAFT or CREATED): bumps it. */
export async function PATCH(request: Request, context: { params: Promise<Params> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "crm.manage");
    if (scope instanceof Response) return scope;
    const { quoteId } = await context.params;
    const body = QuoteEdit.safeParse(await request.json().catch(() => null));
    if (!body.success) return invalidQuote(body.error.issues[0]?.message);
    return Response.json({ quote: await editQuote(scope, quoteId, body.data) }, { headers: NO_STORE });
  } catch (error) {
    return quoteProblem(error);
  }
}

/** `{ action: "revise" | "acceptSubtotal", version }`. */
export async function POST(request: Request, context: { params: Promise<Params> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "crm.manage");
    if (scope instanceof Response) return scope;
    const { quoteId } = await context.params;
    const body = QuoteAction.safeParse(await request.json().catch(() => null));
    if (!body.success) return invalidQuote(body.error.issues[0]?.message);
    return Response.json({ quote: await quoteAction(scope, quoteId, body.data) }, { headers: NO_STORE });
  } catch (error) {
    return quoteProblem(error);
  }
}

/** Delete a draft never sent to Shopify (204); cancel any other open one (200 with the quote, and a notice when its invoice stays payable in Shopify). */
export async function DELETE(request: Request, context: { params: Promise<Params> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "crm.manage");
    if (scope instanceof Response) return scope;
    const { quoteId } = await context.params;
    const cancelled = await deleteQuote(scope, quoteId);
    return cancelled ? Response.json(cancelled, { headers: NO_STORE }) : new Response(null, { status: 204 });
  } catch (error) {
    return quoteProblem(error);
  }
}
