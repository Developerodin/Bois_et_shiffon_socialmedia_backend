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

/** ContentItem.channel (prisma ContentChannel). */
export type PostChannel =
  | "INSTAGRAM_POST" | "INSTAGRAM_CAROUSEL" | "INSTAGRAM_REEL" | "INSTAGRAM_STORY" | "FACEBOOK_POST" | "PINTEREST_PIN"
  | "THREADS_POST" | "LINKEDIN_POST" | "X_POST";

/** A post's numbers from its latest read; null where the platform gives none (show "—", not 0). */
export type PostMetricsDto = {
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  interactions: number | null;
};

/** GET insights/posts?from&to (analytics.read): one per Instagram, Facebook or Threads post published in the range. */
export type PostInsightDto = {
  attemptId: string;
  contentItemId: string;
  title: string | null;
  channel: PostChannel;
  /** ISO instant */
  publishedAt: string;
  /** null until the first read */
  metrics: PostMetricsDto | null;
  /** ISO instant of the latest read ("Updated 3 h ago"), or null */
  readAt: string | null;
  /** Past day 30: these numbers are the last read and won't change */
  final: boolean;
};
export type PostInsightsDto = { posts: PostInsightDto[] };
