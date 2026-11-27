import "server-only";
import { randomUUID } from "node:crypto";
import type { TaskFile } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/prisma";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { TX } from "@/server/services/publishing";
import { deleteMedia, getMediaBytes, MediaTooLarge, mediaKey, presignedPut, putMedia, signedMediaUrl } from "@/server/storage/media";
import { lockTaskForEdit, type TaskViewer } from "@/server/tasks/access";
import { taskAudit } from "@/server/tasks/audit";
import { TaskError } from "@/server/tasks/errors";
import { checkTaskFile, cleanFileName, downloadName, FileRefused } from "@/server/tasks/file-check";
import type { TaskScope } from "@/server/tasks/service";
import { TASK_FILE_MAX_BYTES, TASK_FILE_TYPES, TASK_FILES_MAX, type TaskFileDto, type TaskFileType } from "@/shared";

/**
 * Documents on a task (TaskFile): a slot, the browser's PUT, a check of the bytes, then a download link. Kept apart from
 * MediaUpload and the stories upload flow so a document never reaches the story picker or the photo library.
 * Who: staff who may edit the task's checklist (lockTaskForEdit: managesTask or the owner, no extra key). A client
 * reviewer is refused even as owner, so files from outside never reach the team through a task. Who reads: anyone who
 * sees the task (getTask), a client reviewer on a client-visible task included.
 */

const MB = 1024 * 1024;
const PUT_SECONDS = 600;
/** A slot can be checked this long after it was made; the sweep removes unfinished ones after STALE_MS. */
const VERIFY_WITHIN_MS = 3_600_000;
const STALE_MS = 86_400_000;
const SLOTS_PER_HOUR = 30;
/** Checks a person may ask for in an hour, so one person can't keep the MAX_VERIFYING places busy for everyone. */
const VERIFIES_PER_HOUR = 60;
/**
 * Files checked at once by this process: each holds the whole file (≤ 25 MB) in memory, briefly twice while its chunks
 * are joined, so about 100 MB at most. Past it a 429; the web retries the check (the slot stays valid for the hour).
 */
const MAX_VERIFYING = 2;
const URL_SECONDS = 3600;
const UPLOADS = "/task-files/uploads/";
const STORED = "/task-files/";

const TYPES = Object.keys(TASK_FILE_TYPES) as [TaskFileType, ...TaskFileType[]];
const SlotInput = z.object({
  fileName: z.string().min(1).max(500),
  contentType: z.enum(TYPES, { error: "Attach a PDF, Word, Excel, PowerPoint, CSV, text, JPG or PNG file." }),
  bytes: z.number().int().positive(),
});

/** Text is served as UTF-8 (the check made sure it is). */
const servedType = (t: TaskFileType) => (t === "text/csv" || t === "text/plain" ? `${t}; charset=utf-8` : t);

const noClients = (v: TaskViewer) => {
  if (v.client) throw new TaskError("A client reviewer can't add or remove files on a task.", 403);
};

/** A verified file → the DTO, with an hour's signed link that always downloads, under downloadName and the verified type. */
export async function toFileDto(f: TaskFile): Promise<TaskFileDto> {
  const type = f.contentType as TaskFileType;
  return {
    id: f.id, fileName: f.fileName, contentType: f.contentType, bytes: f.bytes, createdById: f.createdById, createdAt: f.createdAt.toISOString(),
    url: await signedMediaUrl(f.key, URL_SECONDS, downloadName(f.fileName, type), servedType(type)),
  };
}

/**
 * A place to PUT one file (`{ fileName, contentType, bytes }`): the type and size are signed into the URL, so storage
 * refuses any other. The row is PENDING until verifyFile has read the bytes. 20 files a task (unfinished ones count,
 * counted under the task's lock), 30 slots an hour a person.
 */
export async function createFileSlot(scope: TaskScope, v: TaskViewer, taskId: string, body: unknown): Promise<{ fileId: string; url: string; headers: Record<string, string> }> {
  noClients(v);
  const parsed = SlotInput.safeParse(body);
  if (!parsed.success) throw new TaskError(parsed.error.issues[0]?.message ?? "Invalid file", 400);
  const { contentType, bytes } = parsed.data;
  if (bytes > TASK_FILE_MAX_BYTES) throw new TaskError(`That file is too large (up to ${TASK_FILE_MAX_BYTES / MB} MB).`, 413);
  if (!(await hitRateLimit(`task-file:${scope.userId}`, SLOTS_PER_HOUR, 3_600_000)).allowed) throw new TaskError("Too many uploads this hour. Try again later.", 429);
  const file = `${randomUUID()}.${TASK_FILE_TYPES[contentType].ext}`;
  // mediaKey checks the tenant segments and the server-made name; then the folder goes in. Nothing from the client is in it.
  const key = mediaKey(scope, file).replace(/[^/]+$/, `${UPLOADS.slice(1)}${file}`);
  const row = await prisma.$transaction(async (tx) => {
    await lockTaskForEdit(tx, v, scope.perms, taskId);
    // Verified files, and slots still young enough to be checked: a dead slot (over the hour) never holds a place.
    const live = { taskId, OR: [{ status: "VERIFIED" }, { createdAt: { gt: new Date(Date.now() - VERIFY_WITHIN_MS) } }] };
    if ((await tx.taskFile.count({ where: live })) >= TASK_FILES_MAX) throw new TaskError(`A task holds up to ${TASK_FILES_MAX} files. Remove one first.`, 409);
    return tx.taskFile.create({
      data: { workspaceId: scope.workspaceId, brandId: scope.brandId, taskId, key, contentType, fileName: cleanFileName(parsed.data.fileName), bytes, createdById: scope.userId },
    });
  }, TX);
  return { fileId: row.id, url: await presignedPut(key, contentType, bytes, PUT_SECONDS), headers: { "Content-Type": contentType } };
}

let verifying = 0;

/**
 * The browser has PUT the file: check it and keep it. Three steps so no transaction is open while storage works:
 * (a) under the task's lock, claim the person's own PENDING slot on this task (CHECKING), made within the hour;
 * (b) read the object once (no more than announced), check those bytes, write those same bytes to the stored key (so
 * swapping the object after the read changes nothing), drop the upload key; (c) under the lock again, VERIFIED and the
 * audit. A refused file loses its row and both keys; the person gets the reason (400).
 */
export async function verifyFile(scope: TaskScope, v: TaskViewer, taskId: string, fileId: string): Promise<TaskFileDto> {
  noClients(v);
  if (!(await hitRateLimit(`task-file-verify:${scope.userId}`, VERIFIES_PER_HOUR, 3_600_000)).allowed) throw new TaskError("Too many uploads this hour. Try again later.", 429);
  if (verifying >= MAX_VERIFYING) throw new TaskError("Busy checking other files. Try again in a moment.", 429, "task.fileBusy");
  verifying++;
  try {
    const row = await prisma.$transaction(async (tx) => {
      await lockTaskForEdit(tx, v, scope.perms, taskId);
      const mine = { id: fileId, taskId, workspaceId: scope.workspaceId, brandId: scope.brandId, createdById: scope.userId };
      const claimed = await tx.taskFile.updateMany({ where: { ...mine, status: "PENDING", createdAt: { gt: new Date(Date.now() - VERIFY_WITHIN_MS) } }, data: { status: "CHECKING" } });
      const found = await tx.taskFile.findFirst({ where: mine });
      if (!found) throw new TaskError("Upload not found.", 404);
      if (claimed.count !== 1) throw new TaskError("That upload was already used or has expired. Upload the file again.", 409);
      return found;
    }, TX);
    const storedKey = row.key.replace(UPLOADS, STORED);
    try {
      const bytes = await getMediaBytes(row.key, row.bytes).catch((e) => {
        throw new FileRefused(e instanceof MediaTooLarge ? "The file is bigger than announced." : "The file didn't arrive. Try again.");
      });
      if (bytes.length !== row.bytes) throw new FileRefused("The file isn't the size that was announced.");
      const type = checkTaskFile(bytes, row.contentType as TaskFileType);
      await putMedia(storedKey, bytes, servedType(type));
      await deleteMedia(row.key).catch(() => {});
      const done = await prisma.$transaction(async (tx) => {
        const task = await lockTaskForEdit(tx, v, scope.perms, taskId);
        const moved = await tx.taskFile.updateMany({ where: { id: row.id, status: "CHECKING" }, data: { status: "VERIFIED", key: storedKey } });
        if (moved.count !== 1) throw new TaskError("Upload not found.", 404);
        await taskAudit(tx, scope, "task.file.add", { type: "Task", id: taskId, title: task.title }, { fileId: row.id, contentType: type, bytes: row.bytes });
        return tx.taskFile.findUniqueOrThrow({ where: { id: row.id } });
      }, TX);
      return toFileDto(done);
    } catch (e) {
      // Nothing half-kept: both keys and the row go (the row last, so a crash leaves a row the sweep finds).
      await deleteMedia(row.key).catch(() => {});
      await deleteMedia(storedKey).catch(() => {});
      await prisma.taskFile.deleteMany({ where: { id: row.id, status: "CHECKING" } }).catch(() => {});
      if (e instanceof FileRefused) throw new TaskError(e.message, 400);
      throw e;
    }
  } finally {
    verifying--;
  }
}

/** Take a file off a task (the same people as add): this task's own verified file only; the row, then the object. */
export async function removeFile(scope: TaskScope, v: TaskViewer, taskId: string, fileId: string): Promise<void> {
  noClients(v);
  const key = await prisma.$transaction(async (tx) => {
    const task = await lockTaskForEdit(tx, v, scope.perms, taskId);
    const row = await tx.taskFile.findFirst({ where: { id: fileId, taskId, workspaceId: scope.workspaceId, brandId: scope.brandId, status: "VERIFIED" }, select: { key: true } });
    if (!row) throw new TaskError("File not found", 404);
    await tx.taskFile.delete({ where: { id: fileId } });
    await taskAudit(tx, scope, "task.file.remove", { type: "Task", id: taskId, title: task.title }, { fileId });
    return row.key;
  }, TX);
  // A failed delete leaves an orphan object, never a row pointing at nothing.
  await deleteMedia(key).catch(() => {});
}

/**
 * Daily: slots never finished (PENDING or CHECKING after a day; verify refuses slots over an hour old, so none is being
 * checked). The row, then both keys it may have used.
 */
export async function purgeStaleTaskFiles(now: Date): Promise<number> {
  let removed = 0;
  for (;;) {
    const rows = await prisma.taskFile.findMany({
      where: { status: { in: ["PENDING", "CHECKING"] }, createdAt: { lt: new Date(now.getTime() - STALE_MS) } },
      orderBy: { id: "asc" },
      take: 500,
      select: { id: true, key: true },
    });
    if (!rows.length) break;
    for (const r of rows) {
      const gone = await prisma.taskFile.deleteMany({ where: { id: r.id, status: { in: ["PENDING", "CHECKING"] } } });
      if (!gone.count) continue;
      await deleteMedia(r.key).catch(() => {});
      await deleteMedia(r.key.replace(UPLOADS, STORED)).catch(() => {});
      removed++;
    }
    if (rows.length < 500) break;
  }
  return removed;
}
