import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/prisma";
import type { PermissionKey } from "@/server/auth/permissions.catalog";
import { taskViewer } from "@/server/tasks/access";
import { runTaskAction } from "@/server/tasks/actions";
import { patchTask } from "@/server/tasks/service";

/**
 * A task in review whose reviewer has left (no membership), so PATCH may swap the reviewer. The owner and a second
 * Owner both read tasks, so the owner is not sole staff and may not become their own reviewer.
 */
let scope: { workspaceId: string; brandId: string; userId: string; perms: Set<PermissionKey>; clientReviewer: boolean };
let taskId: string;
let other: string;

beforeAll(async () => {
  const ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-task-review-swap" } })).id;
  const brandId = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "B" } })).id;
  const role = await prisma.role.create({ data: { workspaceId: ws, slug: "owner", name: "Owner", isSystem: true, permissions: ["brand.read", "tasks.read", "tasks.manage"] } });
  const [owner, second, gone] = await Promise.all(
    ["owner", "second", "gone"].map((n) => prisma.user.create({ data: { email: `${n}@task-review-swap.test` } })),
  );
  await prisma.workspaceMember.createMany({ data: [owner, second].map((u) => ({ workspaceId: ws, userId: u.id, roleId: role.id })) });
  other = second.id;
  scope = { workspaceId: ws, brandId, userId: owner.id, perms: new Set(["brand.read", "tasks.read", "tasks.manage"]), clientReviewer: false };
  taskId = (await prisma.task.create({ data: { workspaceId: ws, brandId, title: "T", status: "IN_REVIEW", ownerId: owner.id, reviewerId: gone.id } })).id;
});

describe("reviewer swap while in review", () => {
  it("the owner can't make themselves the reviewer → 409, nothing written", async () => {
    await expect(patchTask(scope, taskViewer(scope), taskId, { reviewerId: scope.userId })).rejects.toMatchObject({ status: 409, code: "task.reviewerIsOwner" });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).reviewerId).not.toBe(scope.userId);
  });

  it("another staff member can take over the review", async () => {
    await patchTask(scope, taskViewer(scope), taskId, { reviewerId: other });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).reviewerId).toBe(other);
  });

  it("hand the task away, name yourself reviewer, submit: you still can't approve it", async () => {
    const t = await prisma.task.create({ data: { workspaceId: scope.workspaceId, brandId: scope.brandId, title: "T2", status: "IN_PROGRESS", ownerId: scope.userId, reviewerId: other } });
    await patchTask(scope, taskViewer(scope), t.id, { ownerId: other, reviewerId: scope.userId });
    await runTaskAction(scope, taskViewer(scope), t.id, { action: "submitForReview" });
    await expect(runTaskAction(scope, taskViewer(scope), t.id, { action: "approve" })).rejects.toMatchObject({ status: 409, code: "task.selfApproval" });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("IN_REVIEW");
  });

  it("an impossible date is a 400, not a crash", async () => {
    await expect(patchTask(scope, taskViewer(scope), taskId, { dueOn: "2026-13-01" })).rejects.toMatchObject({ status: 400 });
  });
});
