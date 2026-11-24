import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { ArticleEdit, blogProblem, deleteArticle, editArticle, invalidBody, loadArticle, toArticleDto } from "@/server/blog/articles";

type Params = BrandRouteParams & { articleId: string };

export async function GET(request: Request, context: { params: Promise<Params> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "brand.read");
    if (scope instanceof Response) return scope;
    const { articleId } = await context.params;
    return Response.json({ article: toArticleDto(await loadArticle(scope, articleId)) });
  } catch (error) {
    return blogProblem(error);
  }
}

/** Edit (content.create) on the `version` read: bumps it, and sends an approved article back to review. */
export async function PATCH(request: Request, context: { params: Promise<Params> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "content.create");
    if (scope instanceof Response) return scope;
    const { articleId } = await context.params;
    const body = ArticleEdit.safeParse(await request.json().catch(() => null));
    if (!body.success) return invalidBody(body.error.issues[0]?.message);
    return Response.json({ article: await editArticle(scope, articleId, body.data) });
  } catch (error) {
    return blogProblem(error);
  }
}

/** Delete a draft never sent to Shopify; archive one that was (Shopify's copy is left alone). */
export async function DELETE(request: Request, context: { params: Promise<Params> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "content.create");
    if (scope instanceof Response) return scope;
    const { articleId } = await context.params;
    await deleteArticle(scope, articleId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return blogProblem(error);
  }
}
