import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/prisma";
import type { PermissionKey } from "@/server/auth/permissions.catalog";
import { taskViewer } from "@/server/tasks/access";
import { runTaskAction } from "@/server/tasks/actions";

/** The partial unique index (one open task per finding) turns a reopen that would make a second open one into a 409. */
let scope: { workspaceId: string; brandId: string; userId: string; perms: Set<PermissionKey>; clientReviewer: boolean };
let done: string;

beforeAll(async () => {
  const ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-task-reopen" } })).id;
  const brandId = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "B" } })).id;
  const userId = (await prisma.user.create({ data: { email: "manager@task-reopen.test" } })).id;
  scope = { workspaceId: ws, brandId, userId, perms: new Set(["brand.read", "tasks.read", "tasks.manage"]), clientReviewer: false };
  const finding = { workspaceId: ws, brandId, findingKind: "SEO" as const, findingId: "missing-meta" };
  done = (await prisma.task.create({ data: { ...finding, title: "Old", status: "DONE", completedAt: new Date() } })).id;
  await prisma.task.create({ data: { ...finding, title: "New", status: "TODO" } });
});

describe("reopen", () => {
  it("reopen while another open task holds the finding → 409", async () => {
    await expect(runTaskAction(scope, taskViewer(scope), done, { action: "reopen" })).rejects.toMatchObject({ status: 409 });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: done } })).status).toBe("DONE");
    expect(await prisma.auditEvent.count({ where: { entityId: done } })).toBe(0);
  });
});
