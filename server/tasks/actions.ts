import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/prisma";
import { notifyTx } from "@/server/notifications/tasks";
import { lockRow, TX } from "@/server/services/publishing";
import { canBeAssigned, findVisibleTask, isSoleStaff, type TaskViewer } from "@/server/tasks/access";
import { taskAudit } from "@/server/tasks/audit";
import { TaskError } from "@/server/tasks/errors";
import { checkTaskLinks } from "@/server/tasks/links";
import { getTask, rowOf, type TaskScope } from "@/server/tasks/service";
import { applyAction, TASK_ACTIONS, type TaskDto } from "@/shared";

const id = z.string().min(1).max(100);
/** POST tasks/:id. `note` goes with approve, `reason` with requestChanges and block. */
export const TaskActionInput = z.object({
  action: z.enum(TASK_ACTIONS),
  reviewerId: id.optional(),
  note: z.string().max(4_000).optional(),
  reason: z.string().max(4_000).optional(),
  blockedOnId: id.optional(),
});
export type TaskActionInput = z.infer<typeof TaskActionInput>;

/** The rules hand dates back as ISO strings; these columns store Dates (recheckOn is only ever cleared here). */
const DATE_FIELDS = new Set(["completedAt", "checkedLiveAt", "findingClearedAt", "recheckOn"]);

const isUniqueViolation = (e: unknown) =>
  (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") || (e as { meta?: { code?: string } } | null)?.meta?.code === "23505";

/**
 * Move a task through its status rules (shared applyAction) as the caller: owner, reviewer or manager per action. In one
 * locked transaction: the change, the reviewer's APPROVED / CHANGES_REQUESTED comment, the audit event and the
 * reviewer's notice on submitForReview. The reviewer must still be able to see the task to approve or ask for changes.
 */
export async function runTaskAction(scope: TaskScope, v: TaskViewer, taskId: string, body: TaskActionInput): Promise<TaskDto> {
  const { action } = body;
  await prisma.$transaction(async (tx) => {
    if (!(await findVisibleTask(tx, v, taskId))) throw new TaskError("Task not found", 404);
    await lockRow(tx, "task", taskId);
    const current = await tx.task.findUnique({ where: { id: taskId } });
    if (!current) throw new TaskError("Task not found", 404);
    const isOwner = current.ownerId === scope.userId;
    // Only submitForReview asks whether the owner may review their own task (nobody else on the brand could).
    const soleStaff = action === "submitForReview" && isOwner && (await isSoleStaff(scope.workspaceId, scope.brandId, scope.userId));
    const actor = { userId: scope.userId, isOwner, isReviewer: current.reviewerId === scope.userId, canManage: v.canManage, soleStaff, isBlockedOn: current.blockedOnId === scope.userId };
    const result = applyAction(rowOf(current), action, actor, { reviewerId: body.reviewerId, reason: body.reason, blockedOnId: body.blockedOnId, now: new Date().toISOString() });
    if (!result.ok) throw new TaskError(result.reason, 409);
    const { patch } = result;
    await checkTaskLinks(tx, scope, { reviewerId: patch.reviewerId, blockedOnId: patch.blockedOnId }, current);
    if ((action === "approve" || action === "requestChanges") && !(await canBeAssigned(tx, scope, scope.userId, current))) {
      throw new TaskError("You can no longer review this task.", 403);
    }
    const data = Object.fromEntries(Object.entries(patch).map(([k, val]) => [k, DATE_FIELDS.has(k) && typeof val === "string" ? new Date(val) : val]));
    try {
      await tx.task.update({ where: { id: taskId }, data: data as Prisma.TaskUncheckedUpdateInput });
    } catch (e) {
      // Reopening a task whose audit finding another open task now holds (the one-open-task-per-finding index).
      if (isUniqueViolation(e)) throw new TaskError("Another open task already covers this finding.", 409, "task.findingTaken");
      throw e;
    }
    if (action === "approve" || action === "requestChanges") {
      const text = (action === "approve" ? body.note : body.reason)?.trim() ?? "";
      await tx.taskComment.create({
        data: { workspaceId: scope.workspaceId, brandId: scope.brandId, taskId, authorId: scope.userId, kind: action === "approve" ? "APPROVED" : "CHANGES_REQUESTED", body: text, byClient: v.client, internal: false },
      });
    }
    const event = await taskAudit(tx, scope, `task.${action}`, { type: "Task", id: taskId, title: current.title });
    if (action === "submitForReview") {
      await notifyTx(tx, { userId: patch.reviewerId ?? null, workspaceId: scope.workspaceId, brandId: scope.brandId, kind: "REVIEW_REQUESTED", taskId, actorId: scope.userId, auditEventId: event.id });
    }
  }, TX);
  return getTask(scope, v, taskId);
}
