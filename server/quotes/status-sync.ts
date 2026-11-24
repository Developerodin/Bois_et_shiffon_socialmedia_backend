import type { Quote } from "@prisma/client";
import { addDays, brandTimeZone, registerSync, type SyncOutcome, zoneToday } from "@/server/data/sources";
import { prisma } from "@/server/db/prisma";
import { closeQuoteReminders, reminderKey } from "@/server/quotes/quotes";
import { target } from "@/server/quotes/shopify-draft-orders";
import { TX } from "@/server/services/publishing";
import { askCartWriteAdapter, type ShopifyWriteAdapter } from "@/server/shopify/adapter";
import { canBeAssigned } from "@/server/tasks/access";
import { taskAudit } from "@/server/tasks/audit";
import { isUniqueViolation } from "@/server/tasks/errors";
import { quoteNumber } from "@/shared";

/**
 * SHOPIFY_QUOTES runner (plan 2026-11-24-phase-3-crm, Task 8b), once a day per brand with quotes, on the data.sync job
 * (so it gets lastResult, the sweep and Sync now). In order:
 *  1. Expiry: an open quote (CREATED or SENT) past its validUntil (30 brand days from the invoice send; never-sent
 *     quotes have none and don't expire) is EXPIRED; its Shopify draft is left for a person.
 *  2. Status: open quotes in Shopify are read back by id (the adapter's draft order carries status, order id and
 *     dates, never customer fields): COMPLETED → ACCEPTED with its order; gone → CANCELLED.
 *  3. Payment reminders: a quote still SENT 7 (then 21) brand days after its invoice gets a CRM task owned by whoever
 *     sent it, made once (Task.requestId), closed when the quote leaves SENT (closeQuoteReminders).
 * While AskCart's writes aren't connected, step 2 reads nothing; 1 and 3 still run.
 * ponytail: the 250 oldest open quotes per brand per day, one lookup each; past that the newer ones wait until older
 * ones close. Batch the reads (`nodes(ids:)`) in the adapter and page by createdAt once a brand keeps more open.
 */
const OPEN = ["CREATED", "SENT"] as const;
const READS = 250;
const REMINDER_DAYS = [21, 7] as const;

type Scope = { workspaceId: string; brandId: string };

/** The quote leaves SENT/CREATED for `status`, its reminders closed, in one transaction; false when it had moved on. */
async function settle(scope: Scope, q: Quote, status: "EXPIRED" | "ACCEPTED" | "CANCELLED", why: string, orderId: string | null = null) {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.quote.updateMany({ where: { id: q.id, workspaceId: scope.workspaceId, brandId: scope.brandId, status: q.status }, data: { status, ...(orderId ? { orderId } : {}) } });
    if (!count) return false;
    if (q.status === "SENT") await closeQuoteReminders(tx, q, why);
    await tx.auditEvent.create({ data: { workspaceId: scope.workspaceId, brandId: scope.brandId, actorUserId: null, action: `quote.${status.toLowerCase()}`, entityType: "Quote", entityId: q.id, metadata: { from: q.status, orderId } } });
    return true;
  }, TX);
}

/** A payment reminder for a SENT quote, made once per send day and day count; false when it exists already. */
async function remind(scope: Scope, q: Quote, sentDay: string, days: number) {
  const title = `Quote ${quoteNumber(q.number)}: no payment after ${days} days`;
  try {
    return await prisma.$transaction(async (tx) => {
      // The sender owns it while they may (crm.manage or inbox.read, and tasks.read); else it waits for someone to take it.
      const owner = q.sentById && (await canBeAssigned(tx, scope, q.sentById, { reviewerId: null, workProjectId: null, areas: ["CRM"] })) ? q.sentById : null;
      const task = await tx.task.create({
        data: {
          workspaceId: scope.workspaceId, brandId: scope.brandId, title, areas: ["CRM"], ownerId: owner, dueOn: new Date(`${addDays(sentDay, days)}T00:00:00Z`),
          description: "The customer hasn't paid this quote's Shopify invoice yet. Open the quote in Sales & CRM to follow up.", requestId: reminderKey(q.id, sentDay, days),
        },
        select: { id: true },
      });
      await taskAudit(tx, { ...scope, userId: null }, "task.create", { type: "Task", id: task.id, title }, { quoteId: q.id, source: "quote-reminder" });
      return true;
    }, TX);
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}

export async function syncQuoteStatus(scope: Scope, adapter: ShopifyWriteAdapter = askCartWriteAdapter, now = new Date()): Promise<SyncOutcome> {
  const zone = await brandTimeZone(scope);
  const today = zoneToday(zone, now);
  let count = 0;
  let reason: SyncOutcome["reason"] = null;

  const expired = await prisma.quote.findMany({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId, status: { in: [...OPEN] }, validUntil: { lt: new Date(`${today}T00:00:00Z`) } } });
  for (const q of expired) if (await settle(scope, q, "EXPIRED", "The quote expired")) count++;

  const open = await prisma.quote.findMany({
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId, status: { in: [...OPEN] }, shopifyId: { not: null } },
    orderBy: { createdAt: "asc" },
    take: READS,
  });
  for (const q of open) {
    const found = await adapter.lookupDraftOrder(target(scope), { id: q.shopifyId! });
    if (!found.ok) {
      // Not connected: nothing to read yet. A missing scope is the store app's, never the connection's.
      if (found.reason === "MISSING_SCOPE") reason = "permission";
      break;
    }
    const d = found.value;
    if (!d) {
      if (await settle(scope, q, "CANCELLED", "The draft order was deleted in Shopify")) count++;
    } else if (d.status === "COMPLETED") {
      if (await settle(scope, q, "ACCEPTED", "The customer paid: the quote is accepted", d.orderId)) count++;
    }
  }

  const sent = await prisma.quote.findMany({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId, status: "SENT", sentAt: { not: null } } });
  for (const q of sent) {
    const sentDay = zoneToday(zone, q.sentAt!);
    // Only the latest one due: a quote first seen on day 21 gets the 21-day reminder, not both.
    const due = REMINDER_DAYS.find((d) => today >= addDays(sentDay, d));
    if (due && (await remind(scope, q, sentDay, due))) count++;
  }
  return { count, reason };
}

registerSync("SHOPIFY_QUOTES", (ctx) => syncQuoteStatus(ctx.source));
