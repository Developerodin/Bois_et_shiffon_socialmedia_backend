import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { brandLocalDay, openTaskSql } from "@/server/tasks/sql";

// ponytail: runs at 05:00 UTC; brands west of UTC hear a day late. Hourly sweep firing per brand-local day if that matters.

const OPEN = openTaskSql;
/** The task's brand-local day at `now` (brandLocalDay; the queries join the task's BrandProfile as bp). */
const localDay = brandLocalDay;

/**
 * One notice per owned task matching `where`, keyed `<kind>:<owner>:<task>:<brand-local yyyy-mm-dd>`, so a second
 * sweep the same brand-local day adds nothing. Returns how many were written.
 * ponytail: an invalid stored time zone fails the whole statement (every brand misses that day); validate it where
 * the profile is written.
 */
function notifyOwners(kind: "TASK_OVERDUE" | "TASK_RECHECK", now: Date, where: Prisma.Sql) {
  const today = localDay(now);
  return prisma.$executeRaw`
    INSERT INTO "Notification" (id, "userId", "workspaceId", "brandId", kind, "taskId", "dedupeKey")
    SELECT gen_random_uuid()::text, t."ownerId", t."workspaceId", t."brandId", ${kind}::"NotificationKind", t.id,
           ${kind}::text || ':' || t."ownerId" || ':' || t.id || ':' || to_char(${today}, 'YYYY-MM-DD')
    FROM "Task" t LEFT JOIN "BrandProfile" bp ON bp."brandId" = t."brandId"
    WHERE ${where} AND t."ownerId" IS NOT NULL
    ON CONFLICT ("dedupeKey") DO NOTHING`;
}

/** TASK_OVERDUE to the owner of every open task whose due day has passed in its brand's time zone. */
export function notifyOverdueTasks(now: Date) {
  return notifyOwners("TASK_OVERDUE", now, Prisma.sql`${OPEN} AND t."dueOn" < ${localDay(now)}`);
}

/** TASK_RECHECK to the owner of every DONE task whose re-check day is today in its brand's time zone. */
export function notifyRechecks(now: Date) {
  return notifyOwners("TASK_RECHECK", now, Prisma.sql`t.status = 'DONE' AND t."recheckOn" = ${localDay(now)}`);
}

/** Notices are kept 90 days. */
export async function pruneNotifications(now: Date) {
  return (await prisma.notification.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 90 * 86_400_000) } } })).count;
}
