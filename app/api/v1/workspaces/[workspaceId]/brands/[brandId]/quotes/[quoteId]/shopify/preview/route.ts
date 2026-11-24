import { z } from "zod";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { invalidQuote, quoteProblem } from "@/server/quotes/quotes";
import { previewDraftOrderWrite } from "@/server/quotes/shopify-draft-orders";
import { shopifyWriteProblem } from "@/server/shopify/writes";

type Params = BrandRouteParams & { quoteId: string };
const Body = z.object({ action: z.enum(["create", "update"]), again: z.boolean().optional() });

/** What will be written to Shopify (every line, price, discount and note) and the token to confirm it (crm.manage). */
export async function POST(request: Request, context: { params: Promise<Params> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "crm.manage");
    if (scope instanceof Response) return scope;
    const { quoteId } = await context.params;
    const body = Body.safeParse(await request.json().catch(() => null));
    if (!body.success) return invalidQuote(body.error.issues[0]?.message);
    return Response.json(await previewDraftOrderWrite(scope, quoteId, body.data.action, { again: body.data.again }), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return shopifyWriteProblem(error) ?? quoteProblem(error);
  }
}
