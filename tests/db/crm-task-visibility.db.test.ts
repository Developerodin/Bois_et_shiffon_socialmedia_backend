import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/request-user", () => ({ requestUserId: vi.fn() }));

import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { brandAccess } from "@/server/auth/access";
import { ensureSystemRoles } from "@/server/auth/permissions";
import { SYSTEM_ROLES } from "@/server/auth/permissions.catalog";
import { countUnread, listNotifications } from "@/server/notifications/list";
import { taskViewer } from "@/server/tasks/access";
import { assignTasks } from "@/server/tasks/assign";
import { listTasks, todayTasks } from "@/server/tasks/list";
import { searchBrand } from "@/server/tasks/search";
import { createTask, patchTask, TaskInput } from "@/server/tasks/service";

/**
 * The CRM task area on built-in roles (ensureSystemRoles). `lead` holds tasks.all through a custom project role without
 * inbox.read or crm.manage; `manager` holds the built-in Manager grant (both keys); `viewer` the Viewer grant (neither);
 * `client` the Client reviewer grant. `admin` (workspace Admin) writes.
 */
let ws: string;
let brand: string;
const user: Record<string, string> = {};
const role: Record<string, string> = {};
const task: Record<string, string> = {};
const NOW = new Date("2026-11-24T12:00:00Z");

async function scopeOf(name: string) {
  const access = await brandAccess(ws, brand, user[name]!);
  return { userId: user[name]!, workspaceId: ws, brandId: brand, perms: access.perms, clientReviewer: access.clientReviewer };
}
const input = (data: Partial<TaskInput>) => TaskInput.parse({ title: "Task", areas: ["CRM"], priority: "NORMAL", ...data });

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-crm-tasks" } })).id;
  brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "B" } })).id;
  await ensureSystemRoles(ws);
  Object.assign(role, Object.fromEntries((await prisma.role.findMany({ where: { workspaceId: ws } })).map((r) => [r.slug, r.id])));
  role.lead = (await prisma.role.create({ data: { workspaceId: ws, slug: "lead", name: "Lead", scope: "PROJECT", permissions: ["brand.read", "tasks.read", "tasks.manage", "tasks.all"] } })).id;
  for (const [name, grant] of [["admin", null], ["lead", "lead"], ["manager", "manager"], ["viewer", "viewer"], ["client", "client-reviewer"]] as const) {
    user[name] = (await prisma.user.create({ data: { email: `${name}@crm-tasks.test`, name } })).id;
    await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: user[name]!, roleId: role[grant ? "member" : "admin"]! } });
    if (grant) await prisma.brandMember.create({ data: { workspaceId: ws, brandId: brand, userId: user[name]!, roleId: role[grant]! } });
  }
  const shared = await prisma.workProject.create({ data: { workspaceId: ws, brandId: brand, name: "Shared", clientVisible: true } });
  const make = async (key: string, data: Partial<Prisma.TaskUncheckedCreateInput>) => {
    task[key] = (await prisma.task.create({ data: { workspaceId: ws, brandId: brand, title: `Follow up ${key}`, dueOn: new Date("2026-11-24T00:00:00Z"), ...data } })).id;
  };
  // Owned by lead as if given before they lost the keys; one in a project shared with the client.
  await make("crm", { areas: ["CRM"], ownerId: user.lead });
  await make("crmShared", { areas: ["CRM", "GENERAL"], workProjectId: shared.id });
  await make("plain", { areas: ["GENERAL"], ownerId: user.lead, workProjectId: shared.id });
  await prisma.notification.createMany({
    data: ["crm", "plain"].map((k) => ({ userId: user.lead!, workspaceId: ws, brandId: brand, kind: "TASK_ASSIGNED" as const, taskId: task[k]!, dedupeKey: `n:${k}` })),
  });
});

describe("CRM task visibility", () => {
  it("a CRM task is hidden from a tasks.all holder without the keys in list, search, Today and notifications", async () => {
    const s = await scopeOf("lead");
    const v = taskViewer(s);
    expect((await listTasks(s, v, { view: "open" }, NOW)).tasks.map((t) => t.id)).toEqual([task.plain]);
    expect((await searchBrand(s, v, "follow")).tasks.map((t) => t.title)).toEqual(["Follow up plain"]);
    const today = await todayTasks(s, v, NOW);
    expect(today.mine.count).toBe(1);
    expect(await countUnread(user.lead!, ws)).toBe(1);
    expect((await listNotifications(user.lead!, ws)).notifications.map((n) => n.taskId)).toEqual([task.plain]);
  });

  it("inbox.read or crm.manage shows them", async () => {
    const admin = await scopeOf("admin");
    expect((await listTasks(admin, taskViewer(admin), { view: "open" }, NOW)).tasks.map((t) => t.id).sort()).toEqual([task.crm, task.crmShared, task.plain].sort());
    // The lead's role given crm.manage in the matrix: seen at once, notifications too.
    await prisma.role.update({ where: { id: role.lead }, data: { permissions: { push: "crm.manage" } } });
    const s = await scopeOf("lead");
    expect((await listTasks(s, taskViewer(s), { view: "open" }, NOW)).tasks).toHaveLength(3);
    expect(await countUnread(user.lead!, ws)).toBe(2);
    await prisma.role.update({ where: { id: role.lead }, data: { permissions: ["brand.read", "tasks.read", "tasks.manage", "tasks.all"] } });
    expect(await countUnread(user.lead!, ws)).toBe(1);
  });

  it("a client reviewer sees CRM tasks only once the matrix gives the role inbox.read, then under client rules", async () => {
    const seen = async () => {
      const s = await scopeOf("client");
      return (await listTasks(s, taskViewer(s), { view: "open" }, NOW)).tasks.map((t) => t.id).sort();
    };
    expect(await seen()).toEqual([task.plain]);
    const before = await prisma.role.findUniqueOrThrow({ where: { id: role["client-reviewer"] } });
    await prisma.role.update({ where: { id: before.id }, data: { permissions: [...before.permissions, "inbox.read"] } });
    try {
      // crmShared sits in the shared project; crm doesn't, so the client clause still hides it.
      expect(await seen()).toEqual([task.crmShared, task.plain].sort());
    } finally {
      await prisma.role.update({ where: { id: before.id }, data: { permissions: before.permissions } });
    }
  });
});

describe("CRM task assignment", () => {
  it("assigning a CRM task to someone or a role without the keys → 400; with them it works", async () => {
    const s = await scopeOf("admin");
    const v = taskViewer(s);
    for (const field of ["ownerId", "reviewerId"] as const) {
      await expect(createTask(s, v, input({ [field]: user.viewer }))).rejects.toMatchObject({ status: 400, message: `Invalid ${field}` });
    }
    await expect(createTask(s, v, input({ ownerRoleId: role.viewer }))).rejects.toMatchObject({ status: 400 });
    expect((await createTask(s, v, input({ ownerId: user.manager }))).owner?.id).toBe(user.manager);
    expect((await createTask(s, v, input({ ownerRoleId: role.manager }))).ownerRole?.id).toBe(role.manager);
    await expect(assignTasks(s, v, { ids: [task.crm!], ownerId: user.viewer })).rejects.toMatchObject({ status: 400 });
  });

  it("moving a task into CRM re-checks the people it has", async () => {
    const s = await scopeOf("admin");
    const t = await prisma.task.create({ data: { workspaceId: ws, brandId: brand, title: "Move", areas: ["GENERAL"], ownerId: user.viewer } });
    await expect(patchTask(s, taskViewer(s), t.id, { areas: ["CRM"] })).rejects.toMatchObject({ status: 400, message: "Invalid ownerId" });
    await prisma.task.update({ where: { id: t.id }, data: { ownerId: user.manager } });
    expect((await patchTask(s, taskViewer(s), t.id, { areas: ["CRM"] })).areas).toEqual(["CRM"]);
  });

  it("only someone holding a key may put a task in CRM (403)", async () => {
    const s = await scopeOf("lead");
    await expect(createTask(s, taskViewer(s), input({}))).rejects.toMatchObject({ status: 403, code: "task.crmNotAllowed" });
  });
});

describe("crm.manage on built-in roles", () => {
  const dir = join(__dirname, "../../prisma/migrations");
  const migration = readFileSync(join(dir, readdirSync(dir).find((d) => d.endsWith("_crm_manage"))!, "migration.sql"), "utf8");

  it("fresh and migrated workspaces give the same keys; a custom role is untouched; re-run safe", async () => {
    const old = (await prisma.workspace.create({ data: { name: "old", slug: "w-crm-manage-old" } })).id;
    await prisma.role.createMany({ data: SYSTEM_ROLES.map((r) => ({ ...r, workspaceId: old, isSystem: true, permissions: r.permissions.filter((p) => p !== "crm.manage") })) });
    const custom = (await prisma.workspace.create({ data: { name: "custom", slug: "w-crm-manage-custom" } })).id;
    await prisma.role.create({ data: { workspaceId: custom, slug: "manager", name: "Manager", scope: "PROJECT", permissions: ["brand.read"] } });
    await prisma.$executeRaw(Prisma.raw(migration));
    await prisma.$executeRaw(Prisma.raw(migration));
    const rows = await prisma.role.findMany({ where: { workspaceId: old } });
    for (const r of SYSTEM_ROLES) {
      const stored = rows.find((x) => x.slug === r.slug)!.permissions;
      expect(new Set(stored).size, r.slug).toBe(stored.length);
      expect([...stored].sort(), r.slug).toEqual([...r.permissions].sort());
    }
    expect(rows.find((r) => r.slug === "manager")!.permissions).toContain("crm.manage");
    expect((await prisma.role.findFirstOrThrow({ where: { workspaceId: custom, slug: "manager" } })).permissions).toEqual(["brand.read"]);
  });
});
