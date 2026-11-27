import { beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { CrmScope } from "@/server/crm/common";
import { ConversationCreate, createConversation } from "@/server/crm/conversations";
import { addNote, createCustomer, CustomerCreate, setQuoteCustomer } from "@/server/crm/customers";
import { createDeal, DealCreate } from "@/server/crm/deals";
import { mergeCustomers, mergeSuggestions } from "@/server/crm/merge";
import { createQuote, QuoteCreate } from "@/server/quotes/quotes";
import type { PermissionKey } from "@/shared";

/** Plan 2026-11-27-crm, Task A4: merge suggestions and merge, only when a person confirms. */
let s: CrmScope;
let other: CrmScope;

beforeAll(async () => {
  const ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-crm-merge" } })).id;
  const brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "B" } })).id;
  const brand2 = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b2", displayName: "B2" } })).id;
  const u = await prisma.user.create({ data: { email: "a@crm-merge.test", name: "a" } });
  s = { workspaceId: ws, brandId: brand, userId: u.id, perms: new Set<PermissionKey>(["brand.read", "crm.manage", "inbox.read"]) };
  other = { ...s, brandId: brand2 };
});

describe("merge", () => {
  it("suggests the same name in any case; moves identities, notes, conversations, deals and quotes; audits ids only", async () => {
    const a = await createCustomer(s, CustomerCreate.parse({ displayName: "Jeanne Martin", identities: [{ kind: "EMAIL", value: "jeanne@a.fr" }] }));
    const b = await createCustomer(s, CustomerCreate.parse({ displayName: " jeanne martin ", role: "Designer", identities: [{ kind: "PHONE", value: "+33612345678" }] }));
    await createCustomer(s, CustomerCreate.parse({ displayName: "Jeanne Marti" }));
    expect((await mergeSuggestions(s, a.id)).map((c) => c.id)).toEqual([b.id]);
    await addNote(s, b.id, { text: "Met at the fair" });
    const conv = await createConversation(s, ConversationCreate.parse({ customerId: b.id, message: { fromCustomer: true, medium: "PHONE", text: "Hi", sentAt: new Date().toISOString() } }));
    const deal = await createDeal(s, DealCreate.parse({ title: "Studio fit-out", customerId: b.id }));
    const q = await createQuote(s, QuoteCreate.parse({ currency: "EUR", lines: [] }));
    await setQuoteCustomer(s, q.id, { customerId: b.id });
    const [ra, rb] = await Promise.all([prisma.customer.findUniqueOrThrow({ where: { id: a.id } }), prisma.customer.findUniqueOrThrow({ where: { id: b.id } })]);
    const merged = await mergeCustomers(s, a.id, { otherId: b.id, survivorUpdatedAt: ra.updatedAt.toISOString(), otherUpdatedAt: rb.updatedAt.toISOString() });
    expect(merged.identities.map((i) => i.kind).sort()).toEqual(["EMAIL", "PHONE"]);
    // The survivor's empty fields are filled from the other.
    expect(merged).toMatchObject({ role: "Designer", displayName: "Jeanne Martin" });
    expect(merged.notes).toHaveLength(1);
    expect(merged.conversations?.map((c) => c.id)).toEqual([conv.id]);
    expect(merged.deals.map((d) => d.id)).toEqual([deal.id]);
    expect(merged.quotes.map((x) => x.id)).toEqual([q.id]);
    expect(await prisma.customer.findUnique({ where: { id: b.id } })).toBeNull();
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "customer.merged", entityId: a.id } });
    expect(audit.metadata).toMatchObject({ mergedId: b.id, identities: 1, notes: 1, conversations: 1, deals: 1, quotes: 1 });
    expect(JSON.stringify(audit)).not.toMatch(/Jeanne|jeanne|fair/i);
  });

  it("a stale preview is 409; itself is 400; another brand's customer is 404", async () => {
    const a = await createCustomer(s, CustomerCreate.parse({ displayName: "Paul" }));
    const b = await createCustomer(s, CustomerCreate.parse({ displayName: "Paul" }));
    const old = new Date(0).toISOString();
    await expect(mergeCustomers(s, a.id, { otherId: b.id, survivorUpdatedAt: old, otherUpdatedAt: old })).rejects.toMatchObject({ status: 409 });
    await expect(mergeCustomers(s, a.id, { otherId: a.id, survivorUpdatedAt: old, otherUpdatedAt: old })).rejects.toMatchObject({ status: 400 });
    const f = await createCustomer(other, CustomerCreate.parse({ displayName: "Paul" }));
    await expect(mergeCustomers(s, a.id, { otherId: f.id, survivorUpdatedAt: old, otherUpdatedAt: old })).rejects.toMatchObject({ status: 404 });
    expect((await mergeSuggestions(s, a.id)).map((c) => c.id)).toEqual([b.id]);
  });
});
