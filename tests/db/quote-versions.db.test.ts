import { beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import { createQuote, editQuote, QuoteAction, QuoteCreate, QuoteEdit, quoteAction, quoteVersions, type QuoteScope } from "@/server/quotes/quotes";
import type { PermissionKey } from "@/shared";

/** Plan 2026-11-27-crm, Task A2: each earlier version of a quote, without the contact fields. */
let scope: QuoteScope;
let other: QuoteScope;

beforeAll(async () => {
  const ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-quote-versions" } })).id;
  const brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "B" } })).id;
  const brand2 = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b2", displayName: "B2" } })).id;
  const u = await prisma.user.create({ data: { email: "v@quote-versions.test", name: "v" } });
  scope = { workspaceId: ws, brandId: brand, userId: u.id, perms: new Set<PermissionKey>(["crm.manage"]) };
  other = { ...scope, brandId: brand2 };
});

const make = () => createQuote(scope, QuoteCreate.parse({ currency: "EUR", contactName: "Jeanne Martin", contactEmail: "jeanne@client.test", note: "Delivery in May", lines: [{ title: "Sofa", quantity: 1, unitPrice: "900" }] }));

describe("quote versions", () => {
  it("an edit keeps the version it replaced, once, with no contact fields", async () => {
    const q = await make();
    const e = await editQuote(scope, q.id, QuoteEdit.parse({ version: q.version, lines: [{ title: "Sofa", quantity: 2, unitPrice: "850" }] }));
    expect(e.version).toBe(2);
    const [v] = await quoteVersions(scope, q.id, 1);
    expect(v).toMatchObject({ version: 1, sent: false, note: "Delivery in May", totals: { total: "900.00" } });
    expect(v!.lines).toEqual([{ productId: null, variantId: null, title: "Sofa", quantity: 1, unitPrice: "900.00" }]);
    const raw = await prisma.quoteVersion.findMany({ where: { quoteId: q.id } });
    expect(raw).toHaveLength(1);
    expect(JSON.stringify(raw)).not.toMatch(/Jeanne|jeanne@/);
    // The list leaves out lines and totals.
    expect((await quoteVersions(scope, q.id))[0]).not.toHaveProperty("lines");
  });

  it("two edits of the same version at once: one row, one 409", async () => {
    const q = await make();
    const edit = (n: number) => editQuote(scope, q.id, QuoteEdit.parse({ version: q.version, lines: [{ title: "Sofa", quantity: n, unitPrice: "900" }] }));
    const out = await Promise.allSettled([edit(2), edit(3)]);
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(out.find((o) => o.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect(await prisma.quoteVersion.count({ where: { quoteId: q.id } })).toBe(1);
  });

  it("a revise keeps the sent version, marked sent; the edit after it keeps working", async () => {
    const q = await make();
    const sent = await quoteAction(scope, q.id, QuoteAction.parse({ action: "markSent", version: q.version }));
    const revised = await quoteAction(scope, q.id, QuoteAction.parse({ action: "revise", version: sent.version }));
    const edited = await editQuote(scope, q.id, QuoteEdit.parse({ version: revised.version, note: "Delivery in June" }));
    expect(edited.version).toBe(2);
    const list = await quoteVersions(scope, q.id);
    expect(list.map((v) => [v.version, v.sent])).toEqual([[1, true]]);
  });

  it("another brand's quote is 404", async () => {
    const q = await make();
    await expect(quoteVersions(other, q.id)).rejects.toMatchObject({ status: 404 });
  });
});
