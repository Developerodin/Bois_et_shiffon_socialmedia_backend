import { randomUUID } from "node:crypto";
import type { Prisma, Quote, QuoteStatus } from "@prisma/client";
import { z } from "zod";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { addDays, brandTimeZone, zoneToday } from "@/server/data/sources";
import { prisma } from "@/server/db/prisma";
import { PublishingError } from "@/server/services/publishing";
import { OPEN_TASK_STATUSES, QUOTE_LIMITS, quoteNumber, type PermissionKey, type QuoteDiscount, type QuoteDto, type QuoteLine, type QuoteTotals } from "@/shared";

/**
 * Quotes in our app (plan 2026-11-24-phase-3-crm, Task 7), crm.manage for everything (checked by the routes). A quote
 * is drafted from catalogue products or free lines; each line is a snapshot (title, variant and unit price frozen when
 * added: a later catalogue change never alters a quote). Totals are worked out here only, in cents. Only an edit bumps
 * `version`, which a Shopify confirm token binds (server/quotes/shopify-draft-orders.ts). Editable in DRAFT and CREATED;
 * a SENT quote is revised first (back to CREATED). Contact name and email are a snapshot too, and never leave this
 * module except in the quote itself and Shopify's invoice send: audit metadata carries ids and counts only.
 */
export type QuoteScope = { workspaceId: string; brandId: string; userId: string; perms: Set<PermissionKey> };

const PRICE = /^\d{1,9}(\.\d{1,2})?$/;
const price = z.string().trim().regex(PRICE, "Write prices like 1250 or 1250.50");
const LineInput = z.union([
  z.object({ productId: z.string().min(1).max(40), quantity: z.number().int().min(1).max(QUOTE_LIMITS.quantity), title: z.string().trim().min(1).max(QUOTE_LIMITS.title).optional(), unitPrice: price.optional() }),
  z.object({ productId: z.null().optional(), title: z.string().trim().min(1).max(QUOTE_LIMITS.title), quantity: z.number().int().min(1).max(QUOTE_LIMITS.quantity), unitPrice: price }),
]);
const Discount = z
  .object({ kind: z.enum(["PERCENT", "AMOUNT"]), value: price })
  .refine((d) => d.kind !== "PERCENT" || Number(d.value) <= 100, "A percentage discount is at most 100");
const fields = {
  contactName: z.string().trim().max(QUOTE_LIMITS.name).nullable().optional(),
  contactEmail: z.string().trim().max(QUOTE_LIMITS.email).email("That email address doesn't look right").nullable().optional(),
  lines: z.array(LineInput).max(QUOTE_LIMITS.lines, `A quote has at most ${QUOTE_LIMITS.lines} lines`),
  discount: Discount.nullable().optional(),
  note: z.string().trim().max(QUOTE_LIMITS.note).nullable().optional(),
  internalNote: z.string().trim().max(QUOTE_LIMITS.note).nullable().optional(),
};
/** Totals a client sends are not fields here: they are dropped and always worked out again. */
export const QuoteCreate = z.object({ ...fields, lines: fields.lines.default([]), currency: z.string().regex(/^[A-Z]{3}$/).optional() });
export const QuoteEdit = z.object({ ...fields, lines: fields.lines.optional(), version: z.number().int().positive() });
export const QuoteAction = z.object({ action: z.enum(["revise", "acceptSubtotal"]), version: z.number().int().positive() });

// ---- money, in cents ---------------------------------------------------------------------------------------------

/** "12.5" → 1250. Amounts are at most 9 digits before the point, so cents stay well inside a safe integer. */
export const toCents = (s: string) => {
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
};
export const fromCents = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;

/**
 * Subtotal of the lines, the discount (a percentage rounded half up to the cent, or an amount capped at the subtotal)
 * and what is left before shipping and tax. Shopify may round a percentage differently: the draft order's own
 * subtotal is compared with `total` after every write and a difference shown.
 */
export function quoteTotals(lines: Pick<QuoteLine, "quantity" | "unitPrice">[], discount: QuoteDiscount | null): QuoteTotals {
  const subtotal = lines.reduce((n, l) => n + l.quantity * toCents(l.unitPrice), 0);
  const off = !discount ? 0 : discount.kind === "PERCENT" ? Math.round((subtotal * toCents(discount.value)) / 10_000) : Math.min(toCents(discount.value), subtotal);
  return { subtotal: fromCents(subtotal), discount: fromCents(off), total: fromCents(subtotal - off) };
}

// ---- reading -----------------------------------------------------------------------------------------------------

export const quoteLines = (json: unknown): QuoteLine[] => (Array.isArray(json) ? (json as QuoteLine[]) : []);
export const quoteDiscount = (json: unknown): QuoteDiscount | null => (json && typeof json === "object" ? (json as QuoteDiscount) : null);
const day = (d: Date) => d.toISOString().slice(0, 10);

export function toQuoteDto(q: Quote): QuoteDto {
  const totals = quoteTotals(quoteLines(q.lines), quoteDiscount(q.discount));
  const differs = q.shopifySubtotal !== null && toCents(q.shopifySubtotal) !== toCents(totals.total);
  return {
    id: q.id,
    number: quoteNumber(q.number),
    status: q.status,
    version: q.version,
    contactName: q.contactName,
    contactEmail: q.contactEmail,
    currency: q.currency,
    lines: quoteLines(q.lines),
    discount: quoteDiscount(q.discount),
    totals,
    note: q.note,
    internalNote: q.internalNote,
    validUntil: day(q.validUntil),
    shopifyName: q.shopifyName,
    needsShopifyUpdate: !!q.shopifyId && q.syncedVersion !== q.version,
    shopifySubtotal: q.shopifySubtotal,
    subtotalDiffers: differs,
    subtotalAccepted: differs && q.subtotalAccepted === q.shopifySubtotal,
    invoiceUrl: q.invoiceUrl,
    sentAt: q.sentAt?.toISOString() ?? null,
    createdById: q.createdById,
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
  };
}

const notFound = () => new PublishingError("Quote not found", 404);
const changed = () => new PublishingError("This quote changed since you opened it. Reload it and try again.", 409, "quote.changed");

/** The brand's quote, or 404 (another brand's id included). */
export async function loadQuote(scope: { workspaceId: string; brandId: string }, id: string, db: Prisma.TransactionClient | typeof prisma = prisma) {
  const q = await db.quote.findFirst({ where: { id, workspaceId: scope.workspaceId, brandId: scope.brandId } });
  if (!q) throw notFound();
  return q;
}

/** ponytail: the latest 100 changed; page by updatedAt once a brand keeps more open at a time. */
export async function listQuotes(scope: { workspaceId: string; brandId: string }) {
  const rows = await prisma.quote.findMany({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId }, orderBy: { updatedAt: "desc" }, take: 100 });
  return rows.map(toQuoteDto);
}

// ---- writing -----------------------------------------------------------------------------------------------------

/**
 * The shop's currency: the brand's Shopify catalogue carries it (the catalogue sync stores shop { currencyCode } on
 * every product). A brand without one gives it with the first quote.
 */
async function shopCurrency(scope: { workspaceId: string; brandId: string }) {
  const p = await prisma.product.findFirst({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId, source: "SHOPIFY", currency: { not: null } }, orderBy: { updatedAt: "desc" }, select: { currency: true } });
  return p?.currency ?? null;
}

/** Lines as frozen on the quote: a catalogue product (this brand's, not archived, else 404) copies its title and price now. */
async function snapshotLines(scope: { workspaceId: string; brandId: string }, input: z.infer<typeof LineInput>[], currency: string): Promise<QuoteLine[]> {
  const ids = [...new Set(input.flatMap((l) => (l.productId ? [l.productId] : [])))];
  const products = ids.length
    ? await prisma.product.findMany({ where: { id: { in: ids }, workspaceId: scope.workspaceId, brandId: scope.brandId, archivedAt: null }, select: { id: true, source: true, externalId: true, title: true, price: true, currency: true } })
    : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  return input.map((l, i) => {
    const unit = (s: string) => fromCents(toCents(s));
    if (l.productId == null) return { productId: null, variantId: null, title: l.title, quantity: l.quantity, unitPrice: unit(l.unitPrice) };
    const p = byId.get(l.productId);
    if (!p) throw new PublishingError("Product not found", 404);
    if (p.currency && p.currency !== currency) throw new PublishingError(`Line ${i + 1} is priced in ${p.currency}; this quote is in ${currency}`, 400, "quote.currency");
    const given = l.unitPrice ?? (p.price !== null ? p.price.toFixed(2) : null);
    if (given === null) throw new PublishingError(`Give a price for line ${i + 1}: the product has none`, 400, "quote.noPrice");
    return { productId: p.id, variantId: p.source === "SHOPIFY" ? p.externalId : null, title: l.title ?? p.title.slice(0, QUOTE_LIMITS.title), quantity: l.quantity, unitPrice: unit(given) };
  });
}

/** An amount discount can't take more than the lines are worth. */
function checkDiscount(lines: QuoteLine[], discount: QuoteDiscount | null | undefined) {
  if (discount?.kind === "AMOUNT" && toCents(discount.value) > toCents(quoteTotals(lines, null).subtotal)) {
    throw new PublishingError("The discount is more than the quote's lines", 400, "quote.discount");
  }
}

const audit = (db: Prisma.TransactionClient | typeof prisma, scope: { workspaceId: string; brandId: string; userId: string | null }, action: string, id: string, metadata: Prisma.InputJsonObject) =>
  db.auditEvent.create({ data: { workspaceId: scope.workspaceId, brandId: scope.brandId, actorUserId: scope.userId, action, entityType: "Quote", entityId: id, metadata } });

/**
 * A new DRAFT quote, numbered from the brand's counter in the same transaction (one row update, so two creates at once
 * get distinct numbers), valid 30 brand days. The brand's first quote also turns on its SHOPIFY_QUOTES source (daily
 * status, expiry and payment reminders: server/quotes/status-sync.ts).
 */
export async function createQuote(scope: QuoteScope, input: z.infer<typeof QuoteCreate>) {
  const currency = (await shopCurrency(scope)) ?? input.currency;
  if (!currency) throw new PublishingError("Say which currency the quote is in", 400, "quote.currency");
  const lines = await snapshotLines(scope, input.lines, currency);
  checkDiscount(lines, input.discount);
  const validUntil = addDays(zoneToday(await brandTimeZone(scope)), QUOTE_LIMITS.validDays);
  const quote = await prisma.$transaction(async (tx) => {
    const [{ number }] = await tx.$queryRaw<{ number: number }[]>`
      INSERT INTO "BrandProfile" ("id", "workspaceId", "brandId", "nextQuoteNumber", "updatedAt") VALUES (${randomUUID()}, ${scope.workspaceId}, ${scope.brandId}, 2, now())
      ON CONFLICT ("brandId") DO UPDATE SET "nextQuoteNumber" = "BrandProfile"."nextQuoteNumber" + 1, "updatedAt" = now()
      RETURNING "nextQuoteNumber" - 1 AS number`;
    const q = await tx.quote.create({
      data: {
        workspaceId: scope.workspaceId, brandId: scope.brandId, number, currency, lines: lines as Prisma.InputJsonValue,
        discount: (input.discount ?? undefined) as Prisma.InputJsonValue | undefined, contactName: input.contactName || null, contactEmail: input.contactEmail || null,
        note: input.note || null, internalNote: input.internalNote || null, validUntil: new Date(`${validUntil}T00:00:00Z`), createdById: scope.userId,
      },
    });
    await tx.dataSource.createMany({ data: [{ workspaceId: scope.workspaceId, brandId: scope.brandId, kind: "SHOPIFY_QUOTES", externalId: "" }], skipDuplicates: true });
    await audit(tx, scope, "quote.created", q.id, { number, lines: lines.length });
    return q;
  });
  return toQuoteDto(quote);
}

const EDITABLE: QuoteStatus[] = ["DRAFT", "CREATED"];

/** An edit on the `version` read (DRAFT or CREATED only): bumps it, so a token for the old one no longer confirms. */
export async function editQuote(scope: QuoteScope, id: string, patch: z.infer<typeof QuoteEdit>) {
  const { version, lines: lineInput, discount, ...rest } = patch;
  const q = await loadQuote(scope, id);
  if (q.version !== version) throw changed();
  if (!EDITABLE.includes(q.status)) {
    throw new PublishingError(q.status === "SENT" ? "The invoice was sent: revise the quote to change it" : "This quote can't be changed any more", 409, "quote.notEditable");
  }
  const lines = lineInput ? await snapshotLines(scope, lineInput, q.currency) : quoteLines(q.lines);
  const nextDiscount = discount === undefined ? quoteDiscount(q.discount) : discount;
  checkDiscount(lines, nextDiscount);
  const blank = (v: string | null | undefined) => (v === undefined ? undefined : v || null);
  const { count } = await prisma.quote.updateMany({
    where: { id, workspaceId: scope.workspaceId, brandId: scope.brandId, version, status: { in: EDITABLE } },
    data: {
      contactName: blank(rest.contactName), contactEmail: blank(rest.contactEmail), note: blank(rest.note), internalNote: blank(rest.internalNote),
      ...(lineInput ? { lines: lines as Prisma.InputJsonValue } : {}),
      ...(discount !== undefined ? { discount: (discount ?? null) as Prisma.InputJsonValue } : {}),
      version: { increment: 1 },
    },
  });
  if (!count) throw changed();
  // Field names only: never the contact's name, email or the notes.
  await audit(prisma, scope, "quote.edited", id, { fields: Object.keys(patch).filter((k) => k !== "version"), version: version + 1, lines: lines.length });
  return toQuoteDto(await loadQuote(scope, id));
}

/**
 * revise: a SENT quote back to CREATED so it can be edited (its payment reminders close). acceptSubtotal: a person
 * accepts Shopify's subtotal where it differs from ours, which lets the invoice go.
 */
export async function quoteAction(scope: QuoteScope, id: string, input: z.infer<typeof QuoteAction>) {
  const q = await loadQuote(scope, id);
  if (q.version !== input.version) throw changed();
  if (input.action === "revise") {
    if (q.status !== "SENT") throw new PublishingError("Only a sent quote is revised", 409, "quote.notSent");
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.quote.updateMany({ where: { id, workspaceId: scope.workspaceId, brandId: scope.brandId, version: q.version, status: "SENT" }, data: { status: "CREATED" } });
      if (!count) throw changed();
      await closeQuoteReminders(tx, q, "The quote is being revised");
      await audit(tx, scope, "quote.revised", id, { version: q.version });
    });
  } else {
    const dto = toQuoteDto(q);
    if (!dto.subtotalDiffers) throw new PublishingError("Shopify's subtotal matches this quote", 409, "quote.subtotalMatches");
    const { count } = await prisma.quote.updateMany({
      where: { id, workspaceId: scope.workspaceId, brandId: scope.brandId, version: q.version, shopifySubtotal: q.shopifySubtotal },
      data: { subtotalAccepted: q.shopifySubtotal },
    });
    if (!count) throw changed();
    await audit(prisma, scope, "quote.subtotal-accepted", id, { version: q.version, shopifySubtotal: q.shopifySubtotal, total: dto.totals.total });
  }
  return toQuoteDto(await loadQuote(scope, id));
}

/**
 * Remove a quote: a DRAFT never in Shopify is deleted; any other is CANCELLED here (its Shopify draft order is left
 * for a person: deleting it there is their call).
 */
export async function deleteQuote(scope: QuoteScope, id: string) {
  const q = await loadQuote(scope, id);
  await prisma.$transaction(async (tx) => {
    if (!q.shopifyId && q.status === "DRAFT") {
      await tx.quote.deleteMany({ where: { id, workspaceId: scope.workspaceId, brandId: scope.brandId, shopifyId: null, status: "DRAFT" } });
    } else {
      await tx.quote.updateMany({ where: { id, workspaceId: scope.workspaceId, brandId: scope.brandId }, data: { status: "CANCELLED" } });
      if (q.status === "SENT") await closeQuoteReminders(tx, q, "The quote was cancelled");
    }
    await audit(tx, scope, q.shopifyId || q.status !== "DRAFT" ? "quote.cancelled" : "quote.deleted", id, { number: q.number });
  });
}

// ---- payment reminders ------------------------------------------------------------------------------------------

/** A reminder task's requestId: one per quote, send day and day count (server/quotes/status-sync.ts makes them). */
export const reminderKey = (quoteId: string, sentDay: string, days: number) => `quote:${quoteId}:${sentDay}:${days}`;

/** Closes the quote's open payment reminders (it left SENT) with a system comment saying why. */
export async function closeQuoteReminders(tx: Prisma.TransactionClient, q: Pick<Quote, "id" | "workspaceId" | "brandId">, why: string) {
  const open = await tx.task.findMany({
    where: { workspaceId: q.workspaceId, brandId: q.brandId, requestId: { startsWith: `quote:${q.id}:` }, status: { in: [...OPEN_TASK_STATUSES] } },
    select: { id: true },
  });
  if (!open.length) return;
  const ids = open.map((t) => t.id);
  const now = new Date();
  await tx.task.updateMany({ where: { id: { in: ids } }, data: { status: "DONE", completedAt: now, blockedReason: null, blockedOnId: null } });
  await tx.taskComment.createMany({ data: ids.map((taskId) => ({ workspaceId: q.workspaceId, brandId: q.brandId, taskId, authorId: null, kind: "SYSTEM" as const, body: why, byClient: false, internal: false })) });
  await tx.auditEvent.createMany({ data: ids.map((id) => ({ workspaceId: q.workspaceId, brandId: q.brandId, actorUserId: null, action: "task.closed-by-quote", entityType: "Task", entityId: id, metadata: { quoteId: q.id } })) });
}

// ---- responses ---------------------------------------------------------------------------------------------------

export function quoteProblem(error: unknown) {
  if (error instanceof PublishingError) {
    return problemResponse({ type: "https://api.brandpilot/errors/quote", title: error.message, status: error.status, detail: error.message, code: error.code, ...error.data });
  }
  return fromAccessError(error);
}

export const invalidQuote = (detail?: string) => problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid quote", status: 400, detail });
