import { beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/prisma";
import { createQuote, deleteQuote, editQuote, QuoteCreate, QuoteEdit, quoteAction, type QuoteScope } from "@/server/quotes/quotes";
import type { PermissionKey } from "@/shared";

/** Quotes in our app: numbers, line snapshots, server totals and what may change when. */
let ws: string;
let brand: string;
let other: string;
let scope: QuoteScope;
let product: string;
const ALL = new Set<PermissionKey>(["brand.read", "crm.manage"]);
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; code?: string }) => ({ status: e.status, code: e.code }));

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-quotes" } })).id;
  brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "Bois & Chiffons" } })).id;
  other = (await prisma.brand.create({ data: { workspaceId: ws, slug: "o", displayName: "Other" } })).id;
  const u = await prisma.user.create({ data: { email: "q@quotes.test", name: "q" } });
  scope = { workspaceId: ws, brandId: brand, userId: u.id, perms: ALL };
  product = (await prisma.product.create({ data: { workspaceId: ws, brandId: brand, source: "SHOPIFY", externalId: "gid://shopify/ProductVariant/7", title: "Linen sofa — Sand", price: "1200.00", currency: "EUR" } })).id;
});

const create = (body: unknown) => createQuote(scope, QuoteCreate.parse(body));

describe("quotes", () => {
  it("snapshots a catalogue line in the shop's currency and works out totals itself", async () => {
    const q = await create({ lines: [{ productId: product, quantity: 2 }, { title: "Delivery to the 3rd floor", quantity: 1, unitPrice: "80" }], discount: { kind: "PERCENT", value: "10" }, totals: { total: "1" } });
    expect(q).toMatchObject({ status: "DRAFT", version: 1, currency: "EUR", totals: { subtotal: "2480.00", discount: "248.00", total: "2232.00" } });
    expect(q.lines[0]).toEqual({ productId: product, variantId: "gid://shopify/ProductVariant/7", title: "Linen sofa — Sand", quantity: 2, unitPrice: "1200.00" });
    expect(q.lines[1]).toMatchObject({ productId: null, variantId: null, unitPrice: "80.00" });
    // No validity until the invoice is sent.
    expect(q.validUntil).toBeNull();
  });

  it("two quotes at once get distinct numbers", async () => {
    const qs = await Promise.all(Array.from({ length: 5 }, () => create({ lines: [] })));
    const numbers = qs.map((q) => q.number);
    expect(new Set(numbers).size).toBe(5);
    const profile = await prisma.brandProfile.findUniqueOrThrow({ where: { brandId: brand } });
    expect(profile.nextQuoteNumber).toBe(Math.max(...numbers.map((n) => Number(n.slice(2)))) + 1);
  });

  it("a product of another brand is 404", async () => {
    const theirs = await prisma.product.create({ data: { workspaceId: ws, brandId: other, source: "MANUAL", title: "Theirs", price: "1.00", currency: "EUR" } });
    expect(await refusal(create({ lines: [{ productId: theirs.id, quantity: 1 }] }))).toEqual({ status: 404, code: undefined });
  });

  it("a later catalogue price change leaves the quote as quoted", async () => {
    const q = await create({ lines: [{ productId: product, quantity: 1 }] });
    await prisma.product.update({ where: { id: product }, data: { price: "1500.00", title: "Linen sofa — Sand (new)" } });
    try {
      const edited = await editQuote(scope, q.id, QuoteEdit.parse({ version: 1, note: "Delivery in May" }));
      expect(edited).toMatchObject({ version: 2, note: "Delivery in May", totals: { total: "1200.00" } });
      expect(edited.lines[0]).toMatchObject({ title: "Linen sofa — Sand", unitPrice: "1200.00" });
      // A person's own price on a catalogue line wins over the catalogue's.
      const priced = await editQuote(scope, q.id, QuoteEdit.parse({ version: 2, lines: [{ productId: product, quantity: 1, title: "Linen sofa — Sand", unitPrice: "1100" }] }));
      expect(priced.totals.total).toBe("1100.00");
    } finally {
      await prisma.product.update({ where: { id: product }, data: { price: "1200.00", title: "Linen sofa — Sand" } });
    }
  });

  it("an edit on an old version, or of a sent quote, is a 409; revise reopens it", async () => {
    const q = await create({ lines: [] });
    expect(await refusal(editQuote(scope, q.id, QuoteEdit.parse({ version: 9, note: "x" })))).toMatchObject({ status: 409, code: "quote.changed" });
    await prisma.quote.update({ where: { id: q.id }, data: { status: "SENT", shopifyId: "gid://shopify/DraftOrder/1" } });
    expect(await refusal(editQuote(scope, q.id, QuoteEdit.parse({ version: 1, note: "x" })))).toMatchObject({ status: 409, code: "quote.notEditable" });
    expect(await quoteAction(scope, q.id, { action: "revise", version: 1 })).toMatchObject({ status: "CREATED" });
    expect(await editQuote(scope, q.id, QuoteEdit.parse({ version: 1, note: "x" }))).toMatchObject({ version: 2, needsShopifyUpdate: true });
  });

  it("the contact's email and name never reach the audit log", async () => {
    const q = await create({ contactName: "Jeanne Martin", contactEmail: "jeanne@client.test", lines: [] });
    await editQuote(scope, q.id, QuoteEdit.parse({ version: 1, contactEmail: "jeanne.m@client.test" }));
    const events = await prisma.auditEvent.findMany({ where: { entityType: "Quote", entityId: q.id } });
    expect(events.map((e) => e.action)).toEqual(["quote.created", "quote.edited"]);
    expect(JSON.stringify(events)).not.toMatch(/jeanne|Martin/i);
  });

  it("a draft never in Shopify is deleted; one in Shopify is cancelled", async () => {
    const a = await create({ lines: [] });
    await deleteQuote(scope, a.id);
    expect(await prisma.quote.findUnique({ where: { id: a.id } })).toBeNull();
    const b = await create({ lines: [] });
    await prisma.quote.update({ where: { id: b.id }, data: { status: "CREATED", shopifyId: "gid://shopify/DraftOrder/2" } });
    expect(await deleteQuote(scope, b.id)).toMatchObject({ quote: { status: "CANCELLED" }, notice: null });
    // Closed quotes stay closed.
    expect(await refusal(deleteQuote(scope, b.id))).toMatchObject({ status: 409, code: "quote.closed" });
  });

  it("a draft whose create in Shopify is unconfirmed can't be deleted", async () => {
    const q = await create({ lines: [] });
    await prisma.shopifyWrite.create({ data: { workspaceId: ws, brandId: brand, entityType: "QUOTE", entityId: q.id, version: 1, action: "DRAFT_ORDER_CREATE", payloadHash: "h", status: "UNKNOWN", actorUserId: scope.userId } });
    expect(await refusal(deleteQuote(scope, q.id))).toMatchObject({ status: 409, code: "quote.createInFlight" });
  });

  it("prices follow the currency's decimals: none for JPY, three for KWD", async () => {
    const s2 = { ...scope, brandId: other };
    expect(await createQuote(s2, QuoteCreate.parse({ currency: "JPY", lines: [{ title: "Chair", quantity: 3, unitPrice: "1200" }], discount: { kind: "PERCENT", value: "10" } }))).toMatchObject({ totals: { subtotal: "3600", discount: "360", total: "3240" } });
    expect(await refusal(createQuote(s2, QuoteCreate.parse({ currency: "JPY", lines: [{ title: "Chair", quantity: 1, unitPrice: "1200.5" }] })))).toMatchObject({ status: 400, code: "quote.decimals" });
    expect(await createQuote(s2, QuoteCreate.parse({ currency: "KWD", lines: [{ title: "Chair", quantity: 2, unitPrice: "1.255" }] }))).toMatchObject({ totals: { total: "2.510" } });
  });

  it("a brand without a Shopify catalogue gives the currency; a line in another currency is refused", async () => {
    const s2 = { ...scope, brandId: other };
    await expect(createQuote(s2, QuoteCreate.parse({ lines: [] }))).rejects.toMatchObject({ status: 400 });
    const usd = await prisma.product.create({ data: { workspaceId: ws, brandId: other, source: "MANUAL", title: "Lamp", price: "10.00", currency: "USD" } });
    expect(await refusal(createQuote(s2, QuoteCreate.parse({ currency: "EUR", lines: [{ productId: usd.id, quantity: 1 }] })))).toMatchObject({ status: 400, code: "quote.currency" });
    expect(await createQuote(s2, QuoteCreate.parse({ currency: "USD", lines: [{ productId: usd.id, quantity: 1 }] }))).toMatchObject({ currency: "USD", totals: { total: "10.00" } });
  });
});

vi.setConfig({ testTimeout: 20_000 });
