import "server-only";
import { Prisma, type TaskAttachment } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/prisma";
import { TX } from "@/server/services/publishing";
import { signedMediaUrl } from "@/server/storage/media";
import { lockTaskForEdit, type TaskViewer } from "@/server/tasks/access";
import { taskAudit } from "@/server/tasks/audit";
import { TaskError } from "@/server/tasks/errors";
import type { TaskScope } from "@/server/tasks/service";
import type { TaskAttachmentDto } from "@/shared";

const AttachmentInput = z.object({ mediaUploadId: z.string().min(1).max(100), role: z.enum(["BEFORE", "AFTER", "OTHER"]) });

/** An attachment with its upload's key → the DTO, with a signed URL as the story upload previews use. */
export const toAttachmentDto = async (a: TaskAttachment, key: string): Promise<TaskAttachmentDto> => ({
  id: a.id, mediaUploadId: a.mediaUploadId, role: a.role, createdById: a.createdById, createdAt: a.createdAt.toISOString(), url: await signedMediaUrl(key),
});

/**
 * Attach a brand photo (the owner holding content.create, or tasks.manage). The upload is re-read in the transaction: this
 * brand's, VERIFIED, a photo, not a product photo (the web uploads through libraryApi.upload, which makes such uploads).
 * The daily purge could delete the upload between this read and the insert (only uploads over 7 days old, in that
 * instant); the insert then fails its FK (P2003) and the caller gets the same 400 as for a missing upload.
 */
export async function addAttachment(scope: TaskScope, v: TaskViewer, taskId: string, body: unknown): Promise<TaskAttachmentDto> {
  const parsed = AttachmentInput.safeParse(body);
  if (!parsed.success) throw new TaskError(parsed.error.issues[0]?.message ?? "Invalid attachment", 400);
  const { mediaUploadId, role } = parsed.data;
  const created = await prisma.$transaction(async (tx) => {
    const task = await lockTaskForEdit(tx, v, scope.perms, taskId, "content.create");
    const upload = await tx.mediaUpload.findFirst({
      where: { id: mediaUploadId, workspaceId: scope.workspaceId, brandId: scope.brandId, status: "VERIFIED", kind: "photo", productId: null },
      select: { key: true },
    });
    if (!upload) throw new TaskError("Invalid mediaUploadId", 400);
    let row: TaskAttachment;
    try {
      row = await tx.taskAttachment.create({ data: { taskId, mediaUploadId, role, createdById: scope.userId } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") throw new TaskError("Invalid mediaUploadId", 400);
      throw e;
    }
    await taskAudit(tx, scope, "task.attachment.add", { type: "Task", id: taskId, title: task.title }, { attachmentId: row.id, role });
    return { row, key: upload.key };
  }, TX);
  return toAttachmentDto(created.row, created.key);
}

/** Take a photo off a task (same people as attach). Only the attachment row goes; the upload and its file stay. */
export async function removeAttachment(scope: TaskScope, v: TaskViewer, taskId: string, attachmentId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const task = await lockTaskForEdit(tx, v, scope.perms, taskId, "content.create");
    const row = await tx.taskAttachment.findFirst({ where: { id: attachmentId, taskId } });
    if (!row) throw new TaskError("Attachment not found", 404);
    await tx.taskAttachment.delete({ where: { id: attachmentId } });
    await taskAudit(tx, scope, "task.attachment.remove", { type: "Task", id: taskId, title: task.title }, { attachmentId, mediaUploadId: row.mediaUploadId });
  }, TX);
}
