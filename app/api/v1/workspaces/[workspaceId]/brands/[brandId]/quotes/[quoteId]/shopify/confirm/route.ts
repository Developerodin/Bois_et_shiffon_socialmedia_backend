import { z } from "zod";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { invalidQuote, quoteProblem } from "@/server/quotes/quotes";
import { confirmDraftOrderWrite } from "@/server/quotes/shopify-draft-orders";
import { shopifyWriteProblem } from "@/server/shopify/writes";

type Params = BrandRouteParams & { quoteId: string };
const Body = z.object({ action: z.enum(["create", "update"]), confirmToken: z.string().min(1).max(1000) });

/** Write what the person confirmed, at most once (crm.manage); 409 when the quote changed since the preview. */
export async function POST(request: Request, context: { params: Promise<Params> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "crm.manage");
    if (scope instanceof Response) return scope;
    const { quoteId } = await context.params;
    const body = Body.safeParse(await request.json().catch(() => null));
    if (!body.success) return invalidQuote(body.error.issues[0]?.message);
    return Response.json({ quote: await confirmDraftOrderWrite(scope, quoteId, body.data.action, body.data.confirmToken) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return shopifyWriteProblem(error) ?? quoteProblem(error);
  }
}
