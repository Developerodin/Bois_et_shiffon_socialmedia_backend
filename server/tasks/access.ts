import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { brandMemberPerms, CLIENT_GRANT_WHERE, type Db, hasOtherHolder, isClientGrant, isClientMember, memberRole } from "@/server/auth/permissions";
import { CLIENT_REVIEWER, type PermissionKey } from "@/server/auth/permissions.catalog";
import { lockRow } from "@/server/services/publishing";
import { TaskError } from "@/server/tasks/errors";

/** Who is looking at a brand's tasks, from the route scope already loaded (no extra read). */
export type TaskViewer = { userId: string; workspaceId: string; brandId: string; canRead: boolean; canManage: boolean; client: boolean };

export function taskViewer(scope: { userId: string; workspaceId: string; brandId: string; perms: Set<PermissionKey>; clientReviewer: boolean }): TaskViewer {
  return {
    userId: scope.userId,
    workspaceId: scope.workspaceId,
    brandId: scope.brandId,
    canRead: scope.perms.has("tasks.read"),
    canManage: scope.perms.has("tasks.manage"),
    client: scope.clientReviewer,
  };
}

/** A table alias for raw SQL: a plain identifier only, since it is spliced in as text. */
function ref(alias: string) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`Bad SQL alias: ${alias}`);
  return Prisma.raw(alias);
}

/**
 * THE client-visible rule: a client sees a task they review, or one in a project of the same brand shared with the
 * client. clientClause is it in SQL, clientSees with Prisma; they change together.
 */
const clientClause = (userId: string, a: Prisma.Sql) =>
  Prisma.sql`(${a}."reviewerId" = ${userId} OR EXISTS (SELECT 1 FROM "WorkProject" p WHERE p.id = ${a}."workProjectId" AND p."brandId" = ${a}."brandId" AND p."clientVisible"))`;

type BrandScope = { workspaceId: string; brandId: string };
type TaskPeople = { reviewerId: string | null; workProjectId: string | null };

/** Is the task in a project of this brand that is shared with the client? */
async function inSharedProject(db: Db, scope: BrandScope, workProjectId: string | null): Promise<boolean> {
  if (!workProjectId) return false;
  return !!(await db.workProject.findFirst({ where: { id: workProjectId, workspaceId: scope.workspaceId, brandId: scope.brandId, clientVisible: true }, select: { id: true } }));
}

/** clientClause for one client and one task (as it is, or as it will be after a change). */
const clientSees = async (db: Db, scope: BrandScope, clientId: string, task: TaskPeople) => task.reviewerId === clientId || inSharedProject(db, scope, task.workProjectId);

/** The person's client grant on this brand (with its permissions) when they are a client there (isClientMember), else null. */
async function clientGrantOn(db: Db, scope: BrandScope, userId: string) {
  const [grant, approves] = await Promise.all([
    db.brandMember.findFirst({
      where: { workspaceId: scope.workspaceId, brandId: scope.brandId, userId, role: CLIENT_GRANT_WHERE, user: { status: "ACTIVE", deletedAt: null } },
      select: { role: { select: { permissions: true } } },
    }),
    db.workspaceMember.findFirst({ where: { workspaceId: scope.workspaceId, userId, roleRef: { permissions: { has: "content.approve" } } }, select: { id: true } }),
  ]);
  return isClientMember(!!grant, approves ? ["content.approve"] : []) ? grant : null;
}

/** Is `userId` a client on this brand (isClientMember: a client grant here, no content.approve from the workspace role)? */
export async function isClientOn(db: Db, scope: BrandScope, userId: string): Promise<boolean> {
  return !!(await clientGrantOn(db, scope, userId));
}

/** isClientMember in SQL, for user/brand/workspace id expressions (the notification actor). */
export const clientMemberSql = (user: Prisma.Sql, brand: Prisma.Sql, workspace: Prisma.Sql) => Prisma.sql`(EXISTS (
    SELECT 1 FROM "BrandMember" cm JOIN "Role" cr ON cr.id = cm."roleId"
    WHERE cm."brandId" = ${brand} AND cm."userId" = ${user} AND cr."isSystem" AND cr.slug = ${CLIENT_REVIEWER})
  AND NOT EXISTS (
    SELECT 1 FROM "WorkspaceMember" cw JOIN "Role" cwr ON cwr.id = cw."roleId"
    WHERE cw."workspaceId" = ${workspace} AND cw."userId" = ${user} AND 'content.approve' = ANY(cwr.permissions)))`;

/** Can some client see the task (spec §6): its project is shared with the client, or its reviewer is a client? */
export async function clientCanSee(db: Db, scope: BrandScope, t: TaskPeople): Promise<boolean> {
  const [shared, reviewer] = await Promise.all([inSharedProject(db, scope, t.workProjectId), t.reviewerId ? isClientOn(db, scope, t.reviewerId) : false]);
  return shared || reviewer;
}

/**
 * THE definition of which tasks a person sees on one brand, as a SQL condition on the Task row `alias`. Every task read
 * (lists, search, comments, attachments, notifications, counts) builds on it or on visibleTasksAcrossSql below.
 */
export function visibleTaskSql(v: TaskViewer, alias = "t"): Prisma.Sql {
  if (!v.canRead) return Prisma.sql`FALSE`;
  const a = ref(alias);
  const brand = Prisma.sql`${a}."workspaceId" = ${v.workspaceId} AND ${a}."brandId" = ${v.brandId}`;
  return v.client ? Prisma.sql`(${brand} AND ${clientClause(v.userId, a)})` : Prisma.sql`(${brand})`;
}

/**
 * visibleTaskSql over every brand of the workspace at once (notifications): reads the person's role and project grants
 * once, then decides per brand as brandAccess + taskViewer would (brand.read and tasks.read from role ∪ grant; a
 * client-reviewer grant without content.approve from the workspace role makes them a client there, isClientMember).
 * Archived brands are left out, as brandAccess refuses them.
 */
export async function visibleTasksAcrossSql(userId: string, workspaceId: string, alias = "t"): Promise<Prisma.Sql> {
  const a = ref(alias);
  const [found, grants] = await Promise.all([
    memberRole(workspaceId, userId),
    prisma.brandMember.findMany({ where: { workspaceId, userId }, select: { brandId: true, role: { select: { isSystem: true, slug: true, permissions: true } } } }),
  ]);
  if (!found?.role) return Prisma.sql`FALSE`;
  const own = found.role.permissions;
  const reads = (perms: string[]) => perms.includes("brand.read") && perms.includes("tasks.read");
  const staff: string[] = [];
  const client: string[] = [];
  for (const g of grants) {
    const perms = [...own, ...g.role.permissions];
    if (isClientMember(isClientGrant(g.role), own)) {
      if (reads(perms)) client.push(g.brandId);
    } else if (reads(perms)) staff.push(g.brandId);
  }
  const anyOf = (ids: string[]) => (ids.length ? Prisma.sql`${a}."brandId" IN (${Prisma.join(ids)})` : Prisma.sql`FALSE`);
  // The workspace role alone reaches every brand (Owner/Admin), except where a client grant makes them a client.
  const staffSql = reads(own)
    ? client.length ? Prisma.sql`${a}."brandId" NOT IN (${Prisma.join(client)})` : Prisma.sql`TRUE`
    : anyOf(staff);
  const live = Prisma.sql`EXISTS (SELECT 1 FROM "Brand" b WHERE b.id = ${a}."brandId" AND b."workspaceId" = ${workspaceId} AND b.status <> 'ARCHIVED')`;
  return Prisma.sql`(${a}."workspaceId" = ${workspaceId} AND ${live} AND (${staffSql} OR (${anyOf(client)} AND ${clientClause(userId, a)})))`;
}

/** The task if this viewer may see it, else null (callers answer 404). Every route on a task or its children starts here. */
export async function findVisibleTask(tx: Db, v: TaskViewer, id: string): Promise<{ id: string } | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT t.id FROM "Task" t WHERE t.id = ${id} AND ${visibleTaskSql(v)}`;
  return rows[0] ?? null;
}

/**
 * Start a write to a task's children (checklist, attachments): 404 unless the viewer sees it, then the task lock, then
 * owner or tasks.manage (403). `ownerNeeds`: a key the owner must also hold (attachments need content.create).
 * Returns the task's title for the audit event.
 */
export async function lockTaskForEdit(tx: Prisma.TransactionClient, v: TaskViewer, perms: Set<PermissionKey>, taskId: string, ownerNeeds?: PermissionKey): Promise<{ title: string }> {
  if (!(await findVisibleTask(tx, v, taskId))) throw new TaskError("Task not found", 404);
  await lockRow(tx, "task", taskId);
  const task = await tx.task.findUnique({ where: { id: taskId }, select: { title: true, ownerId: true } });
  if (!task) throw new TaskError("Task not found", 404);
  const owner = task.ownerId === v.userId && (!ownerNeeds || perms.has(ownerNeeds));
  if (!v.canManage && !owner) throw new TaskError("Only the task's owner or a manager can change this.", 403);
  return { title: task.title };
}

/** Comments a viewer may read: a client never sees internal ones. */
export function commentVisibility(v: TaskViewer): Prisma.TaskCommentWhereInput {
  return v.client ? { internal: false } : {};
}

/** Nobody else on the brand reads tasks as staff (client reviewers don't count), so no four-eyes rule can apply. */
export async function isSoleStaff(workspaceId: string, brandId: string, userId: string) {
  return !(await hasOtherHolder(workspaceId, brandId, userId, "tasks.read"));
}

/**
 * May `userId` be owner, reviewer or blocked-on of this task? They must see it: tasks.read as staff, or as a client
 * (isClientOn) with tasks.read on a task that is client-visible to them (they review it, or its project is shared).
 * Pass `task` as it will be AFTER the proposed change (e.g. `reviewerId: proposed`, the new `workProjectId`), so a client
 * made reviewer of a task counts it as theirs, and moving a task out of a shared project is checked against the new one.
 */
export async function canBeAssigned(tx: Db, scope: BrandScope, userId: string, task: TaskPeople): Promise<boolean> {
  // brandMemberPerms: the workspace role or a non-client grant (a brand has one grant per person).
  const [client, staffReads] = await Promise.all([clientGrantOn(tx, scope, userId), brandMemberPerms(tx, scope, userId, "tasks.read")]);
  if (!client) return staffReads;
  if (!staffReads && !client.role.permissions.includes("tasks.read")) return false;
  return clientSees(tx, scope, userId, task);
}
