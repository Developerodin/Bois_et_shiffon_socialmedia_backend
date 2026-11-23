import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/prisma";
import { purgeStaleUploads } from "@/server/stories/uploads";

/** The Restrict FK from TaskAttachment and the purge's `taskAttachments: { none: {} }` keep a task's photos. */
let attached: string;
let unused: string;

beforeAll(async () => {
  const ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-task-attach" } })).id;
  const brandId = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "B" } })).id;
  const old = new Date(Date.now() - 30 * 86_400_000);
  const upload = (key: string) =>
    prisma.mediaUpload.create({ data: { workspaceId: ws, brandId, key, kind: "photo", status: "VERIFIED", bytes: 1, createdBy: "u", createdAt: old } });
  attached = (await upload(`${ws}/attached.jpg`)).id;
  unused = (await upload(`${ws}/unused.jpg`)).id;
  const taskId = (await prisma.task.create({ data: { workspaceId: ws, brandId, title: "Fix menu" } })).id;
  await prisma.taskAttachment.create({ data: { taskId, mediaUploadId: attached, role: "BEFORE", createdById: "u" } });
});

describe("upload purge and task attachments", () => {
  it("an attached upload can't be deleted (P2003)", async () => {
    await expect(prisma.mediaUpload.delete({ where: { id: attached } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("purge skips uploads a task uses and removes the unused one", async () => {
    await purgeStaleUploads();
    expect(await prisma.mediaUpload.findUnique({ where: { id: attached } })).not.toBeNull();
    expect(await prisma.mediaUpload.findUnique({ where: { id: unused } })).toBeNull();
  });
});
