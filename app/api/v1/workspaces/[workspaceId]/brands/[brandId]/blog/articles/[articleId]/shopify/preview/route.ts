import { z } from "zod";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { blogProblem, invalidBody } from "@/server/blog/articles";
import { previewArticleWrite } from "@/server/blog/shopify-articles";
import { shopifyWriteProblem } from "@/server/shopify/writes";

type Params = BrandRouteParams & { articleId: string };
const Body = z.object({ action: z.enum(["create", "update", "publish"]), again: z.boolean().optional() });

/** What will be written to Shopify (every field and link target) and the token to confirm it (publish.execute). */
export async function POST(request: Request, context: { params: Promise<Params> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "publish.execute");
    if (scope instanceof Response) return scope;
    const { articleId } = await context.params;
    const body = Body.safeParse(await request.json().catch(() => null));
    if (!body.success) return invalidBody(body.error.issues[0]?.message);
    return Response.json(await previewArticleWrite(scope, articleId, body.data.action, { again: body.data.again }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return shopifyWriteProblem(error) ?? blogProblem(error);
  }
}
