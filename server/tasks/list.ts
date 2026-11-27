import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/prisma";
import { brandOwners } from "@/server/services/publishing";
import { ownedBySql, visibleTaskSql, type TaskViewer } from "@/server/tasks/access";
import { fromCursor, toCursor } from "@/server/tasks/cursor";
import { TaskError } from "@/server/tasks/errors";
import { TASK_DTO_INCLUDE, toTaskDtos, type TaskScope } from "@/server/tasks/service";
import { brandLocalDay, dueSql, openTaskSql } from "@/server/tasks/sql";
import { DONE_DAYS, isBlocked, isOverdue, OPEN_STATUSES, TASK_AREAS, TASK_VIEWS, type PostRow, type TaskDto, type TaskView, type TodayDto } from "@/shared";

/**
 * GET tasks query (every view but today). `area` may come lower-case from a link (`?area=website`); `source` keeps the
 * tasks made from that kind of audit report (`?source=geo`).
 */
export const ListQuery = z.object({
  view: z.enum(TASK_VIEWS),
  area: z.string().transform((s) => s.toUpperCase()).pipe(z.enum(TASK_AREAS)).optional(),
  source: z.string().transform((s) => s.toUpperCase()).pipe(z.enum(["SEO", "GEO"])).optional(),
  workProjectId: z.string().min(1).max(100).optional(),
  ownerId: z.string().min(1).max(100).optional(),
  cursor: z.string().min(1).max(500).optional(),
});
export type ListQuery = z.infer<typeof ListQuery>;

const PAGE = 50;
const TODAY_ROWS = 5;
const POSTS = 20;

const OPEN = openTaskSql;
const DUE = dueSql;
/** In review with this person as reviewer: the Approvals view and Today's approvals group. */
const toReview = (userId: string) => Prisma.sql`t.status = 'IN_REVIEW' AND t."reviewerId" = ${userId}`;

/** The brand's local day at `now` (brandLocalDay). */
const localToday = (brandId: string, now: Date) =>
  Prisma.sql`(SELECT ${brandLocalDay(now)} FROM "Brand" b LEFT JOIN "BrandProfile" bp ON bp."brandId" = b.id WHERE b.id = ${brandId})`;

const OpenKey = z.object({ due: z.union([z.literal("infinity"), z.iso.date()]), id: z.string().min(1).max(100) });
const DoneKey = z.object({ completedAt: z.iso.datetime(), id: z.string().min(1).max(100) });
const OpenCursor = OpenKey.extend({ view: z.enum(TASK_VIEWS) });
const DoneCursor = DoneKey.extend({ view: z.literal("done") });
type OpenKey = z.infer<typeof OpenKey>;
type DoneKey = z.infer<typeof DoneKey>;
type KeyOf<V extends TaskView> = V extends "done" ? DoneKey : OpenKey;

/** base64url JSON of the view and the last row's sort key; a cursor only works on the view that made it. */
export function encodeCursor<V extends TaskView>(view: V, key: KeyOf<V>): string {
  return toCursor({ view, ...key });
}

export function decodeCursor<V extends TaskView>(view: V, s: string): KeyOf<V> {
  const { view: made, ...key } = fromCursor<{ view: TaskView } & (OpenKey | DoneKey)>(view === "done" ? DoneCursor : OpenCursor, s);
  if (made !== view) throw new TaskError("Invalid cursor", 400);
  return key as KeyOf<V>;
}

/**
 * One page of task ids (51, to know if there is more) for a view, on top of visibleTaskSql so a client's page is never
 * short. Open views sort by due day (no day last), then id; Done by completion, newest first (last 30 days).
 */
export function listSql(v: TaskViewer, q: ListQuery, now = new Date()): Prisma.Sql {
  const done = q.view === "done";
  const where: Prisma.Sql[] = [visibleTaskSql(v)];
  if (done) where.push(Prisma.sql`t.status = 'DONE' AND t."completedAt" > ${new Date(now.getTime() - DONE_DAYS * 86_400_000).toISOString()}::timestamp`);
  else where.push(OPEN);
  // Yours, or your role's until someone takes it.
  if (q.view === "mine") where.push(ownedBySql(v.userId));
  if (q.view === "approvals") where.push(toReview(v.userId));
  // The same expression as the ORDER BY and cursor, so the (brand, due, id) index serves the filter too.
  // Overdue too, so the index scan stops before the undated rows (DUE is infinity there, never before today).
  if (q.view === "due-today") where.push(Prisma.sql`${DUE} = ${localToday(v.brandId, now)}`);
  if (q.view === "overdue") where.push(Prisma.sql`${DUE} < ${localToday(v.brandId, now)}`);
  if (q.view === "blocked") where.push(Prisma.sql`t."blockedReason" IS NOT NULL`);
  if (q.area) where.push(Prisma.sql`${q.area}::"TaskArea" = ANY(t.areas)`);
  if (q.source) where.push(Prisma.sql`t."findingKind" = ${q.source}::"AuditKind"`);
  if (q.workProjectId) where.push(Prisma.sql`t."workProjectId" = ${q.workProjectId}`);
  if (q.ownerId) where.push(Prisma.sql`t."ownerId" = ${q.ownerId}`);
  if (q.cursor && done) {
    const k = decodeCursor("done", q.cursor);
    where.push(Prisma.sql`(t."completedAt" < ${k.completedAt}::timestamp OR (t."completedAt" = ${k.completedAt}::timestamp AND t.id > ${k.id}))`);
  } else if (q.cursor) {
    const k = decodeCursor(q.view, q.cursor) as OpenKey;
    where.push(Prisma.sql`(${DUE}, t.id) > (${k.due}::date, ${k.id})`);
  }
  const order = done ? Prisma.sql`t."completedAt" DESC, t.id` : Prisma.sql`${DUE}, t.id`;
  return Prisma.sql`SELECT t.id, ${DUE}::text AS due, t."completedAt" FROM "Task" t WHERE ${Prisma.join(where, " AND ")} ORDER BY ${order} LIMIT ${PAGE + 1}`;
}

/** Rows for ids from a visibility-checked query, in that query's order. */
async function rowsFor(ids: string[]) {
  if (!ids.length) return [];
  const rows = await prisma.task.findMany({ where: { id: { in: ids } }, include: TASK_DTO_INCLUDE });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/**
 * Your posts that need action (the Phase 0 rule from shared): open posts you own, at most 20 read, then isOverdue /
 * isBlocked. ponytail: a person owning more than 20 open posts may miss some here; the calendar still lists them all.
 */
async function postsNeedingAction(scope: TaskScope, now: Date): Promise<PostRow[]> {
  const items = await prisma.contentItem.findMany({
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId, ownerId: scope.userId, status: { in: [...OPEN_STATUSES] } },
    orderBy: [{ scheduledFor: { sort: "asc", nulls: "last" } }, { id: "asc" }],
    take: POSTS,
    select: {
      id: true, title: true, channel: true, status: true, scheduledFor: true, byHand: true,
      versions: { orderBy: { version: "desc" }, take: 1, select: { checks: { orderBy: { createdAt: "desc" }, take: 1, select: { overall: true } } } },
      publications: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true } },
    },
  });
  return items
    .filter((i) => {
      const scheduledFor = i.scheduledFor?.toISOString() ?? null;
      // The same publishIssue the content list sends.
      const pub = i.publications[0]?.status;
      const publishIssue = pub === "PENDING_VERIFY" ? "CHECK" : pub === "FAILED" && i.status === "APPROVED" ? "FAILED" : null;
      const latest = i.versions[0] ? { check: i.versions[0].checks[0] ?? null } : null;
      return isOverdue({ status: i.status, scheduledFor, byHand: i.byHand }, now) || isBlocked({ status: i.status, publishIssue, latest });
    })
    .map((i) => ({ id: i.id, title: i.title, channel: i.channel, status: i.status, scheduledFor: i.scheduledFor?.toISOString() ?? null }));
}

type PageRow = { id: string; due: string; completedAt: Date | null };

/** A page of a view. `posts` only on the first page of view=mine, and only for content work (no area, or CONTENT). */
export async function listTasks(scope: TaskScope, v: TaskViewer, q: ListQuery, now = new Date()): Promise<{ tasks: TaskDto[]; posts?: PostRow[]; nextCursor: string | null }> {
  const sql = listSql(v, q, now);
  const [page, people, posts] = await Promise.all([
    prisma.$queryRaw<PageRow[]>(sql),
    brandOwners(scope, { key: "tasks.read", includeClients: true }),
    q.view === "mine" && !q.cursor && (!q.area || q.area === "CONTENT") ? postsNeedingAction(scope, now) : undefined,
  ]);
  const shown = page.slice(0, PAGE);
  const tasks = await toTaskDtos(scope, await rowsFor(shown.map((r) => r.id)), people);
  const last = shown.at(-1);
  const nextCursor =
    page.length > PAGE && last
      ? q.view === "done"
        ? encodeCursor("done", { completedAt: last.completedAt!.toISOString(), id: last.id })
        : encodeCursor(q.view, { due: last.due, id: last.id })
      : null;
  return { tasks, ...(posts ? { posts } : {}), nextCursor };
}

/**
 * Today: yours due today or earlier (brand-local), what you review, and what's blocked that you own or it waits on you.
 * One count query, one query for the first 5 of each (UNION ALL, each part in its own order), one toTaskDtos.
 */
export async function todayTasks(scope: TaskScope, v: TaskViewer, now = new Date()): Promise<TodayDto> {
  const base = Prisma.sql`FROM "Task" t WHERE ${visibleTaskSql(v)} AND ${OPEN}`;
  const groups = {
    // DUE as the (brand, owner, due, id) and (brand, ownerRole, due, id) indexes have it, so the scan stops before the
    // undated rows (DUE infinity). Yours, or your role's until someone takes it (ownedBySql).
    mine: Prisma.sql`${ownedBySql(v.userId)} AND ${DUE} <= ${localToday(v.brandId, now)}`,
    approvals: toReview(v.userId),
    // ponytail: person-based; a blocked task of your role shows here once someone takes it.
    blockers: Prisma.sql`t."blockedReason" IS NOT NULL AND (t."ownerId" = ${v.userId} OR t."blockedOnId" = ${v.userId})`,
  };
  const names = Object.keys(groups) as (keyof typeof groups)[];
  const first = (g: keyof typeof groups) =>
    Prisma.sql`(SELECT ${g}::text AS grp, t.id ${base} AND ${groups[g]} ORDER BY ${DUE}, t.id LIMIT ${TODAY_ROWS})`;
  const [[counts], picked, people] = await Promise.all([
    prisma.$queryRaw<Record<keyof typeof groups, number>[]>(Prisma.sql`SELECT
      count(*) FILTER (WHERE ${groups.mine})::int AS mine,
      count(*) FILTER (WHERE ${groups.approvals})::int AS approvals,
      count(*) FILTER (WHERE ${groups.blockers})::int AS blockers
      ${base}`),
    prisma.$queryRaw<{ grp: keyof typeof groups; id: string }[]>(Prisma.join(names.map(first), " UNION ALL ", "", "")),
    brandOwners(scope, { key: "tasks.read", includeClients: true }),
  ]);
  const dtos = await toTaskDtos(scope, await rowsFor([...new Set(picked.map((r) => r.id))]), people);
  const byId = new Map(dtos.map((d) => [d.id, d]));
  // Sorted here by (due, id) as each part's SQL did, since UNION ALL doesn't promise to keep each part's order.
  const key = (t: TaskDto) => t.dueOn ?? "infinity";
  const byDue = (a: TaskDto, b: TaskDto) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const group = (g: keyof typeof groups) => ({
    count: counts?.[g] ?? 0,
    tasks: picked.filter((r) => r.grp === g).flatMap((r) => byId.get(r.id) ?? []).sort(byDue),
  });
  return { mine: group("mine"), approvals: group("approvals"), blockers: group("blockers") };
}
