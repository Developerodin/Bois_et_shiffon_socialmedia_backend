import { z } from "zod";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { invalidQuote, quoteProblem } from "@/server/quotes/quotes";
import { confirmDraftOrderWrite, confirmInvoice } from "@/server/quotes/shopify-draft-orders";
import { shopifyWriteProblem } from "@/server/shopify/writes";
import { QUOTE_LIMITS } from "@/shared";

type Params = BrandRouteParams & { quoteId: string };
const Email = z.object({ to: z.string().trim().max(QUOTE_LIMITS.email).optional(), subject: z.string().trim().min(1).max(QUOTE_LIMITS.subject).optional(), message: z.string().max(QUOTE_LIMITS.message).optional() });
const token = z.string().min(1).max(1000);
/** An invoice confirm carries the same email fields as its preview: they are rebuilt and must hash the same. */
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["create", "update"]), confirmToken: token }),
  z.object({ action: z.literal("invoice"), confirmToken: token, email: Email.default({}) }),
]);

/** Write what the person confirmed, at most once (crm.manage); 409 when the quote changed since the preview. */
export async function POST(request: Request, context: { params: Promise<Params> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "crm.manage");
    if (scope instanceof Response) return scope;
    const { quoteId } = await context.params;
    const body = Body.safeParse(await request.json().catch(() => null));
    if (!body.success) return invalidQuote(body.error.issues[0]?.message);
    const b = body.data;
    const quote = b.action === "invoice" ? await confirmInvoice(scope, quoteId, b.email, b.confirmToken) : await confirmDraftOrderWrite(scope, quoteId, b.action, b.confirmToken);
    return Response.json({ quote }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return shopifyWriteProblem(error) ?? quoteProblem(error);
  }
}
