# Phase 2 plan — four-lens review decisions (2026-11-23)

Apply these to `2026-11-23-phase-2-data.md`. They override the plan where they differ.

## Simplify (maintainability)
- No `lock.ts` / `syncLockedUntil`: idempotency key + delete-then-insert per day in one transaction. Fold `days.ts`/`mock.ts` into `sources.ts` or the first client that needs them.
- `DataSource`: keep, but status fields collapse to `status` + one `lastResult` JSON `{at, reason, count, error}` (like `BrandProfile.catalogSync`); `lastError` text only from fixed strings keyed by reason, never provider text.
- One job type `data.sync` with `{dataSourceId}` payload and a switch on kind. Manual "Sync now" reuses the catalogue's check-then-create (`requestCatalogSync`) plus a per-brand+user rate limit (3/h per source, skipped if synced under 5 min ago). Backfill = the same job on a resumable window (`syncedThrough`), one job at a time (chain the next window when one finishes) — no parallel chunk jobs.
- Flags: three at most — `data` (Search, Social, Report), `sales`, `ads`.
- Mock: no app-wide `DATA_SOURCES_MOCK`. Client tests inject a `fetch` stub with tiny inline fixtures (header `// recorded <date>, API vX`). If a dev walkthrough needs sample data later, add a flag then; it must throw at boot in production and mark DTOs "Sample data".
- Search Console v1: SITE and PAGE only (QUERY when someone asks). SITE from one windowed call with `dimensions:["date"]`. Top 500 pages/day. Drop `keyHash` (cap page key length) and the 16-month prune (note the ceiling). Declining pages deferred.
- Web: tabs on the existing `/performance` page instead of five new pages. Print = `@media print` on those pages, reusing the read functions; no separate `reports/summary` DTO.
- Task 8/11 money settings (FX, VAT, revenue basis, budgets) HELD until owner answers questions 2, 5, 6. When built: Meta only, one `fxRate` on settings, no `AdPlatform.GOOGLE`.
- Meta Ads (Tasks 9–11): build on fixtures only after the core ships; go-live depends on Meta Advanced access (weeks). Say "23 days = build on fixtures; approvals are calendar time not counted".
- Split Task 1 into 1a (permissions `crm.read`/`ads.read` + `SYSTEM_ROLES` + role migration) and 1b (`DataSource` + sweep). Publisher `post_id` fix is its own small commit before Task 4; skip back-resolving old Facebook photo posts.

## Security
- Server, not UI, enforces keys: report/summary data computes sales parts only with `crm.read`, ads parts only with `ads.read`, cross-source ROAS needs both, FX/VAT only with either. `GET reporting` needs `ads.read` or `crm.read`. Route tests as client-reviewer and viewer assert no sales/ads fields in JSON.
- `GET data-sources`: rows filtered by each kind's read key; `label` (shop domain, ad account name) only for `integrations.manage`.
- Role migration matches `isSystem` + slug per workspace and `SYSTEM_ROLES` changes too; test fresh-seeded and migrated workspaces give manager the same keys; client-reviewer and viewer get neither.
- Pickers (`google/sites`, `meta-ads/accounts`, their PUTs): connection loaded by `{id, brandId, workspaceId, provider}`, 404 otherwise; `siteUrl` / account id must be in the live list; rate limit per brand+user. Test a cross-brand `connectionId`.
- Job handler re-reads `DataSource` by id with brand/workspace/kind, loads the connection via `dataSource.connectionId`, asserts same brand; switched-off or deleted source = no-op. On disconnect: keep rows, stop syncing (state it); purge on brand delete via cascade.
- Every new model gets the composite `@relation(fields:[brandId, workspaceId]) onDelete: Cascade` like `DataSource`.
- `META_ADS`: grep every `IntegrationProvider` switch / `Record<IntegrationProvider,…>`; exclude from `PUBLISHERS`, publish targets and insights jobs; test publishing can't pick it. OAuth callback checks stored provider = callback slug (test META state can't complete as META_ADS). Token-until-expiry behaviour is an adapter flag (`noRefresh: true`) on META_ADS only; other adapters unchanged (test). Build Graph pages from the `after` cursor, never follow `paging.next`; never log URLs; "token never in payload/log" test for Graph, Search Console and Shopify.
- Shopify: query field list is an allow-list constant, test it contains none of customer/email/shippingAddress/billingAddress/phone/lineItems. The turn-on PUT never accepts a token in the body. `:kind` zod enum, unknown → 404.
- Exports: numbers stay numbers (negatives); xlsx test that `=HYPERLINK(...)` is a string cell; filename only from validated `YYYY-MM-DD`.
- Print view: same route check, `Cache-Control: private, no-store`, no `dangerouslySetInnerHTML`; viewer/client-reviewer test.

## Performance
- SearchDay: delete per `(brandId, siteUrl, dimension, day)`; no index that is a prefix of the unique key; index `INCLUDE (clicks, impressions, positionSum)`. State volume: ~500 rows/brand/day, ceiling and rollup path noted.
- Queue: data jobs must not starve publishing — `claimNextJob` skips `data.%` when 2 are already RUNNING (or orders them after publishing). Spread runAt by its own hash mod 120 min, offset per source.
- Sweep: `enqueueDailyDataSyncs` = one `findMany` of active sources, enqueue only, no provider calls; in the try/catch group; test ordering and failure isolation, and that catalogue sync behaves the same.
- Post metrics: Graph batch (≤50 per call); refresh decays (daily to day 7, every 3 days to day 14, weekly to day 30); oldest `readAt` first; group by connection. Index `PublicationAttempt @@index([brandId, status, publishedAt])`. Latest snapshot via LATERAL … LIMIT 1. After day 30 keep only the final row.
- Search reads: cap range to 90 days; compute any heavy aggregate once per sync, not per request.
- Shopify: one `INSERT … ON CONFLICT DO UPDATE` per page (unnest); summary filters by instant bounds from brand-local from/to, buckets with `AT TIME ZONE`.
- Meta Ads: range delete per chunk `WHERE brandId, platform, accountId AND day BETWEEN` with index `(brandId, platform, accountId, day)`; 7-day chunks, `limit=500`; on "reduce the amount of data" halve the chunk.
- Migration timestamps must sort after the latest on main (check at build time).

## Correctness
- Day bucketing on Prisma `timestamp(3)` (UTC, no zone): `(("col" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(bp."timeZone",'UTC'))::date`. db test at 23:30 UTC / Paris on a real column.
- Shopify money: request `currentSubtotalPriceSet` (after discounts, refunds, edits) = net sales; gross = subtotal + discounts; order total = `currentTotalPriceSet`; refunds stored for display only. VAT removal respects `taxesIncluded` and uses line tax, not `totalTaxSet`. Fixture test: one refunded + one discounted order, hand-computed totals.
- Lock no-ops: moot (no lock, one job at a time per source). A daily job that finds a running backfill for the same source re-queues itself `runAt + 5 min` rather than completing.
- `syncedThrough`: null = daily covers today−3..today−1 only. Backfill walks windows oldest first in order and advances `syncedThrough` only contiguously; set to the backfill end when done.
- Partial pages: buffer the whole window before writing. Write a day only when every query/page for it succeeded; on a mid-pagination stop write nothing and keep `syncedThrough`.
- Keys that must re-run carry a generation: backfill keys include `DataSource.updatedAt` epoch (like Shopify's `connect:<updatedAt>`). Daily key unchanged.
- Pacing (when built): elapsed = days from the 1st to `syncedThrough`; "no data yet" at 0; test with a lagging `syncedThrough`.
- FX (when built): stale rate used and labelled; separate currencies only when no rate at all; a day's spend uses its own month in the account's zone.
- Build order: Task 8 before 7, or 7 returns unadjusted totals and VAT lands in 8. Each `Brand` back-relation is added in the task that creates its model (Task 1 must pass `prisma validate`).
- `refreshExpiringTokens` gets a META_ADS 7-day reconnect warning step, or drop that message. Expired 60-day token → 190 → `lastReason = "reconnect"` is expected; say so.
- Meta insights: name the attribution key read (match Ads Manager default) in one constant + footnote; request `account_currency` and `timezone_name` and assert currency per request.
- `DataSource` unique: `@@unique([brandId, kind, externalId])` with `externalId` non-null except POST_METRICS (use '' there), so several ad accounts per brand work.
- Search totals: page sums are below the site total (top-N cap); label it on screen.
