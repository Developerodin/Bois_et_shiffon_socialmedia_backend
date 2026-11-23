import "server-only";
import type { Prisma } from "@prisma/client";
import { CLIENT_GRANT_WHERE, type Db } from "@/server/auth/permissions";
import type { PermissionKey } from "@/server/auth/permissions.catalog";
import { canBeAssigned, seesAllTasks } from "@/server/tasks/access";
import { TaskError } from "@/server/tasks/errors";

type Id = string | null | undefined;
/** The ids a write sets; undefined = not changed, null = cleared (neither is checked). */
export type TaskLinks = { workProjectId?: Id; contentItemId?: Id; auditReportId?: Id; ownerId?: Id; ownerRoleId?: Id; reviewerId?: Id; blockedOnId?: Id };

/**
 * The roles a task can be given to: a project role of this workspace that reads tasks, never the client one
 * (CLIENT_GRANT_WHERE). checkTaskLinks and the people list (GET tasks/people) both read it.
 */
export const taskOwnerRoleWhere = (workspaceId: string): Prisma.RoleWhereInput => ({
  workspaceId,
  scope: "PROJECT",
  permissions: { has: "tasks.read" },
  NOT: CLIENT_GRANT_WHERE,
});

/**
 * THE check for every id a task write sets (create, patch, batch, assign, actions, make-task): each linked row is
 * re-read with `{ id, workspaceId, brandId }`, so a project, post or report of another brand is refused like a missing
 * one (the client visibility clause relies on the project being on the task's brand). Owner, reviewer and blocked-on
 * must see the task as it will be after the write (`current` = the stored task, for a patch); an owning role must be
 * one of taskOwnerRoleWhere. Throws TaskError("Invalid <field>", 400).
 * The assign rule: without tasks.all, a new or changed owner can only be the caller or nobody, and no role (403).
 */
export async function checkTaskLinks(
  tx: Db,
  scope: { workspaceId: string; brandId: string; userId: string; perms: Set<PermissionKey>; clientReviewer?: boolean },
  input: TaskLinks,
  current?: { reviewerId: string | null; workProjectId: string | null; ownerId?: string | null },
): Promise<void> {
  if (!seesAllTasks(scope)) {
    const ownerChanged = input.ownerId !== undefined && input.ownerId !== (current?.ownerId ?? null);
    if ((ownerChanged && input.ownerId && input.ownerId !== scope.userId) || input.ownerRoleId) {
      throw new TaskError("Only an admin can give a task to someone else.", 403, "task.assignNotAllowed");
    }
  }
  const where = (id: string) => ({ id, workspaceId: scope.workspaceId, brandId: scope.brandId });
  const select = { id: true } as const;
  const refuse = (field: string) => new TaskError(`Invalid ${field}`, 400);
  if (input.workProjectId && !(await tx.workProject.findFirst({ where: where(input.workProjectId), select }))) throw refuse("workProjectId");
  if (input.contentItemId && !(await tx.contentItem.findFirst({ where: where(input.contentItemId), select }))) throw refuse("contentItemId");
  if (input.auditReportId && !(await tx.auditReport.findFirst({ where: where(input.auditReportId), select }))) throw refuse("auditReportId");
  if (input.ownerRoleId && !(await tx.role.findFirst({ where: { id: input.ownerRoleId, ...taskOwnerRoleWhere(scope.workspaceId) }, select }))) throw refuse("ownerRoleId");
  const after = {
    reviewerId: input.reviewerId !== undefined ? input.reviewerId : (current?.reviewerId ?? null),
    workProjectId: input.workProjectId !== undefined ? input.workProjectId : (current?.workProjectId ?? null),
  };
  for (const field of ["ownerId", "reviewerId", "blockedOnId"] as const) {
    const userId = input[field];
    if (userId && !(await canBeAssigned(tx, scope, userId, after))) throw refuse(field);
  }
}
