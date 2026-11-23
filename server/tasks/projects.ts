import "server-only";
import { Prisma, type WorkProject, type WorkProjectMilestone } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/prisma";
import { brandMemberPerms, CLIENT_GRANT_WHERE, type Db } from "@/server/auth/permissions";
import { contentWindow } from "@/server/content/window";
import { brandOwners, lockRow, TX } from "@/server/services/publishing";
import { visibleTaskSql, type TaskViewer } from "@/server/tasks/access";
import { taskAudit } from "@/server/tasks/audit";
import { isUniqueViolation, TaskError } from "@/server/tasks/errors";
import { dateOf, day, dayOf, personOf, type TaskScope } from "@/server/tasks/service";
import { OPEN_TASK_STATUSES, WORK_PROJECT_STATUSES, type WorkProjectDetailDto, type WorkProjectDto, type WorkProjectMilestoneDto } from "@/shared";

const id = z.string().min(1).max(100);
const opt = <T extends z.ZodType>(t: T) => t.nullable().optional();

/** A new project (POST work-projects). The owner and campaign are checked against the brand by checkProjectLinks. */
export const WorkProjectInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: opt(z.string().max(4_000)),
  ownerId: opt(id),
  startsOn: opt(day),
  dueOn: opt(day),
  campaignId: opt(id),
  clientVisible: z.boolean().optional(),
  status: z.enum(WORK_PROJECT_STATUSES).optional(),
  requestId: z.string().uuid().optional(),
});
export type WorkProjectInput = z.infer<typeof WorkProjectInput>;
const WorkProjectPatch = WorkProjectInput.omit({ requestId: true }).partial();
export const ListProjectsQuery = z.object({ status: z.enum(WORK_PROJECT_STATUSES).optional(), cursor: id.optional() });

const MilestoneAdd = z.object({ title: z.string().trim().min(1).max(120), dueOn: day });
const MilestonePatch = z
  .object({ title: MilestoneAdd.shape.title.optional(), dueOn: day.optional(), done: z.boolean().optional(), position: z.number().int().min(0).max(100_000).optional() })
  .refine((o) => Object.values(o).some((x) => x !== undefined), "Nothing to change");

const PAGE = 30;
const POSTS = 50;

function parse<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new TaskError(r.error.issues[0]?.message ?? `Invalid ${what}`, 400);
  return r.data;
}

const notFound = () => new TaskError("Project not found", 404);
/** The project row a viewer may see: same brand, and shared with the client when the viewer is one. */
const projectWhere = (v: TaskViewer, projectId?: string): Prisma.WorkProjectWhereInput => ({
  ...(projectId ? { id: projectId } : {}),
  workspaceId: v.workspaceId,
  brandId: v.brandId,
  ...(v.client ? { clientVisible: true } : {}),
});

/** Input fields → columns (days as Dates); only the fields present. */
function columns(input: Partial<WorkProjectInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(input)) {
    if (val === undefined || k === "requestId") continue;
    out[k] = k === "startsOn" || k === "dueOn" ? dateOf(val as string | null) : val;
  }
  return out;
}

/**
 * The campaign must be this brand's ({ id, workspaceId, brandId }); the owner must hold tasks.read on the brand as staff
 * (a client reviewer never owns a project). Throws TaskError("Invalid <field>", 400).
 */
async function checkProjectLinks(tx: Db, scope: { workspaceId: string; brandId: string }, input: { campaignId?: string | null; ownerId?: string | null }) {
  if (input.campaignId && !(await tx.campaign.findFirst({ where: { id: input.campaignId, workspaceId: scope.workspaceId, brandId: scope.brandId }, select: { id: true } }))) {
    throw new TaskError("Invalid campaignId", 400);
  }
  if (input.ownerId && !(await brandMemberPerms(tx, scope, input.ownerId, "tasks.read"))) throw new TaskError("Invalid ownerId", 400);
}

const campaignTaken = () => new TaskError("Another project already uses this campaign.", 409, "workProject.campaignTaken");

/** Done / (all − cancelled) per project, from task counts by status. */
function progressOf(counts: Record<string, number>) {
  const total = Object.entries(counts).reduce((n, [s, c]) => (s === "CANCELLED" ? n : n + c), 0);
  return { done: counts.DONE ?? 0, total };
}

function toDto(p: WorkProject, person: ReturnType<typeof personOf>, counts: Record<string, number>): WorkProjectDto {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    status: p.status,
    startsOn: dayOf(p.startsOn),
    dueOn: dayOf(p.dueOn),
    campaignId: p.campaignId,
    clientVisible: p.clientVisible,
    owner: person(p.ownerId),
    progress: progressOf(counts),
  };
}

const toMilestoneDto = (m: WorkProjectMilestone): WorkProjectMilestoneDto => ({ id: m.id, title: m.title, dueOn: dayOf(m.dueOn)!, doneAt: m.doneAt?.toISOString() ?? null, position: m.position });

const people = (scope: TaskScope) => brandOwners(scope, { key: "tasks.read", includeClients: true });

/**
 * A page of projects (30), soonest due first (undated last), then id; archived ones only when asked for by status.
 * A client sees only projects shared with them. Progress for the page counts only the viewer's visible tasks
 * (visibleTaskSql), in one query, as getProject does, so the list and the project agree.
 */
export async function listProjects(scope: TaskScope, v: TaskViewer, q: z.infer<typeof ListProjectsQuery>): Promise<{ projects: WorkProjectDto[]; nextCursor: string | null }> {
  const where: Prisma.WorkProjectWhereInput = { ...projectWhere(v), status: q.status ?? { not: "ARCHIVED" } };
  // Prisma's cursor reads the row by id alone: one of another brand (or not shared, for a client) would still page.
  if (q.cursor && !(await prisma.workProject.findFirst({ where: projectWhere(v, q.cursor), select: { id: true } }))) throw new TaskError("Invalid cursor", 400);
  const [rows, names] = await Promise.all([
    prisma.workProject.findMany({
      where,
      orderBy: [{ dueOn: { sort: "asc", nulls: "last" } }, { id: "asc" }],
      take: PAGE + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    }),
    people(scope),
  ]);
  const page = rows.slice(0, PAGE);
  const groups = page.length
    ? await prisma.$queryRaw<{ workProjectId: string; status: string; count: number }[]>`SELECT t."workProjectId", t.status::text AS status, count(*)::int AS count FROM "Task" t
        WHERE t."workProjectId" IN (${Prisma.join(page.map((p) => p.id))}) AND ${visibleTaskSql(v)} GROUP BY t."workProjectId", t.status`
    : [];
  const counts = new Map<string, Record<string, number>>();
  for (const g of groups) counts.set(g.workProjectId, { ...counts.get(g.workProjectId), [g.status]: g.count });
  const person = personOf(names);
  return { projects: page.map((p) => toDto(p, person, counts.get(p.id) ?? {})), nextCursor: rows.length > PAGE ? (page.at(-1)?.id ?? null) : null };
}

/**
 * One project: milestones, the viewer's visible tasks counted by status (visibleTaskSql), and the linked campaign's posts
 * in the calendar window. 404 for another brand's project, and for a client when it isn't shared.
 */
export async function getProject(scope: TaskScope, v: TaskViewer, projectId: string, now = new Date()): Promise<WorkProjectDetailDto> {
  const p = await prisma.workProject.findFirst({
    where: projectWhere(v, projectId),
    include: { campaign: { select: { id: true, name: true } }, milestones: { orderBy: [{ position: "asc" }, { id: "asc" }] } },
  });
  if (!p) throw notFound();
  const [rows, names, posts] = await Promise.all([
    prisma.$queryRaw<{ status: string; count: number }[]>`SELECT t.status::text AS status, count(*)::int AS count FROM "Task" t WHERE t."workProjectId" = ${projectId} AND ${visibleTaskSql(v)} GROUP BY t.status`,
    people(scope),
    p.campaignId
      ? prisma.contentItem.findMany({
          where: { workspaceId: v.workspaceId, brandId: v.brandId, campaignId: p.campaignId, status: { not: "CANCELLED" }, ...contentWindow(now) },
          orderBy: [{ scheduledFor: { sort: "asc", nulls: "first" } }, { id: "asc" }],
          take: POSTS,
          select: { id: true, title: true, channel: true, status: true, scheduledFor: true },
        })
      : [],
  ]);
  const taskCounts = Object.fromEntries(rows.map((r) => [r.status, r.count]));
  return {
    ...toDto(p, personOf(names), taskCounts),
    campaign: p.campaign,
    milestones: p.milestones.map(toMilestoneDto),
    taskCounts,
    posts: posts.map((i) => ({ id: i.id, title: i.title, channel: i.channel, status: i.status, scheduledFor: i.scheduledFor?.toISOString() ?? null })),
  };
}

/** A new project (tasks.manage). With a requestId, a repeat returns the project the first request made. */
export async function createProject(scope: TaskScope, v: TaskViewer, input: WorkProjectInput): Promise<WorkProjectDetailDto> {
  const projectId = await prisma.$transaction(async (tx) => {
    if (input.requestId) {
      await lockRow(tx, "task", `project-request:${scope.brandId}:${input.requestId}`);
      const existing = await tx.workProject.findFirst({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId, requestId: input.requestId }, select: { id: true } });
      if (existing) return existing.id;
    }
    await checkProjectLinks(tx, scope, input);
    let created: WorkProject;
    try {
      created = await tx.workProject.create({
        data: { ...(columns(input) as Prisma.WorkProjectUncheckedCreateInput), name: input.name, workspaceId: scope.workspaceId, brandId: scope.brandId, requestId: input.requestId ?? null },
      });
    } catch (e) {
      // (brandId, campaignId) is unique: one project per campaign.
      if (isUniqueViolation(e)) throw campaignTaken();
      throw e;
    }
    await taskAudit(tx, scope, "workProject.create", { type: "WorkProject", id: created.id, title: created.name });
    return created.id;
  }, TX);
  return getProject(scope, v, projectId);
}

/**
 * Edit a project (tasks.manage); status ARCHIVED archives it (no hard delete). Only changed fields are written and
 * checked. Unsharing it (clientVisible off) is refused while a client reviews, owns or unblocks an open task in it,
 * since they would lose sight of that task.
 * ponytail: the check reads the project's tasks under the project lock, not each task's lock; a client made reviewer in
 * the same instant can slip through (they then keep the task through reviewerId anyway).
 */
export async function patchProject(scope: TaskScope, v: TaskViewer, projectId: string, body: unknown): Promise<WorkProjectDetailDto> {
  const input = parse(WorkProjectPatch, body, "project");
  await prisma.$transaction(async (tx) => {
    await lockRow(tx, "task", `project:${projectId}`);
    const current = await tx.workProject.findFirst({ where: projectWhere(v, projectId) });
    if (!current) throw notFound();
    const data = columns(input);
    const same = (k: string) => JSON.stringify(current[k as keyof WorkProject] ?? null) === JSON.stringify(data[k] ?? null);
    const changed = Object.keys(data).filter((k) => !same(k));
    if (!changed.length) return;
    const write = Object.fromEntries(changed.map((k) => [k, data[k]]));
    await checkProjectLinks(tx, scope, write as { campaignId?: string | null; ownerId?: string | null });
    if (write.clientVisible === false) {
      const clients = await tx.brandMember.findMany({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId, role: CLIENT_GRANT_WHERE }, select: { userId: true } });
      const ids = clients.map((c) => c.userId);
      const held = ids.length
        ? await tx.task.findFirst({
            where: { workProjectId: projectId, status: { in: [...OPEN_TASK_STATUSES] }, OR: [{ reviewerId: { in: ids } }, { ownerId: { in: ids } }, { blockedOnId: { in: ids } }] },
            select: { id: true },
          })
        : null;
      if (held) throw new TaskError("A client reviews tasks in this project", 409, "workProject.clientReviewing");
    }
    try {
      await tx.workProject.update({ where: { id: projectId }, data: write as Prisma.WorkProjectUncheckedUpdateInput });
    } catch (e) {
      if (isUniqueViolation(e)) throw campaignTaken();
      throw e;
    }
    await taskAudit(tx, scope, "workProject.update", { type: "WorkProject", id: projectId, title: (write.name as string | undefined) ?? current.name }, { fields: changed });
  }, TX);
  return getProject(scope, v, projectId);
}

/** Lock and read the project ({ id, workspaceId, brandId }) before a milestone write; 404 if it isn't this brand's. */
async function lockProject(tx: Prisma.TransactionClient, v: TaskViewer, projectId: string) {
  await lockRow(tx, "task", `project:${projectId}`);
  const p = await tx.workProject.findFirst({ where: projectWhere(v, projectId), select: { id: true, name: true } });
  if (!p) throw notFound();
  return p;
}

/** The milestone, only if it belongs to this project (404 otherwise). */
async function milestoneOf(tx: Prisma.TransactionClient, projectId: string, milestoneId: string) {
  const m = await tx.workProjectMilestone.findFirst({ where: { id: milestoneId, workProjectId: projectId } });
  if (!m) throw new TaskError("Milestone not found", 404);
  return m;
}

/** Add a milestone at the end (tasks.manage). The project lock makes "last position + 1" safe. */
export async function addMilestone(scope: TaskScope, v: TaskViewer, projectId: string, body: unknown): Promise<WorkProjectMilestoneDto> {
  const input = parse(MilestoneAdd, body, "milestone");
  return prisma.$transaction(async (tx) => {
    const p = await lockProject(tx, v, projectId);
    const { _max } = await tx.workProjectMilestone.aggregate({ where: { workProjectId: projectId }, _max: { position: true } });
    const m = await tx.workProjectMilestone.create({ data: { workProjectId: projectId, title: input.title, dueOn: dateOf(input.dueOn)!, position: (_max.position ?? -1) + 1 } });
    await taskAudit(tx, scope, "workProject.milestone.add", { type: "WorkProject", id: projectId, title: p.name }, { milestoneId: m.id });
    return toMilestoneDto(m);
  }, TX);
}

/** Rename, re-date, tick or move a milestone (tasks.manage). */
export async function patchMilestone(scope: TaskScope, v: TaskViewer, projectId: string, milestoneId: string, body: unknown): Promise<WorkProjectMilestoneDto> {
  const input = parse(MilestonePatch, body, "milestone");
  return prisma.$transaction(async (tx) => {
    const p = await lockProject(tx, v, projectId);
    const current = await milestoneOf(tx, projectId, milestoneId);
    const data: Prisma.WorkProjectMilestoneUpdateInput = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.dueOn !== undefined) data.dueOn = dateOf(input.dueOn)!;
    if (input.position !== undefined) data.position = input.position;
    if (input.done !== undefined) data.doneAt = input.done ? (current.doneAt ?? new Date()) : null;
    const m = await tx.workProjectMilestone.update({ where: { id: milestoneId }, data });
    await taskAudit(tx, scope, "workProject.milestone.update", { type: "WorkProject", id: projectId, title: p.name }, { milestoneId, fields: Object.keys(input) });
    return toMilestoneDto(m);
  }, TX);
}

/** Remove a milestone (tasks.manage); its title stays in the audit event. */
export async function removeMilestone(scope: TaskScope, v: TaskViewer, projectId: string, milestoneId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const p = await lockProject(tx, v, projectId);
    const current = await milestoneOf(tx, projectId, milestoneId);
    await tx.workProjectMilestone.delete({ where: { id: milestoneId } });
    await taskAudit(tx, scope, "workProject.milestone.remove", { type: "WorkProject", id: projectId, title: p.name }, { milestoneId, milestoneTitle: current.title });
  }, TX);
}
