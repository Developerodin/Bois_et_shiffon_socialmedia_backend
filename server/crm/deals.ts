import { Prisma, type Deal } from "@prisma/client";
import { z } from "zod";
import { brandWhere, changed, checkCrmLinks, checkOwner, crmAudit, type CrmScope, type Db, dayOf, dayString, invalid, notFound } from "@/server/crm/common";
import { advanceDealForQuote, eventOfStatus } from "@/server/crm/deal-moves";
import { prisma } from "@/server/db/prisma";
import { loadQuote } from "@/server/quotes/quotes";
import { TX } from "@/server/services/publishing";
import { CRM_LIMITS, DEAL_CLOSE_REASONS, DEAL_STAGES, OPEN_DEAL_STAGES, quoteNumber, type DealDto, type DealStage, type PipelineDto } from "@/shared";

/**
 * The pipeline (plan 2026-11-27-crm, Task A7), crm.manage. A deal's value is Decimal(14,2) with its currency, and
 * totals are per currency (never summed across). Won and Lost need a reason. Quotes move deals forward through
 * server/crm/deal-moves.ts. A deal's conversation id is shown only to inbox.read holders (plan review, Security 4).
 */
const id = z.string().min(1).max(40);
const VALUE = /^\d{1,12}(\.\d{1,2})?$/;
const fields = {
  title: z.string().trim().min(1, "Give the deal a title").max(CRM_LIMITS.dealTitle),
  customerId: id.nullable().optional(),
  companyId: id.nullable().optional(),
  conversationId: id.nullable().optional(),
  value: z.string().trim().regex(VALUE, "Write the value like 1250 or 1250.50").nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, "A currency is a 3-letter code like EUR").nullable().optional(),
  ownerId: id.nullable().optional(),
  nextAction: z.string().trim().max(CRM_LIMITS.nextAction).nullable().optional(),
  nextActionDue: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
};
export const DealCreate = z.object({ ...fields, stage: z.enum(OPEN_DEAL_STAGES).default("NEW") });
export const DealPatch = z.object({
  ...fields,
  title: fields.title.optional(),
  updatedAt: z.string().datetime(),
  stage: z.enum(DEAL_STAGES).optional(),
  closedReason: z.enum(DEAL_CLOSE_REASONS).nullable().optional(),
  closedNote: z.string().trim().max(CRM_LIMITS.closedNote).nullable().optional(),
});
export const QuoteDealInput = z.object({ dealId: id.nullable() });

const OPEN_QUOTE = ["DRAFT", "CREATED", "SENT"];
/** Won and Lost columns show the last 90 days, 50 each; open columns up to 200 each (performance review 6). */
const OPEN_COLUMN = 200;
const CLOSED_COLUMN = 50;
const CLOSED_DAYS = 90;

type DealRow = Deal & { customer: { id: string; displayName: string } | null; company: { id: string; name: string } | null };
const include = { customer: { select: { id: true, displayName: true } }, company: { select: { id: true, name: true } } } as const;
type QuoteBrief = { id: string; number: number; status: string; dealId: string | null };

export function toDealDto(d: DealRow, quotes: QuoteBrief[], perms: Set<string>): DealDto {
  const mine = quotes.filter((q) => q.dealId === d.id);
  const open = d.stage !== "WON" && d.stage !== "LOST";
  const accepted = mine.some((q) => q.status === "ACCEPTED");
  return {
    id: d.id,
    title: d.title,
    stage: d.stage,
    customer: d.customer,
    company: d.company,
    conversationId: perms.has("inbox.read") ? d.conversationId : null,
    value: d.value?.toFixed(2) ?? null,
    currency: d.currency,
    ownerId: d.ownerId,
    nextAction: d.nextAction,
    nextActionDue: dayString(d.nextActionDue),
    closedReason: (d.closedReason as DealDto["closedReason"]) ?? null,
    closedNote: d.closedNote,
    stageChangedAt: d.stageChangedAt.toISOString(),
    closedAt: d.closedAt?.toISOString() ?? null,
    lostSuggested: open && mine.length > 0 && !accepted && !mine.some((q) => OPEN_QUOTE.includes(q.status)),
    lostButPaid: d.stage === "LOST" && accepted,
    quotes: mine.map((q) => ({ id: q.id, number: quoteNumber(q.number), status: q.status })),
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

/** The quotes of these deals in one read (lostSuggested without N+1). */
const quotesOf = (db: Db, s: { workspaceId: string; brandId: string }, ids: string[]) =>
  ids.length ? db.quote.findMany({ where: { ...brandWhere(s), dealId: { in: ids } }, select: { id: true, number: true, status: true, dealId: true }, orderBy: { number: "asc" } }) : Promise.resolve([]);

export async function getDeal(s: CrmScope, dealId: string) {
  const d = await prisma.deal.findFirst({ where: { id: dealId, ...brandWhere(s) }, include });
  if (!d) throw notFound("Deal");
  return toDealDto(d, await quotesOf(prisma, s, [d.id]), s.perms);
}

/** A customer's deals for their page (crm.manage). */
export async function customerDeals(s: CrmScope, customerId: string) {
  const rows = await prisma.deal.findMany({ where: { ...brandWhere(s), customerId }, orderBy: [{ updatedAt: "desc" }], take: 50, select: { id: true, title: true, stage: true, value: true, currency: true } });
  return rows.map((d) => ({ id: d.id, title: d.title, stage: d.stage, value: d.value?.toFixed(2) ?? null, currency: d.currency }));
}

export async function pipeline(s: CrmScope, now = new Date()): Promise<PipelineDto> {
  const since = new Date(now.getTime() - CLOSED_DAYS * 86_400_000);
  const w = brandWhere(s);
  const columns = await Promise.all(
    DEAL_STAGES.map(async (stage) => {
      const closed = stage === "WON" || stage === "LOST";
      const take = closed ? CLOSED_COLUMN : OPEN_COLUMN;
      const rows = await prisma.deal.findMany({ where: { ...w, stage, ...(closed ? { closedAt: { gte: since } } : {}) }, include, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: take + 1 });
      return { stage, rows: rows.slice(0, take), more: rows.length > take };
    }),
  );
  // Totals per stage and currency in SQL, over the same sets the columns draw from.
  const totals = await prisma.$queryRaw<{ stage: DealStage; currency: string; value: Prisma.Decimal }[]>`
    SELECT stage, currency, sum(value) AS value FROM "Deal"
    WHERE "workspaceId" = ${s.workspaceId} AND "brandId" = ${s.brandId} AND value IS NOT NULL AND currency IS NOT NULL
      AND (stage NOT IN ('WON', 'LOST') OR "closedAt" >= ${since})
    GROUP BY stage, currency ORDER BY currency`;
  const quotes = await quotesOf(prisma, s, columns.flatMap((c) => c.rows.map((d) => d.id)));
  return {
    columns: columns.map((c) => ({
      stage: c.stage,
      deals: c.rows.map((d) => toDealDto(d, quotes, s.perms)),
      totals: totals.filter((t) => t.stage === c.stage).map((t) => ({ currency: t.currency, value: new Prisma.Decimal(t.value).toFixed(2) })),
      more: c.more,
    })),
  };
}

function checkMoney(value: string | null | undefined, currency: string | null | undefined) {
  if (value && !currency) throw invalid("Give the deal's currency with its value", "crm.currency");
}

export async function createDeal(s: CrmScope, input: z.infer<typeof DealCreate>) {
  checkMoney(input.value, input.currency);
  if (input.conversationId && !s.perms.has("inbox.read")) throw invalid("Linking a conversation needs access to customer messages", "crm.needsInbox");
  const d = await prisma.$transaction(async (tx) => {
    await checkCrmLinks(tx, s, { customerId: input.customerId, companyId: input.companyId, conversationId: input.conversationId });
    await checkOwner(tx, s, input.ownerId, "crm.manage");
    const row = await tx.deal.create({
      data: {
        ...brandWhere(s), title: input.title, stage: input.stage, customerId: input.customerId ?? null, companyId: input.companyId ?? null, conversationId: input.conversationId ?? null,
        value: input.value ?? null, currency: input.value ? input.currency : (input.currency ?? null), ownerId: input.ownerId ?? null, nextAction: input.nextAction || null, nextActionDue: dayOf(input.nextActionDue) ?? null,
      },
    });
    if (row.customerId) await tx.customer.updateMany({ where: { id: row.customerId, lastActivityAt: { lt: row.createdAt } }, data: { lastActivityAt: row.createdAt } });
    await crmAudit(tx, s, "deal.created", "Deal", row.id, { stage: row.stage });
    return row;
  }, TX);
  return getDeal(s, d.id);
}

/** Field edits and stage moves on the `updatedAt` read. Won/Lost need a reason; reopening clears it. */
export async function updateDeal(s: CrmScope, dealId: string, patch: z.infer<typeof DealPatch>, now = new Date()) {
  const { updatedAt, stage, closedReason, closedNote, ...rest } = patch;
  if (rest.conversationId && !s.perms.has("inbox.read")) throw invalid("Linking a conversation needs access to customer messages", "crm.needsInbox");
  await prisma.$transaction(async (tx) => {
    const d = await tx.deal.findFirst({ where: { id: dealId, ...brandWhere(s) } });
    if (!d) throw notFound("Deal");
    if (d.updatedAt.toISOString() !== new Date(updatedAt).toISOString()) throw changed("This deal");
    await checkCrmLinks(tx, s, { customerId: rest.customerId, companyId: rest.companyId, conversationId: rest.conversationId });
    await checkOwner(tx, s, rest.ownerId, "crm.manage");
    const value = rest.value === undefined ? d.value?.toFixed(2) ?? null : rest.value;
    const currency = rest.currency === undefined ? d.currency : rest.currency;
    checkMoney(value, currency);
    const moving = stage !== undefined && stage !== d.stage;
    const closing = moving && (stage === "WON" || stage === "LOST");
    if (closing && !closedReason) throw invalid("Say why the deal was won or lost", "crm.closeReason");
    const reopening = moving && !closing;
    const blank = (v: string | null | undefined) => (v === undefined ? undefined : v || null);
    await tx.deal.update({
      where: { id: d.id },
      data: {
        title: rest.title, customerId: rest.customerId, companyId: rest.companyId, conversationId: rest.conversationId, value: rest.value, currency: rest.currency, ownerId: rest.ownerId,
        nextAction: blank(rest.nextAction), nextActionDue: dayOf(rest.nextActionDue),
        ...(moving ? { stage, stageChangedAt: now } : {}),
        ...(closing ? { closedAt: now, closedReason, closedNote: closedNote || null } : {}),
        ...(reopening ? { closedAt: null, closedReason: null, closedNote: null } : {}),
        ...(!moving && closedNote !== undefined && (d.stage === "WON" || d.stage === "LOST") ? { closedNote: closedNote || null } : {}),
      },
    });
    const customerId = rest.customerId ?? d.customerId;
    if (customerId) await tx.customer.updateMany({ where: { id: customerId, lastActivityAt: { lt: now } }, data: { lastActivityAt: now } });
    await crmAudit(tx, s, moving ? "deal.stage" : "deal.edited", "Deal", d.id, moving ? { from: d.stage, to: stage, reason: closedReason ?? null } : { fields: Object.keys(rest) });
  }, TX);
  return getDeal(s, dealId);
}

/** A quote's deal (null unlinks). Linking an already-sent or accepted quote applies its forward move (review, Correctness 13). */
export async function setQuoteDeal(s: CrmScope, quoteId: string, input: z.infer<typeof QuoteDealInput>) {
  const q = await loadQuote(s, quoteId);
  await prisma.$transaction(async (tx) => {
    await checkCrmLinks(tx, s, { dealId: input.dealId });
    await tx.quote.updateMany({ where: { id: q.id, ...brandWhere(s) }, data: { dealId: input.dealId } });
    const event = input.dealId ? eventOfStatus(q.status) : null;
    if (event) await advanceDealForQuote(tx, { ...q, dealId: input.dealId }, event, s.userId);
    await crmAudit(tx, s, "quote.deal", "Quote", q.id, { dealId: input.dealId });
  }, TX);
  return loadQuote(s, quoteId);
}
