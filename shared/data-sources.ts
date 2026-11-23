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

/** PUT data-sources/shopify-orders: turn on the orders sync for one of the brand's Shopify connections. Never a token. */
export type TurnOnShopifyOrdersBody = { connectionId: string };

/**
 * Order totals over a range, excluding test and cancelled orders. Money is a decimal string in the entry's currency
 * (never added across currencies). gross = netSales + discounts; netSales is after discounts, refunds and edits;
 * refunded is display only (already in netSales and total). Unadjusted: VAT is not taken out.
 */
export type SalesTotals = { orders: number; gross: string; discounts: string; netSales: string; total: string; refunded: string };
export type SalesDay = SalesTotals & { day: string };
/** One currency: totals for from..to, the same-length period just before it, and its days that had orders. */
export type SalesCurrency = { currency: string; totals: SalesTotals; previous: SalesTotals; days: SalesDay[] };
/** GET sales/summary?from&to (brand-local "YYYY-MM-DD", inclusive). Needs crm.read. */
export type SalesSummaryDto = { currencies: SalesCurrency[] };
