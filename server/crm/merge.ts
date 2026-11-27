import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { brandWhere, changed, crmAudit, type CrmScope, invalid, notFound } from "@/server/crm/common";
import { getCustomer } from "@/server/crm/customers";
import { prisma } from "@/server/db/prisma";
import { TX } from "@/server/services/publishing";
import type { CustomerRow } from "@/shared";

/**
 * Merging duplicate customers (plan 2026-11-27-crm, Task A4, Decision 4), crm.manage, only when a person confirms.
 * Suggestions: other customers of the brand with the same display name (trimmed, any case: the expression index
 * Customer_brandId_name_key_idx); two customers can never share an identity, so that is the duplicate a person makes.
 * The merge moves identities, notes, conversations, deals and quotes onto the survivor, fills the survivor's empty
 * fields from the other, deletes the other and is audited with both ids. There is no un-merge.
 */
export const MergeInput = z.object({ otherId: z.string().min(1).max(40), survivorUpdatedAt: z.string().datetime(), otherUpdatedAt: z.string().datetime() });

export async function mergeSuggestions(s: CrmScope, customerId: string): Promise<CustomerRow[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT o.id FROM "Customer" c JOIN "Customer" o
      ON o."brandId" = c."brandId" AND lower(btrim(o."displayName")) = lower(btrim(c."displayName")) AND o.id <> c.id
    WHERE c.id = ${customerId} AND c."workspaceId" = ${s.workspaceId} AND c."brandId" = ${s.brandId}
    ORDER BY o."lastActivityAt" DESC LIMIT 10`;
  if (!rows.length) {
    if (!(await prisma.customer.findFirst({ where: { id: customerId, ...brandWhere(s) }, select: { id: true } }))) throw notFound("Customer");
    return [];
  }
  const found = await prisma.customer.findMany({ where: { id: { in: rows.map((r) => r.id) }, ...brandWhere(s) }, include: { company: { select: { id: true, name: true } } }, orderBy: { lastActivityAt: "desc" } });
  return found.map((c) => ({ id: c.id, displayName: c.displayName, role: c.role, company: c.company, ownerId: c.ownerId, nextAction: c.nextAction, nextActionDue: c.nextActionDue?.toISOString().slice(0, 10) ?? null, lastActivityAt: c.lastActivityAt.toISOString() }));
}

/** Locks customer rows in id order (merge, erasure and retention all do, so two of them never deadlock). */
export async function lockCustomers(tx: Prisma.TransactionClient, s: { workspaceId: string; brandId: string }, ids: string[]) {
  const sorted = [...new Set(ids)].sort();
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Customer" WHERE id = ANY(${sorted}) AND "workspaceId" = ${s.workspaceId} AND "brandId" = ${s.brandId} ORDER BY id FOR UPDATE`;
  return new Set(rows.map((r) => r.id));
}

export async function mergeCustomers(s: CrmScope, survivorId: string, input: z.infer<typeof MergeInput>) {
  if (survivorId === input.otherId) throw invalid("Pick another customer to merge", "crm.mergeSelf");
  await prisma.$transaction(async (tx) => {
    const locked = await lockCustomers(tx, s, [survivorId, input.otherId]);
    if (!locked.has(survivorId) || !locked.has(input.otherId)) throw notFound("Customer");
    const [a, b] = await Promise.all([tx.customer.findUniqueOrThrow({ where: { id: survivorId } }), tx.customer.findUniqueOrThrow({ where: { id: input.otherId } })]);
    // Both as the person saw them in the preview: anything changed since (on either) is a 409.
    if (a.updatedAt.toISOString() !== new Date(input.survivorUpdatedAt).toISOString() || b.updatedAt.toISOString() !== new Date(input.otherUpdatedAt).toISOString()) throw changed("One of these customers");
    const from = { customerId: b.id, ...brandWhere(s) };
    const counts = {
      identities: (await tx.customerIdentity.updateMany({ where: from, data: { customerId: a.id } })).count,
      notes: (await tx.customerNote.updateMany({ where: from, data: { customerId: a.id } })).count,
      conversations: (await tx.conversation.updateMany({ where: from, data: { customerId: a.id } })).count,
      deals: (await tx.deal.updateMany({ where: from, data: { customerId: a.id } })).count,
      quotes: (await tx.quote.updateMany({ where: from, data: { customerId: a.id } })).count,
    };
    await tx.customer.update({
      where: { id: a.id },
      data: {
        role: a.role ?? b.role, language: a.language ?? b.language, companyId: a.companyId ?? b.companyId, ownerId: a.ownerId ?? b.ownerId,
        nextAction: a.nextAction ?? b.nextAction, nextActionDue: a.nextAction ? a.nextActionDue : b.nextActionDue,
        lastActivityAt: a.lastActivityAt > b.lastActivityAt ? a.lastActivityAt : b.lastActivityAt,
      },
    });
    await tx.customer.delete({ where: { id: b.id } });
    await crmAudit(tx, s, "customer.merged", "Customer", a.id, { mergedId: b.id, ...counts });
  }, TX);
  return getCustomer(s, survivorId);
}
