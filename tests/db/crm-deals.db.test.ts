import { beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { CrmScope } from "@/server/crm/common";
import { createDeal, DealCreate, getDeal, pipeline, setQuoteDeal, toDealDto, updateDeal } from "@/server/crm/deals";
import { createQuote, QuoteAction, QuoteCreate, quoteAction } from "@/server/quotes/quotes";
import { confirmDraftOrderWrite, confirmInvoice, previewDraftOrderWrite, previewInvoice } from "@/server/quotes/shopify-draft-orders";
import { syncQuoteStatus } from "@/server/quotes/status-sync";
import type { PermissionKey } from "@/shared";
import { fakeShopify } from "../fixtures/shopify-fake";

/** Plan 2026-11-27-crm, Task A7: the pipeline and the quote → deal moves (O2, Decision 8). */
let s: CrmScope;
let other: CrmScope;
const DAY = 86_400_000;

beforeAll(async () => {
  const ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-crm-deals" } })).id;
  const brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "B" } })).id;
  const brand2 = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b2", displayName: "B2" } })).id;
  const u = await prisma.user.create({ data: { email: "a@crm-deals.test", name: "a" } });
  s = { workspaceId: ws, brandId: brand, userId: u.id, perms: new Set<PermissionKey>(["brand.read", "crm.manage"]) };
  other = { ...s, brandId: brand2 };
});

const deal = (title = "Hotel lobby sofas", stage: "NEW" | "CONTACTED" = "NEW") => createDeal(s, DealCreate.parse({ title, stage, value: "12000", currency: "EUR" }));
const quoteOn = async (dealId: string) => {
  const q = await createQuote(s, QuoteCreate.parse({ currency: "EUR", lines: [{ title: "Sofa", quantity: 4, unitPrice: "3000" }] }));
  return setQuoteDeal(s, q.id, { dealId });
};
const act = (id: string, version: number, action: string, extra = {}) => quoteAction(s, id, QuoteAction.parse({ action, version, ...extra }));
const stage = async (id: string) => (await getDeal(s, id)).stage;

describe("deals", () => {
  it("a value needs a currency; lost needs a reason, a win by hand doesn't; reopening clears it", async () => {
    await expect(createDeal(s, DealCreate.parse({ title: "x", value: "10" }))).rejects.toMatchObject({ status: 400, code: "crm.currency" });
    const d = await deal();
    await expect(updateDeal(s, d.id, { updatedAt: d.updatedAt, stage: "LOST" })).rejects.toMatchObject({ status: 400, code: "crm.closeReason" });
    const lost = await updateDeal(s, d.id, { updatedAt: d.updatedAt, stage: "LOST", closedReason: "price", closedNote: "Found cheaper" });
    expect(lost).toMatchObject({ stage: "LOST", closedReason: "price", closedNote: "Found cheaper" });
    expect(lost.closedAt).not.toBeNull();
    const back = await updateDeal(s, d.id, { updatedAt: lost.updatedAt, stage: "NEGOTIATION" });
    expect(back).toMatchObject({ stage: "NEGOTIATION", closedReason: null, closedAt: null });
    await expect(updateDeal(s, d.id, { updatedAt: lost.updatedAt, title: "stale" })).rejects.toMatchObject({ status: 409 });
    // Two edits of the same read at once: one wins, the other is a 409 (never a silent overwrite).
    const both = await Promise.allSettled([updateDeal(s, d.id, { updatedAt: back.updatedAt, title: "one" }), updateDeal(s, d.id, { updatedAt: back.updatedAt, title: "two" })]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const w = await deal("Showroom chairs");
    const won = await updateDeal(s, w.id, { updatedAt: w.updatedAt, stage: "WON", closedNote: "Signed in the showroom" });
    expect(won).toMatchObject({ stage: "WON", closedReason: null, closedNote: "Signed in the showroom" });
    expect(won.closedAt).not.toBeNull();
    await expect(getDeal(other, d.id)).rejects.toMatchObject({ status: 404 });
  });

  it("quotes move a deal forward only: sent → Proposal, revised → Negotiation, accepted → Won", async () => {
    const d = await deal();
    const q = await quoteOn(d.id);
    const sent = await act(q.id, q.version, "markSent");
    expect(await stage(d.id)).toBe("PROPOSAL");
    const revised = await act(q.id, sent.version, "revise");
    expect(await stage(d.id)).toBe("NEGOTIATION");
    const again = await act(q.id, revised.version, "markSent");
    // Sent again from Negotiation: never backwards.
    expect(await stage(d.id)).toBe("NEGOTIATION");
    await act(q.id, again.version, "markAccepted");
    const won = await getDeal(s, d.id);
    expect(won).toMatchObject({ stage: "WON", closedReason: "quote_accepted" });
    const moves = await prisma.auditEvent.findMany({ where: { entityId: d.id, action: "deal.stage" } });
    expect(moves.map((m) => (m.metadata as { to: string }).to)).toEqual(["PROPOSAL", "NEGOTIATION", "WON"]);
  });

  it("the Shopify invoice send and a payment found by the sync move it too; a lost deal is left alone but flagged", async () => {
    const shop = fakeShopify();
    const d = await deal("Shopify path");
    const q0 = await quoteOn(d.id);
    await quoteAction(s, q0.id, QuoteAction.parse({ action: "acceptSubtotal", version: q0.version })).catch(() => null);
    const c = await previewDraftOrderWrite(s, q0.id, "create", {}, shop.adapter);
    await confirmDraftOrderWrite(s, q0.id, "create", c.confirmToken, shop.adapter);
    const i = await previewInvoice(s, q0.id, { to: "buyer@hotel.test" }, {}, shop.adapter);
    const sent = await confirmInvoice(s, q0.id, { to: "buyer@hotel.test" }, i.confirmToken, shop.adapter);
    expect(await stage(d.id)).toBe("PROPOSAL");
    const dd = await getDeal(s, d.id);
    await updateDeal(s, d.id, { updatedAt: dd.updatedAt, stage: "LOST", closedReason: "no_response" });
    Object.assign(shop.drafts.get(`gid://shopify/DraftOrder/${Number(sent.shopifyName!.slice(2))}`)!, { status: "COMPLETED", orderId: "gid://shopify/Order/1" });
    await syncQuoteStatus(s, shop.adapter);
    expect(await getDeal(s, d.id)).toMatchObject({ stage: "LOST", lostButPaid: true });
  });

  it("when its last quote is declined the deal suggests lost but doesn't move", async () => {
    const d = await deal("Declined path");
    const q = await quoteOn(d.id);
    const sent = await act(q.id, q.version, "markSent");
    await act(q.id, sent.version, "decline", { reason: "Too expensive" });
    expect(await getDeal(s, d.id)).toMatchObject({ stage: "PROPOSAL", lostSuggested: true });
  });

  it("linking an already-sent quote moves the deal; linking another brand's deal is 404", async () => {
    const d = await deal("Late link");
    const q = await createQuote(s, QuoteCreate.parse({ currency: "EUR", lines: [{ title: "Chair", quantity: 1, unitPrice: "100" }] }));
    await act(q.id, q.version, "markSent");
    await setQuoteDeal(s, q.id, { dealId: d.id });
    expect(await stage(d.id)).toBe("PROPOSAL");
    const foreign = await createDeal(other, DealCreate.parse({ title: "Other" }));
    await expect(setQuoteDeal(s, q.id, { dealId: foreign.id })).rejects.toMatchObject({ status: 404 });
  });

  it("the board totals per stage and currency, never mixing currencies; old closed deals drop off", async () => {
    const s2 = { ...s, brandId: (await prisma.brand.create({ data: { workspaceId: s.workspaceId, slug: "board", displayName: "Board" } })).id };
    await createDeal(s2, DealCreate.parse({ title: "A", value: "100.50", currency: "EUR" }));
    await createDeal(s2, DealCreate.parse({ title: "B", value: "200", currency: "EUR" }));
    await createDeal(s2, DealCreate.parse({ title: "C", value: "300", currency: "GBP" }));
    const won = await createDeal(s2, DealCreate.parse({ title: "Old win", value: "999", currency: "EUR" }));
    await updateDeal(s2, won.id, { updatedAt: won.updatedAt, stage: "WON", closedReason: "other" });
    await prisma.deal.update({ where: { id: won.id }, data: { closedAt: new Date(Date.now() - 100 * DAY) } });
    const board = await pipeline(s2);
    const col = (st: string) => board.columns.find((c) => c.stage === st)!;
    expect(col("NEW").totals).toEqual([{ currency: "EUR", value: "300.50" }, { currency: "GBP", value: "300.00" }]);
    expect(col("NEW").deals).toHaveLength(3);
    expect(col("WON").deals).toEqual([]);
    expect(col("WON").totals).toEqual([]);
  });

  it("a deal's conversation is shown only to people who read customer messages", async () => {
    const d = await prisma.deal.findFirstOrThrow({ where: { brandId: s.brandId }, include: { customer: { select: { id: true, displayName: true } }, company: { select: { id: true, name: true } } } });
    const row = { ...d, conversationId: "conv1" };
    expect(toDealDto(row, [], new Set(["crm.manage"])).conversationId).toBeNull();
    expect(toDealDto(row, [], new Set(["crm.manage", "inbox.read"])).conversationId).toBe("conv1");
  });
});
