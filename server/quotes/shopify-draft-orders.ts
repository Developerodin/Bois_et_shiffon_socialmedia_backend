import type { Quote, ShopifyWriteAction } from "@prisma/client";
import { AccessDeniedError } from "@/server/auth/errors";
import { addDays, brandTimeZone, zoneToday } from "@/server/data/sources";
import { prisma } from "@/server/db/prisma";
import { closeQuoteReminders, loadQuote, minorDigits, quoteDiscount, quoteLines, quoteTotals, toMinor, toQuoteDto, type QuoteScope } from "@/server/quotes/quotes";
import { PublishingError } from "@/server/services/publishing";
import { askCartWriteAdapter, type DraftOrder, type DraftOrderInput, type ShopifyWriteAdapter } from "@/server/shopify/adapter";
import { confirmWrite, previewWrite, ShopifyWriteError } from "@/server/shopify/writes";
import { QUOTE_LIMITS, quoteNumber, type DraftOrderWritePreview, type InvoiceEmailInput, type InvoiceWritePreview, type QuoteShopifyAction } from "@/shared";

/**
 * Quotes to Shopify as draft orders (plan 2026-11-24-phase-3-crm, Task 8a): create, then update after edits, each a
 * confirmed write (server/shopify/writes.ts) needing crm.manage. Every line goes at the price quoted (the adapter's
 * per-line unit price: Shopify's priceOverride for a variant, originalUnitPrice for a free line), with the discount,
 * the note for the customer and our tag "sma-quote-<id>"; never an email, so the customer hears nothing until a person
 * sends the invoice. After each write Shopify's own subtotal is kept; a difference from ours is shown and holds the
 * invoice until a person accepts it. Shopify access goes through AskCart, whose write endpoints don't exist yet: until
 * then previews say so and confirms answer 503.
 */
const ACTION = { create: "DRAFT_ORDER_CREATE", update: "DRAFT_ORDER_UPDATE", invoice: "DRAFT_ORDER_INVOICE_SEND" } as const satisfies Record<QuoteShopifyAction, ShopifyWriteAction>;
type DraftAction = Exclude<QuoteShopifyAction, "invoice">;
export const quoteTag = (id: string) => `sma-quote-${id}`;
export const target = (scope: { workspaceId: string; brandId: string }) => ({ workspaceId: scope.workspaceId, brandId: scope.brandId });

/** The draft order as it would be written now, or a 409 when the quote isn't in the state the action needs. */
function build(q: Quote, action: DraftAction): DraftOrderWritePreview {
  if (action === "create" && (q.status !== "DRAFT" || q.shopifyId)) throw new PublishingError("This quote is already in Shopify", 409, "quote.inShopify");
  if (action === "update") {
    if (q.status !== "CREATED" || !q.shopifyId) throw new PublishingError(q.status === "SENT" ? "The invoice was sent: revise the quote first" : "Only a quote in Shopify is updated there", 409, "quote.notInShopify");
    if (q.syncedVersion === q.version) throw new PublishingError("Shopify already has this version of the quote", 409, "quote.upToDate");
  }
  const lines = quoteLines(q.lines);
  if (!lines.length) throw new PublishingError("Add a line to the quote first", 409, "quote.empty");
  const discount = quoteDiscount(q.discount);
  return {
    draftOrder: action === "update" ? q.shopifyName : null,
    currency: q.currency,
    lines: lines.map((l) => ({ variantId: l.variantId, title: l.title, quantity: l.quantity, unitPrice: l.unitPrice })),
    discount,
    note: q.note,
    tag: quoteTag(q.id),
    total: quoteTotals(lines, discount, q.currency).total,
  };
}

const input = (p: DraftOrderWritePreview): DraftOrderInput => ({
  currency: p.currency,
  lines: p.lines.map((l) => ({ ...(l.variantId ? { variantId: l.variantId } : {}), title: l.title, quantity: l.quantity, unitPrice: l.unitPrice })),
  discount: p.discount,
  note: p.note,
  tag: p.tag,
});

/** What a person confirms: every line, price, discount and note Shopify gets, and a token for it. */
export async function previewDraftOrderWrite(scope: QuoteScope, quoteId: string, action: DraftAction, opts: { again?: boolean } = {}, adapter: ShopifyWriteAdapter = askCartWriteAdapter) {
  if (!scope.perms.has("crm.manage")) throw new AccessDeniedError("Missing permission crm.manage");
  const q = await loadQuote(scope, quoteId);
  return previewWrite(scope, { entityType: "QUOTE", entityId: q.id, action: ACTION[action], version: q.version, payload: build(q, action), again: opts.again }, adapter);
}

/** "lineItems.2.variantId" → line 3: Shopify's field paths name a line by its place in what we sent. */
function refusedLine(fields: string[] = []) {
  for (const f of fields) {
    const m = f.match(/lineItems\D*(\d+)/);
    if (m) return Number(m[1]) + 1;
  }
  return null;
}

/**
 * A refused update of a draft that was completed in Shopify meanwhile (the customer paid): the quote is ACCEPTED with
 * its order, and the person is told. Returns whether that was it.
 */
export async function completedInShopify(scope: QuoteScope, q: Quote, adapter: ShopifyWriteAdapter) {
  if (!q.shopifyId) return false;
  const found = await adapter.lookupDraftOrder(target(scope), { id: q.shopifyId });
  if (!found.ok || found.value?.status !== "COMPLETED") return false;
  const orderId = found.value.orderId;
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.quote.updateMany({
      where: { id: q.id, workspaceId: scope.workspaceId, brandId: scope.brandId, status: { in: ["DRAFT", "CREATED", "SENT"] } },
      data: { status: "ACCEPTED", orderId },
    });
    if (!count) return;
    if (q.status === "SENT") await closeQuoteReminders(tx, q, "The customer paid: the quote is accepted");
    await tx.auditEvent.create({ data: { workspaceId: scope.workspaceId, brandId: scope.brandId, actorUserId: scope.userId, action: "quote.accepted", entityType: "Quote", entityId: q.id, metadata: { from: q.status, orderId, source: "update-refused" } } });
  });
  return true;
}

/** Whether the draft holds exactly the lines, discount and note a payload sends (an update that landed). */
export function holdsPayload(d: Pick<DraftOrder, "lines" | "discount" | "note">, p: DraftOrderWritePreview) {
  const sent = input(p);
  const digits = minorDigits(p.currency);
  const line = (l: DraftOrder["lines"][number]) => [l.variantId ?? null, l.variantId ? null : l.title, l.quantity, toMinor(l.unitPrice, digits)];
  const disc = (x: DraftOrder["discount"]) => (x ? [x.kind, x.kind === "PERCENT" ? toMinor(x.value, 2) : toMinor(x.value, digits)] : null);
  return JSON.stringify([d.lines.map(line), disc(d.discount), d.note ?? null]) === JSON.stringify([sent.lines.map(line), disc(sent.discount), sent.note ?? null]);
}

/** Writes what the person confirmed, at most once; the quote follows Shopify's answer. Returns the quote. */
export async function confirmDraftOrderWrite(scope: QuoteScope, quoteId: string, action: DraftAction, token: string, adapter: ShopifyWriteAdapter = askCartWriteAdapter) {
  let q = await loadQuote(scope, quoteId);
  let built: DraftOrderWritePreview | null = null;
  const where = { id: q.id, workspaceId: scope.workspaceId, brandId: scope.brandId };
  try {
    await confirmWrite<DraftOrderWritePreview, DraftOrder>(
      scope,
      token,
      { entityType: "QUOTE", entityId: q.id, action: ACTION[action] },
      {
        permission: "crm.manage",
        rebuild: async () => {
          q = await loadQuote(scope, quoteId);
          built = build(q, action);
          return { version: q.version, payload: built };
        },
        run: (a, payload, requestId) =>
          action === "create" ? a.createDraftOrder(target(scope), requestId, input(payload)) : a.updateDraftOrder(target(scope), requestId, q.shopifyId!, input(payload)),
        reconcile: async (a) => {
          // A create by our tag (Shopify's search lags a few minutes: confirmWrite waits before a "Send again").
          if (action === "create") return a.lookupDraftOrder(target(scope), { tag: quoteTag(q.id) });
          // An update by the draft holding what was confirmed (the rebuilt payload: confirmWrite checked it hashes the
          // same), never by timestamps, which an edit in Shopify's admin or clock skew would fool.
          const found = await a.lookupDraftOrder(target(scope), { id: q.shopifyId! });
          if (!found.ok || !found.value) return found;
          return { ok: true, value: built && holdsPayload(found.value, built) ? found.value : null };
        },
        onDone: async (tx, result, write) => {
          // Shopify's draft now holds the confirmed version; its subtotal is kept to compare with ours.
          await tx.quote.updateMany({
            where,
            data: { shopifyId: result.shopifyId, shopifyName: result.name, shopifySubtotal: result.subtotal, subtotalAccepted: null, invoiceUrl: result.invoiceUrl, syncedVersion: write.version },
          });
          if (action === "create") await tx.quote.updateMany({ where: { ...where, status: "DRAFT" }, data: { status: "CREATED" } });
        },
      },
      adapter,
    );
  } catch (e) {
    if (e instanceof ShopifyWriteError && e.code === "USER_ERROR") {
      if (action === "update" && (await completedInShopify(scope, q, adapter))) {
        throw new PublishingError("The customer completed this draft order in Shopify, so the quote is now accepted", 409, "quote.completed");
      }
      const line = refusedLine(e.fields);
      if (line) throw new ShopifyWriteError(`Shopify refused line ${line}: its product may have been deleted or changed`, 422, "USER_ERROR", e.fields);
    }
    throw e;
  }
  return toQuoteDto(await loadQuote(scope, quoteId));
}

// ---- invoice (Task 8b) ---------------------------------------------------------------------------------------------

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * The invoice as it would be sent now: Shopify's draft must hold this version of the quote, and a subtotal Shopify
 * worked out differently must have been accepted. `to` defaults to the quote's contact, the subject to "Quote Q-0042
 * from <brand>", the message to the quote's note. To, subject and message are all in the confirm token's hash.
 */
async function buildInvoice(scope: { workspaceId: string; brandId: string }, q: Quote, email: InvoiceEmailInput): Promise<InvoiceWritePreview> {
  if ((q.status !== "CREATED" && q.status !== "SENT") || !q.shopifyId) throw new PublishingError("Create the quote in Shopify before sending its invoice", 409, "quote.notInShopify");
  if (q.syncedVersion !== q.version) throw new PublishingError("Send the quote's changes to Shopify before the invoice", 409, "quote.needsUpdate");
  const dto = toQuoteDto(q);
  if (dto.subtotalDiffers && !dto.subtotalAccepted) {
    throw new PublishingError(`Shopify's subtotal is ${q.shopifySubtotal} ${q.currency}; ours is ${dto.totals.total}. Accept Shopify's before sending.`, 409, "quote.subtotalDiffers");
  }
  const to = (email.to ?? q.contactEmail ?? "").trim();
  if (!EMAIL.test(to)) throw new PublishingError("Add the customer's email address", 400, "quote.noEmail");
  const brand = await prisma.brand.findFirstOrThrow({ where: { id: scope.brandId, workspaceId: scope.workspaceId }, select: { displayName: true } });
  return {
    draftOrder: q.shopifyName ?? quoteNumber(q.number),
    to,
    subject: (email.subject ?? `Quote ${quoteNumber(q.number)} from ${brand.displayName}`).trim(),
    message: (email.message ?? q.note ?? "").trim(),
  };
}

/**
 * What a person confirms before Shopify emails its invoice. `again`: after an invoice was sent, a token for sending it
 * once more (a new attempt); without it, a second confirm is "Already done".
 */
export async function previewInvoice(scope: QuoteScope, quoteId: string, email: InvoiceEmailInput, opts: { again?: boolean } = {}, adapter: ShopifyWriteAdapter = askCartWriteAdapter) {
  if (!scope.perms.has("crm.manage")) throw new AccessDeniedError("Missing permission crm.manage");
  const q = await loadQuote(scope, quoteId);
  const payload = await buildInvoice(scope, q, email);
  return previewWrite(scope, { entityType: "QUOTE", entityId: q.id, action: ACTION.invoice, version: q.version, payload, again: opts.again }, adapter);
}

/**
 * Shopify sends its invoice email (draftOrderInvoiceSend), at most once per confirmed attempt; the quote is SENT and
 * valid 30 brand days from that send (each send, a re-send after a revision included, starts the 30 days again).
 */
export async function confirmInvoice(scope: QuoteScope, quoteId: string, email: InvoiceEmailInput, token: string, adapter: ShopifyWriteAdapter = askCartWriteAdapter) {
  let q = await loadQuote(scope, quoteId);
  const zone = await brandTimeZone(scope);
  const where = { id: q.id, workspaceId: scope.workspaceId, brandId: scope.brandId };
  await confirmWrite<InvoiceWritePreview, DraftOrder>(
    scope,
    token,
    { entityType: "QUOTE", entityId: q.id, action: ACTION.invoice },
    {
      permission: "crm.manage",
      rebuild: async () => {
        q = await loadQuote(scope, quoteId);
        return { version: q.version, payload: await buildInvoice(scope, q, email) };
      },
      run: (a, p, requestId) => a.sendInvoice(target(scope), requestId, q.shopifyId!, { to: p.to, subject: p.subject, message: p.message }),
      reconcile: async (a) => {
        // Sent when Shopify records a send after the last one we know of (q.sentAt holds Shopify's own invoiceSentAt
        // from the last confirmed send; none before the first): Shopify's clock against Shopify's clock.
        // ponytail: a send from Shopify's admin also counts; an adapter answering without invoiceSentAt leaves our clock in sentAt.
        const found = await a.lookupDraftOrder(target(scope), { id: q.shopifyId! });
        if (!found.ok || !found.value) return found;
        const sentAt = found.value.invoiceSentAt;
        return { ok: true, value: sentAt && (!q.sentAt || new Date(sentAt) > q.sentAt) ? found.value : null };
      },
      onDone: async (tx, result, write) => {
        // The sender owns the payment reminders (server/quotes/status-sync.ts).
        const sentAt = result.invoiceSentAt ? new Date(result.invoiceSentAt) : new Date();
        // Valid through the send day + 30 (that day included); expired from the next brand day (status-sync.ts).
        const validUntil = new Date(`${addDays(zoneToday(zone, sentAt), QUOTE_LIMITS.validDays)}T00:00:00Z`);
        // A re-send starts its own reminders: the last send's open ones close.
        await closeQuoteReminders(tx, q, "The invoice was sent again");
        await tx.quote.updateMany({
          where: { ...where, status: { in: ["CREATED", "SENT"] } },
          data: { status: "SENT", sentAt, validUntil, sentById: write.actorUserId, invoiceUrl: result.invoiceUrl },
        });
      },
    },
    adapter,
  );
  return toQuoteDto(await loadQuote(scope, quoteId));
}
