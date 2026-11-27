import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { AD_ALERT_KEYS, SEO_ALERT_KEYS, brandMemberPerms, CLIENT_GRANT_WHERE, type Db, hasOtherHolder, holdsAll, isClientGrant, isClientMember, memberRole } from "@/server/auth/permissions";
import { CLIENT_REVIEWER, rolePermissions, type PermissionKey } from "@/server/auth/permissions.catalog";
import { CRM_TASK_KEYS } from "@/shared";
import { lockRow } from "@/server/services/publishing";
import { TaskError } from "@/server/tasks/errors";

/**
 * Who is looking at a brand's tasks, from the route scope already loaded (no extra read). `all` (tasks.all, staff only):
 * sees every task; without it a person sees only their own (ownClause). `crm` (handlesCustomers): sees CRM-area tasks.
 */
export type TaskViewer = { userId: string; workspaceId: string; brandId: string; canRead: boolean; canManage: boolean; all: boolean; client: boolean; crm: boolean };

/** Holds a CRM_TASK_KEYS key: may see CRM-area tasks and be given one. Clients too, when the matrix gives them a key. */
export const handlesCustomers = (perms: { has(k: PermissionKey): boolean } | readonly string[]) =>
  CRM_TASK_KEYS.some((k) => ("has" in perms ? perms.has(k) : perms.includes(k)));

/** tasks.all as it counts: a client reviewer never sees every task, whatever their roles hold. */
export const seesAllTasks = (scope: { perms: Set<PermissionKey>; clientReviewer?: boolean }) => scope.perms.has("tasks.all") && !scope.clientReviewer;

export function taskViewer(scope: { userId: string; workspaceId: string; brandId: string; perms: Set<PermissionKey>; clientReviewer: boolean }): TaskViewer {
  return {
    userId: scope.userId,
    workspaceId: scope.workspaceId,
    brandId: scope.brandId,
    canRead: scope.perms.has("tasks.read"),
    canManage: scope.perms.has("tasks.manage"),
    all: seesAllTasks(scope),
    client: scope.clientReviewer,
    crm: handlesCustomers(scope.perms),
  };
}

/**
 * May this person edit the task and run its manager actions: tasks.manage always, and then tasks.all or a task they own
 * or created (a role's task is taken first). actorRole, patchTask and lockTaskForEdit share it.
 */
export const managesTask = (scope: { userId: string; perms: Set<PermissionKey>; clientReviewer?: boolean }, t: { ownerId: string | null; createdById: string | null }) =>
  scope.perms.has("tasks.manage") && (seesAllTasks(scope) || t.ownerId === scope.userId || t.createdById === scope.userId);

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
/** `areas`: the task's areas (after the change); a CRM task needs a CRM_TASK_KEYS key too. */
type TaskPeople = { reviewerId: string | null; workProjectId: string | null; areas?: readonly string[] };

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
      select: { role: { select: { isSystem: true, slug: true, permissions: true } } },
    }),
    // ponytail: reads the stored copy of the workspace role on purpose (a DB filter); the role-reset migration keeps
    // Owner/Admin rows equal to code, and a later change to those two needs a migration (permissions.catalog.ts).
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
    WHERE cw."workspaceId" = ${workspace} AND cw."userId" = ${user} AND 'content.approve' = ANY(cwr.permissions)))`; // ponytail: stored copy, as isClientMember

/** Can some client see the task (spec §6): its project is shared with the client, or its reviewer is a client? */
export async function clientCanSee(db: Db, scope: BrandScope, t: TaskPeople): Promise<boolean> {
  const [shared, reviewer] = await Promise.all([inSharedProject(db, scope, t.workProjectId), t.reviewerId ? isClientOn(db, scope, t.reviewerId) : false]);
  return shared || reviewer;
}

/**
 * The task is `userId`'s to do: they own it, or a project role they hold on its brand does. The mine view and Today's
 * mine group use it as is; ownClause adds the other ways a task concerns someone.
 */
export const ownedBySql = (userId: string, alias = "t") => ownedBy(userId, ref(alias));
const ownedBy = (userId: string, a: Prisma.Sql) =>
  Prisma.sql`(${a}."ownerId" = ${userId} OR (${a}."ownerRoleId" IS NOT NULL AND EXISTS (SELECT 1 FROM "BrandMember" bm WHERE bm."brandId" = ${a}."brandId" AND bm."userId" = ${userId} AND bm."roleId" = ${a}."ownerRoleId")))`;

/**
 * THE staff rule without tasks.all: the task is theirs (ownedBySql), they review it, it waits on them, or they created
 * it. Unassigned tasks nobody created (SEO and GEO audit tasks) are seen only with tasks.all.
 */
const ownClause = (userId: string, a: Prisma.Sql) =>
  Prisma.sql`(${ownedBy(userId, a)} OR ${a}."reviewerId" = ${userId} OR ${a}."blockedOnId" = ${userId} OR ${a}."createdById" = ${userId})`;

/** The CRM-area rule: without a CRM_TASK_KEYS key on the brand, a CRM task is hidden whatever else would show it. */
const notCrm = (a: Prisma.Sql) => Prisma.sql`NOT ('CRM' = ANY(${a}.areas))`;

/**
 * THE definition of which tasks a person sees on one brand, as a SQL condition on the Task row `alias`. Every task read
 * (lists, search, comments, attachments, counts) builds on it; the bell builds on tasksAcrossSql below, the same rule
 * over every brand at once, through visibleNotificationsSql.
 * tasks.all: the whole brand; a client: clientClause; other staff: ownClause. On top, CRM tasks only with v.crm.
 */
export function visibleTaskSql(v: TaskViewer, alias = "t"): Prisma.Sql {
  if (!v.canRead) return Prisma.sql`FALSE`;
  const a = ref(alias);
  const brand = v.crm
    ? Prisma.sql`${a}."workspaceId" = ${v.workspaceId} AND ${a}."brandId" = ${v.brandId}`
    : Prisma.sql`${a}."workspaceId" = ${v.workspaceId} AND ${a}."brandId" = ${v.brandId} AND ${notCrm(a)}`;
  if (v.client) return Prisma.sql`(${brand} AND ${clientClause(v.userId, a)})`;
  return v.all ? Prisma.sql`(${brand})` : Prisma.sql`(${brand} AND ${ownClause(v.userId, a)})`;
}

/**
 * tasksAcrossSql from a fresh memberAccess: only the tests call it (the bell reads tasksAcrossSql through
 * visibleNotificationsSql, sharing one memberAccess with its ads branch).
 */
export async function visibleTasksAcrossSql(userId: string, workspaceId: string, alias = "t"): Promise<Prisma.Sql> {
  return tasksAcrossSql(await memberAccess(workspaceId, userId), userId, workspaceId, alias);
}

/**
 * The person's workspace role and every project grant (with its role) in one workspace: two queries, read once per
 * bell read or digest. The bell's task and ads branches and the digest's readerAccess build on it.
 */
export async function memberAccess(workspaceId: string, userId: string) {
  const [found, grants] = await Promise.all([
    memberRole(workspaceId, userId),
    prisma.brandMember.findMany({ where: { workspaceId, userId }, select: { brandId: true, role: { select: { isSystem: true, slug: true, permissions: true } } } }),
  ]);
  return { found, grants };
}
type MemberAccess = Awaited<ReturnType<typeof memberAccess>>;

/** The brand is in the workspace and not archived (brandAccess refuses archived brands). */
const liveBrand = (a: Prisma.Sql, workspaceId: string) =>
  Prisma.sql`EXISTS (SELECT 1 FROM "Brand" b WHERE b.id = ${a}."brandId" AND b."workspaceId" = ${workspaceId} AND b.status <> 'ARCHIVED')`;

/**
 * The brands on which someone holds every one of `keys` (role ∪ grant, workspace role required, holdsAll), as a SQL
 * condition on the notice's brand: TRUE when their workspace role alone does, else the granted brands that do.
 */
function alertBrandsSql(own: string[] | null, access: MemberAccess, keys: readonly PermissionKey[]): Prisma.Sql {
  const n = ref("n");
  if (!own) return Prisma.sql`FALSE`;
  if (holdsAll(own, [], keys)) return Prisma.sql`TRUE`;
  const ids = access.grants.filter((g) => holdsAll(own, rolePermissions(g.role), keys)).map((g) => g.brandId);
  return ids.length ? Prisma.sql`${n}."brandId" IN (${Prisma.join(ids)})` : Prisma.sql`FALSE`;
}

/**
 * Which notifications a person sees in one workspace, as a SQL condition on Notification `n` LEFT JOIN Task `t`, from
 * one memberAccess: a task notice while they can still see its task (tasksAcrossSql's rule), an AD_ALERT notice
 * while they hold brand.read and ads.read on its brand, a SEO_ALERT notice while they hold brand.read and
 * analytics.read on it (role ∪ grant, workspace role required, holdsAll), the brand not archived.
 */
export async function visibleNotificationsSql(userId: string, workspaceId: string): Promise<Prisma.Sql> {
  const access = await memberAccess(workspaceId, userId);
  const tasks = tasksAcrossSql(access, userId, workspaceId, "t");
  const own = access.found?.role ? rolePermissions(access.found.role) : null;
  const n = ref("n");
  // The alert branches are on n: t is NULL for these rows under the LEFT JOIN.
  const ads = Prisma.sql`(n.kind = 'AD_ALERT' AND n."adAlertId" IS NOT NULL AND ${alertBrandsSql(own, access, AD_ALERT_KEYS)} AND ${liveBrand(n, workspaceId)})`;
  const seo = Prisma.sql`(n.kind = 'SEO_ALERT' AND n."seoAlertId" IS NOT NULL AND ${alertBrandsSql(own, access, SEO_ALERT_KEYS)} AND ${liveBrand(n, workspaceId)})`;
  return Prisma.sql`((n."taskId" IS NOT NULL AND ${tasks}) OR ${ads} OR ${seo})`;
}

/**
 * visibleTaskSql over every brand of the workspace at once, from one memberAccess: decides per brand as brandAccess +
 * taskViewer would (brand.read and tasks.read from role ∪ grant; a client-reviewer grant without content.approve from
 * the workspace role makes them a client there, isClientMember; tasks.all from role ∪ grant, ignored for a client; CRM
 * tasks where role ∪ grant handlesCustomers). Archived brands are left out, as brandAccess refuses them.
 */
function tasksAcrossSql({ found, grants }: MemberAccess, userId: string, workspaceId: string, alias: string): Prisma.Sql {
  const a = ref(alias);
  if (!found?.role) return Prisma.sql`FALSE`;
  const own = rolePermissions(found.role);
  const reads = (perms: string[]) => perms.includes("brand.read") && perms.includes("tasks.read");
  const client: string[] = [];
  const all: string[] = [];
  const mine: string[] = [];
  const crm: string[] = [];
  for (const g of grants) {
    const perms = [...own, ...rolePermissions(g.role)];
    if (handlesCustomers(perms)) crm.push(g.brandId);
    if (isClientMember(isClientGrant(g.role), own)) {
      if (reads(perms)) client.push(g.brandId);
    } else if (reads(perms)) (perms.includes("tasks.all") ? all : mine).push(g.brandId);
  }
  const anyOf = (ids: string[]) => (ids.length ? Prisma.sql`${a}."brandId" IN (${Prisma.join(ids)})` : Prisma.sql`FALSE`);
  const noneOf = (ids: string[]) => (ids.length ? Prisma.sql`${a}."brandId" NOT IN (${Prisma.join(ids)})` : Prisma.sql`TRUE`);
  // The workspace role alone reaches every brand (Owner/Admin), except where a client grant makes them a client; a
  // brand without a grant follows the workspace role's tasks.all.
  const [allSql, mineSql] = !reads(own)
    ? [anyOf(all), anyOf(mine)]
    : own.includes("tasks.all")
      ? [noneOf(client), Prisma.sql`FALSE`]
      : [anyOf(all), noneOf([...client, ...all])];
  const live = liveBrand(a, workspaceId);
  // A key in the workspace role reaches every brand (a grant only adds keys); else only the brands whose grant adds one.
  const crmSql = handlesCustomers(own) ? Prisma.sql`TRUE` : Prisma.sql`(${notCrm(a)} OR ${anyOf(crm)})`;
  return Prisma.sql`(${a}."workspaceId" = ${workspaceId} AND ${live} AND ${crmSql} AND (${allSql} OR (${mineSql} AND ${ownClause(userId, a)}) OR (${anyOf(client)} AND ${clientClause(userId, a)})))`;
}

/** The task if this viewer may see it, else null (callers answer 404). Every route on a task or its children starts here. */
export async function findVisibleTask(tx: Db, v: TaskViewer, id: string): Promise<{ id: string } | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT t.id FROM "Task" t WHERE t.id = ${id} AND ${visibleTaskSql(v)}`;
  return rows[0] ?? null;
}

/**
 * Start a write to a task's children (checklist, attachments): the task lock, then 404 unless the viewer still sees it
 * (a reassignment just before can hide it), then managesTask or the owner (403). `ownerNeeds`: a key the owner must
 * also hold (attachments need content.create). Returns the task's title for the audit event.
 */
export async function lockTaskForEdit(tx: Prisma.TransactionClient, v: TaskViewer, perms: Set<PermissionKey>, taskId: string, ownerNeeds?: PermissionKey): Promise<{ title: string }> {
  await lockRow(tx, "task", taskId);
  if (!(await findVisibleTask(tx, v, taskId))) throw new TaskError("Task not found", 404);
  const task = await tx.task.findUnique({ where: { id: taskId }, select: { title: true, ownerId: true, createdById: true } });
  if (!task) throw new TaskError("Task not found", 404);
  const owner = task.ownerId === v.userId && (!ownerNeeds || perms.has(ownerNeeds));
  if (!managesTask({ userId: v.userId, perms, clientReviewer: v.client }, task) && !owner) throw new TaskError("Only the task's owner, its creator or an admin can change this.", 403);
  return { title: task.title };
}

/** Comments a viewer may read: a client never sees internal ones. */
export function commentVisibility(v: TaskViewer): Prisma.TaskCommentWhereInput {
  return v.client ? { internal: false } : {};
}

/** Who last sent each task for review (from the audit trail); tasks nobody sent are missing. */
export async function lastSubmitters(tx: Db, taskIds: string[]): Promise<Map<string, string | null>> {
  if (!taskIds.length) return new Map();
  const sent = await tx.auditEvent.findMany({
    where: { entityType: "Task", entityId: { in: taskIds }, action: "task.submitForReview" },
    orderBy: [{ entityId: "asc" }, { createdAt: "desc" }, { id: "desc" }],
    distinct: ["entityId"],
    select: { entityId: true, actorUserId: true },
  });
  return new Map(sent.map((s) => [s.entityId, s.actorUserId]));
}

/** Who last sent the task for review, or null if nobody has. */
export async function lastSubmitter(tx: Db, taskId: string): Promise<string | null> {
  return (await lastSubmitters(tx, [taskId])).get(taskId) ?? null;
}

/** Nobody else on the brand reads tasks as staff (client reviewers don't count), so no four-eyes rule can apply. */
export async function isSoleStaff(workspaceId: string, brandId: string, userId: string) {
  return !(await hasOtherHolder(workspaceId, brandId, userId, "tasks.read"));
}

/**
 * May `userId` be owner, reviewer or blocked-on of this task? They must see it: tasks.read as staff, or as a client
 * (isClientOn) with tasks.read on a task that is client-visible to them (they review it, or its project is shared).
 * Pass `task` as it will be AFTER the proposed change (e.g. `reviewerId: proposed`, the new `workProjectId`, `areas`), so
 * a client made reviewer of a task counts it as theirs, and moving a task out of a shared project is checked against the
 * new one. A CRM task also needs a CRM_TASK_KEYS key (handlesCustomers), from the same places as tasks.read.
 */
export async function canBeAssigned(tx: Db, scope: BrandScope, userId: string, task: TaskPeople): Promise<boolean> {
  // brandMemberPerms: the workspace role or a non-client grant (a brand has one grant per person).
  const [client, staffReads] = await Promise.all([clientGrantOn(tx, scope, userId), brandMemberPerms(tx, scope, userId, "tasks.read")]);
  const clientKeys = client ? rolePermissions(client.role) : [];
  if (task.areas?.includes("CRM") && !handlesCustomers(clientKeys)) {
    const keys = await Promise.all(CRM_TASK_KEYS.map((k) => brandMemberPerms(tx, scope, userId, k)));
    if (!keys.some(Boolean)) return false;
  }
  if (!client) return staffReads;
  if (!staffReads && !clientKeys.includes("tasks.read")) return false;
  return clientSees(tx, scope, userId, task);
}
