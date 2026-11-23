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

// ---- Search Console ----------------------------------------------------------------------------------------------

/** Google reports Search Console days in Pacific time; SearchDay keeps them as Google's days. */
export const SEARCH_CONSOLE_ZONE = "America/Los_Angeles";
/** The longest from..to a search read accepts, in days. */
export const SEARCH_RANGE_MAX_DAYS = 90;

/** GET google/sites?connectionId: the Google account's verified sites, and the brand's chosen one. */
export type SearchSiteDto = { siteUrl: string; permissionLevel: string };
export type SearchSitesDto = { sites: SearchSiteDto[]; chosen: string | null };
/** PUT data-sources/search-console */
export type ChooseSearchSiteBody = { connectionId: string; siteUrl: string };

/** ctr = clicks / impressions; position = impression-weighted average. Both null with no impressions. */
export type SearchMetrics = { clicks: number; impressions: number; ctr: number | null; position: number | null };
export type SearchDayRow = SearchMetrics & { day: string };
export type SearchPageRow = SearchMetrics & { page: string };

export const SEARCH_PAGE_SORTS = ["clicks", "impressions"] as const;
export type SearchPageSort = (typeof SEARCH_PAGE_SORTS)[number];
export const SEARCH_PAGES_LIMIT = 50;

/**
 * GET search/summary?from&to (inclusive "YYYY-MM-DD", Google's days). `siteUrl` null: no site chosen yet (all zero).
 * `previous`: the equal-length range just before. `days`: the SITE rows held in the range (a day not synced yet is
 * missing).
 */
export type SearchSummaryDto = {
  siteUrl: string | null;
  daysIn: typeof SEARCH_CONSOLE_ZONE;
  range: { from: string; to: string };
  previousRange: { from: string; to: string };
  totals: SearchMetrics;
  previous: SearchMetrics;
  days: SearchDayRow[];
};

/**
 * GET search/pages?from&to&sort=clicks|impressions&cursor: pages summed over the range, SEARCH_PAGES_LIMIT at a time.
 * Built from each day's top pages, so their sums sit below the site total; say so on screen. `nextCursor` is opaque
 * and only valid with the same sort.
 */
export type SearchPagesDto = { pages: SearchPageRow[]; nextCursor: string | null };

/** GET data-sources. `timeZone`: the brand's zone (dates we bucket ourselves); a provider's own is `reportsInZone`. */
export type DataSourcesDto = { sources: DataSourceDto[]; timeZone: string };
