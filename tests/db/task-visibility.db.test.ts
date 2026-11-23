import { beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { brandAccess } from "@/server/auth/access";
import { taskViewer, visibleTaskSql, visibleTasksAcrossSql } from "@/server/tasks/access";

/**
 * One workspace, two brands. Staff (workspace role with every task key) sees all; the client holds the built-in
 * client-reviewer grant on b1 only and a workspace role without project keys.
 */
const ids = async (where: Prisma.Sql) =>
  (await prisma.$queryRaw<{ id: string }[]>`SELECT t.id FROM "Task" t WHERE ${where}`).map((r) => r.id).sort();

let ws: string;
let b1: string;
let b2: string;
let staff: string;
let client: string;
const task: Record<string, string> = {};

beforeAll(async () => {
  const w = await prisma.workspace.create({ data: { name: "W", slug: "w-task-visibility" } });
  ws = w.id;
  const [brand1, brand2] = await Promise.all([
    prisma.brand.create({ data: { workspaceId: ws, slug: "b1", displayName: "B1" } }),
    prisma.brand.create({ data: { workspaceId: ws, slug: "b2", displayName: "B2" } }),
  ]);
  b1 = brand1.id;
  b2 = brand2.id;
  const [ownerRole, memberRole, clientRole] = await Promise.all([
    prisma.role.create({ data: { workspaceId: ws, slug: "owner", name: "Owner", isSystem: true, permissions: ["brand.read", "content.approve", "tasks.read", "tasks.manage"] } }),
    prisma.role.create({ data: { workspaceId: ws, slug: "member", name: "Member", isSystem: true, permissions: [] } }),
    prisma.role.create({ data: { workspaceId: ws, slug: "client-reviewer", name: "Client", isSystem: true, scope: "PROJECT", permissions: ["brand.read", "content.approve", "tasks.read"] } }),
  ]);
  const [s, c] = await Promise.all([
    prisma.user.create({ data: { email: "staff@task-visibility.test" } }),
    prisma.user.create({ data: { email: "client@task-visibility.test" } }),
  ]);
  staff = s.id;
  client = c.id;
  await prisma.workspaceMember.createMany({ data: [{ workspaceId: ws, userId: staff, roleId: ownerRole.id }, { workspaceId: ws, userId: client, roleId: memberRole.id }] });
  await prisma.brandMember.create({ data: { workspaceId: ws, brandId: b1, userId: client, roleId: clientRole.id } });

  const [shared, internal] = await Promise.all([
    prisma.workProject.create({ data: { workspaceId: ws, brandId: b1, name: "Shared", clientVisible: true } }),
    prisma.workProject.create({ data: { workspaceId: ws, brandId: b1, name: "Internal" } }),
  ]);
  const make = async (key: string, data: Partial<Prisma.TaskUncheckedCreateInput>) => {
    task[key] = (await prisma.task.create({ data: { workspaceId: ws, brandId: b1, title: key, ...data } })).id;
  };
  await make("reviewed", { reviewerId: client });
  await make("shared", { workProjectId: shared.id });
  await make("internal", { workProjectId: internal.id });
  await make("plain", {});
  await make("otherBrand", { brandId: b2 });
});

/** The per-brand form, from the same scope a brand route gets. A brand the person can't open shows nothing. */
async function perBrand(userId: string, brandId: string) {
  const access = await brandAccess(ws, brandId, userId).catch(() => null);
  if (!access) return [];
  return ids(visibleTaskSql(taskViewer({ userId, workspaceId: ws, brandId, perms: access.perms, clientReviewer: access.clientReviewer })));
}

describe("task visibility", () => {
  it("client sees reviewed or shared only", async () => {
    expect(await perBrand(client, b1)).toEqual([task.reviewed, task.shared].sort());
    expect(await perBrand(client, b2)).toEqual([]);
    expect(await perBrand(staff, b1)).toEqual([task.reviewed, task.shared, task.internal, task.plain].sort());
  });

  it("across-brands form matches per-brand form", async () => {
    for (const userId of [staff, client]) {
      const each = [...(await perBrand(userId, b1)), ...(await perBrand(userId, b2))].sort();
      expect(await ids(await visibleTasksAcrossSql(userId, ws))).toEqual(each);
    }
  });
});
