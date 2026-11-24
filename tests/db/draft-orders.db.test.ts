import { beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/prisma";
import { createQuote, editQuote, QuoteCreate, QuoteEdit, quoteAction, type QuoteScope } from "@/server/quotes/quotes";
import { confirmDraftOrderWrite, previewDraftOrderWrite } from "@/server/quotes/shopify-draft-orders";
import type { DraftOrderWritePreview, PermissionKey } from "@/shared";
import { fakeShopify } from "../fixtures/shopify-fake";

/** Quotes to Shopify draft orders through the confirmed-write module, with the fake adapter standing in for AskCart. */
let ws: string;
let brand: string;
let scope: QuoteScope;
let product: string;
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; code?: string; message?: string }) => ({ status: e.status, code: e.code, message: e.message }));

beforeAll(async () => {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-draft-orders" } })).id;
  brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "Bois & Chiffons" } })).id;
  const u = await prisma.user.create({ data: { email: "d@draft-orders.test", name: "d" } });
  scope = { workspaceId: ws, brandId: brand, userId: u.id, perms: new Set<PermissionKey>(["brand.read", "crm.manage"]) };
  product = (await prisma.product.create({ data: { workspaceId: ws, brandId: brand, source: "SHOPIFY", externalId: "gid://shopify/ProductVariant/7", title: "Linen sofa", price: "1200.00", currency: "EUR" } })).id;
});

const quote = () =>
  createQuote(scope, QuoteCreate.parse({
    contactEmail: "jeanne@client.test",
    lines: [{ productId: product, quantity: 2, unitPrice: "1000" }, { title: "Delivery", quantity: 1, unitPrice: "80" }],
    discount: { kind: "PERCENT", value: "10" },
    note: "Delivery in May",
  }));
async function send(id: string, action: "create" | "update", shop: ReturnType<typeof fakeShopify>) {
  const preview = await previewDraftOrderWrite(scope, id, action, {}, shop.adapter);
  return { preview, quote: await confirmDraftOrderWrite(scope, id, action, preview.confirmToken, shop.adapter) };
}

describe("quotes as Shopify draft orders", () => {
  it("creates the draft at the prices quoted, with our tag and no email", async () => {
    const shop = fakeShopify();
    const create = vi.spyOn(shop.adapter, "createDraftOrder");
    const q = await quote();
    const { preview, quote: after } = await send(q.id, "create", shop);
    expect(preview.preview as DraftOrderWritePreview).toEqual({
      draftOrder: null, currency: "EUR", discount: { kind: "PERCENT", value: "10" }, note: "Delivery in May", tag: `sma-quote-${q.id}`, total: "1872.00",
      lines: [{ variantId: "gid://shopify/ProductVariant/7", title: "Linen sofa", quantity: 2, unitPrice: "1000.00" }, { variantId: null, title: "Delivery", quantity: 1, unitPrice: "80.00" }],
    });
    const sent = create.mock.calls[0]![2];
    expect(sent.lines).toEqual([{ variantId: "gid://shopify/ProductVariant/7", title: "Linen sofa", quantity: 2, unitPrice: "1000.00" }, { title: "Delivery", quantity: 1, unitPrice: "80.00" }]);
    expect(JSON.stringify(sent)).not.toContain("jeanne");
    expect(after).toMatchObject({ status: "CREATED", shopifyName: "#D1", shopifySubtotal: "1872.00", subtotalDiffers: false, needsShopifyUpdate: false });
  });

  it("a subtotal Shopify works out differently is shown until a person accepts it", async () => {
    const shop = fakeShopify();
    shop.rounding(1);
    const q = await quote();
    const { quote: after } = await send(q.id, "create", shop);
    expect(after).toMatchObject({ shopifySubtotal: "1872.01", subtotalDiffers: true, subtotalAccepted: false, totals: { total: "1872.00" } });
    expect(await quoteAction(scope, q.id, { action: "acceptSubtotal", version: after.version })).toMatchObject({ subtotalAccepted: true });
  });

  it("an edit needs an update, which Shopify gets at the new prices", async () => {
    const shop = fakeShopify();
    const q = await quote();
    await send(q.id, "create", shop);
    expect(await refusal(previewDraftOrderWrite(scope, q.id, "update", {}, shop.adapter))).toMatchObject({ status: 409, code: "quote.upToDate" });
    const edited = await editQuote(scope, q.id, QuoteEdit.parse({ version: 1, discount: null }));
    expect(edited.needsShopifyUpdate).toBe(true);
    const update = vi.spyOn(shop.adapter, "updateDraftOrder");
    const { quote: after } = await send(q.id, "update", shop);
    expect(update.mock.calls[0]![3]).toMatchObject({ discount: null });
    expect(after).toMatchObject({ version: 2, needsShopifyUpdate: false, shopifySubtotal: "2080.00" });
  });

  it("a create whose answer was lost is found by its tag, never sent twice", async () => {
    const shop = fakeShopify();
    const q = await quote();
    const p = await previewDraftOrderWrite(scope, q.id, "create", {}, shop.adapter);
    shop.fail("lost");
    expect(await refusal(confirmDraftOrderWrite(scope, q.id, "create", p.confirmToken, shop.adapter))).toMatchObject({ status: 502 });
    const again = await previewDraftOrderWrite(scope, q.id, "create", {}, shop.adapter);
    expect(again.last).toBe("UNKNOWN");
    expect(await confirmDraftOrderWrite(scope, q.id, "create", again.confirmToken, shop.adapter)).toMatchObject({ status: "CREATED", shopifyName: "#D1" });
    expect(shop.calls.filter((c) => c.method === "createDraftOrder")).toHaveLength(1);
  });

  it("an update whose answer was lost is reconciled by the draft having changed", async () => {
    const shop = fakeShopify();
    const q = await quote();
    await send(q.id, "create", shop);
    await editQuote(scope, q.id, QuoteEdit.parse({ version: 1, note: "Delivery in June" }));
    const p = await previewDraftOrderWrite(scope, q.id, "update", {}, shop.adapter);
    shop.fail("lost");
    await refusal(confirmDraftOrderWrite(scope, q.id, "update", p.confirmToken, shop.adapter));
    const again = await previewDraftOrderWrite(scope, q.id, "update", {}, shop.adapter);
    expect(await confirmDraftOrderWrite(scope, q.id, "update", again.confirmToken, shop.adapter)).toMatchObject({ needsShopifyUpdate: false });
    expect(shop.calls.filter((c) => c.method === "updateDraftOrder")).toHaveLength(1);
  });

  it("without write_draft_orders the preview says so and the confirm is a 422", async () => {
    const shop = fakeShopify({ scopes: ["write_content"] });
    const q = await quote();
    const p = await previewDraftOrderWrite(scope, q.id, "create", {}, shop.adapter);
    expect(p.writes).toEqual({ ready: false, reason: "MISSING_SCOPE", scope: "write_draft_orders" });
    expect(await refusal(confirmDraftOrderWrite(scope, q.id, "create", p.confirmToken, shop.adapter))).toMatchObject({ status: 422, code: "MISSING_SCOPE" });
    expect(shop.calls.filter((c) => c.method === "createDraftOrder")).toEqual([]);
  });

  it("a draft completed in Shopify during a revision makes the quote accepted", async () => {
    const shop = fakeShopify();
    const q = await quote();
    const { quote: created } = await send(q.id, "create", shop);
    await editQuote(scope, q.id, QuoteEdit.parse({ version: created.version, note: "Changed" }));
    Object.assign(shop.drafts.get("gid://shopify/DraftOrder/1")!, { status: "COMPLETED", orderId: "gid://shopify/Order/9" });
    const p = await previewDraftOrderWrite(scope, q.id, "update", {}, shop.adapter);
    shop.fail({ ok: false, reason: "USER_ERROR", fields: ["id"] });
    expect(await refusal(confirmDraftOrderWrite(scope, q.id, "update", p.confirmToken, shop.adapter))).toMatchObject({ status: 409, code: "quote.completed" });
    expect(await prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).toMatchObject({ status: "ACCEPTED", orderId: "gid://shopify/Order/9" });
  });

  it("a refused line is named by its number", async () => {
    const shop = fakeShopify();
    const q = await quote();
    const p = await previewDraftOrderWrite(scope, q.id, "create", {}, shop.adapter);
    shop.fail({ ok: false, reason: "USER_ERROR", fields: ["input.lineItems.0.variantId"] });
    expect(await refusal(confirmDraftOrderWrite(scope, q.id, "create", p.confirmToken, shop.adapter))).toMatchObject({ status: 422, message: "Shopify refused line 1: its product may have been deleted or changed" });
  });

  it("while AskCart's writes aren't built, the preview says so and nothing is sent", async () => {
    const q = await quote();
    const p = await previewDraftOrderWrite(scope, q.id, "create");
    expect(p.writes).toEqual({ ready: false, reason: "NOT_CONNECTED" });
    expect(await refusal(confirmDraftOrderWrite(scope, q.id, "create", p.confirmToken))).toMatchObject({ status: 503, message: "Shopify writes aren't connected yet" });
  });
});
