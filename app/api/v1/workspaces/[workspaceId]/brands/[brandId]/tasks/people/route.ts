import { fromAccessError } from "@/server/api/http-error";
import { AccessDeniedError } from "@/server/auth/errors";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { brandOwners } from "@/server/services/publishing";
import type { TaskPersonDto } from "@/shared";

/**
 * Who can take a task (tasks.read, staff only: a client reviewer gets 403, the list names the team): everyone who
 * reads the brand's tasks, client reviewers included and marked `client`, by name (never emails), sorted by name. The
 * server still checks each pick (checkTaskLinks): a client only fits a task they can see.
 */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.read");
    if (scope instanceof Response) return scope;
    if (scope.clientReviewer) throw new AccessDeniedError("Only the team can list who works on tasks");
    const people: TaskPersonDto[] = (await brandOwners(scope, { key: "tasks.read", includeClients: true }))
      .map((p) => ({ id: p.id, name: p.name, gone: false, client: !!p.client }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return Response.json({ people });
  } catch (error) {
    return fromAccessError(error);
  }
}
