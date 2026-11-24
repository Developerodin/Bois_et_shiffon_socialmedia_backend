import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { ArticleDecision, blogProblem, decideArticle, invalidBody } from "@/server/blog/articles";

type Params = BrandRouteParams & { articleId: string };

/** Approve or ask for changes (content.approve; your own text only when nobody else can approve). */
export async function POST(request: Request, context: { params: Promise<Params> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "content.approve");
    if (scope instanceof Response) return scope;
    const { articleId } = await context.params;
    const body = ArticleDecision.safeParse(await request.json().catch(() => null));
    if (!body.success) return invalidBody(body.error.issues[0]?.message);
    return Response.json({ article: await decideArticle(scope, articleId, body.data) });
  } catch (error) {
    return blogProblem(error);
  }
}
