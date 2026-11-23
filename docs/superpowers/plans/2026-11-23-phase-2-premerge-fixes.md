# Phase 2 pre-merge review fixes (2026-11-23)

Server branch `p2-wire` (C:/Users/INTEL/Desktop/sma-p2-wire). Web branch `phase-2-data` (C:/Users/INTEL/Desktop/sma-web-p2).
NEVER edit these migrations (already applied to the dev DB): 20261125090000_crm_ads_read, 20261125100000_data_sources,
20261125110000_meta_ads_provider, 20261125123000_ad_day. Others (search_day, shop_order, post_metric) may still change.
NEVER run `prisma migrate deploy|dev|reset` yourself; use only `TEST_DATABASE_URL=postgresql://postgres:test@localhost:55432/<own db> npm run test:db` (it is guarded).

## Server — performance
S1. Shopify: client MAX_MS ~180 s (below the 240 s job deadline); when the signal aborts, return `capped` with the orders read so far instead of throwing (prefix sorted by UPDATED_AT is safe).
S2. post-metric-sync dueSql: add `AND a."publishedAt" > now - interval '30 days'` as an index bound (keep the CASE).
S3. pruneFinal: limit to attempts that crossed day 30 recently (`publishedAt >= now - 40 days`); drop `PostMetric_brandId_idx` if nothing else needs it (post_metric migration may change).
S4. Post metrics: pass ctx.signal into readPostMetrics, check between calls, time cap below the deadline → `capped`, write what was read; Instagram/Threads cap ~200 per run.
S5. SearchDay reads: drop the `workspaceId` filter from read queries (brand already scoped by the route) so the INCLUDE index is index-only; or add workspaceId to INCLUDE (search_day migration may change).
S6. searchSummary: totals computed in JS from `days`; previous period in one aggregate; resolve the chosen site once.

## Server — security
S7. GET connections: without integrations.manage, filter out META_ADS and SHOPIFY rows (names/domains are manage-only). Route test as Approver.
S8. searchSummary: return `siteUrl` only with integrations.manage; else `hasSite: boolean`.
S9. OAuth callback: for META_ADS redirect with a count ("Meta Ads (N accounts)"), not every account name.
S10. Shopify orders turn-on PUT: `hitRateLimit(shopify-orders:turn-on:<brand>:<user>, 10, 60_000)` → 429.
S11. (optional) Meta Ads code exchange as POST with URLSearchParams body.

## Server — maintainability
S12. Delete merge adapters: search-sync toStop/readWindow, post-metric-sync stopOf/read, shopify-orders-sync readOrders; call clients directly, read `.stoppedReason`. Remove stale "at merge"/"another branch" comments.
S13. One stop type: clients use SyncStop (or `Exclude<SyncStop,…>`) from ./sync-stop; drop the re-export from sources.ts; meta-ads.ts derives from SyncStop.
S14. One reason vocabulary: rename DataSyncReason "rate-limited" → "rate_limited" (DATA_SYNC_ERRORS, web copy). post-metric-sync outcomeReason: pick the worst stop and pass through stopReason, no second map.
S15. Error text: delete search-console.ts MESSAGES (dead); fold route problem mappers into one `syncProblem(error)` next to fromAccessError if simple.
S16. One `parseDayRange(params, maxDays)` + one badRange problem (400) + `previousRange` in sources.ts; used by search, sales, insights, ads routes (rejects 2026-02-30). Merge with the ads `parseRange` in shared/data-sources.ts (keep one).
S17. One `brandTimeZone(scope)`; pass the zone as a parameter into the sales and insights raw SQL (drop the COALESCE blocks); post-metric-sync uses it too.
S18. One provider-zone settings key (`reportsIn`) written by Search and Meta, read once.
S19. Delete `refreshDue` (dead) and echo tests (DECAY toEqual, READ_KEY equals itself).
S20. Remove NOT_BUILT; runSync throws on an unregistered kind; update the sources.ts module doc example.
S21. Move Meta's pick to `PUT data-sources/meta-ads` (keep GET meta-ads/accounts for listing); all three picks (search-console, shopify-orders, meta-ads) return `{ source: DataSourceDto }` with 200.

## Web — after `npm run sync:shared` brings shared/data-sources.ts
W1. Delete hand-copied DTOs (lib/data-api.ts, posts-tab.tsx, ads-tab.tsx) and KIND_SLUG / MAX_DAYS; import from @/shared (DATA_SOURCE_SLUGS, SEARCH_RANGE_MAX_DAYS, the DTOs).
W2. ctr/position may be null → show "—" (pct(null) currently shows 0.0%).
W3. Render `source.lastResult.error` from the server; delete REASON_TEXT. "rate-limited" → "rate_limited" if referenced.
W4. Posts and Ads tabs get their source from PerformanceTabs (no second data-sources fetch); one rangeQuery everywhere; one `money` in components/data/shared.tsx.
W5. Focus reload: skip if loaded in the last 60 s.
W6. Search site picker: load sites only when "Choose site" is pressed (don't call Google on every tab switch).
W7. Posts table: first 50 rows + "Show more".
W8. Meta pick: PUT data-sources/meta-ads; read `{ source }` responses for all three picks; site picker reads `hasSite` when siteUrl is absent.
W9. Ad account picker: match the account by connection, not by name (if GET meta-ads/accounts can return the connection's account id, use it).
