import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/prisma";
import { assigneesOf, notifyManyTx } from "@/server/notifications/tasks";
import { lockRows, TX } from "@/server/services/publishing";
import { isSoleStaff, visibleTaskSql, type TaskViewer } from "@/server/tasks/access";
import { TaskError } from "@/server/tasks/errors";
import { checkTaskLinks } from "@/server/tasks/links";
import { TASK_DTO_INCLUDE, toTaskDtos, type TaskScope } from "@/server/tasks/service";
import { OPEN_TASK_STATUSES, type TaskDto } from "@/shared";

const id = z.string().min(1).max(100);

/**
 * POST tasks/assign: up to 100 tasks to one person (`ownerId`), one role (`ownerRoleId`) or nobody (`ownerId: null`).
 * Exactly one of the two keys.
 */
export const AssignInput = z
  .object({
    ids: z.array(id).min(1).max(100).refine((ids) => new Set(ids).size === ids.length, "Each task once"),
    ownerId: id.nullable().optional(),
    ownerRoleId: id.nullable().optional(),
  })
  .refine((b) => (b.ownerId === undefined) !== (b.ownerRoleId === undefined), "Give either ownerId or ownerRoleId");
export type AssignInput = z.infer<typeof AssignInput>;

const OPEN: readonly string[] = OPEN_TASK_STATUSES;

/**
 * Give several tasks to one owner at once (tasks.manage + tasks.all), all or nothing, in one transaction: each task
 * locked in id order (as clearFindings), every id must be a task the caller sees on this brand (else 404), the owner is
 * checked once (checkTaskLinks, against no project: a client can't be given tasks in bulk), and a task in review can't
 * get its reviewer as owner (409 naming it, unless sole staff). Finished and cancelled tasks, and those that already
 * have this owner, are left alone. One update, one audit event per changed task, one TASK_ASSIGNED notice each.
 * Returns the changed tasks and `skipped`, the count of finished or cancelled ones left alone.
 */
export async function assignTasks(scope: TaskScope, v: TaskViewer, input: AssignInput): Promise<{ tasks: TaskDto[]; skipped: number }> {
  if (!v.all) throw new TaskError("Only an admin can assign tasks in bulk.", 403);
  const ownerRoleId = input.ownerRoleId ?? null;
  const ownerId = ownerRoleId ? null : (input.ownerId ?? null);
  const ids = [...input.ids].sort();
  const { changed, skipped } = await prisma.$transaction(async (tx) => {
    await lockRows(tx, "task", ids);
    const seen = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT t.id FROM "Task" t WHERE t.id IN (${Prisma.join(ids)}) AND ${visibleTaskSql(v)}`);
    if (seen.length !== ids.length) throw new TaskError("Task not found", 404);
    await checkTaskLinks(tx, scope, { ownerId, ownerRoleId });
    const rows = await tx.task.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, status: true, reviewerId: true, ownerId: true, ownerRoleId: true } });
    const open = rows.filter((t) => OPEN.includes(t.status));
    const skipped = rows.length - open.length;
    // The submitForReview rule, kept while in review (as patchTask): the owner doesn't review their own task.
    const clash = ownerId ? open.find((t) => t.status === "IN_REVIEW" && t.reviewerId === ownerId) : undefined;
    if (clash && !(await isSoleStaff(scope.workspaceId, scope.brandId, ownerId!))) {
      throw new TaskError(`The reviewer can't be the owner: "${clash.title}" is in review with them.`, 409, "task.reviewerIsOwner");
    }
    const toChange = open.filter((t) => t.ownerId !== ownerId || t.ownerRoleId !== ownerRoleId);
    if (!toChange.length) return { changed: [], skipped };
    const changeIds = toChange.map((t) => t.id);
    await tx.task.updateMany({ where: { id: { in: changeIds } }, data: { ownerId, ownerRoleId } });
    const events = await tx.auditEvent.createManyAndReturn({
      data: toChange.map((t) => ({
        workspaceId: scope.workspaceId,
        brandId: scope.brandId,
        actorUserId: scope.userId,
        action: "task.update",
        entityType: "Task",
        entityId: t.id,
        metadata: { title: t.title, fields: ["ownerId", "ownerRoleId"], bulk: true },
      })),
      select: { id: true, entityId: true },
    });
    const to = await assigneesOf(tx, { workspaceId: scope.workspaceId, brandId: scope.brandId, ownerId, ownerRoleId });
    await notifyManyTx(tx, to, events.map((e) => ({ workspaceId: scope.workspaceId, brandId: scope.brandId, kind: "TASK_ASSIGNED" as const, taskId: e.entityId, actorId: scope.userId, auditEventId: e.id })));
    return { changed: changeIds, skipped };
  }, TX);
  if (!changed.length) return { tasks: [], skipped };
  const found = await prisma.task.findMany({ where: { id: { in: changed } }, include: TASK_DTO_INCLUDE });
  const byId = new Map(found.map((t) => [t.id, t]));
  return { tasks: await toTaskDtos(scope, changed.flatMap((taskId) => byId.get(taskId) ?? [])), skipped };
}
