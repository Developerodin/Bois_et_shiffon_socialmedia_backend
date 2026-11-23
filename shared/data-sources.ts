import type { PermissionKey } from "./permissions";

/** Outside sources of daily numbers (prisma DataSourceKind). */
export const DATA_SOURCE_KINDS = ["SEARCH_CONSOLE", "POST_METRICS", "SHOPIFY_ORDERS", "META_ADS"] as const;
export type DataSourceKind = (typeof DATA_SOURCE_KINDS)[number];
export type DataSourceStatus = "ACTIVE" | "ERROR" | "OFF";

/** How each kind is named in a URL (`data-sources/:kind/sync`). */
export const DATA_SOURCE_SLUGS = {
  SEARCH_CONSOLE: "search-console",
  POST_METRICS: "post-metrics",
  SHOPIFY_ORDERS: "shopify-orders",
  META_ADS: "meta-ads",
} as const satisfies Record<DataSourceKind, string>;
export type DataSourceSlug = (typeof DATA_SOURCE_SLUGS)[DataSourceKind];

/** The key a person needs to see a kind's numbers, its sync state, or press its Sync now. Enforced by the server. */
export const READ_KEY = {
  SEARCH_CONSOLE: "analytics.read",
  POST_METRICS: "analytics.read",
  SHOPIFY_ORDERS: "crm.read",
  META_ADS: "ads.read",
} as const satisfies Record<DataSourceKind, PermissionKey>;

/** Why the last sync didn't fully succeed, as a kind the apps word themselves. */
export type DataSyncReason = "reconnect" | "permission" | "partial" | "failed" | "rate-limited";

/** The only error texts ever stored or returned for a sync: provider text is logged, never shown. */
export const DATA_SYNC_ERRORS: Record<DataSyncReason, string> = {
  reconnect: "The account needs reconnecting. Reconnect it in Connections.",
  permission: "The account didn't grant access to these numbers. Reconnect it and allow access.",
  partial: "Some days are still loading.",
  failed: "The last sync couldn't read the numbers. It tries again tomorrow, or press Sync now.",
  "rate-limited": "The provider asked us to slow down. The next sync picks up where this one stopped.",
};

/** DataSource.lastResult. `okAt`: the last successful sync ("Updated 3 h ago"). */
export type DataSyncResult = { at: string; okAt: string | null; reason: DataSyncReason | null; count: number; error: string | null };

/** GET data-sources: one per source the person may see. `label` only for people who manage integrations. */
export type DataSourceDto = {
  id: string;
  kind: DataSourceKind;
  label?: string | null;
  status: DataSourceStatus;
  lastResult: DataSyncResult | null;
  /** "YYYY-MM-DD", the last provider day held contiguously */
  syncedThrough: string | null;
  /** The zone the provider's days are in (Google: Pacific; Meta Ads: the account's), when it says */
  reportsInZone: string | null;
};

/** Inclusive days, "YYYY-MM-DD". */
export type DateRange = { from: string; to: string };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (s: string) => ISO_DAY.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** `?from&to` as real YYYY-MM-DD days, from ≤ to, at most `maxDays` long (both ends counted); else null. */
export function parseRange(from: string | null | undefined, to: string | null | undefined, maxDays = 90): DateRange | null {
  if (!from || !to || !isDay(from) || !isDay(to) || from > to) return null;
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  return days <= maxDays ? { from, to } : null;
}

/** Ads totals in one currency (never summed across currencies). Money as decimal strings, 2 places. */
export type AdsTotals = {
  currency: string;
  spend: string;
  purchases: number;
  purchaseValue: string;
  /** purchase value ÷ spend, 2 places; null when nothing was spent */
  roas: number | null;
  /** spend ÷ purchases, 2 places; null with no purchases */
  costPerPurchase: string | null;
};

/** GET ads/summary. `budget` stays null until budgets are built (held on the owner's answers). */
export type AdsSummaryDto = { totals: AdsTotals[]; previous: AdsTotals[]; previousRange: DateRange; budget: null };

export type AdsCampaignDto = AdsTotals & { accountId: string; campaignId: string; campaignName: string; impressions: number; clicks: number };
/** GET ads/campaigns, highest spend first. */
export type AdsCampaignsDto = { campaigns: AdsCampaignDto[] };
