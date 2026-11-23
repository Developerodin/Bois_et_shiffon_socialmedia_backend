import "server-only";
import type { Db } from "@/server/auth/permissions";
import { canBeAssigned } from "@/server/tasks/access";
import { TaskError } from "@/server/tasks/errors";

type Id = string | null | undefined;
/** The ids a write sets; undefined = not changed, null = cleared (neither is checked). */
export type TaskLinks = { workProjectId?: Id; contentItemId?: Id; auditReportId?: Id; ownerId?: Id; reviewerId?: Id; blockedOnId?: Id };

/**
 * THE check for every id a task write sets (create, patch, batch, actions, make-task): each linked row is re-read with
 * `{ id, workspaceId, brandId }`, so a project, post or report of another brand is refused like a missing one (the
 * client visibility clause relies on the project being on the task's brand). Owner, reviewer and blocked-on must see the
 * task as it will be after the write (`current` = the stored task, for a patch). Throws TaskError("Invalid <field>", 400).
 */
export async function checkTaskLinks(
  tx: Db,
  scope: { workspaceId: string; brandId: string },
  input: TaskLinks,
  current?: { reviewerId: string | null; workProjectId: string | null },
): Promise<void> {
  const where = (id: string) => ({ id, workspaceId: scope.workspaceId, brandId: scope.brandId });
  const select = { id: true } as const;
  const refuse = (field: string) => new TaskError(`Invalid ${field}`, 400);
  if (input.workProjectId && !(await tx.workProject.findFirst({ where: where(input.workProjectId), select }))) throw refuse("workProjectId");
  if (input.contentItemId && !(await tx.contentItem.findFirst({ where: where(input.contentItemId), select }))) throw refuse("contentItemId");
  if (input.auditReportId && !(await tx.auditReport.findFirst({ where: where(input.auditReportId), select }))) throw refuse("auditReportId");
  const after = {
    reviewerId: input.reviewerId !== undefined ? input.reviewerId : (current?.reviewerId ?? null),
    workProjectId: input.workProjectId !== undefined ? input.workProjectId : (current?.workProjectId ?? null),
  };
  for (const field of ["ownerId", "reviewerId", "blockedOnId"] as const) {
    const userId = input[field];
    if (userId && !(await canBeAssigned(tx, scope, userId, after))) throw refuse(field);
  }
}
