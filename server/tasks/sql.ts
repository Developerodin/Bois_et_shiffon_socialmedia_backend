import "server-only";
import { Prisma } from "@prisma/client";
import { DEFAULT_TIME_ZONE } from "@/server/catalog/campaigns";
import { OPEN_TASK_STATUSES } from "@/shared";

/**
 * `t.status IN ('A','B')` as a literal, so the planner matches the partial indexes (WHERE status IN (...)). The only
 * Prisma.raw for tasks, built from code constants; the Task row must be aliased `t`.
 */
export const taskStatusInSql = (statuses: readonly (typeof OPEN_TASK_STATUSES)[number][]) =>
  Prisma.raw(`t.status IN (${statuses.map((s) => `'${s}'`).join(",")})`);

/** Open tasks (to do, in progress, in review). */
export const openTaskSql = taskStatusInSql(OPEN_TASK_STATUSES);

/**
 * The brand-local day at `now`: the brand profile's time zone, else DEFAULT_TIME_ZONE (passed as a value). Reads
 * `bp."timeZone"`, so the query must join "BrandProfile" bp.
 * ponytail: an invalid stored time zone makes the query fail; the profile writers are where to validate it.
 */
export const brandLocalDay = (now: Date) => Prisma.sql`(${now.toISOString()}::timestamptz AT TIME ZONE COALESCE(bp."timeZone", ${DEFAULT_TIME_ZONE}))::date`;
