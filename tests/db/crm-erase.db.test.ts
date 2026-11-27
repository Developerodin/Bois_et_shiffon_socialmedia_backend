import { beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { CrmScope } from "@/server/crm/common";
import { createCompany, CompanyCreate } from "@/server/crm/companies";
import { ConversationCreate, createConversation } from "@/server/crm/conversations";
import { addNote, createCustomer, CustomerCreate, setQuoteCustomer } from "@/server/crm/customers";
import { createDeal, DealCreate } from "@/server/crm/deals";
import { eraseCompany, eraseCustomer } from "@/server/crm/erase";
import { exportCustomer } from "@/server/crm/export";
import { pruneCrm } from "@/server/crm/retention";
import { createQuote, editQuote, QuoteAction, QuoteCreate, QuoteEdit, quoteAction } from "@/server/quotes/quotes";
import type { PermissionKey } from "@/shared";

/** Plan 2026-11-27-crm, Task A8: erasure, the access export and retention (O6, Decision 18). */
let s: CrmScope;
let manager: CrmScope;
const DAY = 86_400_000;
const all = new Set<PermissionKey>(["brand.read", "crm.manage", "inbox.read"]);

beforeAll(async () => {
  const ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-crm-erase" } })).id;
  const brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "B" } })).id;
  const admin = await prisma.role.create({ data: { workspaceId: ws, slug: "admin", name: "Admin", permissions: ["members.manage", "crm.manage", "inbox.read", "tasks.read"] } });
  const plain = await prisma.role.create({ data: { workspaceId: ws, slug: "member", name: "Member", permissions: [] } });
  const u = await prisma.user.create({ data: { email: "a@crm-erase.test", name: "a" } });
  await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: u.id, roleId: admin.id } });
  const m = await prisma.user.create({ data: { email: "m@crm-erase.test", name: "m" } });
  await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: m.id, roleId: plain.id } });
  s = { workspaceId: ws, brandId: brand, userId: u.id, perms: all };
  manager = { ...s, userId: m.id };
});

async function fullCustomer(name: string, email: string) {
  const c = await createCustomer(s, CustomerCreate.parse({ displayName: name, identities: [{ kind: "EMAIL", value: email }] }));
  await addNote(s, c.id, { text: `${name} prefers oak` });
  const conv = await createConversation(s, ConversationCreate.parse({ customerId: c.id, message: { fromCustomer: true, medium: "EMAIL", text: `${name} lives at 3 rue Haute`, sentAt: new Date(Date.now() - 30 * 3_600_000).toISOString() } }));
  const deal = await createDeal(s, DealCreate.parse({ title: `${name}'s living room`, customerId: c.id, nextAction: `Call ${name}` }));
  const linked = await createQuote(s, QuoteCreate.parse({ currency: "EUR", contactName: name, contactEmail: email, note: `For ${name}`, lines: [{ title: "Sofa", quantity: 1, unitPrice: "900" }, { title: `Cushion embroidered ${name}`, quantity: 1, unitPrice: "50" }] }));
  await setQuoteCustomer(s, linked.id, { customerId: c.id });
  const edited = await editQuote(s, linked.id, QuoteEdit.parse({ version: linked.version, note: "changed" }));
  const sent = await quoteAction(s, linked.id, QuoteAction.parse({ action: "markSent", version: edited.version }));
  await quoteAction(s, linked.id, QuoteAction.parse({ action: "decline", version: sent.version, reason: `${name} said too dear` }));
  // A quote never linked, with the same email.
  const loose = await createQuote(s, QuoteCreate.parse({ currency: "EUR", contactName: name, contactEmail: email.toUpperCase(), lines: [] }));
  return { c, conv, deal, linked, loose };
}

describe("erasure", () => {
  it("reaches identities, notes, conversations, messages, quote contacts and notes (linked or same email), version notes, deal text; ids-only audit", async () => {
    const x = await fullCustomer("Jeanne Martin", "jeanne@martin.fr");
    await eraseCustomer(s, x.c.id);
    expect(await prisma.customer.findUnique({ where: { id: x.c.id } })).toBeNull();
    expect(await prisma.customerIdentity.count({ where: { customerId: x.c.id } })).toBe(0);
    expect(await prisma.customerNote.count({ where: { customerId: x.c.id } })).toBe(0);
    expect(await prisma.conversation.findUnique({ where: { id: x.conv.id } })).toBeNull();
    expect(await prisma.conversationMessage.count({ where: { conversationId: x.conv.id } })).toBe(0);
    const quotes = await prisma.quote.findMany({ where: { id: { in: [x.linked.id, x.loose.id] } }, include: { versions: true } });
    expect(quotes).toHaveLength(2);
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: x.deal.id } });
    expect(deal).toMatchObject({ customerId: null, nextAction: null, title: `Deal ${x.deal.id.slice(0, 8)}` });
    const left = JSON.stringify([quotes, deal]);
    expect(left).not.toMatch(/Jeanne|jeanne|said too dear|For Jeanne/i);
    expect(quotes.find((q) => q.id === x.linked.id)).toMatchObject({ status: "DECLINED", currency: "EUR" });
    // Free line titles go (a bespoke piece can name the person); the prices and the rest of the line stay.
    expect((quotes.find((q) => q.id === x.linked.id)!.lines as { title: string; unitPrice: string }[]).map((l) => [l.title, l.unitPrice])).toEqual([["Item", "900.00"], ["Item", "50.00"]]);
    const audit = await prisma.auditEvent.findMany({ where: { action: "customer.erased" } });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toMatch(/Jeanne|jeanne/i);
  });

  it("a quote with the erased person's email but linked to someone else keeps that link", async () => {
    const a1 = await createCustomer(s, CustomerCreate.parse({ displayName: "Anna", identities: [{ kind: "EMAIL", value: "anna@a.fr" }] }));
    const b1 = await createCustomer(s, CustomerCreate.parse({ displayName: "Studio B" }));
    const q = await createQuote(s, QuoteCreate.parse({ currency: "EUR", contactName: "Anna", contactEmail: "anna@a.fr", lines: [] }));
    await setQuoteCustomer(s, q.id, { customerId: b1.id });
    await eraseCustomer(s, a1.id);
    expect(await prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).toMatchObject({ customerId: b1.id, contactName: null, contactEmail: null });
  });

  it("erase and export need a workspace owner or admin", async () => {
    const c = await createCustomer(s, CustomerCreate.parse({ displayName: "Guarded" }));
    await expect(eraseCustomer(manager, c.id)).rejects.toMatchObject({ name: "AccessDeniedError" });
    await expect(exportCustomer(manager, c.id)).rejects.toMatchObject({ name: "AccessDeniedError" });
    await expect(eraseCustomer({ ...s, clientReviewer: true }, c.id)).rejects.toMatchObject({ name: "AccessDeniedError" });
  });

  it("a company erase strips its deals and unlinks its customers", async () => {
    const co = await createCompany(s, CompanyCreate.parse({ name: "Atelier Dupont" }));
    const c = await createCustomer(s, CustomerCreate.parse({ displayName: "Marc Dupont", companyId: co.id }));
    const d = await createDeal(s, DealCreate.parse({ title: "Dupont showroom", companyId: co.id }));
    await eraseCompany(s, co.id);
    expect(await prisma.company.findUnique({ where: { id: co.id } })).toBeNull();
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).companyId).toBeNull();
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: d.id } })).title).not.toContain("Dupont");
  });
});

describe("export", () => {
  it("holds everything we keep about that customer and nothing of another", async () => {
    const x = await fullCustomer("Claire Petit", "claire@petit.fr");
    await fullCustomer("Other Person", "other@person.fr");
    const out = await exportCustomer(s, x.c.id);
    const text = JSON.stringify(out);
    expect(text).toContain("claire@petit.fr");
    expect(text).toContain("Claire Petit prefers oak");
    expect(text).toContain("3 rue Haute");
    expect(text).toContain("said too dear");
    expect(out.quotes).toHaveLength(2);
    expect(out.quotes[0]!.earlierVersions.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/Other Person|other@person/);
    expect(await prisma.auditEvent.count({ where: { action: "customer.exported", entityId: x.c.id } })).toBe(1);
  });
});

describe("retention", () => {
  const age = async (id: string, days: number) => {
    const at = new Date(Date.now() - days * DAY);
    await prisma.$executeRaw`UPDATE "Customer" SET "lastActivityAt" = ${at}, "updatedAt" = ${at} WHERE id = ${id}`;
  };

  it("deletes a customer inactive 25 months; a recent note keeps one; a SHOPIFY identity keeps one; old messages and orphan deals go", async () => {
    const gone = await createCustomer(s, CustomerCreate.parse({ displayName: "Long gone" }));
    const noted = await createCustomer(s, CustomerCreate.parse({ displayName: "Recently noted" }));
    const shop = await createCustomer(s, CustomerCreate.parse({ displayName: "Shopify one" }));
    await prisma.customerIdentity.create({ data: { workspaceId: s.workspaceId, brandId: s.brandId, customerId: shop.id, kind: "SHOPIFY", value: "gid://shopify/Customer/1" } });
    await addNote(s, noted.id, { text: "still in touch" });
    for (const id of [gone.id, noted.id, shop.id]) await age(id, 25 * 30);
    // An old logged message on a kept customer.
    const keep = await createCustomer(s, CustomerCreate.parse({ displayName: "Keeps record" }));
    const conv = await createConversation(s, ConversationCreate.parse({ customerId: keep.id, message: { fromCustomer: true, medium: "PHONE", text: "old call", sentAt: new Date(Date.now() - 2 * DAY).toISOString() } }));
    await prisma.conversationMessage.updateMany({ where: { conversationId: conv.id }, data: { sentAt: new Date(Date.now() - 400 * DAY) } });
    const orphan = await createDeal(s, DealCreate.parse({ title: "Orphan" }));
    await prisma.$executeRaw`UPDATE "Deal" SET "updatedAt" = ${new Date(Date.now() - 800 * DAY)} WHERE id = ${orphan.id}`;

    // Someone inactive for years who came back with a fresh quote (not linked): retention must leave that quote whole.
    await prisma.customerIdentity.create({ data: { workspaceId: s.workspaceId, brandId: s.brandId, customerId: gone.id, kind: "EMAIL", value: "back@again.fr" } });
    await age(gone.id, 25 * 30);
    const fresh = await createQuote(s, QuoteCreate.parse({ currency: "EUR", contactName: "Back Again", contactEmail: "back@again.fr", lines: [] }));

    // An accepted quote is a record of a sale: retention unlinks it but keeps it whole.
    const sold = await createQuote(s, QuoteCreate.parse({ currency: "EUR", contactName: "Long gone", contactEmail: "gone@x.fr", lines: [{ title: "Bespoke", quantity: 1, unitPrice: "10" }] }));
    await setQuoteCustomer(s, sold.id, { customerId: gone.id });
    const sentSold = await quoteAction(s, sold.id, QuoteAction.parse({ action: "markSent", version: sold.version }));
    await quoteAction(s, sold.id, QuoteAction.parse({ action: "markAccepted", version: sentSold.version }));
    await prisma.$executeRaw`UPDATE "Quote" SET "updatedAt" = ${new Date(Date.now() - 800 * DAY)} WHERE id = ${sold.id}`;
    await age(gone.id, 25 * 30);
    const out = await pruneCrm();
    expect(out).toMatchObject({ customers: 1, messages: 1, conversations: 1, deals: 1 });
    expect(await prisma.quote.findUniqueOrThrow({ where: { id: fresh.id } })).toMatchObject({ contactName: "Back Again", contactEmail: "back@again.fr" });
    expect(await prisma.quote.findUniqueOrThrow({ where: { id: sold.id } })).toMatchObject({ customerId: null, contactName: "Long gone", status: "ACCEPTED" });
    expect(await prisma.customer.findUnique({ where: { id: gone.id } })).toBeNull();
    expect(await prisma.customer.findUnique({ where: { id: noted.id } })).not.toBeNull();
    expect(await prisma.customer.findUnique({ where: { id: shop.id } })).not.toBeNull();
    expect(await prisma.customer.findUnique({ where: { id: keep.id } })).not.toBeNull();
    expect(await prisma.conversation.findUnique({ where: { id: conv.id } })).toBeNull();
    expect(await prisma.auditEvent.count({ where: { action: "customer.retention-deleted", entityId: gone.id } })).toBe(1);
  });
});
