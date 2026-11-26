import { Prisma } from "@prisma/client";
import { dayDate, dayOf, previousRange } from "./sources";
import type { AdsCampaignDto, AdsSummaryDto, AdsTotals, DateRange, ShopRevenueOverSpend } from "@/shared";
import { prisma } from "@/server/db/prisma";
import { convertedSpend } from "./budgets";
import { exVat } from "./sales-read";

/**
 * Ads numbers for the Ads tab and its export, read only from AdDay (never from Meta). Callers have checked ads.read.
 * Every query is scoped by workspace and brand; money is grouped by currency and never added across currencies,
 * except the shop-revenue ratio, whose spend is converted through the ECB rates and says so. Days are each ad account's own days.
 * ponytail: sums run per request over the (brandId, platform, accountId, day) index; at many campaigns × 366 days
 * a per-day rollup would replace them.
 * ponytail: reads filter (brandId, platform, day) without accountId, so that index seeks on its (brandId, platform)
 * prefix only and filters the days. Upgrade: `@@index([brandId, platform, day])` in a NEW migration (never edit
 * 20261125123000_ad_day).
 */
type Scope = { workspaceId: string; brandId: string };

/** Longest `?from&to` the ads routes accept: a year, both ends counted, leap years included. */
export const ADS_MAX_DAYS = 366;

export const D = (v: Prisma.Decimal | string | number | null | undefined) => new Prisma.Decimal(v ?? 0);

/** ROAS and cost per purchase from sums; null where the divisor is zero. */
export function totalsOf(currency: string, spend: Prisma.Decimal, purchases: number, purchaseValue: Prisma.Decimal): AdsTotals {
  return {
    currency,
    spend: spend.toFixed(2),
    purchases,
    purchaseValue: purchaseValue.toFixed(2),
    roas: spend.isZero() ? null : purchaseValue.div(spend).toDecimalPlaces(2).toNumber(),
    costPerPurchase: purchases === 0 ? null : spend.div(purchases).toFixed(2),
  };
}

async function totals(scope: Scope, range: DateRange): Promise<AdsTotals[]> {
  const groups = await prisma.adDay.groupBy({
    by: ["currency"],
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId, platform: "META", day: { gte: dayDate(range.from), lte: dayDate(range.to) } },
    _sum: { spend: true, purchases: true, purchaseValue: true },
    orderBy: { currency: "asc" },
  });
  return groups.map((g) => totalsOf(g.currency, D(g._sum.spend), g._sum.purchases ?? 0, D(g._sum.purchaseValue)));
}

/**
 * Totals per currency for the range and for the same length before it. `crmRead` (the ads/summary route passes the
 * person's crm.read) adds shop revenue ÷ ad spend; it defaults to false, so the weekly digest never carries it.
 */
export async function adsSummary(scope: Scope, range: DateRange, opts: { crmRead?: boolean } = {}): Promise<AdsSummaryDto> {
  const prev = previousRange(range);
  const [now, before, ratio] = await Promise.all([totals(scope, range), totals(scope, prev), opts.crmRead ? shopRevenueOverSpend(scope, range) : null]);
  return { totals: now, previous: before, previousRange: prev, ...(ratio ? { shopRevenueOverSpend: ratio } : {}) };
}

/**
 * Net sales without VAT (Task 2) ÷ ad spend over the same days, the spend converted to the shop's currency. Shopify
 * days are the brand's and ad days the ad account's, so the two may differ by a few hours (the screen says so).
 * Reads the ex-VAT figure alone (sales-read.ts exVat), for the range's currencies only. No figure when orders were
 * left out of the ex-VAT sum (exVatMissing): the ratio would read low. `accountIds`: the live ad accounts, if already read.
 */
export async function shopRevenueOverSpend(scope: Scope, range: DateRange, accountIds?: string[]): Promise<ShopRevenueOverSpend> {
  const none = (why: ShopRevenueOverSpend["why"], currency: string | null = null): ShopRevenueOverSpend => ({ ratio: null, currency, why, staleRateFrom: null });
  const vat = await exVat(scope, range);
  if (vat.size > 1) return none("currencies");
  const [entry] = [...vat];
  if (!entry) return none("no_revenue");
  const [currency, shop] = entry;
  if (shop.netExVat === null || shop.exVatFrom !== null) return none("no_revenue", currency);
  if (shop.exVatMissing > 0) return none("vat_missing", currency);
  const spend = await convertedSpend(scope, range.from, range.to, currency, accountIds);
  if (!spend) return none("no_rate", currency);
  if (spend.total.isZero()) return none("no_spend", currency);
  return { ratio: D(shop.netExVat).div(spend.total).toDecimalPlaces(2).toNumber(), currency, why: null, staleRateFrom: spend.stale };
}

/** One currency's ads sums for one day (adsDays). */
export type AdsDayRow = { currency: string; day: string; spend: Prisma.Decimal; impressions: number; clicks: number; purchases: number; purchaseValue: Prisma.Decimal };

/**
 * The brand's Meta sums per currency and day over the range, for the given ad accounts only (the chat passes the ones
 * switched on). The same groupBy shape as budgets' convertedSpend, with every figure summed; it reads through the
 * (brandId, platform, accountId, day) index like totals(). Ordered by day, then currency.
 */
export async function adsDays(scope: Scope, range: DateRange, accountIds: string[]): Promise<AdsDayRow[]> {
  const groups = await prisma.adDay.groupBy({
    by: ["currency", "day"],
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId, platform: "META", accountId: { in: accountIds }, day: { gte: dayDate(range.from), lte: dayDate(range.to) } },
    _sum: { spend: true, impressions: true, clicks: true, purchases: true, purchaseValue: true },
    orderBy: [{ day: "asc" }, { currency: "asc" }],
  });
  return groups.map((g) => ({
    currency: g.currency,
    day: dayOf(g.day),
    spend: D(g._sum.spend),
    impressions: g._sum.impressions ?? 0,
    clicks: g._sum.clicks ?? 0,
    purchases: g._sum.purchases ?? 0,
    purchaseValue: D(g._sum.purchaseValue),
  }));
}

type CampaignRow = {
  accountId: string; campaignId: string; currency: string; campaignName: string;
  spend: Prisma.Decimal; purchaseValue: Prisma.Decimal; purchases: bigint; impressions: bigint; clicks: bigint;
};

/** One row per campaign (and currency) over the range, highest spend first; the name is the latest day's. */
export async function adsCampaigns(scope: Scope, range: DateRange): Promise<AdsCampaignDto[]> {
  const rows = await prisma.$queryRaw<CampaignRow[]>`
    SELECT "accountId", "campaignId", "currency",
           (array_agg("campaignName" ORDER BY "day" DESC))[1] AS "campaignName",
           SUM("spend") AS "spend", SUM("purchaseValue") AS "purchaseValue",
           SUM("purchases") AS "purchases", SUM("impressions") AS "impressions", SUM("clicks") AS "clicks"
    FROM "AdDay"
    WHERE "workspaceId" = ${scope.workspaceId} AND "brandId" = ${scope.brandId} AND "platform" = 'META'
      AND "day" BETWEEN ${dayDate(range.from)}::date AND ${dayDate(range.to)}::date
    GROUP BY "accountId", "campaignId", "currency"
    ORDER BY SUM("spend") DESC, "accountId", "campaignId"`;
  return rows.map((r) => ({
    ...totalsOf(r.currency, D(r.spend), Number(r.purchases), D(r.purchaseValue)),
    accountId: r.accountId,
    campaignId: r.campaignId,
    campaignName: r.campaignName,
    impressions: Number(r.impressions),
    clicks: Number(r.clicks),
  }));
}

export const EXPORT_COLUMNS = [
  { key: "day", label: "Day", width: 12 },
  { key: "account", label: "Account", width: 22 },
  { key: "campaign", label: "Campaign", width: 40 },
  { key: "currency", label: "Currency", width: 10 },
  { key: "spend", label: "Spend", width: 12 },
  { key: "impressions", label: "Impressions", width: 13 },
  { key: "clicks", label: "Clicks", width: 10 },
  { key: "purchases", label: "Purchases", width: 11 },
  { key: "purchaseValue", label: "Purchase value", width: 15 },
  { key: "roas", label: "ROAS", width: 8 },
  { key: "costPerPurchase", label: "Cost per purchase", width: 18 },
];

/**
 * The export: one row per campaign day, numbers as numbers (ROAS to 2 places; empty where it has no divisor).
 * ponytail: built in memory; ~100 campaigns × 366 days is ~37k rows. Stream it if accounts get far bigger.
 */
export async function adsExportRows(scope: Scope, range: DateRange): Promise<Record<string, string | number | null>[]> {
  const rows = await prisma.adDay.findMany({
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId, platform: "META", day: { gte: dayDate(range.from), lte: dayDate(range.to) } },
    orderBy: [{ day: "asc" }, { accountId: "asc" }, { spend: "desc" }, { campaignId: "asc" }],
    select: { day: true, accountId: true, campaignName: true, currency: true, spend: true, impressions: true, clicks: true, purchases: true, purchaseValue: true },
  });
  return rows.map((r) => {
    const t = totalsOf(r.currency, r.spend, r.purchases, r.purchaseValue);
    return {
      day: r.day.toISOString().slice(0, 10),
      account: r.accountId,
      campaign: r.campaignName,
      currency: r.currency,
      spend: r.spend.toNumber(),
      impressions: r.impressions,
      clicks: r.clicks,
      purchases: r.purchases,
      purchaseValue: r.purchaseValue.toNumber(),
      roas: t.roas,
      costPerPurchase: t.costPerPurchase === null ? null : Number(t.costPerPurchase),
    };
  });
}
