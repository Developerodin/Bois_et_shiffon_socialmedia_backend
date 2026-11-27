import type { DealStage, Prisma } from "@prisma/client";

/**
 * Quote events moving a deal forward (plan 2026-11-27-crm, Decision 8; stages per owner decision O2). Forward only, and
 * never a deal already WON or LOST: a sent quote takes New/Contacted to Proposal, a revise of a sent quote takes
 * Proposal to Negotiation, an accepted quote takes any open stage to Won ("quote_accepted"). Declined, expired and
 * cancelled quotes move nothing (the deal shows a "mark it lost?" suggestion, derived on read). Runs in the caller's
 * transaction; audited `deal.stage` with ids only. Kept apart from deals.ts so the quote modules can import it.
 */
export type QuoteEvent = "sent" | "revised" | "accepted";

const FROM: Record<QuoteEvent, DealStage[]> = {
  sent: ["NEW", "CONTACTED"],
  revised: ["PROPOSAL"],
  accepted: ["NEW", "CONTACTED", "PROPOSAL", "NEGOTIATION"],
};
const TO: Record<QuoteEvent, DealStage> = { sent: "PROPOSAL", revised: "NEGOTIATION", accepted: "WON" };

/** The event a quote status stands for when a quote is linked to a deal afterwards (an already-sent quote counts). */
export const eventOfStatus = (status: string): QuoteEvent | null => (status === "SENT" || status === "EXPIRED" || status === "DECLINED" ? "sent" : status === "ACCEPTED" ? "accepted" : null);

export async function advanceDealForQuote(tx: Prisma.TransactionClient, quote: { id: string; workspaceId: string; brandId: string; dealId?: string | null }, event: QuoteEvent, actorUserId: string | null = null, now = new Date()) {
  let dealId = quote.dealId;
  if (dealId === undefined) dealId = (await tx.quote.findFirst({ where: { id: quote.id, workspaceId: quote.workspaceId, brandId: quote.brandId }, select: { dealId: true } }))?.dealId ?? null;
  if (!dealId) return false;
  const deal = await tx.deal.findFirst({ where: { id: dealId, workspaceId: quote.workspaceId, brandId: quote.brandId }, select: { id: true, stage: true } });
  if (!deal || !FROM[event].includes(deal.stage)) return false;
  const to = TO[event];
  const { count } = await tx.deal.updateMany({
    where: { id: deal.id, stage: deal.stage },
    data: { stage: to, stageChangedAt: now, ...(to === "WON" ? { closedAt: now, closedReason: "quote_accepted", closedNote: null } : {}) },
  });
  if (!count) return false;
  await tx.auditEvent.create({ data: { workspaceId: quote.workspaceId, brandId: quote.brandId, actorUserId, action: "deal.stage", entityType: "Deal", entityId: deal.id, metadata: { from: deal.stage, to, quoteId: quote.id, auto: true } } });
  return true;
}
