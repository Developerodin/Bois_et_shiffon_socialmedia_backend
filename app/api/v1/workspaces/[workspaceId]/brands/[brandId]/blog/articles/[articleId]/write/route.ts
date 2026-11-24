import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { blogProblem } from "@/server/blog/articles";
import { writeArticle } from "@/server/blog/writer";

// The AI call (or a Shopify send) runs in the request: give it time, so a host timeout never cuts off the refund or the settle.
export const maxDuration = 300;

type Params = BrandRouteParams & { articleId: string };

/** Have the article writer (re)write the article (content.create; costs credits, given back on failure). */
export async function POST(request: Request, context: { params: Promise<Params> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "content.create");
    if (scope instanceof Response) return scope;
    const { articleId } = await context.params;
    return Response.json({ article: await writeArticle(scope, articleId) });
  } catch (error) {
    return blogProblem(error);
  }
}
