import type { Quote } from "@prisma/client";
import { addDays, brandTimeZone, registerSync, type SyncOutcome, zoneToday } from "@/server/data/sources";
import { prisma } from "@/server/db/prisma";
import { closeQuoteReminders, reminderKey } from "@/server/quotes/quotes";
import { target } from "@/server/quotes/shopify-draft-orders";
import { TX } from "@/server/services/publishing";
import { askCartWriteAdapter, type ShopifyWriteAdapter } from "@/server/shopify/adapter";
import { shopifyMcpOnly } from "@/server/shopify/writes";
import { canBeAssigned } from "@/server/tasks/access";
import { taskAudit } from "@/server/tasks/audit";
import { isUniqueViolation } from "@/server/tasks/errors";
import { quoteNumber } from "@/shared";

/**
 * SHOPIFY_QUOTES runner (plan 2026-11-24-phase-3-crm, Task 8b), once a day per brand with quotes, on the data.sync job
 * (so it gets lastResult, the sweep and Sync now). In order:
 *  1. Status: quotes in Shopify are read back by id (the adapter's draft order carries status, order id, dates and
 *     what it holds, never customer fields): COMPLETED → ACCEPTED with its order; gone → CANCELLED. Open quotes first,
 *     then cancelled or expired ones of the last 60 days, whose Shopify invoice can still be paid (→ ACCEPTED, noted).
 *     A lookup that throws skips that quote only.
 *  2. Expiry, after the reads: an open quote past its validUntil whose read succeeded today (or that isn't in Shopify)
 *     is EXPIRED, so a quote paid on its last day is ACCEPTED, never expired, even after days of failed reads.
 *     validUntil is the send day + 30, that day included: expired from the next brand day. Never-sent quotes have
 *     none and don't expire. The Shopify draft is left for a person.
 *  3. Payment reminders: a quote still SENT 7 (then 21) brand days after its invoice gets a CRM task owned by whoever
 *     sent it, made once per send (Task.requestId), closed when the quote leaves SENT or is sent again.
 * While AskCart's writes aren't connected, step 1 reads nothing (and open quotes in Shopify don't expire); 3 still runs.
 * ponytail: 250 lookups per brand per day, oldest first; past that the run reports "partial" and the rest wait. Batch
 * the reads (`nodes(ids:)`) in the adapter and page by createdAt once a brand keeps more.
 */
const OPEN = ["CREATED", "SENT"] as const;
const READS = 250;
/** How long a cancelled or expired quote's Shopify invoice is still watched for a payment. */
const CLOSED_WATCH_DAYS = 60;
const REMINDER_DAYS = [21, 7] as const;

type Scope = { workspaceId: string; brandId: string };

/** The quote leaves SENT/CREATED for `status`, its reminders closed, in one transaction; false when it had moved on. */
async function settle(scope: Scope, q: Quote, status: "EXPIRED" | "ACCEPTED" | "CANCELLED", why: string, orderId: string | null = null) {
  // Paid after it was closed here: the team's note says so (the internal note is never sent).
  const late = status === "ACCEPTED" && (q.status === "CANCELLED" || q.status === "EXPIRED");
  const note = late ? [`Paid in Shopify after it was ${q.status === "CANCELLED" ? "cancelled" : "expired"} here.`, q.internalNote].filter(Boolean).join("\n").slice(0, 2000) : undefined;
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.quote.updateMany({ where: { id: q.id, workspaceId: scope.workspaceId, brandId: scope.brandId, status: q.status }, data: { status, ...(orderId ? { orderId } : {}), ...(note ? { internalNote: note } : {}) } });
    if (!count) return false;
    if (q.status === "SENT") await closeQuoteReminders(tx, q, why);
    await tx.auditEvent.create({ data: { workspaceId: scope.workspaceId, brandId: scope.brandId, actorUserId: null, action: `quote.${status.toLowerCase()}`, entityType: "Quote", entityId: q.id, metadata: { from: q.status, orderId, ...(late ? { late: true } : {}) } } });
    return true;
  }, TX);
}

/** A payment reminder for a SENT quote, made once per send and day count; false when it exists already. */
async function remind(scope: Scope, q: Quote, sentDay: string, days: number) {
  const title = `Quote ${quoteNumber(q.number)}: no payment after ${days} days`;
  try {
    return await prisma.$transaction(async (tx) => {
      // The sender owns it while they may (crm.manage or inbox.read, and tasks.read); else it waits for someone to take it.
      const owner = q.sentById && (await canBeAssigned(tx, scope, q.sentById, { reviewerId: null, workProjectId: null, areas: ["CRM"] })) ? q.sentById : null;
      const task = await tx.task.create({
        data: {
          workspaceId: scope.workspaceId, brandId: scope.brandId, title, areas: ["CRM"], ownerId: owner, dueOn: new Date(`${addDays(sentDay, days)}T00:00:00Z`),
          description: "The customer hasn't paid this quote's Shopify invoice yet. Open the quote in Sales & CRM to follow up.", requestId: reminderKey(q.id, q.sentAt!, days),
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
  // Shopify MCP reads the catalogue only: draft orders can't be read back, so nothing is asked and nothing expires.
  if (await shopifyMcpOnly(scope)) return { count: 0, reason: "permission" };
  const zone = await brandTimeZone(scope);
  const today = zoneToday(zone, now);
  const where = { workspaceId: scope.workspaceId, brandId: scope.brandId, shopifyId: { not: null } };
  let count = 0;
  let reason: SyncOutcome["reason"] = null;

  const open = await prisma.quote.findMany({ where: { ...where, status: { in: [...OPEN] } }, orderBy: { createdAt: "asc" }, take: READS + 1 });
  const closed = await prisma.quote.findMany({
    where: { ...where, status: { in: ["CANCELLED", "EXPIRED"] }, updatedAt: { gte: new Date(now.getTime() - CLOSED_WATCH_DAYS * 86_400_000) } },
    orderBy: { createdAt: "asc" },
    take: READS + 1,
  });
  const toRead = [...open, ...closed];
  if (toRead.length > READS) reason = "partial";
  const read = new Set<string>();
  for (const q of toRead.slice(0, READS)) {
    let found: Awaited<ReturnType<ShopifyWriteAdapter["lookupDraftOrder"]>>;
    try {
      found = await adapter.lookupDraftOrder(target(scope), { id: q.shopifyId! });
    } catch (e) {
      // This quote only: the rest are still read, and it isn't expired today. Logged by error name (adapter text can carry anything).
      console.warn("[quotes] status read failed", q.id, e instanceof Error ? e.name : "error");
      reason ??= "partial";
      continue;
    }
    if (!found.ok) {
      // Not connected: nothing can be read. A missing scope is the store app's, never the connection's.
      if (found.reason === "MISSING_SCOPE") reason = "permission";
      break;
    }
    read.add(q.id);
    const d = found.value;
    if (!d) {
      if (q.status !== "CANCELLED" && q.status !== "EXPIRED" && (await settle(scope, q, "CANCELLED", "The draft order was deleted in Shopify"))) count++;
    } else if (d.status === "COMPLETED") {
      if (await settle(scope, q, "ACCEPTED", "The customer paid: the quote is accepted", d.orderId)) count++;
    }
  }

  const expired = await prisma.quote.findMany({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId, status: { in: [...OPEN] }, validUntil: { lt: new Date(`${today}T00:00:00Z`) } } });
  for (const q of expired) {
    if (q.shopifyId && !read.has(q.id)) continue;
    if (await settle(scope, q, "EXPIRED", "The quote expired")) count++;
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
