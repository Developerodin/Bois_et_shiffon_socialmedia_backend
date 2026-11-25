import { Prisma } from "@prisma/client";
import { shopifyQuery } from "@/server/catalog/shopify";
import { ReconnectNeeded } from "@/server/services/reconnect-needed";
import { AskCartError, askCartOrders, type AskCartLineItem, type AskCartMoney, type AskCartOrder, type AskCartPage } from "@/server/shopify/askcart";
import type { SyncStop } from "@/server/data/sync-stop";

/**
 * Shopify order totals for the Sales tab. Pure: reads Shopify, returns mapped rows, writes nothing.
 * ponytail: written against the 2025-07 docs, not yet run against a live store (same as the catalogue sync).
 */

/**
 * The only order fields ever requested. Allow-list on purpose: no customer, email, phone, addresses or line items,
 * so no personal data reaches the server. Adding a field here is a privacy decision, not a refactor.
 */
export const ORDER_FIELDS = `id name processedAt cancelledAt test updatedAt taxesIncluded sourceName
      currentSubtotalPriceSet { shopMoney { amount currencyCode } }
      currentTotalDiscountsSet { shopMoney { amount } }
      currentShippingPriceSet { shopMoney { amount } }
      currentTotalPriceSet { shopMoney { amount } }
      totalRefundedSet { shopMoney { amount } }
      currentTaxLines { priceSet { shopMoney { amount } } }`;

export const ORDERS_QUERY = `query Orders($after: String, $query: String!) {
  orders(first: 100, after: $after, sortKey: UPDATED_AT, query: $query) {
    pageInfo { hasNextPage endCursor }
    nodes { ${ORDER_FIELDS} }
  }
}`;

type Money = { shopMoney: { amount: string; currencyCode?: string } };
type OrderNode = {
  id: string;
  name: string;
  processedAt: string;
  cancelledAt: string | null;
  test: boolean;
  updatedAt: string;
  taxesIncluded: boolean;
  sourceName: string | null;
  currentSubtotalPriceSet: Money;
  currentTotalDiscountsSet: Money | null;
  currentShippingPriceSet: Money | null;
  currentTotalPriceSet: Money;
  totalRefundedSet: Money | null;
  currentTaxLines: { priceSet: Money }[];
};

/** One order as the ShopOrder row stores it. Amounts are decimal strings in the shop currency, never floats. */
export type ShopOrderRow = {
  shopifyId: string;
  name: string;
  processedAt: Date;
  cancelledAt: Date | null;
  test: boolean;
  currency: string;
  /** currentSubtotalPriceSet: after discounts, refunds and edits. */
  netSales: string;
  discounts: string;
  /**
   * netSales + discounts. Caveat: Shopify documents currentTotalDiscountsSet as "order and line level discounts" without
   * saying whether a shipping discount (free-shipping code) counts; if a live store shows it does, gross overstates
   * merchandise by that amount (separable via shippingLines.discountAllocations).
   */
  gross: string;
  shipping: string;
  /** Sum of currentTaxLines (not totalTaxSet), kept with taxesIncluded so VAT can be taken out later. */
  taxes: string;
  taxesIncluded: boolean;
  /** currentTotalPriceSet. */
  total: string;
  /** Display only; already reflected in netSales and total. */
  refunded: string;
  sourceName: string | null;
  shopifyUpdatedAt: Date;
  // AskCart only (the pasted-token query asks for none of these). Absent = not sent: the stored value stays.
  fulfillmentStatus?: string | null;
  financialStatus?: string | null;
  discountCodes?: string[];
  /** Set with `lines`: more line items exist than were stored, or some were unreadable. */
  lineItemsTruncated?: boolean;
  /** The order's line items; undefined = AskCart didn't send them, so the lines already stored are kept. */
  lines?: ShopOrderLineRow[];
};

/** One line item as ShopOrderLine stores it: product and variant ids, title, SKU, quantities, amounts. No customer data. */
export type ShopOrderLineRow = {
  lineShopifyId: string;
  /** null when the product or variant was deleted from the store */
  productId: string | null;
  variantId: string | null;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  /** After refunds and edits; null when AskCart didn't send it. */
  currentQuantity: number | null;
  unitPrice: string;
  /** discountedTotalSet: the line's total after discounts. */
  discountedTotal: string;
  currency: string;
};

export type FetchOrdersResult = {
  orders: ShopOrderRow[];
  /** Latest updatedAt among the returned orders (the next run's `sinceUpdatedAt`); `sinceUpdatedAt` if none. */
  cursorEnd: Date;
  /** Set when the run stopped before the last page. */
  stoppedReason?: SyncStop;
};

const OVERLAP_MS = 3_600_000; // re-reads the last hour: covers clock skew and same-second updates at a page edge
const MAX_PAGES = 50;
/** Below the job's 240 s deadline, so a long read ends as `capped` with its pages rather than aborting. */
const MAX_MS = 180_000;

/** Adds decimal amounts exactly (Prisma.Decimal, never floats) → a fixed-2 string: "0.1" + "0.2" → "0.30". */
const add = (...values: string[]) => values.reduce((sum, v) => sum.plus(v), new Prisma.Decimal(0)).toFixed(2);

const amount = (m: Money | null | undefined) => m?.shopMoney.amount ?? "0";

export function mapOrder(o: OrderNode): ShopOrderRow {
  const netSales = add(amount(o.currentSubtotalPriceSet));
  const discounts = add(amount(o.currentTotalDiscountsSet));
  return {
    shopifyId: o.id,
    name: o.name,
    processedAt: new Date(o.processedAt),
    cancelledAt: o.cancelledAt ? new Date(o.cancelledAt) : null,
    test: o.test,
    currency: o.currentSubtotalPriceSet.shopMoney.currencyCode ?? "",
    netSales,
    discounts,
    gross: add(netSales, discounts),
    shipping: add(amount(o.currentShippingPriceSet)),
    taxes: add("0", ...o.currentTaxLines.map((t) => amount(t.priceSet))),
    taxesIncluded: o.taxesIncluded,
    total: add(amount(o.currentTotalPriceSet)),
    refunded: add(amount(o.totalRefundedSet)),
    sourceName: o.sourceName,
    shopifyUpdatedAt: new Date(o.updatedAt),
  };
}

/**
 * Every order updated since `sinceUpdatedAt` (minus a 1 h overlap), oldest update first, cursor-paginated.
 * All pages are buffered and returned together; nothing is written here.
 * `rate_limited` (still throttled after the helper's retries) and `capped` (50 pages, 3 minutes or the job's deadline) return the pages
 * finished so far: because pages are sorted by updatedAt they form a contiguous prefix and `cursorEnd` covers exactly
 * them, so the caller writes them and advances — capped is progress, not a failure.
 * `reconnect` (401/403), `missing_scope` (ACCESS_DENIED: the token lacks read_orders, the catalogue keeps working) and
 * `failed` (5xx, network, timeout, a GraphQL error) return no orders. Only bugs throw; the token never reaches a message.
 * ponytail: 50 × 100 = 5,000 orders a run; a busier store catches up over several runs from `cursorEnd`.
 * `read_orders` only reaches the last 60 days, whatever `sinceUpdatedAt` says.
 */
export async function fetchOrders(
  conn: { shop: string; accessToken: string },
  sinceUpdatedAt: Date,
  signal?: AbortSignal,
): Promise<FetchOrdersResult> {
  const query = `updated_at:>='${new Date(sinceUpdatedAt.getTime() - OVERLAP_MS).toISOString()}'`;
  const started = Date.now();
  const orders: ShopOrderRow[] = [];
  let after: string | null = null;
  const done = (stoppedReason?: SyncStop): FetchOrdersResult => ({
    orders,
    cursorEnd: orders.reduce((max, o) => (o.shopifyUpdatedAt > max ? o.shopifyUpdatedAt : max), sinceUpdatedAt),
    ...(stoppedReason ? { stoppedReason } : {}),
  });

  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0 && (Date.now() - started > MAX_MS || signal?.aborted)) return done("capped");
    type Page = { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: OrderNode[] } };
    let data: Page;
    try {
      ({ data } = await shopifyQuery<Page>(conn.shop, conn.accessToken, ORDERS_QUERY, { after, query }, signal));
    } catch (err) {
      const none = (stoppedReason: SyncStop): FetchOrdersResult => ({ orders: [], cursorEnd: sinceUpdatedAt, stoppedReason });
      // ACCESS_DENIED is a missing scope (read_orders), not a dead token: the connection must not be marked for reconnect.
      if (err instanceof ReconnectNeeded) return none(err.message === "Shopify ACCESS_DENIED" ? "missing_scope" : "reconnect");
      // The job's deadline hit mid-page: the pages before it are a sorted prefix, so keep them.
      if (signal?.aborted) return done("capped");
      if (!(err instanceof Error)) throw err;
      if (/THROTTLED/.test(err.message)) return done("rate_limited");
      if (err.message.startsWith("Shopify ") || err instanceof TypeError || err.name === "TimeoutError" || err.name === "AbortError") {
        console.error("[shopify-orders] failed", err.name, err.message.startsWith("Shopify ") ? err.message : "");
        return none("failed");
      }
      throw err;
    }
    orders.push(...data.orders.nodes.map(mapOrder));
    if (!data.orders.pageInfo.hasNextPage) return done();
    after = data.orders.pageInfo.endCursor;
  }
  return done("capped");
}

const shopMoney = (m: AskCartMoney | null | undefined): Money | null => (m && typeof m.amount === "string" ? { shopMoney: m } : null);

const DECIMAL = /^-?\d{1,12}(\.\d+)?$/;
/** A money amount as an exact fixed-2 string, or null when it isn't a plain decimal (that line is skipped). */
const decimal = (m: AskCartMoney | null | undefined) => (m && typeof m.amount === "string" && DECIMAL.test(m.amount) ? add(m.amount) : null);
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const count = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : null);

/** A line item as a row, or null when it lacks an id, title, quantity or a readable amount. */
function mapLine(l: AskCartLineItem, orderCurrency: string): ShopOrderLineRow | null {
  const lineShopifyId = text(l?.id, 200);
  const title = text(l?.title, 300);
  const quantity = count(l?.quantity);
  const unitPrice = decimal(l?.originalUnitPriceSet);
  const discountedTotal = decimal(l?.discountedTotalSet);
  if (!lineShopifyId || !title || quantity === null || unitPrice === null || discountedTotal === null) return null;
  return {
    lineShopifyId,
    productId: text(l.productId, 200),
    variantId: text(l.variantId, 200),
    title,
    variantTitle: text(l.variantTitle, 200),
    sku: text(l.sku, 100),
    quantity,
    currentQuantity: count(l.currentQuantity),
    unitPrice,
    discountedTotal,
    currency: text(l.discountedTotalSet?.currencyCode, 3) ?? orderCurrency,
  };
}

/**
 * AskCart's additive order fields (statuses, discount codes, line items), each left out when not sent so the upsert
 * keeps what is stored. A malformed line item is skipped (and the order marked truncated) rather than failing the
 * order; a line id seen twice keeps its first.
 */
function askCartExtras(o: AskCartOrder, currency: string): Partial<ShopOrderRow> {
  const extras: Partial<ShopOrderRow> = {};
  if (o.displayFulfillmentStatus !== undefined) extras.fulfillmentStatus = text(o.displayFulfillmentStatus, 64);
  if (o.displayFinancialStatus !== undefined) extras.financialStatus = text(o.displayFinancialStatus, 64);
  if (Array.isArray(o.discountCodes)) extras.discountCodes = o.discountCodes.flatMap((c) => text(c, 100) ?? []).slice(0, 20);
  if (Array.isArray(o.lineItems)) {
    const lines = new Map<string, ShopOrderLineRow>();
    let skipped = 0;
    for (const l of o.lineItems.slice(0, 250)) {
      const row = mapLine(l, currency);
      if (!row) skipped++;
      else if (!lines.has(row.lineShopifyId)) lines.set(row.lineShopifyId, row);
    }
    extras.lines = [...lines.values()];
    extras.lineItemsTruncated = o.lineItemsTruncated === true || skipped > 0 || o.lineItems.length > 250;
  }
  return extras;
}

/**
 * An AskCart order (the same fields, money without the shopMoney wrapper) as a ShopOrder row, through mapOrder; null
 * when it lacks what a row needs (id, dates, subtotal, total), so the caller stops cleanly instead of crashing.
 */
export function mapAskCartOrder(o: AskCartOrder): ShopOrderRow | null {
  const subtotal = shopMoney(o?.currentSubtotalPriceSet);
  const total = shopMoney(o?.currentTotalPriceSet);
  if (!subtotal || !total || !o.id || !o.processedAt || !o.updatedAt) return null;
  const row = mapOrder({
    ...o,
    currentSubtotalPriceSet: subtotal,
    currentTotalDiscountsSet: shopMoney(o.currentTotalDiscountsSet),
    currentShippingPriceSet: shopMoney(o.currentShippingPriceSet),
    currentTotalPriceSet: total,
    totalRefundedSet: shopMoney(o.totalRefundedSet),
    currentTaxLines: (o.currentTaxLines ?? []).flatMap((t) => {
      const priceSet = shopMoney(t?.priceSet);
      return priceSet ? [{ priceSet }] : [];
    }),
  });
  return { ...row, ...askCartExtras(o, row.currency) };
}

/**
 * fetchOrders for a brand reading through AskCart (server/shopify/askcart.ts): AskCart's incremental mode
 * (`updatedSince`, oldest update first, 100 a page) with the same overlap, caps and stops, so the runner can't tell
 * them apart. A page AskCart cut short (`rateLimited`), its 429 after the client's retries, or Shopify's throttle →
 * `rate_limited` with the pages before it (a sorted prefix). 401 / store not connected throw ReconnectNeeded; 403 access_denied →
 * `missing_scope`; anything else → `failed`. Orders seen twice (same updatedAt at a page edge) keep their last read.
 * AskCart's read_all_orders_pending warning (orders created before visibleSince left out) is logged only: the
 * pasted-token path has the same 60-day reach.
 */
export async function fetchAskCartOrders(bearer: string, sinceUpdatedAt: Date, signal?: AbortSignal): Promise<FetchOrdersResult> {
  const updatedSince = new Date(sinceUpdatedAt.getTime() - OVERLAP_MS);
  const started = Date.now();
  const byId = new Map<string, ShopOrderRow>();
  let cursor: string | null = null;
  const done = (stoppedReason?: SyncStop): FetchOrdersResult => {
    const orders = [...byId.values()];
    return {
      orders,
      cursorEnd: orders.reduce((max, o) => (o.shopifyUpdatedAt > max ? o.shopifyUpdatedAt : max), sinceUpdatedAt),
      ...(stoppedReason ? { stoppedReason } : {}),
    };
  };
  const none = (stoppedReason: SyncStop): FetchOrdersResult => ({ orders: [], cursorEnd: sinceUpdatedAt, stoppedReason });

  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0 && (Date.now() - started > MAX_MS || signal?.aborted)) return done("capped");
    let res: AskCartPage<AskCartOrder>;
    try {
      res = await askCartOrders(bearer, { updatedSince }, cursor, signal);
    } catch (err) {
      // The caller marks the connection with AskCart's own reason (our access vs the store's install).
      if (err instanceof ReconnectNeeded) throw err;
      if (signal?.aborted) return done("capped");
      if (err instanceof AskCartError && err.rateLimited) return done("rate_limited");
      if (err instanceof AskCartError && err.code === "access_denied") return none("missing_scope");
      if (err instanceof AskCartError || err instanceof TypeError || (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))) {
        console.error("[askcart-orders] failed", err.name, err instanceof AskCartError ? err.message : "");
        return none("failed");
      }
      throw err;
    }
    if (res.warning?.code === "read_all_orders_pending" && page === 0) console.warn("[askcart-orders] orders created before", res.warning.visibleSince, "aren't visible yet");
    for (const o of res.items ?? []) {
      const row = mapAskCartOrder(o);
      // An order AskCart sent without its totals: the run fails cleanly (nothing written, retried), never half a page.
      if (!row) {
        console.error("[askcart-orders] an order came without its totals");
        return none("failed");
      }
      byId.set(row.shopifyId, row);
    }
    if (res.rateLimited) return done("rate_limited");
    if (res.complete || !res.nextCursor) return done();
    cursor = res.nextCursor;
  }
  return done("capped");
}
