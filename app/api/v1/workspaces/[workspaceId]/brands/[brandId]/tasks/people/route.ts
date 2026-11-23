import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { brandOwners } from "@/server/services/publishing";
import type { TaskPersonDto } from "@/shared";

/**
 * Who can take a task (tasks.read): everyone who reads the brand's tasks, client reviewers included, by name (never
 * emails), sorted by name. The server still checks each pick (checkTaskLinks): a client only fits a task they can see.
 */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.read");
    if (scope instanceof Response) return scope;
    const people: TaskPersonDto[] = (await brandOwners(scope, { key: "tasks.read", includeClients: true }))
      .map((p) => ({ id: p.id, name: p.name, gone: false }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return Response.json({ people });
  } catch (error) {
    return fromAccessError(error);
  }
}
