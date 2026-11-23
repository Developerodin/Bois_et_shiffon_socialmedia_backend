import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/prisma";
import { notifyTx } from "@/server/notifications/tasks";
import { lockRow, TX } from "@/server/services/publishing";
import { canBeAssigned, findVisibleTask, isSoleStaff, lastSubmitter, type TaskViewer } from "@/server/tasks/access";
import { taskAudit } from "@/server/tasks/audit";
import { isUniqueViolation, TaskError } from "@/server/tasks/errors";
import { checkTaskLinks } from "@/server/tasks/links";
import { actorRole, getTask, myRoleOn, rowOf, type TaskScope } from "@/server/tasks/service";
import { applyAction, TASK_ACTIONS, type TaskDetailDto } from "@/shared";

const id = z.string().min(1).max(100);
/**
 * POST tasks/:id. `note` goes with approve, `reason` with requestChanges and block. A staff reviewer's note or reason is
 * staff-only unless `shareWithClient` (like addComment); a client's is never internal.
 */
export const TaskActionInput = z.object({
  action: z.enum(TASK_ACTIONS),
  reviewerId: id.optional(),
  note: z.string().max(4_000).optional(),
  reason: z.string().max(4_000).optional(),
  blockedOnId: id.optional(),
  shareWithClient: z.boolean().optional(),
});
export type TaskActionInput = z.infer<typeof TaskActionInput>;

/** The rules hand dates back as ISO strings; these columns store Dates (recheckOn is only ever cleared here). */
const DATE_FIELDS = new Set(["completedAt", "checkedLiveAt", "findingClearedAt", "recheckOn"]);

/**
 * Move a task through its status rules (shared applyAction) as the caller: owner, reviewer or manager per action. In one
 * locked transaction: the change, the reviewer's APPROVED / CHANGES_REQUESTED comment, the audit event and the
 * reviewer's notice on submitForReview. The reviewer must still be able to see the task to approve or ask for changes.
 * Visibility is checked under the lock, since a reassignment just before can hide the task.
 * `take`: someone holding the task's owning role makes it theirs (ownerId = them, role cleared); no notice. A take
 * that lost the race to someone else is a 409 task.taken, also when the winner's take hid the task from the caller.
 */
export async function runTaskAction(scope: TaskScope, v: TaskViewer, taskId: string, body: TaskActionInput): Promise<TaskDetailDto> {
  const { action } = body;
  await prisma.$transaction(async (tx) => {
    await lockRow(tx, "task", taskId);
    if (!(await findVisibleTask(tx, v, taskId))) {
      const taken = action === "take" && !v.client && (await tx.task.findFirst({ where: { id: taskId, workspaceId: scope.workspaceId, brandId: scope.brandId, ownerId: { not: null } }, select: { id: true } }));
      if (taken) throw new TaskError("Someone else has taken this task.", 409, "task.taken");
      throw new TaskError("Task not found", 404);
    }
    const current = await tx.task.findUnique({ where: { id: taskId } });
    if (!current) throw new TaskError("Task not found", 404);
    const isOwner = current.ownerId === scope.userId;
    // submitForReview asks whether the owner may review their own task (nobody else on the brand could); take asks
    // whether the reviewer of a task in review may own it.
    const asksSole = (action === "submitForReview" && isOwner) || (action === "take" && current.status === "IN_REVIEW" && current.reviewerId === scope.userId);
    const soleStaff = asksSole && (await isSoleStaff(scope.workspaceId, scope.brandId, scope.userId));
    const myRole = action === "take" ? await myRoleOn(tx, scope) : null;
    const actor = { ...actorRole(scope, current, soleStaff, myRole), ...(action === "take" ? { soleStaff } : {}) };
    const result = applyAction(rowOf(current), action, actor, { reviewerId: body.reviewerId, reason: body.reason, blockedOnId: body.blockedOnId, now: new Date().toISOString() });
    if (!result.ok) throw new TaskError(result.reason, 409, result.code);
    const { patch } = result;
    // take moves a role's task to its taker; applyAction already checked they hold the role, so the assign rule sees no role.
    const linksCurrent = action === "take" ? { ...current, ownerRoleId: null } : current;
    await checkTaskLinks(tx, scope, { ownerId: patch.ownerId, reviewerId: patch.reviewerId, blockedOnId: patch.blockedOnId }, linksCurrent);
    if ((action === "approve" || action === "requestChanges") && !(await canBeAssigned(tx, scope, scope.userId, current))) {
      throw new TaskError("You can no longer review this task.", 403);
    }
    // Four eyes: whoever sent it for review doesn't approve it. Closes owner → hand the task to someone else, name
    // yourself reviewer, submit, approve. Cost: a manager who submits naming themselves can't approve. Sole staff can.
    const reviewed = action === "approve" || action === "requestChanges";
    const submitter = reviewed ? await lastSubmitter(tx, taskId) : null;
    if (action === "approve") {
      if (submitter === scope.userId && !(await isSoleStaff(scope.workspaceId, scope.brandId, scope.userId))) {
        throw new TaskError("You sent this task for review, so someone else approves it.", 409, "task.selfApproval");
      }
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
        data: { workspaceId: scope.workspaceId, brandId: scope.brandId, taskId, authorId: scope.userId, kind: action === "approve" ? "APPROVED" : "CHANGES_REQUESTED", body: text, byClient: v.client, internal: !v.client && !body.shareWithClient },
      });
    }
    const event = await taskAudit(tx, scope, `task.${action}`, { type: "Task", id: taskId, title: current.title });
    if (action === "submitForReview") {
      await notifyTx(tx, { userId: patch.reviewerId ?? null, workspaceId: scope.workspaceId, brandId: scope.brandId, kind: "REVIEW_REQUESTED", taskId, actorId: scope.userId, auditEventId: event.id });
    }
    if (reviewed) {
      // Tell whoever sent it for review (the owner if the audit trail has no submit) what the reviewer decided.
      const kind = action === "approve" ? "TASK_APPROVED" : "TASK_CHANGES_REQUESTED";
      await notifyTx(tx, { userId: submitter ?? current.ownerId, workspaceId: scope.workspaceId, brandId: scope.brandId, kind, taskId, actorId: scope.userId, auditEventId: event.id });
    }
  }, TX);
  return getTask(scope, v, taskId);
}
