import "server-only";
import type { Prisma, Task } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/prisma";
import { hitRateLimit } from "@/server/auth/rate-limit";
import type { PermissionKey } from "@/server/auth/permissions.catalog";
import { TEAM_MEMBER } from "@/server/content/person-name";
import { assigneesOf, notifyManyTx, notifyTx } from "@/server/notifications/tasks";
import { brandOwners, lockRow, TX } from "@/server/services/publishing";
import { canBeAssigned, clientCanSee, findVisibleTask, isSoleStaff, lastSubmitters, managesTask, type TaskViewer } from "@/server/tasks/access";
import { taskAudit } from "@/server/tasks/audit";
import { TaskError } from "@/server/tasks/errors";
import { toAttachmentDto } from "@/server/tasks/attachments";
import { toChecklistDto } from "@/server/tasks/checklist";
import { checkTaskLinks } from "@/server/tasks/links";
import { allowedActions, MANAGE_PATCH_FIELDS, pickPatch, safeHttpUrl, TASK_AREAS, TASK_PRIORITIES, WEBSITE_CHANGE_KINDS, type ActorRole, type TaskDetailDto, type TaskDto, type TaskPersonDto, type TaskRow } from "@/shared";

/** The route scope the task services take (authorizeBrandRoute's result; `clientReviewer` undefined = staff). */
export type TaskScope = { userId: string; workspaceId: string; brandId: string; perms: Set<PermissionKey>; clientReviewer?: boolean };

export const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date")
  // Month 13 or 00 makes an Invalid Date, whose toISOString throws; check it first so it is a 400, not a 500.
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
  }, "Not a real date");
const link = z.string().trim().max(2_000).refine((s) => !!safeHttpUrl(s), "Use an http(s) address");
const id = z.string().min(1).max(100);
const opt = <T extends z.ZodType>(t: T) => t.nullable().optional();

/** A new task (POST tasks, batch rows). Ids are checked against the brand by checkTaskLinks, not here. */
export const TaskInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: opt(z.string().max(10_000)),
  areas: z.array(z.enum(TASK_AREAS)).min(1).max(TASK_AREAS.length).transform((a) => [...new Set(a)]),
  priority: z.enum(TASK_PRIORITIES),
  ownerId: opt(id),
  /** A project role owns it until someone holding it takes it (tasks.all); never with ownerId. */
  ownerRoleId: opt(id),
  reviewerId: opt(id),
  dueOn: opt(day),
  workProjectId: opt(id),
  contentItemId: opt(id),
  url: opt(link),
  previewUrl: opt(link),
  changeKind: opt(z.enum(WEBSITE_CHANGE_KINDS)),
  acceptanceCriteria: opt(z.string().max(4_000)),
  recheckOn: opt(day),
  /** A uuid, so never a batch row's `<uuid>:<i>` key (no ":"); tasks/batch relies on that. */
  requestId: z.string().uuid().optional(),
});
export type TaskInput = z.infer<typeof TaskInput>;
/** PATCH: the same rules, every field optional (null clears). Read through pickPatch first, so status etc. never get here. */
const TaskPatch = TaskInput.omit({ requestId: true }).partial();

/** What toTaskDtos needs with each row: the linked project and post titles, and the owning role's name. */
export const TASK_DTO_INCLUDE = { workProject: { select: { id: true, name: true } }, contentItem: { select: { id: true, title: true } }, ownerRole: { select: { id: true, name: true } } } as const;
export type TaskWithLinks = Prisma.TaskGetPayload<{ include: typeof TASK_DTO_INCLUDE }>;

export const dateOf = (s: string | null) => (s === null ? null : new Date(`${s}T00:00:00Z`));
export const dayOf = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
const isoOf = (d: Date | null) => d?.toISOString() ?? null;

/** The manage-editable fields present in `input`, as column values. */
export function columns(input: Partial<TaskInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of MANAGE_PATCH_FIELDS) {
    const val = input[k];
    if (val !== undefined) out[k] = k === "dueOn" || k === "recheckOn" ? dateOf(val as string | null) : val;
  }
  return out;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** A person or a role owns a task, never both (CHECK task_one_owner): setting one clears the other; both is a 400. */
export function withOneOwner<T extends { ownerId?: string | null; ownerRoleId?: string | null }>(input: T): T {
  if (input.ownerId && input.ownerRoleId) throw new TaskError("Give the task to a person or a role, not both.", 400);
  if (input.ownerRoleId) return { ...input, ownerId: null };
  if (input.ownerId !== undefined) return { ...input, ownerRoleId: null };
  return input;
}

/** The fields the shared status rules read, from a stored task. */
export const rowOf = (t: Task): TaskRow => ({
  status: t.status,
  reviewerId: t.reviewerId,
  ownerId: t.ownerId,
  ownerRoleId: t.ownerRoleId,
  url: t.url,
  blockedReason: t.blockedReason,
  blockedOnId: t.blockedOnId,
  completedAt: isoOf(t.completedAt),
  checkedLiveAt: isoOf(t.checkedLiveAt),
  checkedLiveById: t.checkedLiveById,
  findingClearedAt: isoOf(t.findingClearedAt),
  recheckOn: dayOf(t.recheckOn),
});

/**
 * The caller's role on one task for the shared rules. `soleStaff` (nobody else on the brand could review) counts only
 * for the task's owner. Manager is managesTask (tasks.all, or tasks.manage on a task they own or created).
 * `myRoleId`: the caller's project role on the brand, so they may take a task that role owns.
 */
export function actorRole(scope: TaskScope, t: Pick<Task, "ownerId" | "ownerRoleId" | "reviewerId" | "blockedOnId" | "createdById">, soleStaff: boolean, myRoleId: string | null = null): ActorRole {
  const isOwner = t.ownerId === scope.userId;
  return {
    userId: scope.userId,
    isOwner,
    isReviewer: t.reviewerId === scope.userId,
    canManage: managesTask(scope, t),
    soleStaff: isOwner && soleStaff,
    isBlockedOn: t.blockedOnId === scope.userId,
    holdsOwnerRole: !scope.clientReviewer && !!t.ownerRoleId && t.ownerRoleId === myRoleId,
  };
}

/** The caller's project role on the brand (one grant per person per brand), or null. */
export async function myRoleOn(db: Pick<typeof prisma, "brandMember">, scope: TaskScope): Promise<string | null> {
  return (await db.brandMember.findFirst({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId, userId: scope.userId }, select: { roleId: true } }))?.roleId ?? null;
}

/**
 * A user id → the person on a task, named from the brand's tasks.read people (brandOwners with includeClients, which
 * says who is a client); someone not among them is `gone` (and not a client).
 */
export function personOf(names: { id: string; name: string; client?: boolean }[]) {
  const byId = new Map(names.map((p) => [p.id, p]));
  return (userId: string | null): TaskPersonDto | null => {
    if (!userId) return null;
    const p = byId.get(userId);
    return { id: userId, name: p?.name ?? TEAM_MEMBER, gone: !p, client: !!p?.client };
  };
}

/**
 * Rows → DTOs for the viewer: names from the brand's tasks.read people (`people`, when the caller already read them in
 * parallel; a person not among them is `gone`), checklist counts in one groupBy, and the actions the viewer can take.
 * Sole staff (an owner may review their own task) is resolved only when the viewer owns one of the rows.
 */
export async function toTaskDtos(scope: TaskScope, rows: TaskWithLinks[], people?: { id: string; name: string }[]): Promise<TaskDto[]> {
  if (!rows.length) return [];
  const owns = rows.some((r) => r.ownerId === scope.userId);
  const [names, counts, sole, myRole] = await Promise.all([
    people ?? brandOwners(scope, { key: "tasks.read", includeClients: true }),
    prisma.taskChecklistItem.groupBy({ by: ["taskId"], where: { taskId: { in: rows.map((r) => r.id) } }, _count: { _all: true, doneAt: true } }),
    owns ? isSoleStaff(scope.workspaceId, scope.brandId, scope.userId) : false,
    // Only a page with a role's task asks which role the viewer holds (for Take it).
    rows.some((r) => r.ownerRoleId) ? myRoleOn(prisma, scope) : null,
  ]);
  const countOf = new Map(counts.map((c) => [c.taskId, { done: c._count.doneAt, total: c._count._all }]));
  const person = personOf(names);
  // Four eyes, as runTaskAction enforces it: whoever sent a task for review isn't offered Approve, unless sole staff.
  const reviewing = rows.filter((r) => r.status === "IN_REVIEW" && r.reviewerId === scope.userId).map((r) => r.id);
  const sentBy = await lastSubmitters(prisma, reviewing);
  const selfSent = new Set(reviewing.filter((id) => sentBy.get(id) === scope.userId));
  const mayApproveOwn = selfSent.size > 0 && (owns ? sole : await isSoleStaff(scope.workspaceId, scope.brandId, scope.userId));
  return rows.map((t) => {
    const actor = actorRole(scope, t, sole, myRole);
    const actions = allowedActions(rowOf(t), actor);
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      priority: t.priority,
      areas: t.areas,
      dueOn: dayOf(t.dueOn),
      blockedReason: t.blockedReason,
      url: t.url,
      changeKind: t.changeKind,
      acceptanceCriteria: t.acceptanceCriteria,
      previewUrl: t.previewUrl,
      checkedLiveAt: isoOf(t.checkedLiveAt),
      checkedLiveById: t.checkedLiveById,
      recheckOn: dayOf(t.recheckOn),
      completedAt: isoOf(t.completedAt),
      workProjectId: t.workProjectId,
      contentItemId: t.contentItemId,
      findingKind: t.findingKind,
      findingUrls: t.findingUrls,
      findingClearedAt: isoOf(t.findingClearedAt),
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      owner: person(t.ownerId),
      ownerRole: t.ownerRole,
      reviewer: person(t.reviewerId),
      blockedOn: person(t.blockedOnId),
      project: t.workProject,
      post: t.contentItem,
      checklist: countOf.get(t.id) ?? { done: 0, total: 0 },
      actions: selfSent.has(t.id) && !mayApproveOwn ? actions.filter((x) => x !== "approve") : actions,
    };
  });
}

const notFound = () => new TaskError("Task not found", 404);

/** 60 a minute per person for each kind of task write (create, batch, comment), so a stuck client can't flood a brand. */
export async function limitTaskWrites(kind: "create" | "batch" | "comment", userId: string) {
  if (!(await hitRateLimit(`tasks.${kind}:${userId}`, 60, 60_000)).allowed) throw new TaskError("Too many changes at once. Wait a minute.", 429);
}

/** One task with its checklist lines (position, id) and photos (signed URLs); list rows carry only checklist counts. */
export async function getTask(scope: TaskScope, v: TaskViewer, taskId: string): Promise<TaskDetailDto> {
  if (!(await findVisibleTask(prisma, v, taskId))) throw notFound();
  const row = await prisma.task.findUnique({ where: { id: taskId }, include: TASK_DTO_INCLUDE });
  if (!row) throw notFound();
  const [[dto], items, attachments, clientVisible] = await Promise.all([
    toTaskDtos(scope, [row]),
    prisma.taskChecklistItem.findMany({ where: { taskId }, orderBy: [{ position: "asc" }, { id: "asc" }] }),
    prisma.taskAttachment.findMany({ where: { taskId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: { mediaUpload: { select: { key: true } } } }),
    clientCanSee(prisma, scope, row),
  ]);
  return { ...dto!, clientVisible, viewerIsClient: v.client, checklistItems: items.map(toChecklistDto), attachments: await Promise.all(attachments.map((a) => toAttachmentDto(a, a.mediaUpload.key))) };
}

/**
 * A new task (tasks.manage; another owner or a role needs tasks.all, checkTaskLinks). With a requestId, a repeat by the
 * same person returns the task their first request made.
 */
export async function createTask(scope: TaskScope, v: TaskViewer, raw: TaskInput): Promise<TaskDetailDto> {
  const input = withOneOwner(raw);
  const id = await prisma.$transaction(async (tx) => {
    if (input.requestId) {
      await lockRow(tx, "task", `request:${scope.brandId}:${input.requestId}`);
      const existing = await tx.task.findFirst({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId, requestId: input.requestId, createdById: scope.userId }, select: { id: true } });
      if (existing) return existing.id;
    }
    await checkTaskLinks(tx, scope, input);
    const task = await tx.task.create({
      data: { ...(columns(input) as Prisma.TaskUncheckedCreateInput), title: input.title, workspaceId: scope.workspaceId, brandId: scope.brandId, createdById: scope.userId, requestId: input.requestId ?? null },
      select: { id: true, title: true, ownerId: true, ownerRoleId: true },
    });
    const event = await taskAudit(tx, scope, "task.create", { type: "Task", id: task.id, title: task.title }, input.requestId ? { requestId: input.requestId } : undefined);
    const to = await assigneesOf(tx, { ...scope, ...task });
    await notifyManyTx(tx, to, { workspaceId: scope.workspaceId, brandId: scope.brandId, kind: "TASK_ASSIGNED", taskId: task.id, actorId: scope.userId, auditEventId: event.id });
    return task.id;
  }, TX);
  return getTask(scope, v, id);
}

/**
 * Edit a task's manage fields (managesTask: tasks.all, or tasks.manage on a task you own or created); anything else in
 * the body (status, completedAt, …) is ignored. Only changed fields are written and checked, so a gone owner doesn't
 * block an unrelated edit. Setting ownerId clears ownerRoleId and the other way round (withOneOwner); another owner or
 * a role needs tasks.all (checkTaskLinks).
 * - The reviewer of a task in review is kept, unless they can no longer see it (then they may be replaced, and the new
 *   one is asked to review). A task with an APPROVED or CHANGES_REQUESTED comment can't lose its reviewer (409).
 * - Moving it to another project re-checks the current owner, reviewer and blocked-on, who must still see it.
 * - A new url clears "checked live".
 * ponytail: last write wins per field (the apps send only changed fields); add an updatedAt precondition if people clash.
 */
export async function patchTask(scope: TaskScope, v: TaskViewer, taskId: string, body: Record<string, unknown>): Promise<TaskDetailDto> {
  const parsed = TaskPatch.safeParse(pickPatch(body));
  if (!parsed.success) throw new TaskError(parsed.error.issues[0]?.message ?? "Invalid task", 400);
  await prisma.$transaction(async (tx) => {
    await lockRow(tx, "task", taskId);
    if (!(await findVisibleTask(tx, v, taskId))) throw notFound();
    const current = await tx.task.findUnique({ where: { id: taskId } });
    if (!current) throw notFound();
    if (!managesTask(scope, current)) throw new TaskError("Only the task's owner, its creator or an admin can change this.", 403);
    const data = columns(withOneOwner(parsed.data));
    const changed = Object.keys(data).filter((k) => !same(current[k as keyof typeof current], data[k]));
    if (!changed.length) return;
    const write: Record<string, unknown> = Object.fromEntries(changed.map((k) => [k, data[k]]));
    if ("reviewerId" in write && current.status === "IN_REVIEW") {
      if (!write.reviewerId) throw new TaskError("A task in review needs a reviewer.", 409, "task.reviewerRequired");
      if (current.reviewerId && (await canBeAssigned(tx, scope, current.reviewerId, current))) {
        throw new TaskError("The reviewer can't be changed while the task is in review.", 409, "task.inReview");
      }
    }
    // A reviewed task keeps a reviewer: dropping it would let cancel → reopen → mark done skip the review.
    if ("reviewerId" in write && !write.reviewerId && (await tx.taskComment.findFirst({ where: { taskId, kind: { in: ["APPROVED", "CHANGES_REQUESTED"] } }, select: { id: true } }))) {
      throw new TaskError("This task has been reviewed, so it keeps a reviewer. Pick another reviewer instead.", 409, "task.reviewed");
    }
    // The submitForReview rule, kept while in review: swapping reviewer or owner must not let the owner approve their own task.
    if (current.status === "IN_REVIEW" && ("ownerId" in write || "reviewerId" in write)) {
      const owner = ("ownerId" in write ? write.ownerId : current.ownerId) as string | null;
      const reviewer = ("reviewerId" in write ? write.reviewerId : current.reviewerId) as string | null;
      if (owner && owner === reviewer && !(await isSoleStaff(scope.workspaceId, scope.brandId, owner))) {
        throw new TaskError("The reviewer can't be the owner.", 409, "task.reviewerIsOwner");
      }
    }
    const people = "workProjectId" in write ? { ownerId: current.ownerId, reviewerId: current.reviewerId, blockedOnId: current.blockedOnId } : {};
    await checkTaskLinks(tx, scope, { ...people, ...write }, current);
    if ("url" in write) Object.assign(write, { checkedLiveAt: null, checkedLiveById: null });
    await tx.task.update({ where: { id: taskId }, data: write as Prisma.TaskUncheckedUpdateInput });
    const event = await taskAudit(tx, scope, "task.update", { type: "Task", id: taskId, title: (write.title as string | undefined) ?? current.title }, { fields: changed });
    if ("ownerId" in write || "ownerRoleId" in write) {
      const after = { ...current, ...(write as Partial<Task>) };
      const to = await assigneesOf(tx, after);
      await notifyManyTx(tx, to, { workspaceId: scope.workspaceId, brandId: scope.brandId, kind: "TASK_ASSIGNED", taskId, actorId: scope.userId, auditEventId: event.id });
    }
    // A new reviewer on a task already in review has a review waiting.
    if ("reviewerId" in write && current.status === "IN_REVIEW") {
      await notifyTx(tx, { userId: write.reviewerId as string, workspaceId: scope.workspaceId, brandId: scope.brandId, kind: "REVIEW_REQUESTED", taskId, actorId: scope.userId, auditEventId: event.id });
    }
  }, TX);
  return getTask(scope, v, taskId);
}
