import type { NotificationKind } from "@prisma/client";
import type { Db } from "@/server/auth/permissions";

export type TaskNotice = { userId: string | null; workspaceId: string; brandId: string; kind: NotificationKind; taskId: string; actorId: string; auditEventId: string };

/**
 * One in-app notice for an event, written in the same transaction as its cause. Nobody is told about their own action.
 * The key `<kind>:<userId>:<auditEventId>` makes a retried write a no-op.
 */
export async function notifyTx(tx: Db, n: TaskNotice) {
  await notifyManyTx(tx, n.userId ? [n.userId] : [], n);
}

/** notifyTx for several people, and for several events at once (bulk assign), in one insert; the actor is left out. */
export async function notifyManyTx(tx: Db, userIds: string[], notices: Omit<TaskNotice, "userId"> | Omit<TaskNotice, "userId">[]) {
  const to = [...new Set(userIds)];
  const data = [notices].flat().flatMap((n) =>
    to.filter((id) => id !== n.actorId).map((userId) => ({ userId, workspaceId: n.workspaceId, brandId: n.brandId, kind: n.kind, taskId: n.taskId, actorId: n.actorId, dedupeKey: `${n.kind}:${userId}:${n.auditEventId}` })),
  );
  if (!data.length) return;
  await tx.notification.createMany({ data, skipDuplicates: true });
}

/**
 * Who is told a task is theirs (TASK_ASSIGNED): its owner, or every active person holding its owning role on the brand.
 * ponytail: one notice row per role holder; fine for teams of tens, a role-level notice if a role reaches hundreds.
 */
export async function assigneesOf(tx: Db, t: { workspaceId: string; brandId: string; ownerId: string | null; ownerRoleId: string | null }): Promise<string[]> {
  if (t.ownerId) return [t.ownerId];
  if (!t.ownerRoleId) return [];
  const holders = await tx.brandMember.findMany({
    where: { workspaceId: t.workspaceId, brandId: t.brandId, roleId: t.ownerRoleId, user: { status: "ACTIVE", deletedAt: null } },
    select: { userId: true },
  });
  return holders.map((h) => h.userId);
}
