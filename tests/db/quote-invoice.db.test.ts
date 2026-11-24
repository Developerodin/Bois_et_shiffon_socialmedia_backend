import { beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/prisma";
import { createQuote, editQuote, QuoteCreate, QuoteEdit, quoteAction, type QuoteScope } from "@/server/quotes/quotes";
import { confirmDraftOrderWrite, confirmInvoice, previewDraftOrderWrite, previewInvoice } from "@/server/quotes/shopify-draft-orders";
import type { InvoiceWritePreview, PermissionKey } from "@/shared";
import { fakeShopify } from "../fixtures/shopify-fake";

/** Shopify's invoice email for a quote, sent only when a person confirms the exact to, subject and message. */
let ws: string;
let brand: string;
let scope: QuoteScope;
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; code?: string }) => ({ status: e.status, code: e.code }));

beforeAll(async () => {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-quote-invoice" } })).id;
  brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "Bois & Chiffons" } })).id;
  const u = await prisma.user.create({ data: { email: "i@quote-invoice.test", name: "i" } });
  scope = { workspaceId: ws, brandId: brand, userId: u.id, perms: new Set<PermissionKey>(["brand.read", "crm.manage"]) };
});

/** A quote created in the fake Shopify. */
async function inShopify(shop: ReturnType<typeof fakeShopify>) {
  const q = await createQuote(scope, QuoteCreate.parse({ currency: "EUR", contactEmail: "jeanne@client.test", note: "Delivery in May", lines: [{ title: "Sofa", quantity: 1, unitPrice: "900" }] }));
  const p = await previewDraftOrderWrite(scope, q.id, "create", {}, shop.adapter);
  return confirmDraftOrderWrite(scope, q.id, "create", p.confirmToken, shop.adapter);
}

describe("invoice send", () => {
  it("shows to, subject and message, sends them as confirmed, and marks the quote SENT by the sender", async () => {
    const shop = fakeShopify();
    const q = await inShopify(shop);
    const send = vi.spyOn(shop.adapter, "sendInvoice");
    const p = await previewInvoice(scope, q.id, {}, {}, shop.adapter);
    expect(p.preview as InvoiceWritePreview).toEqual({ draftOrder: "#D1", to: "jeanne@client.test", subject: `Quote ${q.number} from Bois & Chiffons`, message: "Delivery in May" });
    const after = await confirmInvoice(scope, q.id, {}, p.confirmToken, shop.adapter);
    expect(send.mock.calls[0]!.slice(2)).toEqual(["gid://shopify/DraftOrder/1", { to: "jeanne@client.test", subject: `Quote ${q.number} from Bois & Chiffons`, message: "Delivery in May" }]);
    expect(after).toMatchObject({ status: "SENT", sentAt: expect.any(String) });
    expect((await prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).sentById).toBe(scope.userId);
    const audit = await prisma.auditEvent.findMany({ where: { workspaceId: ws, action: "shopify.draft_order_invoice_send" } });
    expect(JSON.stringify(audit)).not.toContain("jeanne");
  });

  it("to, subject and message are in the hash: a different one at confirm is refused", async () => {
    const shop = fakeShopify();
    const q = await inShopify(shop);
    const p = await previewInvoice(scope, q.id, { to: "jeanne@client.test", message: "Hello" }, {}, shop.adapter);
    for (const email of [{ to: "other@client.test", message: "Hello" }, { to: "jeanne@client.test", message: "Hello!" }, { to: "jeanne@client.test", subject: "Hi", message: "Hello" }]) {
      expect(await refusal(confirmInvoice(scope, q.id, email, p.confirmToken, shop.adapter))).toEqual({ status: 409, code: "CHANGED" });
    }
    expect(shop.calls.filter((c) => c.method === "sendInvoice")).toEqual([]);
  });

  it("an edit after the preview needs a fresh token (and Shopify's draft updated first)", async () => {
    const shop = fakeShopify();
    const q = await inShopify(shop);
    const p = await previewInvoice(scope, q.id, {}, {}, shop.adapter);
    await editQuote(scope, q.id, QuoteEdit.parse({ version: q.version, note: "Delivery in June" }));
    expect(await refusal(confirmInvoice(scope, q.id, {}, p.confirmToken, shop.adapter))).toMatchObject({ status: 409, code: "quote.needsUpdate" });
    expect(await refusal(previewInvoice(scope, q.id, {}, {}, shop.adapter))).toMatchObject({ status: 409, code: "quote.needsUpdate" });
  });

  it("a subtotal difference holds the invoice until accepted", async () => {
    const shop = fakeShopify();
    shop.rounding(-1);
    const q = await inShopify(shop);
    expect(await refusal(previewInvoice(scope, q.id, {}, {}, shop.adapter))).toMatchObject({ status: 409, code: "quote.subtotalDiffers" });
    await quoteAction(scope, q.id, { action: "acceptSubtotal", version: q.version });
    expect((await previewInvoice(scope, q.id, {}, {}, shop.adapter)).writes).toEqual({ ready: true });
  });

  it("a second send takes attempt 2 only when asked", async () => {
    const shop = fakeShopify();
    const q = await inShopify(shop);
    const first = await previewInvoice(scope, q.id, {}, {}, shop.adapter);
    await confirmInvoice(scope, q.id, {}, first.confirmToken, shop.adapter);
    const plain = await previewInvoice(scope, q.id, {}, {}, shop.adapter);
    expect(plain).toMatchObject({ attempt: 1, last: "DONE" });
    expect(await refusal(confirmInvoice(scope, q.id, {}, plain.confirmToken, shop.adapter))).toMatchObject({ status: 409, code: "ALREADY_DONE" });
    const again = await previewInvoice(scope, q.id, {}, { again: true }, shop.adapter);
    expect(again).toMatchObject({ attempt: 2, last: null });
    await confirmInvoice(scope, q.id, {}, again.confirmToken, shop.adapter);
    expect(shop.calls.filter((c) => c.method === "sendInvoice")).toHaveLength(2);
  });

  it("an invoice whose answer was lost is settled by Shopify's invoiceSentAt, not sent twice", async () => {
    const shop = fakeShopify();
    const q = await inShopify(shop);
    const p = await previewInvoice(scope, q.id, {}, {}, shop.adapter);
    shop.fail("lost");
    expect(await refusal(confirmInvoice(scope, q.id, {}, p.confirmToken, shop.adapter))).toMatchObject({ status: 502 });
    const again = await previewInvoice(scope, q.id, {}, {}, shop.adapter);
    expect(await confirmInvoice(scope, q.id, {}, again.confirmToken, shop.adapter)).toMatchObject({ status: "SENT" });
    expect(shop.calls.filter((c) => c.method === "sendInvoice")).toHaveLength(1);
  });

  it("no email address → 400", async () => {
    const shop = fakeShopify();
    const q = await inShopify(shop);
    await editQuote(scope, q.id, QuoteEdit.parse({ version: q.version, contactEmail: null }));
    const p = await previewDraftOrderWrite(scope, q.id, "update", {}, shop.adapter);
    await confirmDraftOrderWrite(scope, q.id, "update", p.confirmToken, shop.adapter);
    expect(await refusal(previewInvoice(scope, q.id, {}, {}, shop.adapter))).toMatchObject({ status: 400, code: "quote.noEmail" });
  });
});
