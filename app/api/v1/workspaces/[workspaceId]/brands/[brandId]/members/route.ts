import { z } from "zod";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { fromAccessError } from "@/server/api/http-error";
import { effectivePermissions } from "@/server/auth/permissions";
import { accountErrorResponse, invalid } from "@/server/api/workspace-route";
import { kickRunner } from "@/server/jobs/runner";
import { prisma } from "@/server/db/prisma";
import { personName } from "@/server/content/person-name";
import { addToProject, listProjectPeople } from "@/server/services/project-members";

type Ctx = { params: Promise<BrandRouteParams> };

/**
 * Who works on this project, plus the project roles to pick from. Emails, invitations, role permissions and who is
 * disabled are for people who manage the project; everyone else (a client reviewer too) gets names and role names.
 */
export async function GET(request: Request, context: Ctx) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "brand.read");
    if (scope instanceof Response) return scope;
    const [roles, people, perms] = await Promise.all([
      prisma.role.findMany({
        where: { workspaceId: scope.workspaceId, scope: "PROJECT" },
        orderBy: [{ isSystem: "desc" }, { createdAt: "asc" }],
        select: { id: true, name: true, description: true },
      }),
      listProjectPeople(scope.workspaceId, scope.brandId),
      effectivePermissions(scope.workspaceId, scope.userId, scope.brandId),
    ]);
    if (perms.has("project.members.manage")) return Response.json({ ...people, roles });
    return Response.json({
      viaWorkspace: people.viaWorkspace.map((m) => ({ userId: m.userId, name: personName(m, { reveal: false }), role: m.role })),
      people: people.people.map((g) => ({ id: g.id, userId: g.userId, name: personName(g, { reveal: false }), role: { id: g.role.id, name: g.role.name } })),
      invitations: [],
      roles,
    });
  } catch (error) {
    return accountErrorResponse(error) ?? fromAccessError(error);
  }
}

export async function POST(request: Request, context: Ctx) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "project.members.manage");
    if (scope instanceof Response) return scope;
    const body = z.object({ email: z.string().trim().email(), roleId: z.string().min(1) }).safeParse(await request.json().catch(() => null));
    if (!body.success) return invalid("A valid email and role are required");
    const result = await addToProject({ ...scope, actorUserId: scope.userId, ...body.data });
    if (result.invited) kickRunner(); // sends the invitation email
    return Response.json(result, { status: 201 });
  } catch (error) {
    return accountErrorResponse(error) ?? fromAccessError(error);
  }
}
