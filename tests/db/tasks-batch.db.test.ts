import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/prisma";
import { brandAccess } from "@/server/auth/access";
import { taskViewer } from "@/server/tasks/access";
import { createTaskBatch } from "@/server/tasks/from-note";

const RID = "0b9a7c1e-2d3f-4a5b-8c6d-7e8f9a0b1c2d";
let scope: Parameters<typeof createTaskBatch>[0] & { clientReviewer: boolean };
let other: string;

beforeAll(async () => {
  const ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-tasks-batch" } })).id;
  const brand = await prisma.brand.create({ data: { workspaceId: ws, slug: "b1", displayName: "B1" } });
  const role = await prisma.role.create({ data: { workspaceId: ws, slug: "owner", name: "Owner", isSystem: true, permissions: ["brand.read", "tasks.read", "tasks.manage"] } });
  const [me, them] = await Promise.all([prisma.user.create({ data: { email: "me@tasks-batch.test" } }), prisma.user.create({ data: { email: "them@tasks-batch.test", name: "Them" } })]);
  other = them.id;
  await prisma.workspaceMember.createMany({ data: [{ workspaceId: ws, userId: me.id, roleId: role.id }, { workspaceId: ws, userId: them.id, roleId: role.id }] });
  const access = await brandAccess(ws, brand.id, me.id);
  scope = { userId: me.id, workspaceId: ws, brandId: brand.id, perms: access.perms, clientReviewer: access.clientReviewer };
});

describe("tasks batch", () => {
  it("batch retry creates nothing new and returns the same ids", async () => {
    const input = {
      requestId: RID,
      tasks: [
        { title: "Fix the menu", areas: ["WEBSITE" as const], priority: "HIGH" as const, ownerId: other },
        { title: "Post the new menu", areas: ["CONTENT" as const], priority: "NORMAL" as const },
      ],
    };
    const first = await createTaskBatch(scope, taskViewer(scope), input);
    expect(first.tasks.map((t) => t.title)).toEqual(["Fix the menu", "Post the new menu"]);
    const [again, racing] = await Promise.all([createTaskBatch(scope, taskViewer(scope), input), createTaskBatch(scope, taskViewer(scope), input)]);
    const ids = first.tasks.map((t) => t.id);
    expect(again.tasks.map((t) => t.id)).toEqual(ids);
    expect(racing.tasks.map((t) => t.id)).toEqual(ids);
    expect(await prisma.task.count({ where: { brandId: scope.brandId } })).toBe(2);
    expect(await prisma.auditEvent.count({ where: { action: "task.create", entityId: { in: ids } } })).toBe(2);
    expect(await prisma.notification.count({ where: { userId: other, kind: "TASK_ASSIGNED" } })).toBe(1);
  });
});
