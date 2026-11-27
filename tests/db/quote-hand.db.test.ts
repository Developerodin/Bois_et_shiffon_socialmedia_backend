import { beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/prisma";
import { createQuote, deleteQuote, QuoteAction, QuoteCreate, quoteAction, type QuoteScope } from "@/server/quotes/quotes";
import { confirmDraftOrderWrite, confirmInvoice, previewDraftOrderWrite, previewInvoice } from "@/server/quotes/shopify-draft-orders";
import { syncQuoteStatus } from "@/server/quotes/status-sync";
import { MCP_SCOPE } from "@/server/shopify/catalog-mcp";
import type { PermissionKey } from "@/shared";
import { fakeShopify } from "../fixtures/shopify-fake";

/** Plan 2026-11-27-crm, Task A1: DECLINED, and quotes sent and accepted by hand while Shopify writes aren't connected. */
let ws: string;
let brand: string;
let scope: QuoteScope;
const DAY = 86_400_000;

beforeAll(async () => {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-quote-hand" } })).id;
  brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "Bois & Chiffons" } })).id;
  const u = await prisma.user.create({ data: { email: "s@quote-hand.test", name: "s" } });
  const role = await prisma.role.create({ data: { workspaceId: ws, slug: "sales", name: "Sales", permissions: ["brand.read", "tasks.read", "crm.manage"] } });
  await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: u.id, roleId: role.id } });
  scope = { workspaceId: ws, brandId: brand, userId: u.id, perms: new Set<PermissionKey>(["brand.read", "crm.manage"]) };
});

const handQuote = () => createQuote(scope, QuoteCreate.parse({ currency: "EUR", contactName: "Jeanne Martin", contactEmail: "jeanne@client.test", lines: [{ title: "Sofa", quantity: 1, unitPrice: "900" }] }));
const act = (id: string, body: unknown) => quoteAction(scope, id, QuoteAction.parse(body));
const row = (id: string) => prisma.quote.findUniqueOrThrow({ where: { id } });
const reminders = (id: string) => prisma.task.findMany({ where: { requestId: { startsWith: `quote:${id}:` } }, orderBy: { createdAt: "asc" } });
async function shopifyQuote(shop: ReturnType<typeof fakeShopify>) {
  const q = await handQuote();
  const c = await previewDraftOrderWrite(scope, q.id, "create", {}, shop.adapter);
  await confirmDraftOrderWrite(scope, q.id, "create", c.confirmToken, shop.adapter);
  const i = await previewInvoice(scope, q.id, {}, {}, shop.adapter);
  return confirmInvoice(scope, q.id, {}, i.confirmToken, shop.adapter);
}

describe("quotes by hand", () => {
  it("markSent: SENT for 30 brand days, the sender recorded; the sync reminds on day 7 with hand-sent copy", async () => {
    const q = await handQuote();
    const sent = await act(q.id, { action: "markSent", version: q.version });
    expect(sent.status).toBe("SENT");
    expect(sent.validUntil).toBe(new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10));
    expect((await row(q.id)).sentById).toBe(scope.userId);
    await syncQuoteStatus(scope, fakeShopify().adapter, new Date(Date.now() + 7 * DAY));
    const [task] = await reminders(q.id);
    expect(task).toMatchObject({ areas: ["CRM"], ownerId: scope.userId });
    expect(task!.description).not.toContain("Shopify");
    await syncQuoteStatus(scope, fakeShopify().adapter, new Date(Date.now() + 31 * DAY));
    expect((await row(q.id)).status).toBe("EXPIRED");
  });

  it("an empty quote or a second click is refused", async () => {
    const empty = await createQuote(scope, QuoteCreate.parse({ currency: "EUR", lines: [] }));
    await expect(act(empty.id, { action: "markSent", version: empty.version })).rejects.toMatchObject({ status: 409, code: "quote.empty" });
    const q = await handQuote();
    await act(q.id, { action: "markSent", version: q.version });
    await expect(act(q.id, { action: "markSent", version: q.version })).rejects.toMatchObject({ status: 409 });
  });

  it("hand actions are refused once the quote is in Shopify", async () => {
    const q = await shopifyQuote(fakeShopify());
    await expect(act(q.id, { action: "markAccepted", version: q.version })).rejects.toMatchObject({ status: 409, code: "quote.inShopify" });
    await expect(act(q.id, { action: "markSent", version: q.version })).rejects.toMatchObject({ status: 409, code: "quote.inShopify" });
  });

  it("markAccepted closes the reminders; revise of a hand-sent quote goes back to DRAFT", async () => {
    const q = await handQuote();
    const sent = await act(q.id, { action: "markSent", version: q.version });
    await syncQuoteStatus(scope, fakeShopify().adapter, new Date(Date.now() + 8 * DAY));
    expect(await reminders(q.id)).toHaveLength(1);
    expect((await act(q.id, { action: "markAccepted", version: sent.version })).status).toBe("ACCEPTED");
    expect((await reminders(q.id)).map((t) => t.status)).toEqual(["DONE"]);

    const r = await handQuote();
    const rs = await act(r.id, { action: "markSent", version: r.version });
    expect((await act(r.id, { action: "revise", version: rs.version })).status).toBe("DRAFT");
  });

  it("cancelling a hand-sent quote has no Shopify notice", async () => {
    const q = await handQuote();
    await act(q.id, { action: "markSent", version: q.version });
    expect((await deleteQuote(scope, q.id))?.notice).toBeNull();
  });

  it("an MCP-only Shopify brand still expires and reminds hand-sent quotes", async () => {
    const s2 = { ...scope, brandId: (await prisma.brand.create({ data: { workspaceId: ws, slug: "mcp", displayName: "MCP" } })).id };
    await prisma.integrationConnection.create({
      data: { workspaceId: ws, brandId: s2.brandId, provider: "SHOPIFY", externalAccountId: "mcp.myshopify.com", displayName: "mcp", scopes: [MCP_SCOPE], status: "ACTIVE", credentialKeyVersion: 1, connectedByUserId: scope.userId },
    });
    const q = await createQuote(s2, QuoteCreate.parse({ currency: "EUR", lines: [{ title: "Lamp", quantity: 1, unitPrice: "10" }] }));
    await quoteAction(s2, q.id, QuoteAction.parse({ action: "markSent", version: q.version }));
    expect(await syncQuoteStatus(s2, fakeShopify().adapter, new Date(Date.now() + 31 * DAY))).toMatchObject({ reason: "permission" });
    expect((await row(q.id)).status).toBe("EXPIRED");
  });
});

describe("DECLINED", () => {
  it("from SENT: reminders close, the reason is kept on the quote and only its length in the audit", async () => {
    const q = await handQuote();
    const sent = await act(q.id, { action: "markSent", version: q.version });
    await syncQuoteStatus(scope, fakeShopify().adapter, new Date(Date.now() + 8 * DAY));
    const out = await act(q.id, { action: "decline", version: sent.version, reason: "Went with a cheaper sofa from Jeanne's cousin" });
    expect(out).toMatchObject({ status: "DECLINED", declinedReason: "Went with a cheaper sofa from Jeanne's cousin" });
    expect((await reminders(q.id)).map((t) => t.status)).toEqual(["DONE"]);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: q.id, action: "quote.declined" } });
    expect(audit.metadata).toEqual({ from: "SENT", reasonLength: 45 });
    expect(JSON.stringify(audit)).not.toMatch(/cousin|Jeanne/);
  });

  it("a draft can't be declined", async () => {
    const q = await handQuote();
    await expect(act(q.id, { action: "decline", version: q.version })).rejects.toMatchObject({ status: 409, code: "quote.notDeclinable" });
  });

  it("declined in our app, then paid in Shopify → ACCEPTED with a team note", async () => {
    const shop = fakeShopify();
    const q = await shopifyQuote(shop);
    await act(q.id, { action: "decline", version: q.version });
    Object.assign(shop.drafts.get(`gid://shopify/DraftOrder/${Number(q.shopifyName!.slice(2))}`)!, { status: "COMPLETED", orderId: "gid://shopify/Order/9" });
    await syncQuoteStatus(scope, shop.adapter);
    const r = await row(q.id);
    expect(r.status).toBe("ACCEPTED");
    expect(r.internalNote).toContain("after it was declined here");
  });
});
