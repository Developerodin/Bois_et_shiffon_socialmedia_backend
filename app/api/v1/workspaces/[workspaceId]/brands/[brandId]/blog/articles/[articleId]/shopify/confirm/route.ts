import { z } from "zod";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { blogProblem, invalidBody } from "@/server/blog/articles";
import { confirmArticleWrite } from "@/server/blog/shopify-articles";
import { shopifyWriteProblem } from "@/server/shopify/writes";

// The AI call (or a Shopify send) runs in the request: give it time, so a host timeout never cuts off the refund or the settle.
export const maxDuration = 300;

type Params = BrandRouteParams & { articleId: string };
const Body = z.object({ action: z.enum(["create", "update", "publish"]), confirmToken: z.string().min(1).max(1000) });

/** Write what the person confirmed, at most once (publish.execute); 409 when it changed since the preview. */
export async function POST(request: Request, context: { params: Promise<Params> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "publish.execute");
    if (scope instanceof Response) return scope;
    const { articleId } = await context.params;
    const body = Body.safeParse(await request.json().catch(() => null));
    if (!body.success) return invalidBody(body.error.issues[0]?.message);
    return Response.json({ article: await confirmArticleWrite(scope, articleId, body.data.action, body.data.confirmToken) });
  } catch (error) {
    return shopifyWriteProblem(error) ?? blogProblem(error);
  }
}
