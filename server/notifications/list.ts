import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { requireWorkspaceMember } from "@/server/auth/access";
import { requestUserId } from "@/server/auth/request-user";
import { TEAM_MEMBER, personName } from "@/server/content/person-name";
import { prisma } from "@/server/db/prisma";
import { visibleTasksAcrossSql } from "@/server/tasks/access";
import { TaskError, taskProblem } from "@/server/tasks/errors";
import type { NotificationDto, NotificationPageDto } from "@/shared";

const PAGE = 20; // the query reads PAGE + 1 (LIMIT 21) to know if there is more
// The count stops at 100 (LIMIT 100): the bell shows "99+" past that, so counting further is wasted work.

/** Every notification read joins its task as `t`, so the task visibility rule applies. */
const FROM = Prisma.sql`FROM "Notification" n JOIN "Task" t ON t.id = n."taskId"`;

/**
 * The person's notifications in one workspace that are about tasks they can still see (visibleTasksAcrossSql, the one
 * multi-brand visibility rule), so list and count always agree, also after someone loses access.
 */
export async function notificationWhereSql(userId: string, workspaceId: string): Promise<Prisma.Sql> {
  return Prisma.sql`n."userId" = ${userId} AND n."workspaceId" = ${workspaceId} AND ${await visibleTasksAcrossSql(userId, workspaceId, "t")}`;
}

const Cursor = z.object({ createdAt: z.iso.datetime(), id: z.string().min(1).max(100) });

function decodeCursor(s: string) {
  let raw: unknown = null;
  try {
    raw = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
  } catch {
    // fall through to the 400 below
  }
  const key = Cursor.safeParse(raw);
  if (!key.success) throw new TaskError("Invalid cursor", 400);
  return key.data;
}

type Row = {
  id: string; kind: string; brandId: string; taskId: string | null; taskTitle: string | null; actorId: string | null;
  actorName: string | null; actorEmail: string | null; actorGone: boolean | null; readAt: Date | null; createdAt: Date;
};

/** Newest first, 20 a page; `nextCursor` is null on the last page. */
export async function listNotifications(userId: string, workspaceId: string, cursor?: string): Promise<NotificationPageDto> {
  const after = cursor ? decodeCursor(cursor) : null;
  const where = [await notificationWhereSql(userId, workspaceId)];
  if (after) where.push(Prisma.sql`(n."createdAt", n.id) < (${after.createdAt}::timestamp, ${after.id})`);
  const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
    SELECT n.id, n.kind::text AS kind, n."brandId", n."taskId", t.title AS "taskTitle", n."actorId", a.name AS "actorName",
           a.email AS "actorEmail", (a."deletedAt" IS NOT NULL OR a.status <> 'ACTIVE') AS "actorGone", n."readAt", n."createdAt"
    ${FROM} LEFT JOIN "User" a ON a.id = n."actorId"
    WHERE ${Prisma.join(where, " AND ")}
    ORDER BY n."createdAt" DESC, n.id DESC
    LIMIT 21`);
  const page = rows.slice(0, PAGE);
  const last = page.at(-1);
  return {
    notifications: page.map(toDto),
    nextCursor: rows.length > PAGE && last ? Buffer.from(JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id })).toString("base64url") : null,
  };
}

function toDto(r: Row): NotificationDto {
  const actor = r.actorId
    ? r.actorEmail === null
      ? { id: r.actorId, name: TEAM_MEMBER, gone: true }
      : { id: r.actorId, name: personName({ name: r.actorName, email: r.actorEmail }, { reveal: false }), gone: !!r.actorGone }
    : null;
  return { id: r.id, kind: r.kind, brandId: r.brandId, taskId: r.taskId, taskTitle: r.taskTitle, actor, readAt: r.readAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() };
}

/** Unread notifications, counted up to 100. */
export async function countUnread(userId: string, workspaceId: string): Promise<number> {
  const [row] = await prisma.$queryRaw<{ count: number }[]>(Prisma.sql`
    SELECT count(*)::int AS count FROM (SELECT 1 ${FROM} WHERE ${await notificationWhereSql(userId, workspaceId)} AND n."readAt" IS NULL LIMIT 100) x`);
  return row?.count ?? 0;
}

/** Mark the person's own notifications read in this workspace; ids of anyone else's match nothing. */
export async function markRead(userId: string, workspaceId: string, ids: string[] | "all") {
  const { count } = await prisma.notification.updateMany({
    where: { userId, workspaceId, readAt: null, ...(ids === "all" ? {} : { id: { in: ids } }) },
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
