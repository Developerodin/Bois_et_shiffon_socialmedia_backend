import type { Prisma, TaskArea } from "@prisma/client";
import { assigneesOf } from "@/server/notifications/tasks";
import { taskAudit } from "@/server/tasks/audit";
import { OPEN_TASK_STATUSES } from "@/shared";

/**
 * Tasks the system makes and closes by itself, keyed by `Task.requestId` (unique per brand), so a retried job or a
 * second caller never makes a second one. Used by the CRM follow-ups (server/crm/follow-up-tasks.ts).
 * ponytail: the quote payment reminders (server/quotes/status-sync.ts, closeQuoteReminders) predate this and keep
 * their own copies; move them here in a refactor of their own.
 */
type Scope = { workspaceId: string; brandId: string };

export type KeyedTask = { requestId: string; title: string; description: string; areas: TaskArea[]; ownerId: string | null; ownerRoleId: string | null; dueOn: Date | null };

/**
 * The task for `requestId`, made now unless it exists (ON CONFLICT DO NOTHING, so a clash never aborts the caller's
 * transaction). A new one is audited (system actor) and its owner, or each holder of its owning role, gets a
 * TASK_ASSIGNED notice. Returns its id and whether it was made now.
 */
export async function createKeyedTask(tx: Prisma.TransactionClient, scope: Scope, t: KeyedTask): Promise<{ id: string; created: boolean }> {
  const s = { workspaceId: scope.workspaceId, brandId: scope.brandId };
  const { count } = await tx.task.createMany({ data: [{ ...s, ...t }], skipDuplicates: true });
  const row = await tx.task.findFirstOrThrow({ where: { brandId: s.brandId, requestId: t.requestId }, select: { id: true } });
  if (count) {
    const audit = await taskAudit(tx, { ...s, userId: null }, "task.create", { type: "Task", id: row.id, title: t.title }, { source: "system", requestId: t.requestId });
    const to = await assigneesOf(tx, { ...s, ownerId: t.ownerId, ownerRoleId: t.ownerRoleId });
    if (to.length) {
      await tx.notification.createMany({
        data: to.map((userId) => ({ userId, ...s, kind: "TASK_ASSIGNED" as const, taskId: row.id, actorId: null, dedupeKey: `TASK_ASSIGNED:${userId}:${audit.id}` })),
        skipDuplicates: true,
      });
    }
  }
  return { id: row.id, created: count > 0 };
}

/** Closes the given tasks that are still open (DONE, with a system comment saying why), audited with `metadata`. */
export async function closeTasks(tx: Prisma.TransactionClient, scope: Scope, ids: string[], why: string, metadata: Prisma.InputJsonObject = {}) {
  const s = { workspaceId: scope.workspaceId, brandId: scope.brandId };
  if (!ids.length) return 0;
  const open = await tx.task.findMany({ where: { id: { in: ids }, ...s, status: { in: [...OPEN_TASK_STATUSES] } }, select: { id: true } });
  if (!open.length) return 0;
  const openIds = open.map((t) => t.id);
  await tx.task.updateMany({ where: { id: { in: openIds } }, data: { status: "DONE", completedAt: new Date(), blockedReason: null, blockedOnId: null } });
  await tx.taskComment.createMany({ data: openIds.map((taskId) => ({ ...s, taskId, authorId: null, kind: "SYSTEM" as const, body: why, byClient: false, internal: false })) });
  await tx.auditEvent.createMany({ data: openIds.map((id) => ({ ...s, actorUserId: null, action: "task.closed-by-system", entityType: "Task", entityId: id, metadata })) });
  return openIds.length;
}
