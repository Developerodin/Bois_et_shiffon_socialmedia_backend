import type { PostInsightsDto } from "@/shared";
import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { POSTS_MAX_DAYS, postsWithMetrics } from "@/server/data/post-metrics-read";
import { badRange, parseDayRange } from "@/server/data/sources";

/**
 * How each published Instagram, Facebook and Threads post did: `?from&to` (brand-local "YYYY-MM-DD", at most 90 days)
 * by publish date, each post's latest read, most reach first. Needs analytics.read.
 */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "analytics.read");
    if (scope instanceof Response) return scope;
    const params = new URL(request.url).searchParams;
    const range = parseDayRange(params, POSTS_MAX_DAYS);
    if (!range) return badRange(POSTS_MAX_DAYS);
    const body: PostInsightsDto = { posts: await postsWithMetrics(scope, range) };
    return Response.json(body);
  } catch (error) {
    return fromAccessError(error);
  }
}
