import { Prisma } from "@prisma/client";
import type { DateRange, SalesCurrency, SalesSummaryDto, SalesTotals } from "@/shared";
import { prisma } from "@/server/db/prisma";
import { addDays, previousRange } from "./sources";

/** Longest range a summary reads (and the previous period is as long again). */
export const MAX_SALES_DAYS = 366;
type Row = {
  period: "cur" | "prev";
  currency: string;
  day: Date | null;
  is_total: number;
  orders: number;
  gross: Prisma.Decimal;
  discounts: Prisma.Decimal;
  net_sales: Prisma.Decimal;
  total: Prisma.Decimal;
  refunded: Prisma.Decimal;
};

const ZERO: SalesTotals = { orders: 0, gross: "0.00", discounts: "0.00", netSales: "0.00", total: "0.00", refunded: "0.00" };
const totals = (r: Row): SalesTotals => ({
  orders: r.orders,
  gross: r.gross.toFixed(2),
  discounts: r.discounts.toFixed(2),
  netSales: r.net_sales.toFixed(2),
  total: r.total.toFixed(2),
  refunded: r.refunded.toFixed(2),
});

type Scope = { workspaceId: string; brandId: string };

/**
 * The one definition of a range in the brand's days, shared by the Sales tab and the chat's sales tools
 * (sales-analysis.ts): CTEs `bp` (the brand's zone: BrandProfile.timeZone, else UTC) and `b` (lo, hi: the range's
 * brand-local midnights as instants, hi exclusive), so the (brandId, processedAt) index bounds the scan.
 * ponytail: the planner can't estimate rows from bounds computed in SQL; if plans go wrong on big stores, compute
 * lo/hi in JS (the zone is known) and pass them as literals.
 */
export const brandBounds = (scope: Scope, range: DateRange) => Prisma.sql`
  bp AS (
    SELECT COALESCE((SELECT "timeZone" FROM "BrandProfile" WHERE "brandId" = ${scope.brandId} AND "workspaceId" = ${scope.workspaceId}), 'UTC') AS tz
  ), b AS (
    SELECT ((${range.from}::date)::timestamp AT TIME ZONE bp.tz) AT TIME ZONE 'UTC' AS lo,
           ((${addDays(range.to, 1)}::date)::timestamp AT TIME ZONE bp.tz) AT TIME ZONE 'UTC' AS hi
    FROM bp
  )`;

/**
 * The orders that count, with `local` (the brand-local time): this brand's, in brandBounds' range, not test, not
 * cancelled. Needs brandBounds in the WITH.
 */
export const countedOrders = (scope: Scope) => Prisma.sql`
  SELECT o.*, ((o."processedAt" AT TIME ZONE 'UTC') AT TIME ZONE bp.tz) AS local
  FROM "ShopOrder" o CROSS JOIN b CROSS JOIN bp
  WHERE o."workspaceId" = ${scope.workspaceId} AND o."brandId" = ${scope.brandId}
    AND NOT o."test" AND o."cancelledAt" IS NULL AND o."processedAt" >= b.lo AND o."processedAt" < b.hi`;

/**
 * When ShopOrder rows started carrying shippingTaxes: the day of migration 20261126110000, at 00:00 UTC (UTC wall
 * time, as Prisma stores "updatedAt"); the start of the day rather than the migration's hour so rows written by the
 * new code during that day (tests included) never read as old. A tax-included row with no shippingTaxes written before
 * it was read by the old code (its VAT can't be split yet); one written after it had shipping lines we couldn't read.
 * Rows the old code wrote between this moment and the deploy count as the latter until `reset:shopify-orders`
 * re-reads them (the deploy step for every brand with orders).
 */
export const SHIPPING_TAXES_SINCE = "2026-11-26 00:00:00";

/**
 * Net sales without VAT for one order `o` (decision 2): the item VAT comes off a tax-included order, i.e. its tax
 * lines minus the shipping's (currentTaxLines include the shipping tax, checked live 2026-11-26; netSales has no
 * shipping). A tax-excluded order's netSales has no VAT in it. NULL when the shipping tax isn't known.
 */
export const NET_EX_VAT = Prisma.sql`CASE WHEN o."taxesIncluded" THEN o."netSales" - (o."taxes" - o."shippingTaxes") ELSE o."netSales" END`;

type ExVatRow = { currency: string; last_old: Date | null; net_ex_vat: Prisma.Decimal | null; missing: number };

/**
 * Per currency for `range`: net sales without VAT, from the day after the last tax-included order read before
 * SHIPPING_TAXES_SINCE inside the range (exVatFrom; null = the whole range), and how many later orders were left out
 * because their shipping tax couldn't be read (exVatMissing). Range-bounded, on the same (brandId, processedAt) index.
 * Keyed by the currencies with orders in the range only (the ad ratio counts the shop's currencies from it).
 */
export async function exVat(scope: Scope, range: DateRange) {
  const rows = await prisma.$queryRaw<ExVatRow[]>`
    WITH ${brandBounds(scope, range)}, o AS (${countedOrders(scope)}),
    old AS (
      SELECT o."currency", max(o.local::date) AS last_old FROM o
      WHERE o."taxesIncluded" AND o."shippingTaxes" IS NULL AND o."updatedAt" < ${SHIPPING_TAXES_SINCE}::timestamp
      GROUP BY o."currency"
    )
    SELECT o."currency" AS currency, old.last_old,
           sum(${NET_EX_VAT}) FILTER (WHERE old.last_old IS NULL OR o.local::date > old.last_old) AS net_ex_vat,
           count(*) FILTER (WHERE (old.last_old IS NULL OR o.local::date > old.last_old) AND o."taxesIncluded" AND o."shippingTaxes" IS NULL)::int AS missing
    FROM o LEFT JOIN old ON old."currency" = o."currency"
    GROUP BY o."currency", old.last_old`;
  return new Map(rows.map((r) => {
    const from = r.last_old ? addDays(r.last_old.toISOString().slice(0, 10), 1) : null;
    // An old row on the range's last day leaves no day with an ex-VAT figure.
    const covered = from === null || from <= range.to;
    return [r.currency, { netExVat: covered ? (r.net_ex_vat ?? new Prisma.Decimal(0)).toFixed(2) : null, exVatFrom: from, exVatMissing: covered ? r.missing : 0 }];
  }));
}

/**
 * Sales tab numbers from ShopOrder, per currency (never added across currencies): totals for from..to, the same-length
 * previous period, and the days with orders. Reads the previous period and the range in one pass of countedOrders and
 * buckets each order on its brand-local date. One query (GROUPING SETS for the totals).
 * ponytail: sums raw rows; past ~100k orders in a range add a per-day rollup written by the sync.
 */
export async function salesSummary(scope: Scope, range: DateRange): Promise<SalesSummaryDto> {
  const both = { from: previousRange(range).from, to: range.to };
  // The ex-VAT read runs beside the main one (two queries at once on the pool).
  const [rows, vat] = await Promise.all([prisma.$queryRaw<Row[]>`
    WITH ${brandBounds(scope, both)}, o AS (
      SELECT CASE WHEN o.local::date >= ${range.from}::date THEN 'cur' ELSE 'prev' END AS period, o."currency", o.local::date AS day,
             o."netSales", o."discounts", o."total", o."refunded"
      FROM (${countedOrders(scope)}) o
    )
    SELECT period, "currency" AS currency, day, GROUPING(day)::int AS is_total, count(*)::int AS orders,
           sum("netSales" + "discounts") AS gross, sum("discounts") AS discounts, sum("netSales") AS net_sales,
           sum("total") AS total, sum("refunded") AS refunded
    FROM o
    GROUP BY GROUPING SETS ((period, "currency", day), (period, "currency"))
    ORDER BY "currency", day NULLS FIRST`, exVat(scope, range)]);
  const byCurrency = new Map<string, SalesCurrency>();
  for (const r of rows) {
    let c = byCurrency.get(r.currency);
    if (!c) {
      const v = vat.get(r.currency) ?? { netExVat: null, exVatFrom: null, exVatMissing: 0 };
      byCurrency.set(r.currency, (c = { currency: r.currency, totals: ZERO, previous: ZERO, days: [], ...v }));
    }
    if (r.period === "prev") {
      if (r.is_total) c.previous = totals(r);
    } else if (r.is_total) c.totals = totals(r);
    else c.days.push({ day: r.day!.toISOString().slice(0, 10), ...totals(r) });
  }
  return { currencies: [...byCurrency.values()] };
}
