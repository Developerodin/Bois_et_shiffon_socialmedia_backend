import type { Prisma } from "@prisma/client";
import { SEO_ALERT_KEYS } from "@/server/auth/permissions";
import { alertRecipients } from "@/server/notifications/ads";

/**
 * Who gets a brand's SEO_ALERT notices: active people holding brand.read and analytics.read on it (role ∪ grant,
 * workspace role required: keyHolders; client reviewers included, as the Search tab), none while the brand is archived.
 * The bell's read rule (visibleNotificationsSql) checks the same keys at read time. Computed once per run that notifies.
 * Ceiling, as ads: recipients are fixed when the alerts are raised.
 */
export const seoAlertRecipients = (scope: { workspaceId: string; brandId: string }) => alertRecipients(scope, SEO_ALERT_KEYS);

/**
 * One SEO_ALERT notice per recipient for a decline run that raised new alerts, pointing at the run's lead alert, in the
 * run's transaction: a crash loses the alerts and the notices together, and a rerun (which inserts no alert) writes
 * none. The dedupe key is per person and run, so a repeat is a no-op.
 */
export async function notifySeoAlerts(
  tx: Prisma.TransactionClient,
  run: { leadAlertId: string; runKey: string; workspaceId: string; brandId: string },
  recipients: readonly string[],
) {
  if (!recipients.length) return;
  await tx.notification.createMany({
    data: recipients.map((userId) => ({
      kind: "SEO_ALERT" as const,
      seoAlertId: run.leadAlertId,
      workspaceId: run.workspaceId,
      brandId: run.brandId,
      userId,
      dedupeKey: `SEO_ALERT:${userId}:${run.runKey}`,
    })),
    skipDuplicates: true,
  });
}
