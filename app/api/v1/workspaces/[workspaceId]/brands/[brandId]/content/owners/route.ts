import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { brandOwners } from "@/server/services/publishing";

/** Who a post can be given to: names of the people on this brand (never emails). For anyone who can create posts. */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "content.create");
    if (scope instanceof Response) return scope;
    return Response.json({ owners: await brandOwners(scope) });
  } catch (error) {
    return fromAccessError(error);
  }
}
