import type { NotificationKind } from "@prisma/client";
import type { Db } from "@/server/auth/permissions";

export type TaskNotice = { userId: string | null; workspaceId: string; brandId: string; kind: NotificationKind; taskId: string; actorId: string; auditEventId: string };

/**
 * One in-app notice for an event, written in the same transaction as its cause. Nobody is told about their own action.
 * The key `<kind>:<userId>:<auditEventId>` makes a retried write a no-op.
 */
export async function notifyTx(tx: Db, n: TaskNotice) {
  if (!n.userId || n.userId === n.actorId) return;
  await tx.notification.createMany({
    data: [{ userId: n.userId, workspaceId: n.workspaceId, brandId: n.brandId, kind: n.kind, taskId: n.taskId, actorId: n.actorId, dedupeKey: `${n.kind}:${n.userId}:${n.auditEventId}` }],
    skipDuplicates: true,
  });
}
