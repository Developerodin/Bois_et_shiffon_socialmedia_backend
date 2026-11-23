import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { brandLocalDay, openTaskSql } from "@/server/tasks/sql";

// ponytail: runs at 05:00 UTC; brands west of UTC hear a day late. Hourly sweep firing per brand-local day if that matters.
// ponytail: notices go to t."ownerId" only, so a task a role owns gets no overdue or re-check notice until someone
// takes it; tell the role's holders (assigneesOf) if those tasks start slipping.

const OPEN = openTaskSql;
/** The task's brand-local day at `now` (brandLocalDay; the queries join the task's BrandProfile as bp). */
const localDay = brandLocalDay;

/**
 * One notice per owned task matching `where`, keyed `<kind>:<owner>:<task>:<key>` (`key`: text, default the brand-local
 * yyyy-mm-dd), so a second sweep with the same key adds nothing. Returns how many were written.
 * ponytail: an invalid stored time zone fails the whole statement (every brand misses that day); validate it where
 * the profile is written.
 */
function notifyOwners(kind: "TASK_OVERDUE" | "TASK_RECHECK", now: Date, where: Prisma.Sql, key: Prisma.Sql = Prisma.sql`to_char(${localDay(now)}, 'YYYY-MM-DD')`) {
  return prisma.$executeRaw`
    INSERT INTO "Notification" (id, "userId", "workspaceId", "brandId", kind, "taskId", "dedupeKey")
    SELECT gen_random_uuid()::text, t."ownerId", t."workspaceId", t."brandId", ${kind}::"NotificationKind", t.id,
           ${kind}::text || ':' || t."ownerId" || ':' || t.id || ':' || ${key}
    FROM "Task" t LEFT JOIN "BrandProfile" bp ON bp."brandId" = t."brandId"
    WHERE ${where} AND t."ownerId" IS NOT NULL
    ON CONFLICT ("dedupeKey") DO NOTHING`;
}

/**
 * TASK_OVERDUE to the owner of every open task whose due day has passed in its brand's time zone: once when it goes
 * overdue, then once a week while it stays open. Keyed by the due day and the overdue week, so a missed sweep is caught
 * up the next day and a new due date starts over.
 */
export function notifyOverdueTasks(now: Date) {
  const today = localDay(now);
  return notifyOwners(
    "TASK_OVERDUE",
    now,
    Prisma.sql`${OPEN} AND t."dueOn" < ${today}`,
    Prisma.sql`to_char(t."dueOn", 'YYYY-MM-DD') || ':w' || ((${today} - t."dueOn" - 1) / 7)::text`,
  );
}

/**
 * TASK_RECHECK to the owner of every DONE task whose re-check day is today or in the past week (brand-local), keyed by
 * recheckOn so each re-check day is sent once: a missed sweep or DST skip is caught up next run. The week bound keeps
 * the 90-day prune from letting an old one replay.
 */
export function notifyRechecks(now: Date) {
  const today = localDay(now);
  return notifyOwners("TASK_RECHECK", now, Prisma.sql`t.status = 'DONE' AND t."recheckOn" <= ${today} AND t."recheckOn" > ${today} - 7`, Prisma.sql`to_char(t."recheckOn", 'YYYY-MM-DD')`);
}

/** Notices are kept 90 days. */
export async function pruneNotifications(now: Date) {
  return (await prisma.notification.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 90 * 86_400_000) } } })).count;
}
