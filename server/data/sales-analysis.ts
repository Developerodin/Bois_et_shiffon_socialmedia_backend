import { Prisma } from "@prisma/client";
import type { DateRange } from "@/shared";
import { likeLiteral } from "@/server/catalog/products";
import { prisma } from "@/server/db/prisma";
import { addDays } from "./sources";

/**
 * Read-only analysis over the brand's own ShopOrder / ShopOrderLine / Product rows for the CMO chat (server/chat/tools.ts).
 * Same rules as the Sales tab (sales-read.ts): brand-local days (BrandProfile.timeZone, else UTC) cut into instants so
 * the (brandId, processedAt) index bounds the scan; test and cancelled orders left out; never summed across currencies.
 * Every `by` / `group` is a fixed SQL fragment chosen from a whitelist: nothing the model sends is spliced into SQL.
 * Line-level numbers exist only for AskCart orders sent with line items (hasOrderLines tells the tools when none do).
 * Units are net of refunds (currentQuantity when sent); revenue is discountedTotalSet, the line's total after
 * discounts, which Shopify does not lower on a refund.
 * ponytail: sums raw rows per call; past ~100k orders in a range, add per-day rollups written by the sync.
 */

/** Most rows any analysis returns, so a report built from several calls stays small. */
export const MAX_ANALYSIS_ROWS = 60;

export const days = (range: DateRange) => (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 + 1;

/** bp: the brand's zone; b: the range's brand-local midnights as instants (lo inclusive, hi exclusive). */
const bounds = (scope: Scope, range: DateRange) => Prisma.sql`
  bp AS (
    SELECT COALESCE((SELECT "timeZone" FROM "BrandProfile" WHERE "brandId" = ${scope.brandId} AND "workspaceId" = ${scope.workspaceId}), 'UTC') AS tz
  ), b AS (
    SELECT ((${range.from}::date)::timestamp AT TIME ZONE bp.tz) AT TIME ZONE 'UTC' AS lo,
           ((${addDays(range.to, 1)}::date)::timestamp AT TIME ZONE bp.tz) AT TIME ZONE 'UTC' AS hi
    FROM bp
  )`;
/** The orders that count, with their brand-local time `local`. Needs bounds() in the WITH. */
const countedOrders = (scope: Scope) => Prisma.sql`
  SELECT o.*, ((o."processedAt" AT TIME ZONE 'UTC') AT TIME ZONE bp.tz) AS local
  FROM "ShopOrder" o CROSS JOIN b CROSS JOIN bp
  WHERE o."workspaceId" = ${scope.workspaceId} AND o."brandId" = ${scope.brandId}
    AND NOT o."test" AND o."cancelledAt" IS NULL AND o."processedAt" >= b.lo AND o."processedAt" < b.hi`;
/** Counted orders' lines (`l`), with their order's local time and currency, and the variant's catalogue row (`p`, may be null). */
const countedLines = (scope: Scope) => Prisma.sql`
  SELECT l.*, o.local, o."currency" AS order_currency, p.vendor AS p_vendor, p.collections AS p_collections, p.id AS p_id
  FROM (${countedOrders(scope)}) o
  JOIN "ShopOrderLine" l ON l."brandId" = o."brandId" AND l."orderShopifyId" = o."shopifyId" AND l."workspaceId" = o."workspaceId"
  -- (brandId, source, externalId) is unique, so a line matches at most one catalogue row: no fan-out.
  LEFT JOIN "Product" p ON p."brandId" = l."brandId" AND p."workspaceId" = l."workspaceId" AND p.source = 'SHOPIFY' AND p."externalId" = l."variantId"`;

type Scope = { workspaceId: string; brandId: string };
const UNITS = Prisma.sql`COALESCE(l."currentQuantity", l."quantity")`;
const money = (v: Prisma.Decimal | null) => (v === null ? null : new Prisma.Decimal(v).toFixed(2));

/** Has this brand any stored line items at all? (None: AskCart doesn't send them yet, or the store isn't on AskCart.) */
export async function hasOrderLines(scope: Scope) {
  return !!(await prisma.shopOrderLine.findFirst({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId }, select: { id: true } }));
}

// ---------------------------------------------------------------------------------------------------------------------

export const BREAKDOWNS = ["day", "week", "month", "weekday", "channel", "fulfillmentStatus", "financialStatus", "discountCode", "collection", "vendor"] as const;
export type Breakdown = (typeof BREAKDOWNS)[number];
const TIME: readonly Breakdown[] = ["day", "week", "month", "weekday"];

/** Order-level group keys (o = a counted order). Weeks start on Monday; weekday is "1 Monday" … "7 Sunday". */
const ORDER_KEYS: Partial<Record<Breakdown, Prisma.Sql>> = {
  day: Prisma.sql`to_char(o.local, 'YYYY-MM-DD')`,
  week: Prisma.sql`to_char(date_trunc('week', o.local), 'YYYY-MM-DD')`,
  month: Prisma.sql`to_char(o.local, 'YYYY-MM')`,
  weekday: Prisma.sql`to_char(o.local, 'ID') || ' ' || trim(to_char(o.local, 'Day'))`,
  channel: Prisma.sql`COALESCE(o."sourceName", '(unknown)')`,
  fulfillmentStatus: Prisma.sql`COALESCE(o."fulfillmentStatus", '(not sent)')`,
  financialStatus: Prisma.sql`COALESCE(o."financialStatus", '(not sent)')`,
  discountCode: Prisma.sql`COALESCE(dc.code, '(none)')`,
};

export type BreakdownResult = {
  /** "orders": order totals per group; "lines": line totals per group (collection, vendor). */
  basis: "orders" | "lines";
  columns: string[];
  rows: (string | number | null)[][];
  /** Groups left out by the row cap. */
  moreGroups: number;
};

type OrderGroupRow = {
  key: string; currency: string; n_groups: number; orders: number; gross: Prisma.Decimal; discounts: Prisma.Decimal;
  net_sales: Prisma.Decimal; total: Prisma.Decimal; refunded: Prisma.Decimal;
};
type LineGroupRow = { key: string; currency: string; n_groups: number; orders: number; units: number; revenue: Prisma.Decimal };

/**
 * Sales per group, per currency. Time groups come oldest first; the others by net sales (lines: revenue), largest
 * first. An order with two discount codes counts in both; a line whose product is in two collections counts in both.
 * collection / vendor are line-based (only AskCart orders with line items, matched to the catalogue by variant).
 */
export async function salesBreakdown(scope: Scope, range: DateRange, by: Breakdown, limit = MAX_ANALYSIS_ROWS): Promise<BreakdownResult> {
  const cap = Math.min(limit, MAX_ANALYSIS_ROWS);
  const time = TIME.includes(by);
  if (by === "collection" || by === "vendor") {
    const key =
      by === "vendor"
        ? Prisma.sql`CASE WHEN l.p_id IS NULL THEN '(not in catalogue)' ELSE COALESCE(l.p_vendor, '(no vendor)') END`
        : Prisma.sql`CASE WHEN l.p_id IS NULL THEN '(not in catalogue)' ELSE COALESCE(c.title, '(no collection)') END`;
    const collections =
      by === "collection"
        ? Prisma.sql`LEFT JOIN LATERAL (SELECT e->>'title' AS title FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.p_collections) = 'array' THEN l.p_collections ELSE '[]'::jsonb END) e) c ON true`
        : Prisma.empty;
    const rows = await prisma.$queryRaw<LineGroupRow[]>`
      WITH ${bounds(scope, range)}, g AS (
        SELECT ${key} AS key, l."currency" AS currency, count(DISTINCT l."orderShopifyId")::int AS orders,
               sum(${UNITS})::int AS units, sum(l."discountedTotal") AS revenue
        FROM (${countedLines(scope)}) l ${collections}
        GROUP BY 1, 2
      ), r AS (
        SELECT g.*, row_number() OVER (PARTITION BY currency ORDER BY revenue DESC, key) AS rn, count(*) OVER (PARTITION BY currency)::int AS n_groups FROM g
      )
      SELECT key, currency, orders, units, revenue, n_groups FROM r WHERE rn <= ${cap} ORDER BY currency, rn LIMIT ${cap}`;
    return {
      basis: "lines",
      columns: [by, "currency", "orders", "units", "revenue"],
      rows: rows.map((r) => [r.key, r.currency, r.orders, r.units, money(r.revenue)]),
      moreGroups: moreGroups(rows),
    };
  }
  const discountJoin = by === "discountCode" ? Prisma.sql`LEFT JOIN LATERAL unnest(o."discountCodes") AS dc(code) ON true` : Prisma.empty;
  const order = time ? Prisma.sql`key` : Prisma.sql`net_sales DESC, key`;
  const rows = await prisma.$queryRaw<OrderGroupRow[]>`
    WITH ${bounds(scope, range)}, g AS (
      SELECT ${ORDER_KEYS[by]!} AS key, o."currency" AS currency, count(*)::int AS orders, sum(o."netSales" + o."discounts") AS gross,
             sum(o."discounts") AS discounts, sum(o."netSales") AS net_sales, sum(o."total") AS total, sum(o."refunded") AS refunded
      FROM (${countedOrders(scope)}) o ${discountJoin}
      GROUP BY 1, 2
    ), r AS (
      SELECT g.*, row_number() OVER (PARTITION BY currency ORDER BY ${order}) AS rn, count(*) OVER (PARTITION BY currency)::int AS n_groups FROM g
    )
    SELECT key, currency, orders, gross, discounts, net_sales, total, refunded, n_groups FROM r WHERE rn <= ${cap} ORDER BY currency, rn LIMIT ${cap}`;
  return {
    basis: "orders",
    columns: [by, "currency", "orders", "gross", "discounts", "netSales", "total", "refunded", "avgOrderValue"],
    rows: rows.map((r) => [
      r.key, r.currency, r.orders, money(r.gross), money(r.discounts), money(r.net_sales), money(r.total), money(r.refunded),
      r.orders ? new Prisma.Decimal(r.net_sales).div(r.orders).toFixed(2) : null,
    ]),
    moreGroups: moreGroups(rows),
  };
}

/** Groups the cap left out: every currency's group count minus the rows returned. */
const moreGroups = (rows: { currency: string; n_groups: number }[]) =>
  [...new Map(rows.map((r) => [r.currency, r.n_groups])).values()].reduce((a, n) => a + n, 0) - rows.length;

// ---------------------------------------------------------------------------------------------------------------------

export const PRODUCT_GROUPS = ["product", "collection", "vendor"] as const;
export type ProductGroup = (typeof PRODUCT_GROUPS)[number];

/**
 * A product's key: its Shopify product id, else its SKU, else its title (a product deleted from the store keeps its
 * sales under the SKU or title it was sold with).
 */
const PRODUCT_KEY = Prisma.sql`COALESCE(l."productId", 'sku:' || l.sku, 'title:' || l.title)`;

type TopRow = { name: string; currency: string; units: number; revenue: Prisma.Decimal; orders: number };

/** Best sellers per currency by revenue or units: products (default), collections or vendors. */
export async function topProducts(scope: Scope, range: DateRange, by: "revenue" | "units", group: ProductGroup, limit: number) {
  const cap = Math.min(limit, MAX_ANALYSIS_ROWS);
  const [key, name, collections] =
    group === "product"
      ? [PRODUCT_KEY, Prisma.sql`(array_agg(l.title ORDER BY l.local DESC))[1]`, Prisma.empty]
      : group === "vendor"
        ? [Prisma.sql`CASE WHEN l.p_id IS NULL THEN '(not in catalogue)' ELSE COALESCE(l.p_vendor, '(no vendor)') END`, Prisma.sql`min(l.k)`, Prisma.empty]
        : [
            Prisma.sql`CASE WHEN l.p_id IS NULL THEN '(not in catalogue)' ELSE COALESCE(c.title, '(no collection)') END`,
            Prisma.sql`min(l.k)`,
            Prisma.sql`LEFT JOIN LATERAL (SELECT e->>'title' AS title FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.p_collections) = 'array' THEN l.p_collections ELSE '[]'::jsonb END) e) c ON true`,
          ];
  const order = by === "units" ? Prisma.sql`units DESC, revenue DESC` : Prisma.sql`revenue DESC, units DESC`;
  return prisma.$queryRaw<TopRow[]>`
    WITH ${bounds(scope, range)}, x AS (
      SELECT l.*, ${key} AS k FROM (${countedLines(scope)}) l ${collections}
    ), g AS (
      SELECT k, ${name} AS name, l."currency" AS currency, sum(${UNITS})::int AS units, sum(l."discountedTotal") AS revenue,
             count(DISTINCT l."orderShopifyId")::int AS orders
      FROM x l GROUP BY k, l."currency"
    ), r AS (SELECT g.*, row_number() OVER (PARTITION BY currency ORDER BY ${order}, name) AS rn FROM g)
    SELECT name, currency, units, revenue, orders FROM r WHERE rn <= ${cap} ORDER BY currency, rn LIMIT ${MAX_ANALYSIS_ROWS}`;
}

// ---------------------------------------------------------------------------------------------------------------------

type VariantRow = {
  title: string; variant_title: string | null; sku: string | null; currency: string; units: number; revenue: Prisma.Decimal; orders: number;
  price: Prisma.Decimal | null; in_stock: boolean | null; stock_quantity: number | null; in_catalogue: boolean;
};
type WeekRow = { week: string; currency: string; units: number; revenue: Prisma.Decimal };

/**
 * "How is X selling": the variants whose sold title, variant title or SKU contains `q` (all when empty), with their
 * units, revenue and current price and stock (the live catalogue row, matched by variant id), and their weekly units
 * and revenue together. Weeks start on Monday, in the brand's zone; a 366-day range is at most 53 weeks.
 */
export async function productSales(scope: Scope, range: DateRange, q: string) {
  const match = q ? Prisma.sql`AND (l.title ILIKE ${`%${likeLiteral(q)}%`} OR l."variantTitle" ILIKE ${`%${likeLiteral(q)}%`} OR l.sku ILIKE ${`%${likeLiteral(q)}%`})` : Prisma.empty;
  const lines = Prisma.sql`SELECT * FROM (${countedLines(scope)}) l WHERE true ${match}`;
  const [variants, weeks] = await Promise.all([
    prisma.$queryRaw<VariantRow[]>`
      WITH ${bounds(scope, range)}, m AS (${lines})
      SELECT (array_agg(m.title ORDER BY m.local DESC))[1] AS title, (array_agg(m."variantTitle" ORDER BY m.local DESC))[1] AS variant_title,
             (array_agg(m.sku ORDER BY m.local DESC))[1] AS sku, m."currency" AS currency, sum(${unitsOf("m")})::int AS units,
             sum(m."discountedTotal") AS revenue, count(DISTINCT m."orderShopifyId")::int AS orders,
             min(p.price) AS price, bool_or(p."inStock") AS in_stock, min(p."stockQuantity") AS stock_quantity, bool_or(p.id IS NOT NULL) AS in_catalogue
      FROM m LEFT JOIN "Product" p ON p.id = m.p_id AND p."archivedAt" IS NULL
      GROUP BY COALESCE(m."variantId", 'sku:' || m.sku, 'title:' || m.title || ' / ' || COALESCE(m."variantTitle", '')), m."currency"
      ORDER BY units DESC, revenue DESC LIMIT 20`,
    prisma.$queryRaw<WeekRow[]>`
      WITH ${bounds(scope, range)}, m AS (${lines})
      SELECT to_char(date_trunc('week', m.local), 'YYYY-MM-DD') AS week, m."currency" AS currency, sum(${unitsOf("m")})::int AS units,
             sum(m."discountedTotal") AS revenue
      FROM m GROUP BY 1, 2 ORDER BY 2, 1 LIMIT ${MAX_ANALYSIS_ROWS}`,
  ]);
  return { variants, weeks };
}
const unitsOf = (t: "m") => Prisma.raw(`COALESCE(${t}."currentQuantity", ${t}."quantity")`);

// ---------------------------------------------------------------------------------------------------------------------

type RiskRow = {
  title: string; sku: string | null; units: number; stock_quantity: number | null; in_stock: boolean | null; in_catalogue: boolean;
};
type SlowRow = { title: string; sku: string | null; stock_quantity: number; units: number };

/**
 * Stock against sales, per variant (stock is stored per variant): the `limit` best sellers by units with their
 * current stock (the live catalogue row), and the in-stock variants that sold least for the most stock (slow movers,
 * up to 15). Days of cover = stock ÷ average daily units over the range, worked out by the caller.
 */
export async function stockRisk(scope: Scope, range: DateRange, limit: number) {
  const cap = Math.min(limit, 40);
  const [sellers, slow] = await Promise.all([
    prisma.$queryRaw<RiskRow[]>`
      WITH ${bounds(scope, range)}, m AS (${countedLines(scope)})
      SELECT (array_agg(m.title || COALESCE(' — ' || m."variantTitle", '') ORDER BY m.local DESC))[1] AS title,
             (array_agg(m.sku ORDER BY m.local DESC))[1] AS sku, sum(${unitsOf("m")})::int AS units,
             min(p."stockQuantity") AS stock_quantity, bool_or(p."inStock") AS in_stock, bool_or(p.id IS NOT NULL) AS in_catalogue
      FROM m LEFT JOIN "Product" p ON p.id = m.p_id AND p."archivedAt" IS NULL
      GROUP BY COALESCE(m."variantId", 'sku:' || m.sku, 'title:' || m.title || ' / ' || COALESCE(m."variantTitle", ''))
      ORDER BY units DESC LIMIT ${cap}`,
    prisma.$queryRaw<SlowRow[]>`
      WITH ${bounds(scope, range)}, m AS (${countedLines(scope)}), sold AS (
        SELECT m."variantId", sum(${unitsOf("m")})::int AS units FROM m WHERE m."variantId" IS NOT NULL GROUP BY 1
      )
      SELECT p.title, p.sku, p."stockQuantity" AS stock_quantity, COALESCE(sold.units, 0) AS units
      FROM "Product" p LEFT JOIN sold ON sold."variantId" = p."externalId"
      WHERE p."workspaceId" = ${scope.workspaceId} AND p."brandId" = ${scope.brandId} AND p.source = 'SHOPIFY'
        AND p."archivedAt" IS NULL AND p."stockQuantity" > 0
      ORDER BY COALESCE(sold.units, 0)::numeric / p."stockQuantity", p."stockQuantity" DESC, p.id LIMIT 15`,
  ]);
  return { sellers, slow };
}
