import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { DEFAULT_TIME_ZONE } from "@/server/catalog/campaigns";
import { addDays, brandTimeZone, zoneToday } from "@/server/data/sources";
import { visibleTaskSql, type TaskViewer } from "@/server/tasks/access";
import { projectWhere } from "@/server/tasks/projects";
import { dayOf, type TaskScope } from "@/server/tasks/service";
import { dueSql, openTaskSql } from "@/server/tasks/sql";
import type { UpcomingDto } from "@/shared";

/** Rows of each kind the Overview gets; the counts cover the whole window. */
const ROWS = 10;
/** Today through today + 6: seven brand-local days. */
const WINDOW_DAYS = 7;

/**
 * The Overview's next 7 days: open website tasks due in the window (visibleTaskSql, so a client sees only shared ones
 * and staff without tasks.all only their own) and milestones not done in an active project the caller can see
 * (projectWhere). One read for the brand's zone, then the four reads in parallel. Overdue work is left to Today.
 * Tasks come back as id, title and due day only (the Overview opens the full task in its peek), so no DTO work runs.
 * ponytail: the zone comes from BrandProfile in JS (zoneToday), as the data tabs do; brandLocalDay does the same in SQL.
 */
export async function upcomingWork(scope: TaskScope, v: TaskViewer, now = new Date()): Promise<UpcomingDto> {
  let timeZone = await brandTimeZone(scope);
  let from: string;
  try {
    from = zoneToday(timeZone, now);
  } catch {
    // A stored zone Intl doesn't know: the default, rather than a 500 on every poll.
    timeZone = DEFAULT_TIME_ZONE;
    from = zoneToday(timeZone, now);
  }
  const to = addDays(from, WINDOW_DAYS - 1);
  // Filtered on dueSql, the expression the (brand, due, id) indexes have; an undated task is 'infinity', never in range.
  const tasksWhere = Prisma.sql`${visibleTaskSql(v)} AND ${openTaskSql} AND 'WEBSITE'::"TaskArea" = ANY(t.areas)
    AND ${dueSql} BETWEEN ${from}::date AND ${to}::date`;
  const milestonesWhere: Prisma.WorkProjectMilestoneWhereInput = {
    doneAt: null,
    dueOn: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
    workProject: { ...projectWhere(v), status: "ACTIVE" },
  };
  const [tasks, [taskCount], milestones, milestoneCount] = await Promise.all([
    prisma.$queryRaw<{ id: string; title: string; dueOn: Date }[]>`SELECT t.id, t.title, t."dueOn" FROM "Task" t WHERE ${tasksWhere} ORDER BY ${dueSql}, t.id LIMIT ${ROWS}`,
    prisma.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM "Task" t WHERE ${tasksWhere}`,
    prisma.workProjectMilestone.findMany({
      where: milestonesWhere,
      orderBy: [{ dueOn: "asc" }, { id: "asc" }],
      take: ROWS,
      select: { id: true, title: true, dueOn: true, workProject: { select: { id: true, name: true } } },
    }),
    prisma.workProjectMilestone.count({ where: milestonesWhere }),
  ]);
  return {
    timeZone,
    from,
    to,
    website: { count: taskCount?.count ?? 0, tasks: tasks.map((t) => ({ id: t.id, title: t.title, dueOn: dayOf(t.dueOn)! })) },
    milestones: {
      count: milestoneCount,
      items: milestones.map((m) => ({ id: m.id, title: m.title, dueOn: dayOf(m.dueOn)!, project: { id: m.workProject.id, name: m.workProject.name } })),
    },
  };
}
