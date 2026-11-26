import { Prisma } from "@prisma/client";
import type { DateRange } from "@/shared";
import { likeLiteral } from "@/server/catalog/products";
import { prisma } from "@/server/db/prisma";
import { brandBounds, countedOrders } from "./sales-read";

/**
 * Read-only analysis over the brand's own ShopOrder / ShopOrderLine / Product rows for the CMO chat (server/chat/tools.ts).
 * Same orders as the Sales tab (sales-read.ts' brandBounds + countedOrders: brand-local days, no test or cancelled
 * orders); never summed across currencies. Every grouping is a fixed SQL fragment chosen from a whitelist: nothing the
 * model sends is spliced into SQL (search text goes as a bound value).
 * Line-level numbers exist only for AskCart orders sent with line items (hasOrderLines tells the tools when none do).
 * Units are net: currentQuantity (after refunds and removals). Revenue is net too (AskCart's contract): currentQuantity ×
 * the unit price after every discount (order-level share included); a line read before AskCart sent that price falls
 * back to its discounted total ÷ quantity. Lines without a product (custom lines, deleted products: no title) are one
 * "Other / custom items" group.
 * ponytail: sums raw rows per call; past ~100k orders in a range, add per-day rollups written by the sync.
 */

/** Most rows any analysis returns, so a report built from several calls stays small. */
export const MAX_ANALYSIS_ROWS = 60;
/** stockRisk's best sellers (the tool's input cap too) and slow movers. */
export const MAX_RISK_ROWS = 40;
const MAX_SLOW_ROWS = 15;
/** productSales' variants. */
const MAX_VARIANT_ROWS = 20;
export const OTHER_ITEMS = "Other / custom items";
const OTHER_CODES = "(other codes)";

type Scope = { workspaceId: string; brandId: string };
const id = (alias: string) => Prisma.raw(`"${alias}"`);
/** Net units of the lines aliased `a`. */
const units = (a: string) => Prisma.sql`COALESCE(${id(a)}."currentQuantity", ${id(a)}."quantity")`;
/**
 * Net sales of the lines aliased `a` (see the header). A line with quantity 0 and no net price has no unit price to
 * work out; it sold nothing, so it counts 0 (a NULL would make a group's sum NULL and sort it first).
 */
const netSales = (a: string) =>
  Prisma.sql`COALESCE(${units(a)} * COALESCE(${id(a)}."netUnitPrice", ${id(a)}."discountedTotal" / NULLIF(${id(a)}."quantity", 0)), 0)`;
/** A variant's key: its id; a deleted variant of a live product, the product; a line without a product, OTHER_ITEMS. */
const VARIANT_KEY = Prisma.sql`COALESCE(l."variantId", 'product:' || l."productId", '(other)')`;
const PRODUCT_KEY = Prisma.sql`COALESCE(l."productId", '(other)')`;
/** Needs `l` from countedLines (its p_* columns). */
const VENDOR_KEY = Prisma.sql`CASE WHEN l.p_id IS NULL THEN '(not in catalogue)' ELSE COALESCE(l.p_vendor, '(no vendor)') END`;
/** Needs `l` from countedLines and `c` from COLLECTION_JOIN. */
const COLLECTION_KEY = Prisma.sql`CASE WHEN l.p_id IS NULL THEN '(not in catalogue)' ELSE COALESCE(c.title, '(no collection)') END`;
/** The line's product's collection titles, each once (two collections with one title count once). */
const COLLECTION_JOIN = Prisma.sql`LEFT JOIN LATERAL (
  SELECT DISTINCT e->>'title' AS title
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.p_collections) = 'array' THEN l.p_collections ELSE '[]'::jsonb END) e
) c ON true`;
/** The newest title sold under a key (a renamed product shows its current name); OTHER_ITEMS for lines without a product. */
const latestTitle = (withVariant: boolean) =>
  Prisma.sql`CASE WHEN bool_and(l."productId" IS NULL) THEN ${OTHER_ITEMS}
    ELSE COALESCE((array_agg(l.title${withVariant ? Prisma.raw(` || COALESCE(' — ' || l."variantTitle", '')`) : Prisma.empty} ORDER BY l.local DESC) FILTER (WHERE l.title IS NOT NULL))[1], '(untitled)') END`;

/**
 * Counted orders' lines (`l`): every ShopOrderLine column plus the order's local time, and the variant's catalogue row
 * (p_*; null when not in it). Needs brandBounds in the WITH.
 */
const countedLines = (scope: Scope) => Prisma.sql`
  SELECT l.*, o.local, p.id AS p_id, p.vendor AS p_vendor, p.collections AS p_collections, p.price AS p_price,
         p."inStock" AS p_in_stock, p."stockQuantity" AS p_stock_quantity, p."archivedAt" AS p_archived_at
  FROM (${countedOrders(scope)}) o
  JOIN "ShopOrderLine" l ON l."brandId" = o."brandId" AND l."orderShopifyId" = o."shopifyId" AND l."workspaceId" = o."workspaceId"
  -- (brandId, source, externalId) is unique, so a line matches at most one catalogue row: no fan-out.
  LEFT JOIN "Product" p ON p."brandId" = l."brandId" AND p."workspaceId" = l."workspaceId" AND p.source = 'SHOPIFY' AND p."externalId" = l."variantId"`;

const money = (v: Prisma.Decimal | string | null) => (v === null ? null : new Prisma.Decimal(v).toFixed(2));

/** Has this brand any stored line items at all? (None: AskCart doesn't send them yet, or the store isn't on AskCart.) */
export async function hasOrderLines(scope: Scope) {
  return !!(await prisma.shopOrderLine.findFirst({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId }, select: { id: true } }));
}

/** Counted orders in the range whose stored lines are incomplete (lineItemsTruncated): per-product numbers undercount them. */
export async function truncatedOrders(scope: Scope, range: DateRange) {
  const [row] = await prisma.$queryRaw<{ n: number }[]>`
    WITH ${brandBounds(scope, range)} SELECT count(*)::int AS n FROM (${countedOrders(scope)}) o WHERE o."lineItemsTruncated"`;
  return row?.n ?? 0;
}

/**
 * Per-currency top-N: `rn` numbers the groups of each currency, and each currency shows `cap ÷ currencies` of them (at
 * least one), so every currency appears; total_groups counts all groups, so the caller can say how many are hidden.
 */
const capped = (order: Prisma.Sql) => Prisma.sql`
  r AS (
    SELECT g.*, row_number() OVER (PARTITION BY currency ORDER BY ${order}) AS rn,
           count(*) OVER ()::int AS total_groups, (SELECT count(DISTINCT currency) FROM g)::int AS currencies
    FROM g
  )`;
const shown = (cap: number) => Prisma.sql`rn <= GREATEST(1, ${cap}::int / currencies)`;

export type Capped = { rows: (string | number | null)[][]; moreGroups: number };
const hidden = (rows: { total_groups: number }[]) => (rows.length ? rows[0].total_groups - rows.length : 0);

// ---------------------------------------------------------------------------------------------------------------------

export const BREAKDOWNS = ["day", "week", "month", "weekday", "channel", "fulfillmentStatus", "financialStatus", "discountCode", "collection", "vendor"] as const;
export type Breakdown = (typeof BREAKDOWNS)[number];
export const TIME_BREAKDOWNS: readonly Breakdown[] = ["day", "week", "month", "weekday"];

/** Order-level group keys (o = a counted order). Weeks start on Monday; weekday is "1 Monday" … "7 Sunday". */
const ORDER_KEYS: Partial<Record<Breakdown, Prisma.Sql>> = {
  day: Prisma.sql`to_char(o.local, 'YYYY-MM-DD')`,
  week: Prisma.sql`to_char(date_trunc('week', o.local), 'YYYY-MM-DD')`,
  month: Prisma.sql`to_char(o.local, 'YYYY-MM')`,
  weekday: Prisma.sql`to_char(o.local, 'ID') || ' ' || trim(to_char(o.local, 'Day'))`,
  channel: Prisma.sql`COALESCE(o."sourceName", '(unknown)')`,
  fulfillmentStatus: Prisma.sql`COALESCE(o."fulfillmentStatus", '(not sent)')`,
  financialStatus: Prisma.sql`COALESCE(o."financialStatus", '(not sent)')`,
  // A code on fewer than 2 counted orders can be personal (a one-time code made for one customer): never shown. It
  // counts orders, not customers, so one customer's personal code used on two orders is shown (the owner's choice).
  discountCode: Prisma.sql`CASE WHEN dc.code IS NULL THEN '(none)' WHEN cn.n >= 2 THEN dc.code ELSE ${OTHER_CODES} END`,
};
const DISCOUNT_JOIN = Prisma.sql`
  LEFT JOIN LATERAL unnest(o."discountCodes") AS dc(code) ON true
  LEFT JOIN (SELECT code, count(DISTINCT x.id) AS n FROM co x, unnest(x."discountCodes") AS code GROUP BY code) cn ON cn.code = dc.code`;

export type BreakdownResult = Capped & { columns: string[] };

type OrderGroupRow = {
  key: string; currency: string; total_groups: number; orders: number; gross: Prisma.Decimal; discounts: Prisma.Decimal;
  net_sales: Prisma.Decimal; total: Prisma.Decimal; refunded: Prisma.Decimal;
};

/**
 * Sales per group, per currency. Time groups keep the newest (when capped) and come oldest first; the others by net
 * sales (lines: revenue), largest first. An order counts once per group: once in "(other codes)" however many rare
 * codes it used; an order with two shown codes counts in both. collection / vendor are line-based (AskCart orders with
 * line items, matched to the catalogue by variant); a product in two collections counts in both.
 */
export async function salesBreakdown(scope: Scope, range: DateRange, by: Breakdown, limit = MAX_ANALYSIS_ROWS): Promise<BreakdownResult> {
  const cap = Math.min(limit, MAX_ANALYSIS_ROWS);
  const time = TIME_BREAKDOWNS.includes(by);
  if (by === "collection" || by === "vendor") {
    // Same groups as topProducts by revenue, its columns reordered to this tool's.
    const { rows, moreGroups } = await topProducts(scope, range, "revenue", by, cap);
    return { columns: [by, "currency", "orders", "units", "revenue"], rows: rows.map(([key, currency, units, revenue, orders]) => [key, currency, orders, units, revenue]), moreGroups };
  }
  // Each order once per key (DISTINCT), then summed: an order's two rare codes are one "(other codes)" order.
  const rows = await prisma.$queryRaw<OrderGroupRow[]>`
    WITH ${brandBounds(scope, range)}, co AS (${countedOrders(scope)}), keyed AS (
      SELECT DISTINCT o.id, ${ORDER_KEYS[by]!} AS key FROM co o ${by === "discountCode" ? DISCOUNT_JOIN : Prisma.empty}
    ), g AS (
      SELECT k.key, o."currency" AS currency, count(*)::int AS orders, sum(o."netSales" + o."discounts") AS gross,
             sum(o."discounts") AS discounts, sum(o."netSales") AS net_sales, sum(o."total") AS total, sum(o."refunded") AS refunded
      FROM keyed k JOIN co o ON o.id = k.id
      GROUP BY 1, 2
    ), ${capped(time ? Prisma.sql`key DESC` : Prisma.sql`net_sales DESC, key`)}
    SELECT key, currency, orders, gross, discounts, net_sales, total, refunded, total_groups FROM r WHERE ${shown(cap)}
    ORDER BY currency, ${time ? Prisma.sql`key` : Prisma.sql`rn`}`;
  return {
    columns: [by, "currency", "orders", "gross", "discounts", "netSales", "total", "refunded", "avgOrderValue"],
    rows: rows.map((r) => [
      r.key, r.currency, r.orders, money(r.gross), money(r.discounts), money(r.net_sales), money(r.total), money(r.refunded),
      r.orders ? new Prisma.Decimal(r.net_sales).div(r.orders).toFixed(2) : null,
    ]),
    moreGroups: hidden(rows),
  };
}

// ---------------------------------------------------------------------------------------------------------------------

export const PRODUCT_GROUPS = ["product", "collection", "vendor"] as const;
export type ProductGroup = (typeof PRODUCT_GROUPS)[number];

type TopRow = { name: string; currency: string; units: number; revenue: Prisma.Decimal; orders: number; total_groups: number };

/** Best sellers per currency by net revenue or net units: products (default), collections or vendors. */
export async function topProducts(scope: Scope, range: DateRange, rankBy: "revenue" | "units", group: ProductGroup, limit: number): Promise<Capped> {
  const cap = Math.min(limit, MAX_ANALYSIS_ROWS);
  const [key, name, join] =
    group === "product"
      ? [PRODUCT_KEY, latestTitle(false), Prisma.empty]
      : group === "vendor"
        ? [VENDOR_KEY, Prisma.sql`min(l.k)`, Prisma.empty]
        : [COLLECTION_KEY, Prisma.sql`min(l.k)`, COLLECTION_JOIN];
  const order = rankBy === "units" ? Prisma.sql`units DESC, revenue DESC, name` : Prisma.sql`revenue DESC, units DESC, name`;
  const rows = await prisma.$queryRaw<TopRow[]>`
    WITH ${brandBounds(scope, range)}, x AS (
      SELECT l.*, ${key} AS k FROM (${countedLines(scope)}) l ${join}
    ), g AS (
      SELECT k, ${name} AS name, l."currency" AS currency, sum(${units("l")})::int AS units, sum(${netSales("l")}) AS revenue,
             count(DISTINCT l."orderShopifyId")::int AS orders
      FROM x l GROUP BY k, l."currency"
    ), ${capped(order)}
    SELECT name, currency, units, revenue, orders, total_groups FROM r WHERE ${shown(cap)} ORDER BY currency, rn`;
  // salesBreakdown reads these rows by position (name, currency, units, revenue, orders): reorder both together.
  return { rows: rows.map((r) => [r.name, r.currency, r.units, money(r.revenue), r.orders]), moreGroups: hidden(rows) };
}

// ---------------------------------------------------------------------------------------------------------------------

type VariantRow = {
  title: string; sku: string | null; currency: string; units: number; revenue: Prisma.Decimal; orders: number;
  price: Prisma.Decimal | null; in_stock: boolean | null; stock_quantity: number | null; in_catalogue: boolean;
};
type WeekRow = { week: string; currency: string; units: number; revenue: Prisma.Decimal };
/** The live catalogue row's stock and price (archived = no longer sold: not in the catalogue). */
const LIVE = Prisma.sql`l.p_id IS NOT NULL AND l.p_archived_at IS NULL`;

/**
 * "How is X selling": the variants whose sold title, variant title or SKU contains `q` (all when empty), with net units,
 * net revenue and current price and stock (the live catalogue row, matched by variant id), and their weekly units and
 * revenue together. Weeks start on Monday, in the brand's zone; a 366-day range is at most 53 weeks.
 */
export async function productSales(scope: Scope, range: DateRange, q: string) {
  const like = `%${likeLiteral(q)}%`;
  const match = q ? Prisma.sql`AND (l.title ILIKE ${like} OR l."variantTitle" ILIKE ${like} OR l.sku ILIKE ${like})` : Prisma.empty;
  const lines = Prisma.sql`SELECT * FROM (${countedLines(scope)}) l WHERE true ${match}`;
  const [variants, weeks] = await Promise.all([
    prisma.$queryRaw<VariantRow[]>`
      WITH ${brandBounds(scope, range)}, m AS (${lines})
      SELECT ${latestTitle(true)} AS title, (array_agg(l.sku ORDER BY l.local DESC))[1] AS sku, l."currency" AS currency,
             sum(${units("l")})::int AS units, sum(${netSales("l")}) AS revenue, count(DISTINCT l."orderShopifyId")::int AS orders,
             min(l.p_price) FILTER (WHERE ${LIVE}) AS price, bool_or(l.p_in_stock) FILTER (WHERE ${LIVE}) AS in_stock,
             min(l.p_stock_quantity) FILTER (WHERE ${LIVE}) AS stock_quantity, COALESCE(bool_or(${LIVE}), false) AS in_catalogue
      FROM m l GROUP BY ${VARIANT_KEY}, l."currency"
      ORDER BY units DESC, revenue DESC LIMIT ${MAX_VARIANT_ROWS}`,
    prisma.$queryRaw<WeekRow[]>`
      WITH ${brandBounds(scope, range)}, m AS (${lines})
      SELECT to_char(date_trunc('week', l.local), 'YYYY-MM-DD') AS week, l."currency" AS currency, sum(${units("l")})::int AS units,
             sum(${netSales("l")}) AS revenue
      FROM m l GROUP BY 1, 2 ORDER BY 2, 1`,
  ]);
  return { variants, weeks };
}

// ---------------------------------------------------------------------------------------------------------------------

type RiskRow = { title: string; sku: string | null; units: number; stock_quantity: number | null; in_stock: boolean | null; in_catalogue: boolean };
type SlowRow = { title: string; sku: string | null; stock_quantity: number; units: number };

/**
 * Stock against sales, per variant (stock is stored per variant): the `limit` best sellers by net units with their
 * current stock (the live catalogue row), and the in-stock variants that sold least for the most stock (slow movers,
 * up to MAX_SLOW_ROWS). Days of cover = stock ÷ average daily units over the range, worked out by the caller.
 */
export async function stockRisk(scope: Scope, range: DateRange, limit: number) {
  const [sellers, slow] = await Promise.all([
    prisma.$queryRaw<RiskRow[]>`
      WITH ${brandBounds(scope, range)}, m AS (${countedLines(scope)})
      SELECT ${latestTitle(true)} AS title, (array_agg(l.sku ORDER BY l.local DESC))[1] AS sku, sum(${units("l")})::int AS units,
             min(l.p_stock_quantity) FILTER (WHERE ${LIVE}) AS stock_quantity, bool_or(l.p_in_stock) FILTER (WHERE ${LIVE}) AS in_stock,
             COALESCE(bool_or(${LIVE}), false) AS in_catalogue
      FROM m l GROUP BY ${VARIANT_KEY}
      ORDER BY units DESC LIMIT ${Math.min(limit, MAX_RISK_ROWS)}`,
    prisma.$queryRaw<SlowRow[]>`
      WITH ${brandBounds(scope, range)}, m AS (${countedLines(scope)}), sold AS (
        SELECT l."variantId", sum(${units("l")})::int AS units FROM m l WHERE l."variantId" IS NOT NULL GROUP BY 1
      )
      SELECT p.title, p.sku, p."stockQuantity" AS stock_quantity, COALESCE(sold.units, 0) AS units
      FROM "Product" p LEFT JOIN sold ON sold."variantId" = p."externalId"
      WHERE p."workspaceId" = ${scope.workspaceId} AND p."brandId" = ${scope.brandId} AND p.source = 'SHOPIFY'
        AND p."archivedAt" IS NULL AND p."stockQuantity" > 0
      ORDER BY COALESCE(sold.units, 0)::numeric / p."stockQuantity", p."stockQuantity" DESC, p.id LIMIT ${MAX_SLOW_ROWS}`,
  ]);
  return { sellers, slow };
}
