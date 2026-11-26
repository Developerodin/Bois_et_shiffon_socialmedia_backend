import { setTimeout as sleep } from "node:timers/promises";
import { Prisma } from "@prisma/client";
import { shopifyQuery } from "@/server/catalog/shopify";
import { str } from "@/server/catalog/sync";
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
      currentTaxLines { priceSet { shopMoney { amount } } }
      shippingLines(first: 5) { nodes { discountedPriceSet { shopMoney { amount } } taxLines { priceSet { shopMoney { amount } } } } }`;

/**
 * Shopify's estimated cost of one order node in ORDER_FIELDS, by its documented rules (object 1, scalar 0, connection
 * 2 + first × node): the order 1, five money bags 2 each, the tax lines ~3, shippingLines 2 + 5 × (line 1 + price 2 +
 * tax lines 3) = 42. Not measured live: no brand reads orders through a pasted token (B&C reads through AskCart), so
 * `extensions.cost.requestedQueryCost` couldn't be logged. Log it on the first token-path store and raise ORDERS_PAGE
 * if the real cost is lower.
 */
export const ORDER_NODE_COST = 56;
/** Shopify refuses a query over 1,000 points; 800 leaves room for a wrong estimate. */
export const MAX_QUERY_COST = 800;
/**
 * Orders per page on the pasted-token path: as many as fit MAX_QUERY_COST (14 at the estimate above; was 100 before
 * shippingLines, itself estimated ~1,400, over Shopify's limit). Task 6's created_at query uses the same constant.
 * ponytail: the time cap (MAX_MS), not MAX_PAGES, ends a run: Shopify restores ~50 points a second, so a page of
 * ~800 waits for the bucket and a run reads about 40 pages, ~560 orders. A busier store catches up over the follow-up
 * runs; the history windows on this path are sized for it (HISTORY_WINDOW_DAYS.token).
 */
export const ORDERS_PAGE = Math.floor((MAX_QUERY_COST - 2) / ORDER_NODE_COST);
/** Whether this process has logged a token-path page's real query cost yet (once is enough to check the estimate). */
let costLogged = false;

/** One query for both reads: by update time (daily, UPDATED_AT) and by creation day (history, CREATED_AT). */
export const ORDERS_QUERY = `query Orders($after: String, $query: String!, $sortKey: OrderSortKeys!) {
  orders(first: ${ORDERS_PAGE}, after: $after, sortKey: $sortKey, query: $query) {
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
  /** Absent = not asked for or not sent (the stored shippingTaxes stays); null = sent unreadable. */
  shippingLines?: { nodes: ShippingLineNode[] } | null;
};
type ShippingLineNode = { discountedPriceSet: Money | null; taxLines: { priceSet: Money | null }[] | null };

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
  /**
   * Sum of currentTaxLines (not totalTaxSet), kept with taxesIncluded so VAT can be taken out. Includes the shipping
   * tax: checked live on B&C 2026-11-26 (tax-excluded orders: taxes = 20 % of netSales + shipping, not of netSales;
   * a tax-included one: taxes = (netSales + shipping) × 0.2 / 1.2).
   */
  taxes: string;
  /**
   * The tax on the shipping still charged: shippingLines' tax lines × current shipping ÷ the lines' discounted price,
   * so a refunded shipping charge takes its tax with it; free shipping (price 0) or no shipping line → "0.00".
   * Discounted, not original, price: Shopify taxes shipping after its discount, and currentShippingPriceSet equalled
   * Σ discountedPriceSet on every B&C order read live 2026-11-26 (100 orders; none had a shipping discount, so
   * original = discounted there). undefined = not sent (the stored value stays); null = sent but unreadable.
   */
  shippingTaxes?: string | null;
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
  /**
   * Set with `lines`, AskCart's own flag: more than ASKCART_LINES_PER_ORDER line items, or AskCart paused mid-order to
   * protect the store's API budget (the sync re-reads those within REFETCH_HOURS).
   */
  lineItemsTruncated?: boolean;
  /** Not stored: line items we couldn't read and skipped. The order's other stored lines are then not pruned. */
  linesSkipped?: number;
  /** The order's line items; undefined = AskCart didn't send them, so the lines already stored are kept. */
  lines?: ShopOrderLineRow[];
};

/** One line item as ShopOrderLine stores it: product and variant ids, title, SKU, quantities, amounts. No customer data. */
export type ShopOrderLineRow = {
  lineShopifyId: string;
  /** null when the product or variant was deleted from the store */
  productId: string | null;
  variantId: string | null;
  /** null for a line without a product (custom line, deleted product): AskCart withholds the text. */
  title: string | null;
  variantTitle: string | null;
  sku: string | null;
  /** As ordered: includes refunded and removed units. */
  quantity: number;
  /** Net units: after refunds and edits; null when AskCart didn't send it. */
  currentQuantity: number | null;
  unitPrice: string;
  /** discountedTotalSet: the line's total after line discounts, refunded units included. */
  discountedTotal: string;
  /** discountedUnitPriceAfterAllDiscountsSet (order-level discounts included); net line sales ≈ currentQuantity × this. */
  netUnitPrice: string | null;
  currency: string;
};

export type FetchOrdersResult = {
  orders: ShopOrderRow[];
  /** Latest updatedAt among the returned orders (the next run's `sinceUpdatedAt`); `sinceUpdatedAt` if none. */
  cursorEnd: Date;
  /** Set when the run stopped before the last page. */
  stoppedReason?: SyncStop;
  /**
   * AskCart incremental reads only: whether Shopify lets AskCart read every order (read_all_orders). false when any
   * page carried AskCart's read_all_orders_pending warning; true when none did and at least one page reached Shopify
   * (not rate limited, or with orders); undefined when no page said (all rate limited and empty, or none read).
   */
  allOrders?: boolean;
  /** AskCart's visibleSince (an ISO date), the oldest creation time Shopify shows it, while it can't read all orders. */
  visibleSince?: string;
  /** AskCart history reads: AskCart answered 403 read_all_orders_pending; nothing was read. */
  historyPending?: true;
};

/** A history read: Shopify creation days, "YYYY-MM-DD" inclusive (AskCart: the shop's zone; a token: UTC). */
export type CreatedWindow = { createdFrom: string; createdTo: string };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
/** AskCart's visibleSince, kept only when it is an ISO date (it is shown, and goes into settings). */
export const isoDate = (v: unknown) =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined;

const OVERLAP_MS = 3_600_000; // re-reads the last hour: covers clock skew and same-second updates at a page edge
const MAX_PAGES = 50;
/** Below the job's 240 s deadline, so a long read ends as `capped` with its pages rather than aborting. */
const MAX_MS = 180_000;
/**
 * AskCart sends up to 25 orders a page (line items make each costlier), a quarter of the pasted-token path's 100: four
 * times the pages keeps a run at about 5,000 orders, still within MAX_MS. Waits for a partial page's Retry-After count
 * as pages too.
 */
const ASKCART_MAX_PAGES = 200;
/** The longest Retry-After a run waits out in place (AskCart sends 2–30 s); longer stops the run as rate_limited. */
const MAX_RATE_WAIT_S = 30;

/** Adds decimal amounts exactly (Prisma.Decimal, never floats) → a fixed-2 string: "0.1" + "0.2" → "0.30". */
const add = (...values: string[]) => values.reduce((sum, v) => sum.plus(v), new Prisma.Decimal(0)).toFixed(2);

const amount = (m: Money | null | undefined) => m?.shopMoney.amount ?? "0";

/** A money amount as written, or null when it isn't a plain decimal. */
const plain = (m: Money | null | undefined) => (m && typeof m.shopMoney?.amount === "string" && DECIMAL.test(m.shopMoney.amount) ? m.shopMoney.amount : null);

/** ShopOrderRow.shippingTaxes from the order's shipping lines; null when any amount is unreadable. */
export function shippingTaxesOf(lines: ShippingLineNode[] | null | undefined, current: Money | null): string | null {
  if (!Array.isArray(lines)) return null;
  let charged = new Prisma.Decimal(0);
  let tax = new Prisma.Decimal(0);
  for (const l of lines) {
    const price = plain(l?.discountedPriceSet);
    if (price === null || !Array.isArray(l.taxLines)) return null;
    charged = charged.plus(price);
    for (const t of l.taxLines) {
      const v = plain(t?.priceSet);
      if (v === null) return null;
      tax = tax.plus(v);
    }
  }
  const now = current ? plain(current) : "0";
  if (now === null) return null;
  // Free shipping: nothing charged, so no tax to scale (and no division by 0).
  if (charged.lte(0) || tax.isZero()) return "0.00";
  // Never more than the lines' own tax, even if the current price somehow exceeds the charged one.
  const share = Prisma.Decimal.min(1, Prisma.Decimal.max(0, new Prisma.Decimal(now).div(charged)));
  return tax.mul(share).toFixed(2);
}

export function mapOrder(o: OrderNode): ShopOrderRow {
  const netSales = add(amount(o.currentSubtotalPriceSet));
  const discounts = add(amount(o.currentTotalDiscountsSet));
  return {
    shopifyId: o.id,
    name: o.name,
    processedAt: new Date(o.processedAt),
    cancelledAt: o.cancelledAt ? new Date(o.cancelledAt) : null,
    test: o.test,
    currency: currencyCode(o.currentSubtotalPriceSet.shopMoney.currencyCode) ?? "",
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
    ...(o.shippingLines !== undefined ? { shippingTaxes: shippingTaxesOf(o.shippingLines?.nodes, o.currentShippingPriceSet) } : {}),
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
 * ponytail: 50 × ORDERS_PAGE orders a run; a busier store catches up over several runs from `cursorEnd`.
 * `read_orders` only reaches the last 60 days, whatever `sinceUpdatedAt` says.
 *
 * History (`read` a CreatedWindow): the orders created on those UTC days, oldest first, by `created_at` (needs
 * read_all_orders past 60 days). No stoppedReason = read to the last page, so the window is complete.
 */
export async function fetchOrders(
  conn: { shop: string; accessToken: string },
  read: Date | CreatedWindow,
  signal?: AbortSignal,
): Promise<FetchOrdersResult> {
  const history = !(read instanceof Date);
  if (history && (!DAY.test(read.createdFrom) || !DAY.test(read.createdTo))) throw new Error("fetchOrders: bad window");
  // Bounds formatted here from validated days only: nothing else reaches the search string.
  const query = history
    ? `created_at:>='${read.createdFrom}T00:00:00Z' AND created_at:<'${nextDay(read.createdTo)}T00:00:00Z'`
    : `updated_at:>='${new Date(read.getTime() - OVERLAP_MS).toISOString()}'`;
  const sortKey = history ? "CREATED_AT" : "UPDATED_AT";
  const sinceUpdatedAt = history ? new Date(0) : read;
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
      let cost: { requestedQueryCost?: number } | undefined;
      ({ data, cost } = await shopifyQuery<Page>(conn.shop, conn.accessToken, ORDERS_QUERY, { after, query, sortKey }, signal));
      // ORDER_NODE_COST is an estimate: the first page a process reads logs Shopify's own figure (no token, no shop).
      if (!costLogged && cost?.requestedQueryCost !== undefined) {
        costLogged = true;
        console.info("[shopify-orders] requestedQueryCost", cost.requestedQueryCost, "for", ORDERS_PAGE, "orders a page");
      }
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

/**
 * Up to 4 decimals (3-decimal currencies such as KWD, and AskCart's approximate net unit price), rounded half-up to the
 * column's 2 by add(); at most 11 integer digits, so even rounding up stays within numeric(14,2) and can't fail a page.
 */
const DECIMAL = /^-?\d{1,11}(\.\d{1,4})?$/;
/** A money amount as an exact fixed-2 string, or null when it isn't a plain decimal (that line is skipped). */
const decimal = (m: AskCartMoney | null | undefined) => (m && typeof m.amount === "string" && DECIMAL.test(m.amount) ? add(m.amount) : null);
/** A quantity: a whole number from 0 to below 2^31 (the int column), else null. */
const count = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < 2 ** 31 ? (v as number) : null);
/** An ISO 4217 code, or null: shop text never lands in a currency column. */
const currencyCode = (v: unknown) => (typeof v === "string" && /^[A-Z]{3}$/.test(v) ? v : null);
/** The most line items AskCart sends an order (lineItemsTruncated says when it has more). */
export const ASKCART_LINES_PER_ORDER = 100;
/** Over 2.5 × ASKCART_LINES_PER_ORDER is a broken payload: the rest are dropped and counted as skipped. */
const MAX_LINES = 250;

/**
 * A line item as a row, or null when it lacks an id, a quantity or a readable amount. A line without a product
 * (custom line, deleted product) comes without title or variant title: kept, with null text. The net unit price is
 * optional (an AskCart before 3e05bfc doesn't send it), but one sent unreadable skips the line like any bad amount.
 */
function mapLine(l: AskCartLineItem, orderCurrency: string): ShopOrderLineRow | null {
  const lineShopifyId = str(l?.id, 200);
  const quantity = count(l?.quantity);
  const unitPrice = decimal(l?.originalUnitPriceSet);
  const discountedTotal = decimal(l?.discountedTotalSet);
  const net = l?.discountedUnitPriceAfterAllDiscountsSet;
  const netUnitPrice = net == null ? null : decimal(net);
  if (!lineShopifyId || quantity === null || unitPrice === null || discountedTotal === null || (net != null && netUnitPrice === null)) return null;
  return {
    lineShopifyId,
    productId: str(l.productId, 200),
    variantId: str(l.variantId, 200),
    title: str(l.title, 300),
    variantTitle: str(l.variantTitle, 200),
    sku: str(l.sku, 100),
    quantity,
    currentQuantity: count(l.currentQuantity),
    unitPrice,
    discountedTotal,
    netUnitPrice,
    currency: currencyCode(l.discountedTotalSet?.currencyCode) ?? orderCurrency,
  };
}

/**
 * AskCart's additive order fields (statuses, discount codes, line items), each left out when not sent so the upsert
 * keeps what is stored (a status sent as null is kept as null: it clears). lineItemsTruncated is AskCart's own flag
 * only (more lines than it sends, or it paused mid-order). A malformed line item is skipped rather than failing the
 * order: logged, counted in `linesSkipped`, never re-read; a line id seen twice keeps its first.
 */
function askCartExtras(o: AskCartOrder, currency: string): Partial<ShopOrderRow> {
  const extras: Partial<ShopOrderRow> = {};
  if (o.displayFulfillmentStatus !== undefined) extras.fulfillmentStatus = str(o.displayFulfillmentStatus, 64);
  if (o.displayFinancialStatus !== undefined) extras.financialStatus = str(o.displayFinancialStatus, 64);
  if (Array.isArray(o.discountCodes)) extras.discountCodes = [...new Set(o.discountCodes.flatMap((c) => str(c, 100) ?? []))].slice(0, 20);
  if (Array.isArray(o.lineItems)) {
    const lines = new Map<string, ShopOrderLineRow>();
    let skipped = 0;
    for (const l of o.lineItems.slice(0, MAX_LINES)) {
      const row = mapLine(l, currency);
      if (!row) skipped++;
      else if (!lines.has(row.lineShopifyId)) lines.set(row.lineShopifyId, row);
    }
    skipped += Math.max(0, o.lineItems.length - MAX_LINES);
    if (skipped) console.warn("[askcart-orders] line items skipped as unreadable", skipped);
    extras.lines = [...lines.values()];
    extras.lineItemsTruncated = o.lineItemsTruncated === true;
    if (skipped) extras.linesSkipped = skipped;
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
    // Not sent → left out (the stored value stays); sent but not a list → null (unreadable, never 0).
    shippingLines: o.shippingLines === undefined ? undefined
      : Array.isArray(o.shippingLines) ? { nodes: o.shippingLines.map((l) => ({
          discountedPriceSet: shopMoney(l?.discountedPriceSet),
          taxLines: Array.isArray(l?.taxLines) ? l.taxLines.map((t) => ({ priceSet: shopMoney(t?.priceSet) })) : null,
        })) }
      : null,
  });
  return { ...row, ...askCartExtras(o, row.currency) };
}

/**
 * fetchOrders for a brand reading through AskCart (server/shopify/askcart.ts): AskCart's incremental mode
 * (`updatedSince`, oldest update first, up to 25 a page) with the same overlap, time cap and stops, so the runner can't
 * tell them apart. A page AskCart cut short (`rateLimited`: Shopify's throttle, a timed-out call, or the store's shared
 * API budget running low) is normal: its orders are kept, the run waits the page's Retry-After and resumes from
 * nextCursor (the same cursor when the page was empty). Only when that wait is over 30 s, or would pass the time cap,
 * does it stop as `rate_limited` with the pages so far (a sorted prefix); so does a 429 after the client's retries. 401 / store not connected throw ReconnectNeeded; 403 access_denied →
 * `missing_scope`; anything else → `failed`. Orders seen twice (same updatedAt at a page edge) keep their last read.
 * Incremental reads also say whether Shopify lets AskCart read all orders (`allOrders`, from AskCart's
 * read_all_orders_pending warning, at no extra request; see FetchOrdersResult). A failed run says nothing.
 *
 * History (`read` a CreatedWindow): AskCart's backfill mode, orders created on those shop days, oldest first. The
 * window is complete only when AskCart says `complete` on the last page: a missing nextCursor alone stops as
 * `capped`. AskCart's 403 read_all_orders_pending (scope not granted, or taken back) returns `historyPending`, caught
 * before the generic AskCartError → `failed`, so the caller stops the history quietly instead of retrying it.
 */
export async function fetchAskCartOrders(bearer: string, read: Date | CreatedWindow, signal?: AbortSignal): Promise<FetchOrdersResult> {
  const history = !(read instanceof Date);
  if (history && (!DAY.test(read.createdFrom) || !DAY.test(read.createdTo))) throw new Error("fetchAskCartOrders: bad window");
  const sinceUpdatedAt = history ? new Date(0) : read;
  const query = history ? { createdFrom: read.createdFrom, createdTo: read.createdTo } : { updatedSince: new Date(read.getTime() - OVERLAP_MS) };
  const started = Date.now();
  const byId = new Map<string, ShopOrderRow>();
  let cursor: string | null = null;
  // The grant signal (incremental reads only): a warning on any page wins; a page that reached Shopify says granted.
  let warned = false;
  let reached = false;
  let visibleSince: string | undefined;
  const done = (stoppedReason?: SyncStop): FetchOrdersResult => {
    // Oldest update first, as the sync's write loop needs (a deadline between pages saves the last written update as
    // the cursor). Map order alone isn't: an order re-read with a newer update keeps its first slot.
    const orders = [...byId.values()].sort((a, b) => a.shopifyUpdatedAt.getTime() - b.shopifyUpdatedAt.getTime());
    const allOrders = history ? undefined : warned ? false : reached ? true : undefined;
    return {
      orders,
      cursorEnd: orders.reduce((max, o) => (o.shopifyUpdatedAt > max ? o.shopifyUpdatedAt : max), sinceUpdatedAt),
      ...(stoppedReason ? { stoppedReason } : {}),
      ...(allOrders !== undefined ? { allOrders } : {}),
      ...(allOrders === false && visibleSince ? { visibleSince } : {}),
    };
  };
  const none = (stoppedReason: SyncStop): FetchOrdersResult => ({ orders: [], cursorEnd: sinceUpdatedAt, stoppedReason });

  for (let page = 0; page < ASKCART_MAX_PAGES; page++) {
    if (page > 0 && (Date.now() - started > MAX_MS || signal?.aborted)) return done("capped");
    let res: AskCartPage<AskCartOrder>;
    try {
      res = await askCartOrders(bearer, query, cursor, signal);
    } catch (err) {
      // The caller marks the connection with AskCart's own reason (our access vs the store's install).
      if (err instanceof ReconnectNeeded) throw err;
      if (history && err instanceof AskCartError && err.code === "read_all_orders_pending") {
        const since = isoDate(err.visibleSince);
        return { orders: [], cursorEnd: sinceUpdatedAt, historyPending: true, ...(since ? { visibleSince: since } : {}) };
      }
      if (signal?.aborted) return done("capped");
      if (err instanceof AskCartError && err.rateLimited) return done("rate_limited");
      if (err instanceof AskCartError && err.code === "access_denied") return none("missing_scope");
      if (err instanceof AskCartError || err instanceof TypeError || (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))) {
        console.error("[askcart-orders] failed", err.name, err instanceof AskCartError ? err.message : "");
        return none("failed");
      }
      throw err;
    }
    if (res.warning?.code === "read_all_orders_pending") {
      if (!warned) console.warn("[askcart-orders] orders created before", isoDate(res.warning.visibleSince) ?? "(unknown)", "aren't visible yet");
      warned = true;
      visibleSince ??= isoDate(res.warning.visibleSince);
    }
    // AskCart warns only once its walk reached Shopify: a rate-limited page without orders says nothing either way.
    if (!res.rateLimited || (res.items ?? []).length > 0) reached = true;
    for (const o of res.items ?? []) {
      const row = mapAskCartOrder(o);
      // An order AskCart sent without its totals: the run fails cleanly (nothing written, retried), never half a page.
      if (!row) {
        console.error("[askcart-orders] an order came without its totals");
        return none("failed");
      }
      byId.set(row.shopifyId, row);
    }
    if (res.rateLimited) {
      const wait = res.retryAfter ?? 2;
      if (wait > MAX_RATE_WAIT_S || Date.now() - started + wait * 1000 > MAX_MS) return done("rate_limited");
      try {
        await sleep(wait * 1000, undefined, { signal });
      } catch {
        return done("capped"); // the job's deadline hit during the wait
      }
      cursor = res.nextCursor ?? cursor;
      continue;
    }
    if (res.complete) return done();
    // History: only `complete` ends a window; a missing cursor without it leaves the window to be read again.
    if (!res.nextCursor) return history ? done("capped") : done();
    cursor = res.nextCursor;
  }
  return done("capped");
}
