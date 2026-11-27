import { Prisma } from "@prisma/client";
import { AccessDeniedError } from "@/server/auth/errors";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { brandWhere, type CrmScope, notFound } from "@/server/crm/common";
import { lockCustomers } from "@/server/crm/merge";
import { prisma } from "@/server/db/prisma";
import { PublishingError, TX } from "@/server/services/publishing";
import { closeTasks } from "@/server/tasks/system-tasks";

/**
 * Erasure (plan 2026-11-27-crm, Task A8; GDPR Art. 17), one path for a person's request, a company's, and the 24-month
 * retention sweep (server/crm/retention.ts). For the customers erased it:
 *  - deletes them with their identities and notes (cascade), and their conversations with every message (hard delete);
 *  - unlinks their deals and strips what may describe the person: title (→ "Deal <id>"), next action, closing note;
 *  - keeps their quotes for the books but blanks contact name and email, the declined reason, both notes and the
 *    invoice link, on quotes linked to them AND on quotes whose contact email is one of their emails; version
 *    snapshots lose their customer note. Line titles stay: they are the commercial content of the quote.
 *  - closes the conversations' open follow-up tasks (titles never held customer text).
 * Blanking is raw SQL that leaves `updatedAt` alone, so the status sync's 60-day payment watch isn't extended.
 * Audit rows carry ids only.
 */
type Brand = { workspaceId: string; brandId: string };

/** Erase or export: crm.manage on the brand and a workspace role that manages members (Owner, Admin). Not clients. */
export async function checkEraseAccess(s: CrmScope) {
  if (s.clientReviewer || !s.perms.has("crm.manage")) throw new AccessDeniedError("Missing permission crm.manage");
  const admin = await prisma.workspaceMember.findFirst({ where: { workspaceId: s.workspaceId, userId: s.userId, roleRef: { permissions: { has: "members.manage" } } }, select: { id: true } });
  if (!admin) throw new AccessDeniedError("Only a workspace owner or admin can erase or export customer data");
  if (!(await hitRateLimit(`crm-erase:${s.userId}`, 10, 3_600_000)).allowed) throw new PublishingError("Too many erasures or exports this hour. Try again later.", 429);
}

/** Erases `ids` (this brand's, locked here in id order). Returns the ids actually erased. */
export async function eraseCustomers(tx: Prisma.TransactionClient, scope: Brand, ids: string[], audit: { action: string; actorUserId: string | null }) {
  const b = { workspaceId: scope.workspaceId, brandId: scope.brandId };
  const locked = [...(await lockCustomers(tx, b, ids))];
  if (!locked.length) return [];
  const emails = (await tx.customerIdentity.findMany({ where: { customerId: { in: locked }, kind: "EMAIL" }, select: { value: true } })).map((i) => i.value);
  const quoteIds = (
    await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Quote" WHERE "workspaceId" = ${b.workspaceId} AND "brandId" = ${b.brandId}
        AND ("customerId" = ANY(${locked}::text[]) OR (${emails.length > 0} AND lower("contactEmail") = ANY(${emails}::text[])))`
  ).map((r) => r.id);
  if (quoteIds.length) {
    await tx.$executeRaw`
      UPDATE "Quote" SET "contactName" = NULL, "contactEmail" = NULL, "declinedReason" = NULL, note = NULL, "internalNote" = NULL, "invoiceUrl" = NULL, "customerId" = NULL
      WHERE id = ANY(${quoteIds}::text[])`;
    await tx.$executeRaw`UPDATE "QuoteVersion" SET note = NULL WHERE "quoteId" = ANY(${quoteIds}::text[])`;
  }
  await tx.$executeRaw`
    UPDATE "Deal" SET title = 'Deal ' || left(id, 8), "nextAction" = NULL, "closedNote" = NULL, "customerId" = NULL
    WHERE "workspaceId" = ${b.workspaceId} AND "brandId" = ${b.brandId} AND "customerId" = ANY(${locked}::text[])`;
  const convs = await tx.conversation.findMany({ where: { ...brandWhere(b), customerId: { in: locked } }, select: { id: true, followUpTaskId: true } });
  const tasks = convs.flatMap((c) => (c.followUpTaskId ? [c.followUpTaskId] : []));
  if (tasks.length) await closeTasks(tx, b, tasks, "The conversation was erased", {});
  if (convs.length) await tx.conversation.deleteMany({ where: { id: { in: convs.map((c) => c.id) } } });
  await tx.customer.deleteMany({ where: { id: { in: locked }, ...brandWhere(b) } });
  await tx.auditEvent.createMany({ data: locked.map((id) => ({ ...b, actorUserId: audit.actorUserId, action: audit.action, entityType: "Customer", entityId: id, metadata: { quotes: quoteIds.length, conversations: convs.length } })) });
  return locked;
}

export async function eraseCustomer(s: CrmScope, customerId: string) {
  await checkEraseAccess(s);
  await prisma.$transaction(async (tx) => {
    const done = await eraseCustomers(tx, s, [customerId], { action: "customer.erased", actorUserId: s.userId });
    if (!done.length) throw notFound("Customer");
  }, TX);
}

/**
 * A company erased (a sole trader's company is personal data): the row goes, its customers and deals are unlinked,
 * and the deals' titles, next actions and closing notes are stripped as for a person. Its customers stay (erase them
 * one by one if they ask).
 */
export async function eraseCompany(s: CrmScope, companyId: string) {
  await checkEraseAccess(s);
  await prisma.$transaction(async (tx) => {
    const c = await tx.company.findFirst({ where: { id: companyId, ...brandWhere(s) }, select: { id: true } });
    if (!c) throw notFound("Company");
    await tx.$executeRaw`
      UPDATE "Deal" SET title = 'Deal ' || left(id, 8), "nextAction" = NULL, "closedNote" = NULL, "companyId" = NULL
      WHERE "workspaceId" = ${s.workspaceId} AND "brandId" = ${s.brandId} AND "companyId" = ${c.id}`;
    await tx.company.delete({ where: { id: c.id } });
    await tx.auditEvent.create({ data: { ...brandWhere(s), actorUserId: s.userId, action: "company.erased", entityType: "Company", entityId: c.id, metadata: {} } });
  }, TX);
}
