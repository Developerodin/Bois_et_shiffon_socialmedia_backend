import type { Prisma } from "@prisma/client";
import type { Db } from "@/server/auth/permissions";

type Entity = { type: "Task" | "WorkProject" | "TaskComment"; id: string; title?: string };

/** One AuditEvent for a task-feature write, in the caller's transaction. The title is kept so deletes and cancels still read. */
export function taskAudit(tx: Db, scope: { workspaceId: string; brandId: string; userId: string }, action: string, entity: Entity, metadata?: Record<string, unknown>) {
  return tx.auditEvent.create({
    data: {
      workspaceId: scope.workspaceId,
      brandId: scope.brandId,
      actorUserId: scope.userId,
      action,
      entityType: entity.type,
      entityId: entity.id,
      metadata: { ...(entity.title !== undefined ? { title: entity.title } : {}), ...metadata } as Prisma.InputJsonObject,
    },
    select: { id: true },
  });
}
