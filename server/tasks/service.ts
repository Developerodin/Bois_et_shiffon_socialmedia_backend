import "server-only";
import type { Prisma, Task } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/prisma";
import type { PermissionKey } from "@/server/auth/permissions.catalog";
import { TEAM_MEMBER } from "@/server/content/person-name";
import { notifyTx } from "@/server/notifications/tasks";
import { brandOwners, lockRow, TX } from "@/server/services/publishing";
import { canBeAssigned, findVisibleTask, isSoleStaff, type TaskViewer } from "@/server/tasks/access";
import { taskAudit } from "@/server/tasks/audit";
import { TaskError } from "@/server/tasks/errors";
import { checkTaskLinks } from "@/server/tasks/links";
import { allowedActions, MANAGE_PATCH_FIELDS, pickPatch, safeHttpUrl, TASK_AREAS, TASK_PRIORITIES, WEBSITE_CHANGE_KINDS, type TaskDto, type TaskRow } from "@/shared";

/** The route scope the task services take (authorizeBrandRoute's result). */
export type TaskScope = { userId: string; workspaceId: string; brandId: string; perms: Set<PermissionKey> };

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date")
  .refine((s) => new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), "Not a real date");
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
  reviewerId: opt(id),
  dueOn: opt(day),
  workProjectId: opt(id),
  contentItemId: opt(id),
  url: opt(link),
  previewUrl: opt(link),
  changeKind: opt(z.enum(WEBSITE_CHANGE_KINDS)),
  acceptanceCriteria: opt(z.string().max(4_000)),
  recheckOn: opt(day),
  requestId: z.string().uuid().optional(),
});
export type TaskInput = z.infer<typeof TaskInput>;
/** PATCH: the same rules, every field optional (null clears). Read through pickPatch first, so status etc. never get here. */
const TaskPatch = TaskInput.omit({ requestId: true }).partial();

/** What toTaskDtos needs with each row: the linked project and post titles. */
export const TASK_DTO_INCLUDE = { workProject: { select: { id: true, name: true } }, contentItem: { select: { id: true, title: true } } } as const;
export type TaskWithLinks = Prisma.TaskGetPayload<{ include: typeof TASK_DTO_INCLUDE }>;

const dateOf = (s: string | null) => (s === null ? null : new Date(`${s}T00:00:00Z`));
const dayOf = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
const isoOf = (d: Date | null) => d?.toISOString() ?? null;

/** The manage-editable fields present in `input`, as column values. */
function columns(input: Partial<TaskInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of MANAGE_PATCH_FIELDS) {
    const val = input[k];
    if (val !== undefined) out[k] = k === "dueOn" || k === "recheckOn" ? dateOf(val as string | null) : val;
  }
  return out;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The fields the shared status rules read, from a stored task. */
export const rowOf = (t: Task): TaskRow => ({
  status: t.status,
  reviewerId: t.reviewerId,
  ownerId: t.ownerId,
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
 * Rows → DTOs for the viewer: names from the brand's tasks.read people (`people`, when the caller already read them in
 * parallel; a person not among them is `gone`), checklist counts in one groupBy, and the actions the viewer can take.
 * Sole staff (an owner may review their own task) is resolved only when the viewer owns one of the rows.
 */
export async function toTaskDtos(scope: TaskScope, rows: TaskWithLinks[], people?: { id: string; name: string }[]): Promise<TaskDto[]> {
  if (!rows.length) return [];
  const owns = rows.some((r) => r.ownerId === scope.userId);
  const [names, counts, sole] = await Promise.all([
    people ?? brandOwners(scope, { key: "tasks.read", includeClients: true }),
    prisma.taskChecklistItem.groupBy({ by: ["taskId"], where: { taskId: { in: rows.map((r) => r.id) } }, _count: { _all: true, doneAt: true } }),
    owns ? isSoleStaff(scope.workspaceId, scope.brandId, scope.userId) : false,
  ]);
  const nameOf = new Map(names.map((p) => [p.id, p.name]));
  const countOf = new Map(counts.map((c) => [c.taskId, { done: c._count.doneAt, total: c._count._all }]));
  const person = (userId: string | null) => (userId ? { id: userId, name: nameOf.get(userId) ?? TEAM_MEMBER, gone: !nameOf.has(userId) } : null);
  const canManage = scope.perms.has("tasks.manage");
  return rows.map((t) => {
    const isOwner = t.ownerId === scope.userId;
    const actor = { userId: scope.userId, isOwner, isReviewer: t.reviewerId === scope.userId, canManage, soleStaff: isOwner && sole, isBlockedOn: t.blockedOnId === scope.userId };
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
      reviewer: person(t.reviewerId),
      blockedOn: person(t.blockedOnId),
      project: t.workProject,
      post: t.contentItem,
      checklist: countOf.get(t.id) ?? { done: 0, total: 0 },
      actions: allowedActions(rowOf(t), actor),
    };
  });
}

const notFound = () => new TaskError("Task not found", 404);

export async function getTask(scope: TaskScope, v: TaskViewer, taskId: string): Promise<TaskDto> {
  if (!(await findVisibleTask(prisma, v, taskId))) throw notFound();
  const row = await prisma.task.findUnique({ where: { id: taskId }, include: TASK_DTO_INCLUDE });
  if (!row) throw notFound();
  return (await toTaskDtos(scope, [row]))[0]!;
}

/** A new task (tasks.manage). With a requestId, a repeat returns the task the first request made. */
export async function createTask(scope: TaskScope, v: TaskViewer, input: TaskInput): Promise<TaskDto> {
  const id = await prisma.$transaction(async (tx) => {
    if (input.requestId) {
      await lockRow(tx, "task", `request:${scope.brandId}:${input.requestId}`);
      const existing = await tx.task.findFirst({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId, requestId: input.requestId }, select: { id: true } });
      if (existing) return existing.id;
    }
    await checkTaskLinks(tx, scope, input);
    const task = await tx.task.create({
      data: { ...(columns(input) as Prisma.TaskUncheckedCreateInput), title: input.title, workspaceId: scope.workspaceId, brandId: scope.brandId, createdById: scope.userId, requestId: input.requestId ?? null },
      select: { id: true, title: true, ownerId: true },
    });
    const event = await taskAudit(tx, scope, "task.create", { type: "Task", id: task.id, title: task.title }, input.requestId ? { requestId: input.requestId } : undefined);
    await notifyTx(tx, { userId: task.ownerId, workspaceId: scope.workspaceId, brandId: scope.brandId, kind: "TASK_ASSIGNED", taskId: task.id, actorId: scope.userId, auditEventId: event.id });
    return task.id;
  }, TX);
  return getTask(scope, v, id);
}

/**
 * Edit a task's manage fields (tasks.manage); anything else in the body (status, completedAt, …) is ignored. Only
 * changed fields are written and checked, so a gone owner doesn't block an unrelated edit.
 * - The reviewer of a task in review is kept, unless they can no longer see it (then they may be replaced).
 * - Moving it to another project re-checks the current owner, reviewer and blocked-on, who must still see it.
 * - A new url clears "checked live".
 * ponytail: last write wins per field (the apps send only changed fields); add an updatedAt precondition if people clash.
 */
export async function patchTask(scope: TaskScope, v: TaskViewer, taskId: string, body: Record<string, unknown>): Promise<TaskDto> {
  const parsed = TaskPatch.safeParse(pickPatch(body));
  if (!parsed.success) throw new TaskError(parsed.error.issues[0]?.message ?? "Invalid task", 400);
  await prisma.$transaction(async (tx) => {
    await lockRow(tx, "task", taskId);
    if (!(await findVisibleTask(tx, v, taskId))) throw notFound();
    const current = await tx.task.findUnique({ where: { id: taskId } });
    if (!current) throw notFound();
    const data = columns(parsed.data);
    const changed = Object.keys(data).filter((k) => !same(current[k as keyof typeof current], data[k]));
    if (!changed.length) return;
    const write: Record<string, unknown> = Object.fromEntries(changed.map((k) => [k, data[k]]));
    if ("reviewerId" in write && current.status === "IN_REVIEW") {
      if (!write.reviewerId) throw new TaskError("A task in review needs a reviewer.", 409, "task.reviewerRequired");
      if (current.reviewerId && (await canBeAssigned(tx, scope, current.reviewerId, current))) {
        throw new TaskError("The reviewer can't be changed while the task is in review.", 409, "task.inReview");
      }
    }
    const people = "workProjectId" in write ? { ownerId: current.ownerId, reviewerId: current.reviewerId, blockedOnId: current.blockedOnId } : {};
    await checkTaskLinks(tx, scope, { ...people, ...write }, current);
    if ("url" in write) Object.assign(write, { checkedLiveAt: null, checkedLiveById: null });
    await tx.task.update({ where: { id: taskId }, data: write as Prisma.TaskUncheckedUpdateInput });
    const event = await taskAudit(tx, scope, "task.update", { type: "Task", id: taskId, title: (write.title as string | undefined) ?? current.title }, { fields: changed });
    if ("ownerId" in write) {
      await notifyTx(tx, { userId: write.ownerId as string | null, workspaceId: scope.workspaceId, brandId: scope.brandId, kind: "TASK_ASSIGNED", taskId, actorId: scope.userId, auditEventId: event.id });
    }
  }, TX);
  return getTask(scope, v, taskId);
}
