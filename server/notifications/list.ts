import "server-only";
import { type NotificationKind, Prisma } from "@prisma/client";
import { z } from "zod";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { requireWorkspaceMember } from "@/server/auth/access";
import { requestUserId } from "@/server/auth/request-user";
import { TEAM_MEMBER, personName } from "@/server/content/person-name";
import { prisma } from "@/server/db/prisma";
import { clientMemberSql, visibleNotificationsSql } from "@/server/tasks/access";
import { adAlertText } from "@/server/ads/alerts";
import { fromCursor, toCursor } from "@/server/tasks/cursor";
import { taskProblem } from "@/server/tasks/errors";
import type { AdAlertKind, NotificationDto, NotificationPageDto } from "@/shared";

const PAGE = 20; // the query reads PAGE + 1 (LIMIT 21) to know if there is more
// The count stops at 100 (LIMIT 100): the bell shows "99+" past that, so counting further is wasted work.

/**
 * Every notification read left-joins its task as `t` (an AD_ALERT notice has none), so the task visibility rule
 * applies to task notices and the ads rule to alert notices (visibleNotificationsSql).
 */
const FROM = Prisma.sql`FROM "Notification" n LEFT JOIN "Task" t ON t.id = n."taskId"`;

/**
 * The person's notifications in one workspace that they may still see: task notices about tasks they can still see
 * (visibleTasksAcrossSql's multi-brand rule), ads alerts on brands where they still hold brand.read and ads.read. List
 * and count use it, so they always agree, also after someone loses access.
 */
export async function notificationWhereSql(userId: string, workspaceId: string): Promise<Prisma.Sql> {
  return Prisma.sql`n."userId" = ${userId} AND n."workspaceId" = ${workspaceId} AND ${await visibleNotificationsSql(userId, workspaceId)}`;
}

const Cursor = z.object({ createdAt: z.iso.datetime(), id: z.string().min(1).max(100) });

type Row = {
  id: string; kind: string; brandId: string; taskId: string | null; taskTitle: string | null; actorId: string | null;
  actorName: string | null; actorEmail: string | null; actorGone: boolean | null; actorClient: boolean | null; readAt: Date | null; createdAt: Date;
  alertKind: AdAlertKind | null; alertAccountId: string | null; alertCampaignName: string | null; alertCurrency: string | null; alertValues: unknown;
  count?: number;
};

const COLUMNS = (n: Prisma.Sql) => Prisma.sql`n.id, n.kind::text AS kind, n."brandId", n."taskId", t.title AS "taskTitle", n."actorId", a.name AS "actorName",
           a.email AS "actorEmail", (a."deletedAt" IS NOT NULL OR a.status <> 'ACTIVE') AS "actorGone",
           ${n} AS "actorClient", n."readAt", n."createdAt", al.kind::text AS "alertKind", al."accountId" AS "alertAccountId",
           al."campaignName" AS "alertCampaignName", al.currency AS "alertCurrency", al."values" AS "alertValues"`;
/** An AD_ALERT notice's alert, for its text (same brand, so a notice can't show another brand's alert). */
const ALERT = Prisma.sql`LEFT JOIN "AdAlert" al ON al.id = n."adAlertId" AND al."brandId" = n."brandId"`;

/**
 * Unread notices come first, one row per kind and business (the newest, with `count`), so a morning of overdue tasks
 * or a burst of assignments is one line; then read ones newest first, 20 a page (`nextCursor` pages the read ones).
 * ponytail: groups are recounted on every open; at most kinds × businesses rows, so no paging for them.
 */
export async function listNotifications(userId: string, workspaceId: string, cursor?: string): Promise<NotificationPageDto> {
  const after = cursor ? fromCursor(Cursor, cursor) : null;
  const base = await notificationWhereSql(userId, workspaceId);
  const actorClient = clientMemberSql(Prisma.sql`n."actorId"`, Prisma.sql`n."brandId"`, Prisma.sql`n."workspaceId"`);
  const where = [base, Prisma.sql`n."readAt" IS NOT NULL`];
  if (after) where.push(Prisma.sql`(n."createdAt", n.id) < (${after.createdAt}::timestamp, ${after.id})`);
  const [groups, rows] = await Promise.all([
    after
      ? Promise.resolve([] as Row[])
      : prisma.$queryRaw<Row[]>(Prisma.sql`
    SELECT * FROM (
      SELECT DISTINCT ON (n.kind, n."brandId") ${COLUMNS(actorClient)},
             (count(*) OVER (PARTITION BY n.kind, n."brandId"))::int AS count
      ${FROM} LEFT JOIN "User" a ON a.id = n."actorId" ${ALERT}
      WHERE ${base} AND n."readAt" IS NULL
      ORDER BY n.kind, n."brandId", n."createdAt" DESC, n.id DESC
    ) g ORDER BY "createdAt" DESC, id DESC`),
    prisma.$queryRaw<Row[]>(Prisma.sql`
    SELECT ${COLUMNS(actorClient)}
    ${FROM} LEFT JOIN "User" a ON a.id = n."actorId" ${ALERT}
    WHERE ${Prisma.join(where, " AND ")}
    ORDER BY n."createdAt" DESC, n.id DESC
    LIMIT 21`),
  ]);
  const page = rows.slice(0, PAGE);
  const last = page.at(-1);
  return {
    notifications: [...groups, ...page].map(toDto),
    nextCursor: rows.length > PAGE && last ? toCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null,
  };
}

function toDto(r: Row): NotificationDto {
  const actor = r.actorId
    ? r.actorEmail === null
      ? { id: r.actorId, name: TEAM_MEMBER, gone: true, client: !!r.actorClient }
      : { id: r.actorId, name: personName({ name: r.actorName, email: r.actorEmail }, { reveal: false }), gone: !!r.actorGone, client: !!r.actorClient }
    : null;
  const alert = r.alertKind
    ? { kind: r.alertKind, text: adAlertText({ kind: r.alertKind, accountId: r.alertAccountId, campaignName: r.alertCampaignName, currency: r.alertCurrency ?? "", values: r.alertValues }) }
    : null;
  return { id: r.id, kind: r.kind, count: r.count ?? 1, brandId: r.brandId, taskId: r.taskId, taskTitle: r.taskTitle, actor, alert, readAt: r.readAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() };
}

/** Unread notifications, counted up to 100. */
export async function countUnread(userId: string, workspaceId: string): Promise<number> {
  // The unread rows are fenced (OFFSET 0) so the planner reads them through the (userId, workspaceId, readAt) index.
  // Without it, the LIMIT over the join made it seq-scan Notification on every bell poll: 38 ms at 1M rows, 0 unread.
  const [row] = await prisma.$queryRaw<{ count: number }[]>(Prisma.sql`
    SELECT count(*)::int AS count FROM (
      SELECT 1 FROM (
        SELECT "taskId", "userId", "workspaceId", "kind", "brandId", "adAlertId" FROM "Notification"
        WHERE "userId" = ${userId} AND "workspaceId" = ${workspaceId} AND "readAt" IS NULL OFFSET 0
      ) n LEFT JOIN "Task" t ON t.id = n."taskId"
      WHERE ${await notificationWhereSql(userId, workspaceId)} LIMIT 100) x`);
  return row?.count ?? 0;
}

/** Mark the person's own notifications read in this workspace; ids of anyone else's match nothing. */
export type ReadWhich = string[] | "all" | { kind: NotificationKind; brandId: string; upTo: string };

/** Mark the person's own unread notices read: by id, all, or a bell group (one kind on one business, up to its newest). */
export async function markRead(userId: string, workspaceId: string, which: ReadWhich) {
  const filter = which === "all" ? {} : Array.isArray(which) ? { id: { in: which } } : { kind: which.kind, brandId: which.brandId, createdAt: { lte: new Date(which.upTo) } };
  const { count } = await prisma.notification.updateMany({
    where: { userId, workspaceId, readAt: null, ...filter },
    data: { readAt: new Date() },
  });
  return count;
}

/**
 * The /me/notifications routes: signed in, and a member of the workspace named by X-Workspace-Id (the current one).
 * Runs `handler` with the scope and answers its errors as problem+json.
 */
export async function notificationRoute(request: Request, handler: (userId: string, workspaceId: string) => Promise<Response>) {
  const userId = await requestUserId(request);
  if (!userId) return problemResponse({ type: "https://api.brandpilot/errors/unauthorized", title: "Unauthorized", status: 401, detail: "Sign in required" });
  const workspaceId = request.headers.get("X-Workspace-Id");
  if (!workspaceId) return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid request", status: 400, detail: "X-Workspace-Id is required" });
  try {
    await requireWorkspaceMember(workspaceId, userId);
    return await handler(userId, workspaceId);
  } catch (error) {
    return taskProblem(error) ?? fromAccessError(error);
  }
}
