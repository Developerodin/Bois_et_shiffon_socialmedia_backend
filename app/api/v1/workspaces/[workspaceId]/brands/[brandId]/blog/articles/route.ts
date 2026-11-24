import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { ArticleCreate, blogProblem, createArticle, invalidBody, listArticles } from "@/server/blog/articles";

/** The brand's blog articles, latest changed first (archived left out). */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "brand.read");
    if (scope instanceof Response) return scope;
    return Response.json({ articles: await listArticles(scope) });
  } catch (error) {
    return blogProblem(error);
  }
}

/** A new empty draft from a task (`taskId`, one the person can see) or a `topic` (content.create). */
export async function POST(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "content.create");
    if (scope instanceof Response) return scope;
    const body = ArticleCreate.safeParse(await request.json().catch(() => null));
    if (!body.success) return invalidBody(body.error.issues[0]?.message);
    return Response.json({ article: await createArticle(scope, body.data) }, { status: 201 });
  } catch (error) {
    return blogProblem(error);
  }
}
