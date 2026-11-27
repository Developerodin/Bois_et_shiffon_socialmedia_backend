import { randomUUID } from "node:crypto";
import type { Prisma, Quote, QuoteStatus } from "@prisma/client";
import { z } from "zod";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { prisma } from "@/server/db/prisma";
import { addDays, brandTimeZone, zoneToday } from "@/server/data/sources";
import { PublishingError, TX } from "@/server/services/publishing";
import { writeInFlight } from "@/server/shopify/writes";
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

const PRICE = /^\d{1,9}(\.\d{1,3})?$/;
const price = z.string().trim().regex(PRICE, "Write prices like 1250 or 1250.50");
const percent = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, "Write a percentage like 10 or 12.5, at most 2 decimals")
  .refine((v) => Number(v) <= 100, "A percentage discount is at most 100");
const LineInput = z.union([
  z.object({ productId: z.string().min(1).max(40), quantity: z.number().int().min(1).max(QUOTE_LIMITS.quantity), title: z.string().trim().min(1).max(QUOTE_LIMITS.title).optional(), unitPrice: price.optional() }),
  z.object({ productId: z.null().optional(), title: z.string().trim().min(1).max(QUOTE_LIMITS.title), quantity: z.number().int().min(1).max(QUOTE_LIMITS.quantity), unitPrice: price }),
]);
/** By kind: a percentage 0–100 with at most 2 decimals; an amount as a price (its decimals checked against the currency). */
const Discount = z.discriminatedUnion("kind", [z.object({ kind: z.literal("PERCENT"), value: percent }), z.object({ kind: z.literal("AMOUNT"), value: price })]);
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
/**
 * revise / acceptSubtotal (Shopify path); decline (a person records the customer's no); markSent / markAccepted: the
 * hand path for a quote that isn't in Shopify (plan 2026-11-27-crm, Decision 16), while AskCart's writes don't exist.
 */
export const QuoteAction = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["revise", "acceptSubtotal", "markSent", "markAccepted"]), version: z.number().int().positive() }),
  z.object({ action: z.literal("decline"), version: z.number().int().positive(), reason: z.string().trim().max(QUOTE_LIMITS.reason).nullable().optional() }),
]);

// ---- money, in the currency's minor unit -----------------------------------------------------------------------

/** ISO 4217 currencies without the usual two decimals; every other one has two. */
const ZERO_DECIMALS = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"]);
const THREE_DECIMALS = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);
export const minorDigits = (currency: string) => (ZERO_DECIMALS.has(currency) ? 0 : THREE_DECIMALS.has(currency) ? 3 : 2);

/** "12.5" → 1250 with 2 digits. Digits past `digits` are dropped (callers refuse non-zero ones first: tooPrecise). At most 9 digits before the point, so this stays a safe integer. */
export const toMinor = (s: string, digits = 2) => {
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 10 ** digits + Number(frac.padEnd(digits, "0").slice(0, digits) || "0");
};
export const fromMinor = (n: number, digits = 2) => (digits ? `${Math.floor(n / 10 ** digits)}.${String(n % 10 ** digits).padStart(digits, "0")}` : String(n));
/** More decimals than the currency has (non-zero ones): "1200.5" in JPY. */
export const tooPrecise = (s: string, digits: number) => /[1-9]/.test((s.split(".")[1] ?? "").slice(digits));

/**
 * Subtotal of the lines, the discount (a percentage rounded half up to the minor unit, or an amount capped at the
 * subtotal) and what is left before shipping and tax, in `currency`'s decimals. Shopify may round a percentage
 * differently: the draft order's own subtotal is compared with `total` after every write and a difference shown.
 */
export function quoteTotals(lines: Pick<QuoteLine, "quantity" | "unitPrice">[], discount: QuoteDiscount | null, currency = "EUR"): QuoteTotals {
  const d = minorDigits(currency);
  const subtotal = lines.reduce((n, l) => n + l.quantity * toMinor(l.unitPrice, d), 0);
  const off = !discount ? 0 : discount.kind === "PERCENT" ? Math.round((subtotal * toMinor(discount.value, 2)) / 10_000) : Math.min(toMinor(discount.value, d), subtotal);
  return { subtotal: fromMinor(subtotal, d), discount: fromMinor(off, d), total: fromMinor(subtotal - off, d) };
}

// ---- reading -----------------------------------------------------------------------------------------------------

export const quoteLines = (json: unknown): QuoteLine[] => (Array.isArray(json) ? (json as QuoteLine[]) : []);
export const quoteDiscount = (json: unknown): QuoteDiscount | null => (json && typeof json === "object" ? (json as QuoteDiscount) : null);
const day = (d: Date) => d.toISOString().slice(0, 10);

export function toQuoteDto(q: Quote): QuoteDto {
  const totals = quoteTotals(quoteLines(q.lines), quoteDiscount(q.discount), q.currency);
  const d = minorDigits(q.currency);
  const differs = q.shopifySubtotal !== null && toMinor(q.shopifySubtotal, d) !== toMinor(totals.total, d);
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
    validUntil: q.validUntil ? day(q.validUntil) : null,
    shopifyName: q.shopifyName,
    needsShopifyUpdate: !!q.shopifyId && q.syncedVersion !== q.version,
    shopifySubtotal: q.shopifySubtotal,
    subtotalDiffers: differs,
    subtotalAccepted: differs && q.subtotalAccepted === q.shopifySubtotal,
    invoiceUrl: q.invoiceUrl,
    sentAt: q.sentAt?.toISOString() ?? null,
    declinedReason: q.declinedReason,
    createdById: q.createdById,
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
  };
}

const notFound = () => new PublishingError("Quote not found", 404);
const inFlight = () => new PublishingError("A change to this quote is being sent to Shopify or waits for Shopify to confirm it. Check it again, then edit.", 409, "quote.writeInFlight");
const inShopify = () => new PublishingError("This quote is in Shopify: Shopify's invoice and payment move it along", 409, "quote.inShopify");
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
  const d = minorDigits(currency);
  return input.map((l, i) => {
    const unit = (s: string) => {
      if (tooPrecise(s, d)) throw new PublishingError(`Line ${i + 1}: ${currency} prices have ${d === 0 ? "no decimals" : `at most ${d} decimals`}`, 400, "quote.decimals");
      return fromMinor(toMinor(s, d), d);
    };
    if (l.productId == null) return { productId: null, variantId: null, title: l.title, quantity: l.quantity, unitPrice: unit(l.unitPrice) };
    const p = byId.get(l.productId);
    if (!p) throw new PublishingError("Product not found", 404);
    if (p.currency && p.currency !== currency) throw new PublishingError(`Line ${i + 1} is priced in ${p.currency}; this quote is in ${currency}`, 400, "quote.currency");
    const given = l.unitPrice ?? (p.price !== null ? p.price.toFixed() : null);
    if (given === null) throw new PublishingError(`Give a price for line ${i + 1}: the product has none`, 400, "quote.noPrice");
    return { productId: p.id, variantId: p.source === "SHOPIFY" ? p.externalId : null, title: l.title ?? p.title.slice(0, QUOTE_LIMITS.title), quantity: l.quantity, unitPrice: unit(given) };
  });
}

/** An amount discount can't take more than the lines are worth. */
function checkDiscount(lines: QuoteLine[], discount: QuoteDiscount | null | undefined, currency: string) {
  const d = minorDigits(currency);
  if (discount?.kind === "AMOUNT" && tooPrecise(discount.value, d)) throw new PublishingError(`${currency} amounts have ${d === 0 ? "no decimals" : `at most ${d} decimals`}`, 400, "quote.decimals");
  if (discount?.kind === "AMOUNT" && toMinor(discount.value, d) > toMinor(quoteTotals(lines, null, currency).subtotal, d)) {
    throw new PublishingError("The discount is more than the quote's lines", 400, "quote.discount");
  }
}

const audit = (db: Prisma.TransactionClient | typeof prisma, scope: { workspaceId: string; brandId: string; userId: string | null }, action: string, id: string, metadata: Prisma.InputJsonObject) =>
  db.auditEvent.create({ data: { workspaceId: scope.workspaceId, brandId: scope.brandId, actorUserId: scope.userId, action, entityType: "Quote", entityId: id, metadata } });

/**
 * A new DRAFT quote, numbered from the brand's counter in the same transaction (one row update, so two creates at once
 * get distinct numbers). It has no validity until its invoice is sent (then 30 brand days, shopify-draft-orders.ts).
 * The brand's first quote also turns on its SHOPIFY_QUOTES source (daily
 * status, expiry and payment reminders: server/quotes/status-sync.ts).
 */
export async function createQuote(scope: QuoteScope, input: z.infer<typeof QuoteCreate>) {
  // The shop's currency; without a Shopify catalogue, the one the brand's first quote was given (kept on BrandProfile).
  const shop = await shopCurrency(scope);
  const kept = shop ? null : (await prisma.brandProfile.findFirst({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId }, select: { quoteCurrency: true } }))?.quoteCurrency ?? null;
  if (kept && input.currency && input.currency !== kept) throw new PublishingError(`This business's quotes are in ${kept}`, 400, "quote.currency");
  const currency = shop ?? kept ?? input.currency;
  if (!currency) throw new PublishingError("Say which currency the quote is in", 400, "quote.currency");
  const lines = await snapshotLines(scope, input.lines, currency);
  checkDiscount(lines, input.discount, currency);
  const quote = await prisma.$transaction(async (tx) => {
    // The row update also keeps the first quote's currency when there is no shop's (two first quotes at once queue on
    // the row: the second sees the first's currency and is refused if it differs).
    const keep = shop ? null : currency;
    const [{ number, quoteCurrency }] = await tx.$queryRaw<{ number: number; quoteCurrency: string | null }[]>`
      INSERT INTO "BrandProfile" ("id", "workspaceId", "brandId", "nextQuoteNumber", "quoteCurrency", "updatedAt") VALUES (${randomUUID()}, ${scope.workspaceId}, ${scope.brandId}, 2, ${keep}, now())
      ON CONFLICT ("brandId") DO UPDATE SET "nextQuoteNumber" = "BrandProfile"."nextQuoteNumber" + 1, "quoteCurrency" = COALESCE("BrandProfile"."quoteCurrency", EXCLUDED."quoteCurrency"), "updatedAt" = now()
      RETURNING "nextQuoteNumber" - 1 AS number, "quoteCurrency"`;
    if (keep && quoteCurrency !== keep) throw new PublishingError(`This business's quotes are in ${quoteCurrency}`, 400, "quote.currency");
    const q = await tx.quote.create({
      data: {
        workspaceId: scope.workspaceId, brandId: scope.brandId, number, currency, lines: lines as Prisma.InputJsonValue,
        discount: (input.discount ?? undefined) as Prisma.InputJsonValue | undefined, contactName: input.contactName || null, contactEmail: input.contactEmail || null,
        note: input.note || null, internalNote: input.internalNote || null, createdById: scope.userId,
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
  // A send in flight (or unconfirmed) is for the version it was confirmed on; an edit now would leave Shopify holding
  // lines the quote no longer has, and its onDone mark them sent.
  if (await writeInFlight(scope, "QUOTE", id)) throw inFlight();
  if (!EDITABLE.includes(q.status)) {
    throw new PublishingError(q.status === "SENT" ? "The invoice was sent: revise the quote to change it" : "This quote can't be changed any more", 409, "quote.notEditable");
  }
  const lines = lineInput ? await snapshotLines(scope, lineInput, q.currency) : quoteLines(q.lines);
  const nextDiscount = discount === undefined ? quoteDiscount(q.discount) : discount;
  checkDiscount(lines, nextDiscount, q.currency);
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
 * revise: a SENT quote back to editable (CREATED in Shopify, DRAFT when sent by hand; its payment reminders close).
 * acceptSubtotal: a person accepts Shopify's subtotal where it differs from ours, which lets the invoice go.
 * decline: CREATED, SENT or EXPIRED → DECLINED (Shopify's draft is left; status-sync.ts still notices a late payment).
 * markSent / markAccepted: the hand path, only for a quote with no Shopify draft (refused once it has one).
 */
export async function quoteAction(scope: QuoteScope, id: string, input: z.infer<typeof QuoteAction>) {
  const q = await loadQuote(scope, id);
  if (q.version !== input.version) throw changed();
  // A Shopify write on its way (a create's onDone sets shopifyId by id alone) would make the two paths disagree.
  if (input.action !== "acceptSubtotal" && input.action !== "revise" && (await writeInFlight(scope, "QUOTE", id))) throw inFlight();
  const where = { id, workspaceId: scope.workspaceId, brandId: scope.brandId, version: q.version };
  if (input.action === "revise") {
    if (q.status !== "SENT") throw new PublishingError("Only a sent quote is revised", 409, "quote.notSent");
    // In Shopify it goes back to CREATED (its draft order exists); a quote sent by hand back to DRAFT.
    const to = q.shopifyId ? "CREATED" : "DRAFT";
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.quote.updateMany({ where: { ...where, status: "SENT" }, data: { status: to } });
      if (!count) throw changed();
      await closeQuoteReminders(tx, q, "The quote is being revised");
      await audit(tx, scope, "quote.revised", id, { version: q.version, to });
    }, TX);
  } else if (input.action === "decline") {
    if (!DECLINABLE.includes(q.status)) throw new PublishingError("Only a quote in Shopify, sent or expired can be marked declined", 409, "quote.notDeclinable");
    const reason = input.reason || null;
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.quote.updateMany({ where: { ...where, status: q.status }, data: { status: "DECLINED", declinedReason: reason } });
      if (!count) throw changed();
      if (q.status === "SENT") await closeQuoteReminders(tx, q, "The customer declined the quote");
      // The reason's length only: it is the customer's words, near enough.
      await audit(tx, scope, "quote.declined", id, { from: q.status, reasonLength: reason?.length ?? 0 });
    }, TX);
  } else if (input.action === "markSent") {
    if (q.shopifyId) throw inShopify();
    if (q.status !== "DRAFT" && q.status !== "CREATED") throw new PublishingError("Only a draft quote is marked sent", 409, "quote.notDraft");
    if (!quoteLines(q.lines).length) throw new PublishingError("Add a line to the quote first", 409, "quote.empty");
    const zone = await brandTimeZone(scope);
    const sentAt = new Date();
    // As an invoice send: valid through the send day + 30 brand days; reminders on day 7 and 21 (status-sync.ts).
    const validUntil = new Date(`${addDays(zoneToday(zone, sentAt), QUOTE_LIMITS.validDays)}T00:00:00Z`);
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.quote.updateMany({ where: { ...where, status: q.status, shopifyId: null }, data: { status: "SENT", sentAt, validUntil, sentById: scope.userId } });
      if (!count) throw changed();
      await audit(tx, scope, "quote.marked-sent", id, { version: q.version });
    }, TX);
  } else if (input.action === "markAccepted") {
    if (q.shopifyId) throw inShopify();
    if (q.status !== "SENT" && q.status !== "EXPIRED") throw new PublishingError("Only a sent or expired quote is marked accepted", 409, "quote.notSent");
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.quote.updateMany({ where: { ...where, status: q.status, shopifyId: null }, data: { status: "ACCEPTED" } });
      if (!count) throw changed();
      if (q.status === "SENT") await closeQuoteReminders(tx, q, "The customer accepted the quote");
      await audit(tx, scope, "quote.marked-accepted", id, { from: q.status });
    }, TX);
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

const DECLINABLE: QuoteStatus[] = ["CREATED", "SENT", "EXPIRED"];

const CANCELLABLE: QuoteStatus[] = ["DRAFT", "CREATED", "SENT", "EXPIRED"];
/** Told to whoever cancels a quote whose invoice went out: cancelling here doesn't stop the customer paying it. */
export const INVOICE_STAYS_PAYABLE = "Shopify's invoice stays payable until you delete the draft order in Shopify. If the customer pays it, the quote shows as accepted again.";

/**
 * Remove a quote: a DRAFT never in Shopify is deleted (refused while its create is being sent or unconfirmed, so no
 * draft order is left in Shopify without its quote); a DRAFT, CREATED, SENT or EXPIRED one in Shopify is CANCELLED
 * here, its Shopify draft order left for a person (deleting it there is their call; a payment after the cancel is
 * still noticed by status-sync.ts). Returns the cancelled quote, with a notice when its invoice was sent; null when deleted.
 */
export async function deleteQuote(scope: QuoteScope, id: string): Promise<{ quote: QuoteDto; notice: string | null } | null> {
  const q = await loadQuote(scope, id);
  if (!CANCELLABLE.includes(q.status)) throw new PublishingError("This quote is already closed", 409, "quote.closed");
  const where = { id, workspaceId: scope.workspaceId, brandId: scope.brandId, status: q.status };
  // A DRAFT that was sent by hand and revised keeps its history: cancelled, not deleted.
  const deleting = !q.shopifyId && q.status === "DRAFT" && !q.sentAt;
  if (deleting) {
    if (await writeInFlight(scope, "QUOTE", id, ["DRAFT_ORDER_CREATE"])) throw new PublishingError("Shopify hasn't confirmed this quote's draft order yet. Check it again before deleting the quote.", 409, "quote.createInFlight");
  }
  // ponytail: the in-flight check and the delete aren't one lock; a create confirmed in that instant leaves a draft in Shopify with no quote here (its tag names the id).
  await prisma.$transaction(async (tx) => {
    const { count } = deleting
      ? await tx.quote.deleteMany({ where: { ...where, shopifyId: null, sentAt: null } })
      : await tx.quote.updateMany({ where, data: { status: "CANCELLED" } });
    if (!count) throw changed();
    if (q.status === "SENT") await closeQuoteReminders(tx, q, "The quote was cancelled");
    await audit(tx, scope, deleting ? "quote.deleted" : "quote.cancelled", id, { number: q.number, from: q.status });
  });
  if (deleting) return null;
  // Sent by hand: there is no Shopify invoice to warn about.
  return { quote: toQuoteDto(await loadQuote(scope, id)), notice: q.status === "SENT" && q.shopifyId ? INVOICE_STAYS_PAYABLE : null };
}

// ---- payment reminders ------------------------------------------------------------------------------------------

/** A reminder task's requestId: one per quote, invoice send (its instant) and day count (server/quotes/status-sync.ts makes them). */
export const reminderKey = (quoteId: string, sentAt: Date, days: number) => `quote:${quoteId}:${sentAt.getTime()}:${days}`;

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
