import { beforeAll, describe, expect, it, vi } from "vitest";

const deleted = vi.hoisted(() => [] as string[]);
vi.mock("@/server/storage/media", async (orig) => ({ ...(await orig<object>()), deleteMedia: async (key: string) => void deleted.push(key) }));

import { prisma } from "@/server/db/prisma";
import { purgeStaleTaskFiles } from "@/server/tasks/files";

/** TaskFile against Postgres: the migration's table and FK, the sweep's choice of rows. */
let ws: string;
let brandId: string;
let taskId: string;

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-task-files" } })).id;
  brandId = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "B" } })).id;
  taskId = (await prisma.task.create({ data: { workspaceId: ws, brandId, title: "Quote" } })).id;
});

const file = (key: string, status: string, createdAt = new Date()) =>
  prisma.taskFile.create({ data: { workspaceId: ws, brandId, taskId, key, status, contentType: "application/pdf", fileName: "a.pdf", bytes: 1, createdById: "u", createdAt } });

describe("task files", () => {
  it("the sweep removes only day-old unfinished slots, and both keys they may have used", async () => {
    const old = new Date(Date.now() - 2 * 86_400_000);
    const stale = await file(`${ws}/b/task-files/uploads/old.pdf`, "PENDING", old);
    const stuck = await file(`${ws}/b/task-files/uploads/stuck.pdf`, "CHECKING", old);
    const fresh = await file(`${ws}/b/task-files/uploads/new.pdf`, "PENDING");
    const kept = await file(`${ws}/b/task-files/kept.pdf`, "VERIFIED", old);
    expect(await purgeStaleTaskFiles(new Date())).toBe(2);
    const left = (await prisma.taskFile.findMany({ where: { taskId }, select: { id: true } })).map((r) => r.id).sort();
    expect(left).toEqual([fresh.id, kept.id].sort());
    expect(deleted).toEqual(expect.arrayContaining([stale.key, `${ws}/b/task-files/old.pdf`, stuck.key, `${ws}/b/task-files/stuck.pdf`]));
    expect(deleted).not.toContain(kept.key);
  });

  it("the key is unique, and the files go with their task", async () => {
    await expect(file(`${ws}/b/task-files/kept.pdf`, "VERIFIED")).rejects.toMatchObject({ code: "P2002" });
    await prisma.task.delete({ where: { id: taskId } });
    expect(await prisma.taskFile.count({ where: { taskId } })).toBe(0);
  });
});
