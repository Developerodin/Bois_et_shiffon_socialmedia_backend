import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { invalidQuote, quoteProblem, quoteVersions } from "@/server/quotes/quotes";

type Params = BrandRouteParams & { quoteId: string };
const NO_STORE = { "Cache-Control": "private, no-store" };

/** The quote's earlier versions, newest first; `?version=N` returns that one with its lines and totals (crm.manage). */
export async function GET(request: Request, context: { params: Promise<Params> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "crm.manage");
    if (scope instanceof Response) return scope;
    const { quoteId } = await context.params;
    const v = new URL(request.url).searchParams.get("version");
    if (v !== null && !/^[1-9]\d{0,8}$/.test(v)) return invalidQuote("version must be a positive whole number");
    return Response.json({ versions: await quoteVersions(scope, quoteId, v ? Number(v) : undefined) }, { headers: NO_STORE });
  } catch (error) {
    return quoteProblem(error);
  }
}
