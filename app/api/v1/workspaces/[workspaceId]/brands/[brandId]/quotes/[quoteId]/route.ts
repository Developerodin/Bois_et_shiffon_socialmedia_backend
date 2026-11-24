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

/** Delete a draft never sent to Shopify; cancel any other (Shopify's draft order is left alone). */
export async function DELETE(request: Request, context: { params: Promise<Params> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "crm.manage");
    if (scope instanceof Response) return scope;
    const { quoteId } = await context.params;
    await deleteQuote(scope, quoteId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return quoteProblem(error);
  }
}
