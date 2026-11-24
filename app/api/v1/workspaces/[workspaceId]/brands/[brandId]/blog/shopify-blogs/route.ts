import { z } from "zod";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { blogProblem, invalidBody } from "@/server/blog/articles";
import { pickShopifyBlog, shopifyBlogs } from "@/server/blog/shopify-articles";

/** The store's blogs, the brand's pick and the default (the first). */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "brand.read");
    if (scope instanceof Response) return scope;
    return Response.json(await shopifyBlogs(scope));
  } catch (error) {
    return blogProblem(error);
  }
}

const Pick = z.object({ blogId: z.string().min(1).max(200).nullable() });

/** Pick the blog articles go to (integrations.manage); null = the store's first. */
export async function PUT(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "integrations.manage");
    if (scope instanceof Response) return scope;
    const body = Pick.safeParse(await request.json().catch(() => null));
    if (!body.success) return invalidBody(body.error.issues[0]?.message);
    await pickShopifyBlog(scope, body.data.blogId);
    return Response.json(await shopifyBlogs(scope));
  } catch (error) {
    return blogProblem(error);
  }
}
