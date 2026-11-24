import { z } from "zod";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { invalidQuote, quoteProblem } from "@/server/quotes/quotes";
import { previewDraftOrderWrite, previewInvoice } from "@/server/quotes/shopify-draft-orders";
import { shopifyWriteProblem } from "@/server/shopify/writes";
import { QUOTE_LIMITS } from "@/shared";

type Params = BrandRouteParams & { quoteId: string };
const Email = z.object({ to: z.string().trim().max(QUOTE_LIMITS.email).optional(), subject: z.string().trim().min(1).max(QUOTE_LIMITS.subject).optional(), message: z.string().max(QUOTE_LIMITS.message).optional() });
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["create", "update"]), again: z.boolean().optional() }),
  /** `again`: send an invoice that was sent before once more */
  z.object({ action: z.literal("invoice"), again: z.boolean().optional(), email: Email.default({}) }),
]);

/**
 * What will be written to Shopify (every line, price, discount and note; for an invoice its to, subject and message) and
 * the token to confirm it (crm.manage).
 */
export async function POST(request: Request, context: { params: Promise<Params> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "crm.manage");
    if (scope instanceof Response) return scope;
    const { quoteId } = await context.params;
    const body = Body.safeParse(await request.json().catch(() => null));
    if (!body.success) return invalidQuote(body.error.issues[0]?.message);
    const b = body.data;
    const preview = b.action === "invoice" ? await previewInvoice(scope, quoteId, b.email, { again: b.again }) : await previewDraftOrderWrite(scope, quoteId, b.action, { again: b.again });
    return Response.json(preview, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return shopifyWriteProblem(error) ?? quoteProblem(error);
  }
}
