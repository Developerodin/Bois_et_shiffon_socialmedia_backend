import { beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/prisma";
import { listDataSources, runSync } from "@/server/data/sources";
import { createQuote, QuoteCreate, quoteAction, type QuoteScope } from "@/server/quotes/quotes";
import { confirmDraftOrderWrite, confirmInvoice, previewDraftOrderWrite, previewInvoice } from "@/server/quotes/shopify-draft-orders";
import { syncQuoteStatus } from "@/server/quotes/status-sync";
import type { PermissionKey } from "@/shared";
import { fakeShopify } from "../fixtures/shopify-fake";

/** The SHOPIFY_QUOTES runner: Shopify status, expiry at day 30 and payment reminders at 7 and 21 days. */
let ws: string;
let brand: string;
let scope: QuoteScope;
const DAY = 86_400_000;

beforeAll(async () => {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-quote-status" } })).id;
  brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "Bois & Chiffons" } })).id;
  const u = await prisma.user.create({ data: { email: "s@quote-status.test", name: "s" } });
  scope = { workspaceId: ws, brandId: brand, userId: u.id, perms: new Set<PermissionKey>(["brand.read", "crm.manage"]) };
});

async function sentQuote(shop: ReturnType<typeof fakeShopify>) {
  const q = await createQuote(scope, QuoteCreate.parse({ currency: "EUR", contactEmail: "jeanne@client.test", lines: [{ title: "Sofa", quantity: 1, unitPrice: "900" }] }));
  const c = await previewDraftOrderWrite(scope, q.id, "create", {}, shop.adapter);
  await confirmDraftOrderWrite(scope, q.id, "create", c.confirmToken, shop.adapter);
  const i = await previewInvoice(scope, q.id, {}, {}, shop.adapter);
  return confirmInvoice(scope, q.id, {}, i.confirmToken, shop.adapter);
}
const status = async (id: string) => (await prisma.quote.findUniqueOrThrow({ where: { id } })).status;
const reminders = (id: string) => prisma.task.findMany({ where: { requestId: { startsWith: `quote:${id}:` } }, orderBy: { createdAt: "asc" } });
const draftOf = (shop: ReturnType<typeof fakeShopify>, n: number) => shop.drafts.get(`gid://shopify/DraftOrder/${n}`)!;

describe("quote status", () => {
  it("the brand's first quote turns on its SHOPIFY_QUOTES source, seen with crm.manage only", async () => {
    await createQuote(scope, QuoteCreate.parse({ currency: "EUR", lines: [] }));
    expect(await prisma.dataSource.count({ where: { brandId: brand, kind: "SHOPIFY_QUOTES" } })).toBe(1);
    expect((await listDataSources(scope, new Set(["crm.manage"]))).map((s) => s.kind)).toEqual(["SHOPIFY_QUOTES"]);
    expect(await listDataSources(scope, new Set(["crm.read"]))).toEqual([]);
  });

  it("COMPLETED in Shopify → ACCEPTED with its order; deleted there → CANCELLED; nothing else is stored", async () => {
    const shop = fakeShopify();
    const a = await sentQuote(shop);
    const b = await sentQuote(shop);
    const nA = Number(a.shopifyName!.slice(2));
    Object.assign(draftOf(shop, nA), { status: "COMPLETED", orderId: "gid://shopify/Order/5", email: "someone@else.test" });
    shop.drafts.delete(`gid://shopify/DraftOrder/${Number(b.shopifyName!.slice(2))}`);
    const out = await syncQuoteStatus(scope, shop.adapter);
    expect(out).toEqual({ count: 2, reason: null });
    const rowA = await prisma.quote.findUniqueOrThrow({ where: { id: a.id } });
    expect(rowA).toMatchObject({ status: "ACCEPTED", orderId: "gid://shopify/Order/5", contactEmail: "jeanne@client.test" });
    expect(JSON.stringify(rowA)).not.toContain("someone@else");
    expect(await status(b.id)).toBe("CANCELLED");
    const audit = await prisma.auditEvent.findMany({ where: { entityId: { in: [a.id, b.id] }, action: { in: ["quote.accepted", "quote.cancelled"] } } });
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toMatch(/jeanne|someone/);
  });

  it("a sent quote is valid 30 days from the send, then EXPIRED, its Shopify draft left alone; a never-sent one never expires", async () => {
    const shop = fakeShopify();
    const q = await sentQuote(shop);
    expect(q.validUntil).toBe(new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10));
    const unsent = await createQuote(scope, QuoteCreate.parse({ currency: "EUR", lines: [{ title: "Lamp", quantity: 1, unitPrice: "10" }] }));
    const c = await previewDraftOrderWrite(scope, unsent.id, "create", {}, shop.adapter);
    await confirmDraftOrderWrite(scope, unsent.id, "create", c.confirmToken, shop.adapter);
    await syncQuoteStatus(scope, shop.adapter, new Date(Date.now() + 30 * DAY));
    expect(await status(q.id)).toBe("SENT");
    await syncQuoteStatus(scope, shop.adapter, new Date(Date.now() + 31 * DAY));
    expect(await status(q.id)).toBe("EXPIRED");
    await syncQuoteStatus(scope, shop.adapter, new Date(Date.now() + 400 * DAY));
    expect(await status(unsent.id)).toBe("CREATED");
    expect(shop.drafts.size).toBeGreaterThan(0);
  });

  it("reminders at 7 and 21 days while SENT, CRM area, owned by the sender, made once, closed when the quote leaves SENT", async () => {
    const shop = fakeShopify();
    const q = await sentQuote(shop);
    // The sender may own a CRM task: they hold crm.manage and tasks.read through a workspace role.
    const role = await prisma.role.create({ data: { workspaceId: ws, slug: "crm-sender", name: "Sales", permissions: ["brand.read", "tasks.read", "crm.manage"] } });
    await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: scope.userId, roleId: role.id } });
    await syncQuoteStatus(scope, shop.adapter, new Date(Date.now() + 6 * DAY));
    expect(await reminders(q.id)).toEqual([]);
    await syncQuoteStatus(scope, shop.adapter, new Date(Date.now() + 7 * DAY));
    await syncQuoteStatus(scope, shop.adapter, new Date(Date.now() + 8 * DAY));
    const seven = await reminders(q.id);
    expect(seven).toHaveLength(1);
    expect(seven[0]).toMatchObject({ title: `Quote ${q.number}: no payment after 7 days`, areas: ["CRM"], ownerId: scope.userId, status: "TODO" });
    expect(seven[0]!.title).not.toContain("jeanne");
    await syncQuoteStatus(scope, shop.adapter, new Date(Date.now() + 21 * DAY));
    expect((await reminders(q.id)).map((t) => t.title)).toEqual([`Quote ${q.number}: no payment after 7 days`, `Quote ${q.number}: no payment after 21 days`]);
    await quoteAction(scope, q.id, { action: "revise", version: q.version });
    const closed = await reminders(q.id);
    expect(closed.map((t) => t.status)).toEqual(["DONE", "DONE"]);
    expect(await prisma.taskComment.count({ where: { taskId: { in: closed.map((t) => t.id) }, kind: "SYSTEM" } })).toBe(2);
  });

  it("no reminder once the quote isn't SENT", async () => {
    const shop = fakeShopify();
    const q = await sentQuote(shop);
    await quoteAction(scope, q.id, { action: "revise", version: q.version });
    await syncQuoteStatus(scope, shop.adapter, new Date(Date.now() + 8 * DAY));
    expect(await reminders(q.id)).toEqual([]);
  });

  it("runs as the registered SHOPIFY_QUOTES sync; while writes aren't connected it reads nothing", async () => {
    const source = await prisma.dataSource.findFirstOrThrow({ where: { brandId: brand, kind: "SHOPIFY_QUOTES" } });
    const out = await runSync("SHOPIFY_QUOTES", { source, connection: null, mode: "daily", lease: { jobId: "j", leasedBy: "w" }, signal: AbortSignal.timeout(10_000) } as never);
    expect(out.reason).toBeNull();
  });
});
