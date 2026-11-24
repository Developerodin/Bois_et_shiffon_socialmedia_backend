import type { Quote, ShopifyWriteAction } from "@prisma/client";
import { AccessDeniedError } from "@/server/auth/errors";
import { prisma } from "@/server/db/prisma";
import { loadQuote, quoteDiscount, quoteLines, quoteTotals, toQuoteDto, type QuoteScope } from "@/server/quotes/quotes";
import { PublishingError } from "@/server/services/publishing";
import { askCartWriteAdapter, type DraftOrder, type DraftOrderInput, type ShopifyWriteAdapter } from "@/server/shopify/adapter";
import { confirmWrite, previewWrite, ShopifyWriteError } from "@/server/shopify/writes";
import type { DraftOrderWritePreview, QuoteShopifyAction } from "@/shared";

/**
 * Quotes to Shopify as draft orders (plan 2026-11-24-phase-3-crm, Task 8a): create, then update after edits, each a
 * confirmed write (server/shopify/writes.ts) needing crm.manage. Every line goes at the price quoted (the adapter's
 * per-line unit price: Shopify's priceOverride for a variant, originalUnitPrice for a free line), with the discount,
 * the note for the customer and our tag "sma-quote-<id>"; never an email, so the customer hears nothing until a person
 * sends the invoice. After each write Shopify's own subtotal is kept; a difference from ours is shown and holds the
 * invoice until a person accepts it. Shopify access goes through AskCart, whose write endpoints don't exist yet: until
 * then previews say so and confirms answer 503.
 */
const ACTION = { create: "DRAFT_ORDER_CREATE", update: "DRAFT_ORDER_UPDATE" } as const satisfies Partial<Record<QuoteShopifyAction, ShopifyWriteAction>>;
type DraftAction = keyof typeof ACTION;
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
    total: quoteTotals(lines, discount).total,
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
export async function completedInShopify(scope: { workspaceId: string; brandId: string }, q: Quote, adapter: ShopifyWriteAdapter) {
  if (!q.shopifyId) return false;
  const found = await adapter.lookupDraftOrder(target(scope), { id: q.shopifyId });
  if (!found.ok || found.value?.status !== "COMPLETED") return false;
  await prisma.quote.updateMany({
    where: { id: q.id, workspaceId: scope.workspaceId, brandId: scope.brandId, status: { in: ["DRAFT", "CREATED", "SENT"] } },
    data: { status: "ACCEPTED", orderId: found.value.orderId },
  });
  return true;
}

/** Writes what the person confirmed, at most once; the quote follows Shopify's answer. Returns the quote. */
export async function confirmDraftOrderWrite(scope: QuoteScope, quoteId: string, action: DraftAction, token: string, adapter: ShopifyWriteAdapter = askCartWriteAdapter) {
  let q = await loadQuote(scope, quoteId);
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
          return { version: q.version, payload: build(q, action) };
        },
        run: (a, payload, requestId) =>
          action === "create" ? a.createDraftOrder(target(scope), requestId, input(payload)) : a.updateDraftOrder(target(scope), requestId, q.shopifyId!, input(payload)),
        reconcile: async (a, write) => {
          // A create by our tag (Shopify's search lags a few minutes: confirmWrite waits before a "Send again").
          if (action === "create") return a.lookupDraftOrder(target(scope), { tag: quoteTag(q.id) });
          // An update by the draft having changed since the send started.
          const found = await a.lookupDraftOrder(target(scope), { id: q.shopifyId! });
          if (!found.ok || !found.value) return found;
          return { ok: true, value: new Date(found.value.updatedAt) >= write.startedAt ? found.value : null };
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
