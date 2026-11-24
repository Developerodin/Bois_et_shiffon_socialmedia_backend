import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { createQuote, invalidQuote, listQuotes, QuoteCreate, quoteProblem } from "@/server/quotes/quotes";

const NO_STORE = { "Cache-Control": "private, no-store" };

/** The brand's quotes, latest changed first (crm.manage: they carry customer contact details). */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "crm.manage");
    if (scope instanceof Response) return scope;
    return Response.json({ quotes: await listQuotes(scope) }, { headers: NO_STORE });
  } catch (error) {
    return quoteProblem(error);
  }
}

/** A new DRAFT quote; totals are worked out here, whatever the client sent. */
export async function POST(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "crm.manage");
    if (scope instanceof Response) return scope;
    const body = QuoteCreate.safeParse(await request.json().catch(() => null));
    if (!body.success) return invalidQuote(body.error.issues[0]?.message);
    return Response.json({ quote: await createQuote(scope, body.data) }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return quoteProblem(error);
  }
}
