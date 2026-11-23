import { fromAccessError } from "@/server/api/http-error";
import { AccessDeniedError } from "@/server/auth/errors";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { prisma } from "@/server/db/prisma";
import { brandOwners } from "@/server/services/publishing";
import { seesAllTasks } from "@/server/tasks/access";
import { taskOwnerRoleWhere } from "@/server/tasks/links";
import type { TaskPersonDto } from "@/shared";

/**
 * Who can take a task (tasks.read, staff only: a client reviewer gets 403, the list names the team): everyone who
 * reads the brand's tasks, client reviewers included and marked `client`, by name (never emails), sorted by name. The
 * server still checks each pick (checkTaskLinks): a client only fits a task they can see.
 * `roles`: with tasks.all, the project roles a task can be given to (taskOwnerRoleWhere), by name; else empty.
 */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.read");
    if (scope instanceof Response) return scope;
    if (scope.clientReviewer) throw new AccessDeniedError("Only the team can list who works on tasks");
    const [owners, roles] = await Promise.all([
      brandOwners(scope, { key: "tasks.read", includeClients: true }),
      seesAllTasks(scope) ? prisma.role.findMany({ where: taskOwnerRoleWhere(scope.workspaceId), select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }] }) : [],
    ]);
    const people: TaskPersonDto[] = owners
      .map((p) => ({ id: p.id, name: p.name, gone: false, client: !!p.client }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return Response.json({ people, roles });
  } catch (error) {
    return fromAccessError(error);
  }
}
