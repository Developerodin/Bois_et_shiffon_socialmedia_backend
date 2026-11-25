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
 * Sales tab numbers from ShopOrder, per currency (never added across currencies): totals for from..to, the same-length
 * previous period, and the days with orders. Reads the previous period and the range in one pass of countedOrders and
 * buckets each order on its brand-local date. One query (GROUPING SETS for the totals).
 * ponytail: sums raw rows; past ~100k orders in a range add a per-day rollup written by the sync.
 */
export async function salesSummary(scope: Scope, range: DateRange): Promise<SalesSummaryDto> {
  const both = { from: previousRange(range).from, to: range.to };
  const rows = await prisma.$queryRaw<Row[]>`
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
    ORDER BY "currency", day NULLS FIRST`;

  const byCurrency = new Map<string, SalesCurrency>();
  for (const r of rows) {
    let c = byCurrency.get(r.currency);
    if (!c) byCurrency.set(r.currency, (c = { currency: r.currency, totals: ZERO, previous: ZERO, days: [] }));
    if (r.period === "prev") {
      if (r.is_total) c.previous = totals(r);
    } else if (r.is_total) c.totals = totals(r);
    else c.days.push({ day: r.day!.toISOString().slice(0, 10), ...totals(r) });
  }
  return { currencies: [...byCurrency.values()] };
}
