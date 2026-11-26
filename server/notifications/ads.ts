import type { Prisma } from "@prisma/client";
import { keyHolders } from "@/server/auth/permissions";
import { prisma } from "@/server/db/prisma";
import { AD_ALERT_KEYS } from "@/server/tasks/access";

/**
 * Who gets a brand's AD_ALERT notices: active people holding brand.read and ads.read on it (role ∪ grant, workspace role
 * required: keyHolders), none while the brand is archived. The bell's read rule (visibleNotificationsSql) checks the
 * same keys at read time, so someone who loses them stops seeing the notice. Computed once per alerts job.
 * Ceiling: recipients are fixed when the alert is raised; someone given ads.read later doesn't get old notices.
 */
export async function adAlertRecipients(scope: { workspaceId: string; brandId: string }) {
  const brand = await prisma.brand.findFirst({ where: { id: scope.brandId, workspaceId: scope.workspaceId, status: { not: "ARCHIVED" } }, select: { id: true } });
  if (!brand) return [];
  return keyHolders(prisma, scope.workspaceId, scope.brandId, AD_ALERT_KEYS, { clients: true, activeOnly: true });
}

/**
 * One AD_ALERT notice per recipient for a newly raised alert, in the alert's transaction. No task and no actor; the
 * dedupe key makes a repeat write a no-op (notifyManyTx is task-shaped, so this is its own).
 */
export async function notifyAdAlert(tx: Prisma.TransactionClient, alert: { id: string; workspaceId: string; brandId: string }, recipients: readonly string[]) {
  if (!recipients.length) return;
  await tx.notification.createMany({
    data: recipients.map((userId) => ({
      kind: "AD_ALERT" as const,
      adAlertId: alert.id,
      workspaceId: alert.workspaceId,
      brandId: alert.brandId,
      userId,
      dedupeKey: `AD_ALERT:${userId}:${alert.id}`,
    })),
    skipDuplicates: true,
  });
}
