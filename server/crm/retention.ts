import { prisma } from "@/server/db/prisma";
import type { Prisma } from "@prisma/client";
import { blankQuotes, eraseCustomers } from "@/server/crm/erase";
import { TX } from "@/server/services/publishing";
import { closeTasks } from "@/server/tasks/system-tasks";

/**
 * CRM retention (plan 2026-11-27-crm, Decision 18), from the daily sweep (server/crm/sweep.ts):
 *  1. Messages: kept 13 months from sentAt (owner, 2026-11-24), deleted in chunks; a conversation left empty goes with
 *     its follow-up task closed, and a summary built from deleted messages is cleared.
 *  2. Customers: deleted 24 months after their last activity (owner O6). `lastActivityAt` only picks candidates; the
 *     query re-checks the rows themselves (customer, notes, conversations, deals, linked quotes) and again inside the
 *     erasing transaction, so an irreversible delete never trusts a stale hint. Customers with a SHOPIFY identity
 *     are skipped (they go with their source, Phase C). Erased through eraseCustomers, audited per customer.
 *  3. Deals with no customer, and companies with no customers or deals, 24 months after their last change.
 *  4. Closed quotes not linked to anyone are blanked like an erased customer's (blankQuotes) 24 months after their
 *     last change (the Shopify order stays the accounting record). Quotes found only by an erased customer's email
 *     are blanked here only when closed and older than the cut, so someone who came back keeps their new quote.
 * ponytail: at most 50k messages and 5k customers per sweep, within about 60 s; a backlog drains over the next days.
 */
const DAY = 86_400_000;
export const MESSAGE_DAYS = 396;
export const RECORD_DAYS = 730;
const MESSAGE_CHUNK = 5_000;
const MESSAGE_MAX = 50_000;
const CUSTOMER_BATCH = 500;
const CUSTOMER_MAX = 5_000;
const BUDGET_MS = 60_000;

/** Inactive customers (all activity before `cut`), optionally only among `ids`. */
function inactiveCustomers(db: Prisma.TransactionClient | typeof prisma, cut: Date, ids: string[] | null, limit: number) {
  return db.$queryRaw<{ id: string; workspaceId: string; brandId: string }[]>`
    SELECT c.id, c."workspaceId", c."brandId" FROM "Customer" c
    WHERE c."lastActivityAt" < ${cut} AND c."updatedAt" < ${cut}
      AND (${ids === null} OR c.id = ANY(${ids ?? []}::text[]))
      AND NOT EXISTS (SELECT 1 FROM "CustomerIdentity" i WHERE i."customerId" = c.id AND i.kind = 'SHOPIFY')
      AND NOT EXISTS (SELECT 1 FROM "CustomerNote" n WHERE n."customerId" = c.id AND n."createdAt" >= ${cut})
      AND NOT EXISTS (SELECT 1 FROM "Conversation" v WHERE v."customerId" = c.id AND (v."lastMessageAt" >= ${cut} OR v."updatedAt" >= ${cut}))
      AND NOT EXISTS (SELECT 1 FROM "Deal" d WHERE d."customerId" = c.id AND d."updatedAt" >= ${cut})
      AND NOT EXISTS (SELECT 1 FROM "Quote" q WHERE q."customerId" = c.id AND q."updatedAt" >= ${cut})
    ORDER BY c."lastActivityAt" ASC LIMIT ${limit}`;
}

export async function pruneCrm(now = new Date()) {
  const started = Date.now();
  const left = () => Date.now() - started < BUDGET_MS;
  const out = { messages: 0, conversations: 0, customers: 0, deals: 0, companies: 0, quotes: 0 };

  // 1. Messages older than 13 months.
  const msgCut = new Date(now.getTime() - MESSAGE_DAYS * DAY);
  while (out.messages < MESSAGE_MAX && left()) {
    const gone = await prisma.$queryRaw<{ conversationId: string }[]>`
      DELETE FROM "ConversationMessage" WHERE id IN (SELECT id FROM "ConversationMessage" WHERE "sentAt" < ${msgCut} LIMIT ${MESSAGE_CHUNK})
      RETURNING "conversationId"`;
    if (!gone.length) break;
    out.messages += gone.length;
    const convIds = [...new Set(gone.map((g) => g.conversationId))];
    await prisma.$executeRaw`UPDATE "Conversation" SET summary = NULL, "summaryThrough" = NULL WHERE id = ANY(${convIds}::text[]) AND summary IS NOT NULL`;
    const empty = await prisma.conversation.findMany({ where: { id: { in: convIds }, messages: { none: {} } }, select: { id: true, workspaceId: true, brandId: true, followUpTaskId: true } });
    // Per brand, one transaction: their open follow-up tasks closed, then the still-empty conversations deleted.
    const byBrand = new Map<string, typeof empty>();
    for (const c of empty) byBrand.set(c.brandId, [...(byBrand.get(c.brandId) ?? []), c]);
    for (const list of byBrand.values()) {
      await prisma.$transaction(async (tx) => {
        const tasks = list.flatMap((c) => (c.followUpTaskId ? [c.followUpTaskId] : []));
        await closeTasks(tx, list[0]!, tasks, "The conversation's messages passed the 13-month limit", {});
        out.conversations += (await tx.conversation.deleteMany({ where: { id: { in: list.map((c) => c.id) }, messages: { none: {} } } })).count;
      }, TX);
    }
  }

  // 2. Customers inactive for 24 months, re-checked inside each batch's transaction.
  const cut = new Date(now.getTime() - RECORD_DAYS * DAY);
  while (out.customers < CUSTOMER_MAX && left()) {
    const batch = await inactiveCustomers(prisma, cut, null, CUSTOMER_BATCH);
    if (!batch.length) break;
    const byBrand = new Map<string, typeof batch>();
    for (const c of batch) byBrand.set(c.brandId, [...(byBrand.get(c.brandId) ?? []), c]);
    let erased = 0;
    for (const list of byBrand.values()) {
      const b = { workspaceId: list[0]!.workspaceId, brandId: list[0]!.brandId };
      erased += (
        await prisma.$transaction(
          (tx) =>
            eraseCustomers(tx, b, list.map((c) => c.id), { action: "customer.retention-deleted", actorUserId: null }, {
              // Re-checked after the rows are locked, in this transaction: a note or message committed meanwhile keeps them.
              recheck: async (t, locked) => (await inactiveCustomers(t, cut, locked, locked.length)).map((c) => c.id),
              emailQuotesBefore: cut,
            }),
          TX,
        )
      ).length;
    }
    out.customers += erased;
    if (erased < batch.length) break; // the rest became active meanwhile: next sweep
  }

  // 3. Deals with no customer, companies with nothing left.
  out.deals = await prisma.$executeRaw`DELETE FROM "Deal" WHERE id IN (SELECT id FROM "Deal" WHERE "customerId" IS NULL AND "updatedAt" < ${cut} LIMIT 5000)`;
  out.companies = await prisma.$executeRaw`
    DELETE FROM "Company" co WHERE co.id IN (
      SELECT c.id FROM "Company" c WHERE c."updatedAt" < ${cut}
        AND NOT EXISTS (SELECT 1 FROM "Customer" x WHERE x."companyId" = c.id) AND NOT EXISTS (SELECT 1 FROM "Deal" d WHERE d."companyId" = c.id)
      LIMIT 5000)`;

  // 4. Old closed quotes nobody is linked to: blanked as erasure does (blankQuotes, updatedAt left as it is).
  const stale = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Quote" WHERE "customerId" IS NULL AND status IN ('ACCEPTED', 'EXPIRED', 'CANCELLED', 'DECLINED') AND "updatedAt" < ${cut}
      AND ("contactName" IS NOT NULL OR "contactEmail" IS NOT NULL OR "declinedReason" IS NOT NULL OR note IS NOT NULL OR "internalNote" IS NOT NULL) LIMIT 5000`;
  if (stale.length) await prisma.$transaction((tx) => blankQuotes(tx, stale.map((q) => q.id)), TX);
  out.quotes = stale.length;
  return out;
}
