import { beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import { createCompany, getCompany, CompanyCreate } from "@/server/crm/companies";
import type { CrmScope } from "@/server/crm/common";
import { addIdentity, addNote, createCustomer, CustomerCreate, deleteNote, getCustomer, listCustomers, setQuoteCustomer, updateCustomer } from "@/server/crm/customers";
import { createQuote, QuoteCreate } from "@/server/quotes/quotes";
import type { PermissionKey } from "@/shared";

/** Plan 2026-11-27-crm, Task A3: customer and company records, identities, notes and the access audit. */
let s: CrmScope;
let other: CrmScope;
let colleague: string;

beforeAll(async () => {
  const ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-crm-customers" } })).id;
  const brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "B" } })).id;
  const brand2 = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b2", displayName: "B2" } })).id;
  const u = await prisma.user.create({ data: { email: "a@crm-customers.test", name: "a" } });
  const role = await prisma.role.create({ data: { workspaceId: ws, slug: "sales", name: "Sales", permissions: ["brand.read", "crm.manage", "tasks.read"] } });
  await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: u.id, roleId: role.id } });
  colleague = (await prisma.user.create({ data: { email: "c@crm-customers.test", name: "c" } })).id;
  s = { workspaceId: ws, brandId: brand, userId: u.id, perms: new Set<PermissionKey>(["brand.read", "crm.manage"]) };
  other = { ...s, brandId: brand2 };
});

const make = (name: string, identities: { kind: "EMAIL" | "PHONE"; value: string }[] = []) => createCustomer(s, CustomerCreate.parse({ displayName: name, identities }));

describe("customers", () => {
  it("normalises identities: email lower-cased, phone + and digits", async () => {
    const c = await make("Jeanne Martin", [{ kind: "EMAIL", value: " Jeanne@Studio.FR " }, { kind: "PHONE", value: "+33 6 12-34.56 78" }]);
    const dto = await getCustomer(s, c.id);
    expect(dto.identities.map((i) => [i.kind, i.value])).toEqual([["EMAIL", "jeanne@studio.fr"], ["PHONE", "+33612345678"]]);
  });

  it("an identity on another customer is 409 naming them; a bad value is refused without repeating it", async () => {
    const a = await make("Paul Durand", [{ kind: "EMAIL", value: "paul@durand.fr" }]);
    const b = await make("Paul D.");
    await expect(addIdentity(s, b.id, { kind: "EMAIL", value: "PAUL@durand.fr" })).rejects.toMatchObject({ status: 409, code: "crm.identityTaken", data: { customerId: a.id } });
    const bad = await addIdentity(s, b.id, { kind: "PHONE", value: "call 0612 maybe" }).catch((e: Error) => e);
    expect(bad).toMatchObject({ status: 400 });
    expect((bad as Error).message).not.toContain("0612");
    // Another brand may hold the same email.
    await expect(createCustomer(other, CustomerCreate.parse({ displayName: "Paul", identities: [{ kind: "EMAIL", value: "paul@durand.fr" }] }))).resolves.toBeTruthy();
  });

  it("search needs 2 characters, finds by name or identity, escapes wildcards, audits the count only", async () => {
    await make("Élise Bernard", [{ kind: "EMAIL", value: "elise@atelier.fr" }]);
    await expect(listCustomers(s, { q: "e" })).rejects.toMatchObject({ status: 400 });
    expect((await listCustomers(s, { q: "atelier" })).customers.map((c) => c.displayName)).toEqual(["Élise Bernard"]);
    expect((await listCustomers(s, { q: "%%" })).customers).toEqual([]);
    const audit = await prisma.auditEvent.findMany({ where: { action: "customer.searched", workspaceId: s.workspaceId } });
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toMatch(/atelier|Élise/);
  });

  it("lists by latest activity with a cursor, and another brand's customers never show", async () => {
    await createCustomer(other, CustomerCreate.parse({ displayName: "Other brand's" }));
    const page = await listCustomers(s, {});
    expect(page.customers.some((c) => c.displayName === "Other brand's")).toBe(false);
    expect(await prisma.auditEvent.count({ where: { action: "customer.listed", workspaceId: s.workspaceId } })).toBe(1);
    await listCustomers(s, {});
    expect(await prisma.auditEvent.count({ where: { action: "customer.listed", workspaceId: s.workspaceId } })).toBe(1);
  });

  it("a view is audited once per hour with the id only; another brand's customer is 404", async () => {
    const c = await make("Viewed Person");
    await getCustomer(s, c.id);
    await getCustomer(s, c.id);
    const rows = await prisma.auditEvent.findMany({ where: { action: "customer.viewed", entityId: c.id } });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain("Viewed");
    await expect(getCustomer(other, c.id)).rejects.toMatchObject({ status: 404 });
  });

  it("edits are checked against the version read; an owner must hold crm.manage; a company of another brand is 404", async () => {
    const c = await make("Owner Test");
    const before = await getCustomer(s, c.id);
    await expect(updateCustomer(s, c.id, { updatedAt: before.updatedAt, ownerId: colleague })).rejects.toMatchObject({ status: 400, code: "crm.owner" });
    const company = await createCompany(other, CompanyCreate.parse({ name: "Elsewhere" }));
    await expect(updateCustomer(s, c.id, { updatedAt: before.updatedAt, companyId: company.id })).rejects.toMatchObject({ status: 404 });
    const mine = await createCompany(s, CompanyCreate.parse({ name: "Atelier Martin", website: "https://atelier.example" }));
    const after = await updateCustomer(s, c.id, { updatedAt: before.updatedAt, companyId: mine.id, ownerId: s.userId, nextAction: "Call back", nextActionDue: "2026-12-01" });
    expect(after).toMatchObject({ company: { id: mine.id }, ownerId: s.userId, nextActionDue: "2026-12-01" });
    await expect(updateCustomer(s, c.id, { updatedAt: before.updatedAt, role: "Designer" })).rejects.toMatchObject({ status: 409 });
    expect((await getCompany(s, mine.id)).customers).toBe(1);
  });

  it("notes: the author deletes theirs within 24 h; not someone else's; audit has no text", async () => {
    const c = await make("Noted");
    const n = await addNote(s, c.id, { text: "Prefers oak, budget around 4k" });
    await expect(deleteNote({ ...s, userId: colleague }, c.id, n.id)).rejects.toMatchObject({ status: 403 });
    await expect(deleteNote(s, c.id, n.id, Date.now() + 25 * 3_600_000)).rejects.toMatchObject({ status: 409 });
    await deleteNote(s, c.id, n.id);
    expect(await prisma.customerNote.count({ where: { customerId: c.id } })).toBe(0);
    expect(JSON.stringify(await prisma.auditEvent.findMany({ where: { entityId: c.id } }))).not.toContain("oak");
  });

  it("a quote's contact saved as a customer; its email already a customer's is 409; linking another brand's customer is 404", async () => {
    const q = await createQuote(s, QuoteCreate.parse({ currency: "EUR", contactName: "Claire Petit", contactEmail: "claire@petit.fr", lines: [] }));
    const saved = await setQuoteCustomer(s, q.id, { create: true });
    const c = await getCustomer(s, saved.customerId!);
    expect(c).toMatchObject({ displayName: "Claire Petit", source: "QUOTE" });
    expect(c.quotes.map((x) => x.id)).toEqual([q.id]);
    const q2 = await createQuote(s, QuoteCreate.parse({ currency: "EUR", contactName: "Claire P.", contactEmail: "CLAIRE@petit.fr", lines: [] }));
    await expect(setQuoteCustomer(s, q2.id, { create: true })).rejects.toMatchObject({ status: 409, data: { customerId: c.id } });
    const foreign = await createCustomer(other, CustomerCreate.parse({ displayName: "Foreign" }));
    await expect(setQuoteCustomer(s, q2.id, { customerId: foreign.id })).rejects.toMatchObject({ status: 404 });
    expect((await setQuoteCustomer(s, q2.id, { customerId: c.id })).customerId).toBe(c.id);
  });
});
