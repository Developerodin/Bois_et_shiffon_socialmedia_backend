import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { brandTimeZone, zoneToday } from "@/server/data/sources";
import { visibleTaskSql, type TaskViewer } from "@/server/tasks/access";
import { rowsFor } from "@/server/tasks/list";
import { projectWhere } from "@/server/tasks/projects";
import { dayOf, toTaskDtos, type TaskScope } from "@/server/tasks/service";
import { dueSql, openTaskSql } from "@/server/tasks/sql";
import type { UpcomingDto } from "@/shared";

/** Rows of each kind the Overview gets; the counts cover the whole window. */
const ROWS = 10;
/** Today through today + 6: seven brand-local days. */
const WINDOW_DAYS = 7;

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * The Overview's next 7 days: open website tasks due in the window (visibleTaskSql, so a client sees only shared ones
 * and staff without tasks.all only their own) and milestones not done in an active project the caller can see
 * (projectWhere). One read for the brand's zone, then the four reads in parallel. Overdue work is left to Today.
 * ponytail: the zone comes from BrandProfile in JS (zoneToday), as the data tabs do; brandLocalDay does the same in SQL.
 */
export async function upcomingWork(scope: TaskScope, v: TaskViewer, now = new Date()): Promise<UpcomingDto> {
  const timeZone = await brandTimeZone(scope);
  const from = zoneToday(timeZone, now);
  const to = addDays(from, WINDOW_DAYS - 1);
  // Filtered on dueSql, the expression the (brand, due, id) indexes have; an undated task is 'infinity', never in range.
  const tasksWhere = Prisma.sql`${visibleTaskSql(v)} AND ${openTaskSql} AND 'WEBSITE'::"TaskArea" = ANY(t.areas)
    AND ${dueSql} BETWEEN ${from}::date AND ${to}::date`;
  const milestonesWhere: Prisma.WorkProjectMilestoneWhereInput = {
    doneAt: null,
    dueOn: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
    workProject: { ...projectWhere(v), status: "ACTIVE" },
  };
  const [ids, [taskCount], milestones, milestoneCount] = await Promise.all([
    prisma.$queryRaw<{ id: string }[]>`SELECT t.id FROM "Task" t WHERE ${tasksWhere} ORDER BY ${dueSql}, t.id LIMIT ${ROWS}`,
    prisma.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM "Task" t WHERE ${tasksWhere}`,
    prisma.workProjectMilestone.findMany({
      where: milestonesWhere,
      orderBy: [{ dueOn: "asc" }, { id: "asc" }],
      take: ROWS,
      select: { id: true, title: true, dueOn: true, workProject: { select: { id: true, name: true } } },
    }),
    prisma.workProjectMilestone.count({ where: milestonesWhere }),
  ]);
  // No people list passed: toTaskDtos reads it only when there are rows (most weeks have no website task).
  const tasks = await toTaskDtos(scope, await rowsFor(ids.map((r) => r.id)));
  return {
    timeZone,
    from,
    to,
    website: { count: taskCount?.count ?? 0, tasks },
    milestones: {
      count: milestoneCount,
      items: milestones.map((m) => ({ id: m.id, title: m.title, dueOn: dayOf(m.dueOn)!, project: { id: m.workProject.id, name: m.workProject.name } })),
    },
  };
}
