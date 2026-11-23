import { Prisma } from "@prisma/client";
import { shopifyQuery } from "@/server/catalog/shopify";
import { ReconnectNeeded } from "@/server/services/reconnect-needed";
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
