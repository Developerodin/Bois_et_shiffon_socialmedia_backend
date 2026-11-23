import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// notifications/list.ts also holds route helpers whose auth import pulls next-auth (unloadable under vitest).
vi.mock("@/server/auth/request-user", () => ({ requestUserId: vi.fn() }));
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { brandAccess } from "@/server/auth/access";
import { SYSTEM_ROLES } from "@/server/auth/permissions.catalog";
import { countUnread, listNotifications } from "@/server/notifications/list";
import { changeProjectRole } from "@/server/services/project-members";
import { hashToken } from "@/server/auth/tokens";
import { acceptInvitation, previewInvitation } from "@/server/services/accounts";
import { provisionGoogleUser } from "@/server/services/google-signup";
import { changeMemberRole, createRole, deleteRole, updateRole } from "@/server/services/workspace-admin";
import { taskViewer, visibleTaskSql, visibleTasksAcrossSql } from "@/server/tasks/access";
import { runTaskAction } from "@/server/tasks/actions";
import { assignTasks } from "@/server/tasks/assign";
import { listTasks } from "@/server/tasks/list";
import { listProjects } from "@/server/tasks/projects";
import { createTask, getTask, patchTask } from "@/server/tasks/service";

/**
 * Tasks: admins (tasks.all) see and assign every task; everyone else sees their own; a task can be owned by a role.
 * One workspace with the real built-in roles (SYSTEM_ROLES, as a new workspace gets them), one brand. The Admin row's
 * stored permissions are emptied on purpose (a drifted copy): Admin reads its permissions from code.
 * People: admin (workspace Admin), cy and cid (Creator grants), max (Manager grant), vi (Viewer grant), and cus, whose
 * custom workspace role reads every brand's tasks without tasks.all.
 */
let ws: string;
let brand: string;
const role: Record<string, string> = {};
const user: Record<string, string> = {};
const task: Record<string, string> = {};

const ids = async (where: Prisma.Sql) => (await prisma.$queryRaw<{ id: string }[]>`SELECT t.id FROM "Task" t WHERE ${where}`).map((r) => r.id).sort();
async function scopeOf(who: string) {
  const { perms, clientReviewer } = await brandAccess(ws, brand, user[who]!);
  return { userId: user[who]!, workspaceId: ws, brandId: brand, perms, clientReviewer };
}
const seen = async (who: string) => {
  const s = await scopeOf(who);
  return ids(visibleTaskSql(taskViewer(s)));
};
const named = (...keys: string[]) => keys.map((k) => task[k]!).sort();

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-task-assignment" } })).id;
  brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "B" } })).id;
  await prisma.role.createMany({ data: SYSTEM_ROLES.map((r) => ({ ...r, workspaceId: ws, isSystem: true })) });
  for (const r of await prisma.role.findMany({ where: { workspaceId: ws } })) role[r.slug] = r.id;
  await prisma.role.update({ where: { id: role.admin }, data: { permissions: [] } });
  role.custom = (await prisma.role.create({ data: { workspaceId: ws, slug: "lead", name: "Lead", permissions: ["brand.read", "tasks.read", "members.manage", "members.read"] } })).id;
  for (const n of ["admin", "cy", "cid", "max", "vi", "cus"]) user[n] = (await prisma.user.create({ data: { email: `${n}@task-assignment.test`, name: n } })).id;
  const wsRole = { admin: "admin", cus: "custom" } as Record<string, string>;
  await prisma.workspaceMember.createMany({ data: Object.keys(user).map((n) => ({ workspaceId: ws, userId: user[n]!, roleId: role[wsRole[n] ?? "member"]! })) });
  await prisma.brandMember.createMany({
    data: [
      ["cy", "creator"], ["cid", "creator"], ["max", "manager"], ["vi", "viewer"],
    ].map(([n, r]) => ({ workspaceId: ws, brandId: brand, userId: user[n!]!, roleId: role[r!]! })),
  });
  const make = async (key: string, data: Partial<Prisma.TaskUncheckedCreateInput>) => {
    task[key] = (await prisma.task.create({ data: { workspaceId: ws, brandId: brand, title: key, ...data } })).id;
  };
  await make("own", { ownerId: user.cy });
  await make("role", { ownerRoleId: role.creator });
  await make("reviews", { ownerId: user.max, reviewerId: user.cy });
  await make("waits", { ownerId: user.max, blockedReason: "Needs copy", blockedOnId: user.cy });
  await make("made", { ownerId: user.max, createdById: user.cy });
  await make("others", { ownerId: user.max });
  await make("unassigned", {});
});

describe("who sees which task", () => {
  it("a creator sees what they own, their role owns, they review, unblock or made; not others' or unassigned ones", async () => {
    expect(await seen("cy")).toEqual(named("own", "role", "reviews", "waits", "made"));
  });

  it("an Admin sees every task, though its stored permissions are empty (Admin reads its permissions from code)", async () => {
    expect(await seen("admin")).toEqual(named("own", "role", "reviews", "waits", "made", "others", "unassigned"));
  });

  it("a manager sees only their own; a viewer, with nothing of theirs, sees nothing", async () => {
    expect(await seen("max")).toEqual(named("reviews", "waits", "made", "others"));
    expect(await seen("vi")).toEqual([]);
  });

  it("the notification form across brands matches the per-brand form, also for a custom workspace role without tasks.all", async () => {
    for (const who of ["cy", "admin", "max", "vi", "cus"]) expect(await ids(await visibleTasksAcrossSql(user[who]!, ws))).toEqual(await seen(who));
    expect(await seen("cus")).toEqual([]);
  });

  it("mine has the role's task for every holder until someone takes it", async () => {
    for (const who of ["cy", "cid"]) {
      const s = await scopeOf(who);
      expect((await listTasks(s, taskViewer(s), { view: "mine" })).tasks.map((t) => t.id)).toContain(task.role);
    }
    const s = await scopeOf("cy");
    const [dto] = (await listTasks(s, taskViewer(s), { view: "mine" })).tasks.filter((t) => t.id === task.role);
    expect(dto).toMatchObject({ owner: null, ownerRole: { id: role.creator, name: "Creator" } });
    expect(dto!.actions).toContain("take");
  });

  it("project progress counts only the viewer's visible tasks", async () => {
    const p = await prisma.workProject.create({ data: { workspaceId: ws, brandId: brand, name: "Launch" } });
    await prisma.task.createMany({ data: [user.cy, user.max, null].map((ownerId, i) => ({ workspaceId: ws, brandId: brand, title: `p${i}`, ownerId, workProjectId: p.id })) });
    const progress = async (who: string) => {
      const s = await scopeOf(who);
      return (await listProjects(s, taskViewer(s), {})).projects.find((x) => x.id === p.id)!.progress;
    };
    expect(await progress("cy")).toEqual({ done: 0, total: 1 });
    expect(await progress("admin")).toEqual({ done: 0, total: 3 });
    await prisma.task.deleteMany({ where: { workProjectId: p.id } });
  });
});

describe("assigning", () => {
  it("a task can't have a person and a role (CHECK task_one_owner)", async () => {
    await expect(prisma.task.create({ data: { workspaceId: ws, brandId: brand, title: "x", ownerId: user.cy, ownerRoleId: role.creator } })).rejects.toThrow();
  });

  it("an admin gives a task to a role: every holder is told and sees it; the client role and Admin are refused", async () => {
    const s = await scopeOf("admin");
    const dto = await createTask(s, taskViewer(s), { title: "For creators", areas: ["CONTENT"], priority: "NORMAL", ownerRoleId: role.creator });
    expect(dto).toMatchObject({ owner: null, ownerRole: { id: role.creator } });
    const told = await prisma.notification.findMany({ where: { taskId: dto.id, kind: "TASK_ASSIGNED" }, select: { userId: true } });
    expect(told.map((n) => n.userId).sort()).toEqual([user.cid, user.cy].sort());
    expect((await listNotifications(user.cid!, ws)).notifications.map((n) => n.taskId)).toContain(dto.id);
    for (const bad of [role["client-reviewer"], role.admin]) {
      await expect(createTask(s, taskViewer(s), { title: "x", areas: ["CONTENT"], priority: "NORMAL", ownerRoleId: bad })).rejects.toMatchObject({ status: 400 });
    }
    task.forCreators = dto.id;
  });

  it("take: the first holder gets it, the other gets 409 task.taken and loses sight of it and its notice", async () => {
    const before = await countUnread(user.cid!, ws);
    const cy = await scopeOf("cy");
    const taken = await runTaskAction(cy, taskViewer(cy), task.forCreators!, { action: "take" });
    expect(taken).toMatchObject({ owner: { id: user.cy }, ownerRole: null });
    const cid = await scopeOf("cid");
    await expect(runTaskAction(cid, taskViewer(cid), task.forCreators!, { action: "take" })).rejects.toMatchObject({ status: 409, code: "task.taken" });
    await expect(getTask(cid, taskViewer(cid), task.forCreators!)).rejects.toMatchObject({ status: 404 });
    expect(await countUnread(user.cid!, ws)).toBe(before - 1);
  });

  it("without tasks.all: no giving tasks to others or roles, no editing others' tasks, no bulk assign", async () => {
    const max = await scopeOf("max");
    const v = taskViewer(max);
    await expect(createTask(max, v, { title: "x", areas: ["CONTENT"], priority: "NORMAL", ownerId: user.cy })).rejects.toMatchObject({ status: 403 });
    // A task they only review: they see it but can't edit it.
    const reviewing = (await prisma.task.create({ data: { workspaceId: ws, brandId: brand, title: "Max reviews", ownerId: user.cy, reviewerId: user.max } })).id;
    await expect(patchTask(max, v, reviewing, { title: "Renamed" })).rejects.toMatchObject({ status: 403 });
    await expect(assignTasks(max, v, { ids: [task.others!], ownerId: user.cy })).rejects.toMatchObject({ status: 403 });
    // Their own task: fine, to themselves or nobody.
    await patchTask(max, v, task.others!, { title: "Mine still" });
  });

  it("bulk assign: all visible or 404, closed ones skipped, one notice per task, in-review clash names the task", async () => {
    const s = await scopeOf("admin");
    const v = taskViewer(s);
    const done = (await prisma.task.create({ data: { workspaceId: ws, brandId: brand, title: "Done", status: "DONE", completedAt: new Date() } })).id;
    await expect(assignTasks(s, v, { ids: [task.unassigned!, "nope"], ownerId: user.cy })).rejects.toMatchObject({ status: 404 });
    const out = await assignTasks(s, v, { ids: [task.unassigned!, task.others!, done], ownerId: user.cid });
    expect(out.tasks.map((t) => t.id).sort()).toEqual(named("unassigned", "others"));
    expect(out.skipped).toBe(1);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: done } })).ownerId).toBeNull();
    expect(await prisma.notification.count({ where: { userId: user.cid, kind: "TASK_ASSIGNED", taskId: { in: [task.unassigned!, task.others!] } } })).toBe(2);
    const toRole = await assignTasks(s, v, { ids: [task.unassigned!], ownerRoleId: role.creator });
    expect(toRole.tasks[0]).toMatchObject({ owner: null, ownerRole: { id: role.creator } });
    const inReview = (await prisma.task.create({ data: { workspaceId: ws, brandId: brand, title: "Checked by Cy", status: "IN_REVIEW", ownerId: user.max, reviewerId: user.cy } })).id;
    await expect(assignTasks(s, v, { ids: [task.unassigned!, inReview], ownerId: user.cy })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Checked by Cy") });
    // All or nothing: the first task kept its role.
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.unassigned! } })).ownerRoleId).toBe(role.creator);
  });

  it("a role with open tasks can't be deleted", async () => {
    const temp = await prisma.role.create({ data: { workspaceId: ws, slug: "temp", name: "Temp", scope: "PROJECT", permissions: ["brand.read", "tasks.read"] } });
    await prisma.task.create({ data: { workspaceId: ws, brandId: brand, title: "Temp's", ownerRoleId: temp.id } });
    await expect(deleteRole(ws, user.admin!, temp.id)).rejects.toMatchObject({ status: 409 });
  });
});

describe("roles", () => {
  it("an owner's stored edit of a built-in Creator is honoured; an edit of Admin is ignored", async () => {
    await prisma.role.update({ where: { id: role.viewer }, data: { permissions: ["brand.read"] } });
    expect((await scopeOf("vi")).perms.has("tasks.read")).toBe(false);
    await prisma.role.update({ where: { id: role.viewer }, data: { permissions: SYSTEM_ROLES.find((r) => r.slug === "viewer")!.permissions } });
    expect((await scopeOf("admin")).perms.has("tasks.all")).toBe(true);
  });

  it("no giving a role with permissions you don't have; owners never blocked", async () => {
    // A Manager allowed to manage project members can make someone Creator, not Project admin.
    await prisma.role.update({ where: { id: role.manager }, data: { permissions: [...SYSTEM_ROLES.find((r) => r.slug === "manager")!.permissions, "project.members.manage"] } });
    const grant = (await prisma.brandMember.findFirstOrThrow({ where: { brandId: brand, userId: user.vi } })).id;
    const give = (roleId: string) => changeProjectRole({ workspaceId: ws, brandId: brand, actorUserId: user.max!, grantId: grant, roleId });
    await expect(give(role["project-admin"]!)).rejects.toMatchObject({ status: 403, message: "You can't give a role with permissions you don't have" });
    await give(role.creator!);
    await give(role.viewer!);
    // An Admin may make someone Admin; a custom role with members.manage may not.
    const member = (who: string) => prisma.workspaceMember.findFirstOrThrow({ where: { workspaceId: ws, userId: user[who] } }).then((m) => m.id);
    await changeMemberRole(ws, user.admin!, await member("vi"), role.admin!);
    await changeMemberRole(ws, user.admin!, await member("vi"), role.member!);
    await expect(changeMemberRole(ws, user.cus!, await member("vi"), role.admin!)).rejects.toMatchObject({ status: 403 });
  });

  it("a non-owner shapes roles only with permissions they hold, and never a role they hold", async () => {
    const shape = { name: "Helper", scope: "WORKSPACE" as const };
    await expect(createRole(ws, user.cus!, { ...shape, permissions: ["brand.read", "tasks.all"] })).rejects.toMatchObject({ status: 403 });
    const made = await createRole(ws, user.cus!, { ...shape, permissions: ["brand.read", "tasks.read"] });
    await expect(updateRole(ws, user.cus!, made.id, { permissions: ["brand.read", "tasks.manage"] })).rejects.toMatchObject({ status: 403 });
    await expect(updateRole(ws, user.cus!, role.custom!, { permissions: ["brand.read", "tasks.read"] })).rejects.toMatchObject({ status: 403, message: "You can't change a role you hold" });
  });

  it("an invitation stops working once its inviter could no longer give its role, or has left", async () => {
    const gone = (await prisma.user.create({ data: { email: "gone@task-assignment.test" } })).id;
    const invite = (email: string, roleId: string, invitedByUserId: string) =>
      prisma.invitation.create({ data: { workspaceId: ws, email, roleId, invitedByUserId, tokenHash: hashToken(email), expiresAt: new Date(Date.now() + 86_400_000) } });
    const refused = { status: 409, message: "This invitation is no longer valid. Ask for a new one." };
    await invite("raised@task-assignment.test", role.admin!, user.cus!);
    await expect(acceptInvitation({ token: "raised@task-assignment.test", password: "a-long-password-1" })).rejects.toMatchObject(refused);
    // The invite page says so before the person picks a password.
    await expect(previewInvitation("raised@task-assignment.test")).rejects.toMatchObject(refused);
    await invite("left@task-assignment.test", role.member!, gone);
    await expect(acceptInvitation({ token: "left@task-assignment.test", password: "a-long-password-1" })).rejects.toMatchObject(refused);
    await invite("fine@task-assignment.test", role.member!, user.admin!);
    expect(await acceptInvitation({ token: "fine@task-assignment.test", password: "a-long-password-1" })).toMatchObject({ workspaceId: ws });
  });

  it("Google sign-up accepts only the invitations whose inviter could still give the role", async () => {
    const gone = (await prisma.user.create({ data: { email: "gone-g@task-assignment.test" } })).id;
    const email = "google@task-assignment.test";
    const invite = (roleId: string, invitedByUserId: string, tokenHash: string) =>
      prisma.invitation.create({ data: { workspaceId: ws, email, roleId, invitedByUserId, tokenHash, expiresAt: new Date(Date.now() + 86_400_000) } });
    const stale = await invite(role.member!, gone, "h-g-stale");
    const fine = await invite(role.member!, user.admin!, "h-g-fine");
    const g = await prisma.user.create({ data: { email, name: "G" } });
    expect((await provisionGoogleUser(g)).joined).toBe(1);
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: fine.id } })).acceptedAt).not.toBeNull();
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: stale.id } })).acceptedAt).toBeNull();
  });

  it("the migration moves Commercial owner holders, invitations and tasks to Manager and drops the role", async () => {
    const co = await prisma.role.create({ data: { workspaceId: ws, slug: "commercial-owner", name: "Commercial owner", isSystem: true, scope: "PROJECT", permissions: ["brand.read", "commercial.manage"] } });
    const merchant = (await prisma.user.create({ data: { email: "merchant@task-assignment.test" } })).id;
    await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: merchant, roleId: role.member! } });
    await prisma.brandMember.create({ data: { workspaceId: ws, brandId: brand, userId: merchant, roleId: co.id } });
    const invite = await prisma.invitation.create({ data: { workspaceId: ws, brandId: brand, email: "new@task-assignment.test", roleId: co.id, tokenHash: "h-co", expiresAt: new Date(Date.now() + 86_400_000) } });
    const t = await prisma.task.create({ data: { workspaceId: ws, brandId: brand, title: "Offer", ownerRoleId: co.id } });
    const dir = join(__dirname, "../../prisma/migrations");
    const sql = readFileSync(join(dir, readdirSync(dir).find((d) => d.endsWith("_task_owner_role"))!, "migration.sql"), "utf8");
    const merge = sql.slice(sql.indexOf("-- Commercial owner merges into Manager"));
    for (const statement of merge.split(/;\s*\n/).map((x) => x.replace(/^--.*$/gm, "").trim()).filter(Boolean)) await prisma.$executeRawUnsafe(statement);
    expect((await prisma.brandMember.findFirstOrThrow({ where: { userId: merchant } })).roleId).toBe(role.manager);
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: invite.id } })).roleId).toBe(role.manager);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).ownerRoleId).toBe(role.manager);
    expect(await prisma.role.findUnique({ where: { id: co.id } })).toBeNull();
  });
});
