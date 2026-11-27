import { brandWhere, crmAudit, type CrmScope, notFound } from "@/server/crm/common";
import { checkEraseAccess } from "@/server/crm/erase";
import { prisma } from "@/server/db/prisma";
import { quoteNumber } from "@/shared";

/**
 * One customer's data as JSON, for an access request (GDPR Art. 15; plan 2026-11-27-crm, Decision 15): everything we
 * hold about them, nothing about anyone else. Owner/Admin only (as erasure), at most 10 an hour, audited by id.
 * Quotes: those linked to them and those whose contact email is one of their emails.
 */
export async function exportCustomer(s: CrmScope, customerId: string) {
  await checkEraseAccess(s);
  const c = await prisma.customer.findFirst({
    where: { id: customerId, ...brandWhere(s) },
    include: { company: { select: { name: true, website: true } }, identities: true, notes: { orderBy: { createdAt: "asc" } } },
  });
  if (!c) throw notFound("Customer");
  const emails = c.identities.filter((i) => i.kind === "EMAIL").map((i) => i.value);
  const [conversations, deals, quotes] = await Promise.all([
    prisma.conversation.findMany({ where: { ...brandWhere(s), customerId: c.id }, include: { messages: { orderBy: { sentAt: "asc" } } }, orderBy: { createdAt: "asc" } }),
    prisma.deal.findMany({ where: { ...brandWhere(s), customerId: c.id }, orderBy: { createdAt: "asc" } }),
    prisma.quote.findMany({
      where: { ...brandWhere(s), OR: [{ customerId: c.id }, ...(emails.length ? [{ contactEmail: { in: emails, mode: "insensitive" as const } }] : [])] },
      include: { versions: { orderBy: { version: "asc" } } },
      orderBy: { number: "asc" },
    }),
  ]);
  await crmAudit(prisma, s, "customer.exported", "Customer", c.id, { conversations: conversations.length, deals: deals.length, quotes: quotes.length });
  return {
    exportedAt: new Date().toISOString(),
    customer: {
      id: c.id, displayName: c.displayName, role: c.role, language: c.language, source: c.source, company: c.company, nextAction: c.nextAction,
      nextActionDue: c.nextActionDue?.toISOString().slice(0, 10) ?? null, createdAt: c.createdAt, updatedAt: c.updatedAt,
    },
    contactDetails: c.identities.map((i) => ({ kind: i.kind, value: i.value, addedAt: i.createdAt })),
    notes: c.notes.map((n) => ({ text: n.text, createdAt: n.createdAt })),
    conversations: conversations.map((v) => ({
      channel: v.channel, subject: v.subject, summary: v.summary, nextAction: v.nextAction, createdAt: v.createdAt,
      messages: v.messages.map((m) => ({ fromCustomer: m.fromCustomer, medium: m.medium, text: m.text, sentAt: m.sentAt })),
    })),
    deals: deals.map((d) => ({ title: d.title, stage: d.stage, value: d.value?.toFixed(2) ?? null, currency: d.currency, nextAction: d.nextAction, closedReason: d.closedReason, closedNote: d.closedNote, createdAt: d.createdAt })),
    quotes: quotes.map((q) => ({
      number: quoteNumber(q.number), status: q.status, contactName: q.contactName, contactEmail: q.contactEmail, currency: q.currency, lines: q.lines, discount: q.discount,
      note: q.note, declinedReason: q.declinedReason, sentAt: q.sentAt, validUntil: q.validUntil, createdAt: q.createdAt,
      earlierVersions: q.versions.map((v) => ({ version: v.version, lines: v.lines, note: v.note, createdAt: v.createdAt })),
    })),
  };
}
