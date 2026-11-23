import type { PostInsightsDto } from "@/shared";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { postsWithMetrics, PostsRange } from "@/server/data/post-metrics-read";

/**
 * How each published Instagram, Facebook and Threads post did: `?from&to` (brand-local "YYYY-MM-DD", at most 90 days)
 * by publish date, each post's latest read, most reach first. Needs analytics.read.
 */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "analytics.read");
    if (scope instanceof Response) return scope;
    const params = new URL(request.url).searchParams;
    const range = PostsRange.safeParse({ from: params.get("from"), to: params.get("to") });
    if (!range.success) {
      return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid request", status: 400, detail: "from and to must be days, from first, at most 90 days apart" });
    }
    const body: PostInsightsDto = { posts: await postsWithMetrics(scope, range.data) };
    return Response.json(body);
  } catch (error) {
    return fromAccessError(error);
  }
}
