import "server-only";
import type { TaskComment } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/prisma";
import { brandOwners, TX } from "@/server/services/publishing";
import { commentVisibility, findVisibleTask, type TaskViewer } from "@/server/tasks/access";
import { taskAudit } from "@/server/tasks/audit";
import { TaskError } from "@/server/tasks/errors";
import { personOf, type TaskScope } from "@/server/tasks/service";
import type { TaskCommentDto } from "@/shared";

const CommentInput = z.object({ body: z.string().trim().min(1).max(4_000), shareWithClient: z.boolean().optional() });

/** Newest comments read per task. ponytail: older ones aren't paged yet; add a cursor if a task passes this. */
const COMMENTS = 200;

const notFound = () => new TaskError("Task not found", 404);

async function toDtos(scope: TaskScope, rows: TaskComment[]): Promise<TaskCommentDto[]> {
  const person = personOf(rows.length ? await brandOwners(scope, { key: "tasks.read", includeClients: true }) : []);
  return rows.map((c) => ({ id: c.id, kind: c.kind, body: c.body, author: person(c.authorId), byClient: c.byClient, internal: c.internal, createdAt: c.createdAt.toISOString() }));
}

/** A task's comments the viewer may read (a client never gets internal ones), oldest first. 404 when the task is hidden. */
export async function listComments(scope: TaskScope, v: TaskViewer, taskId: string): Promise<TaskCommentDto[]> {
  if (!(await findVisibleTask(prisma, v, taskId))) throw notFound();
  const rows = await prisma.taskComment.findMany({ where: { taskId, ...commentVisibility(v) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: COMMENTS });
  return toDtos(scope, rows.reverse());
}

/**
 * Comment on a task the viewer can see. Append-only (no edit or delete). Staff comments are internal unless
 * `shareWithClient`, whatever the task's visibility now, so a project shared later doesn't reveal them; a client's
 * comments are never internal.
 */
export async function addComment(scope: TaskScope, v: TaskViewer, taskId: string, body: unknown): Promise<TaskCommentDto> {
  const parsed = CommentInput.safeParse(body);
  if (!parsed.success) throw new TaskError(parsed.error.issues[0]?.message ?? "Invalid comment", 400);
  const { body: text, shareWithClient } = parsed.data;
  const row = await prisma.$transaction(async (tx) => {
    if (!(await findVisibleTask(tx, v, taskId))) throw notFound();
    const comment = await tx.taskComment.create({
      data: { workspaceId: scope.workspaceId, brandId: scope.brandId, taskId, authorId: scope.userId, kind: "COMMENT", body: text, byClient: v.client, internal: v.client ? false : !shareWithClient },
    });
    await taskAudit(tx, scope, "task.comment", { type: "TaskComment", id: comment.id }, { taskId, internal: comment.internal });
    return comment;
  }, TX);
  return (await toDtos(scope, [row]))[0]!;
}
