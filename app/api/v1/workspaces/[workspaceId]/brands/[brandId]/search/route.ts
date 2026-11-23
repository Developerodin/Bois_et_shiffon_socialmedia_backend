import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { taskViewer } from "@/server/tasks/access";
import { taskProblem } from "@/server/tasks/errors";
import { searchBrand } from "@/server/tasks/search";

/** Top-bar search: `?q=` (3–100 characters; shorter answers empty), up to 5 tasks, projects, posts, products and campaigns the caller can see. */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "brand.read");
    if (scope instanceof Response) return scope;
    const q = new URL(request.url).searchParams.get("q") ?? "";
    return Response.json(await searchBrand(scope, taskViewer(scope), q));
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}
