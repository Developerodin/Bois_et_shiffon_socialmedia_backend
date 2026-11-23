import type { Prisma } from "@prisma/client";
import type { SalesCurrency, SalesSummaryDto, SalesTotals } from "@/shared";
import { prisma } from "@/server/db/prisma";
import { addDays } from "./sources";

/** Longest range a summary reads (and the previous period is as long again). */
export const MAX_SALES_DAYS = 366;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `from`..`to` as brand-local days, or null when either isn't a real day, they're reversed or the span is too long. */
export function salesRange(from: string | null, to: string | null): { from: string; to: string; days: number } | null {
  if (!from || !to || !DAY.test(from) || !DAY.test(to)) return null;
  if (addDays(from, 0) !== from || addDays(to, 0) !== to) return null; // 2026-02-30 and the like
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  return days >= 1 && days <= MAX_SALES_DAYS ? { from, to, days } : null;
}

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

/**
 * Sales tab numbers from ShopOrder, per currency (never added across currencies): totals for from..to, the same-length
 * previous period, and the days with orders. Days are the brand's (BrandProfile.timeZone, else UTC): the range is cut
 * at brand-local midnights turned into instants, so the (brandId, processedAt) index bounds the scan, and each order is
 * bucketed on its brand-local date. Test and cancelled orders are left out. One query (GROUPING SETS for the totals).
 * ponytail: sums raw rows; past ~100k orders in a range add a per-day rollup written by the sync.
 */
export async function salesSummary(scope: { workspaceId: string; brandId: string }, range: { from: string; to: string; days: number }): Promise<SalesSummaryDto> {
  const prevFrom = addDays(range.from, -range.days);
  const nextDay = addDays(range.to, 1);
  const rows = await prisma.$queryRaw<Row[]>`
    WITH bp AS (
      SELECT (SELECT "timeZone" FROM "BrandProfile" WHERE "brandId" = ${scope.brandId} AND "workspaceId" = ${scope.workspaceId}) AS "timeZone"
    ), b AS (
      SELECT ((${prevFrom}::date)::timestamp AT TIME ZONE COALESCE(bp."timeZone",'UTC')) AT TIME ZONE 'UTC' AS lo,
             ((${range.from}::date)::timestamp AT TIME ZONE COALESCE(bp."timeZone",'UTC')) AT TIME ZONE 'UTC' AS mid,
             ((${nextDay}::date)::timestamp AT TIME ZONE COALESCE(bp."timeZone",'UTC')) AT TIME ZONE 'UTC' AS hi
      FROM bp
    ), o AS (
      SELECT CASE WHEN o."processedAt" >= b.mid THEN 'cur' ELSE 'prev' END AS period, o."currency",
             ((o."processedAt" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bp."timeZone",'UTC'))::date AS day,
             o."netSales", o."discounts", o."total", o."refunded"
      FROM "ShopOrder" o CROSS JOIN b CROSS JOIN bp
      WHERE o."workspaceId" = ${scope.workspaceId} AND o."brandId" = ${scope.brandId}
        AND NOT o."test" AND o."cancelledAt" IS NULL
        AND o."processedAt" >= b.lo AND o."processedAt" < b.hi
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
