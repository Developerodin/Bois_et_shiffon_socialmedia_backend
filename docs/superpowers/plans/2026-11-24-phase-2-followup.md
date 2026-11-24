# Phase 2 follow-up: money settings, Meta system token, story numbers, full order history

> **Review log:** written 2026-11-24 from the owner's answers to the Phase 2 open questions (see "Owner answers (2026-11-24)" in `2026-11-23-phase-2-data.md`). Four-lens plan review done the same day; all Critical and Important findings are folded in below (summary in "Review changes" at the end). Run the four-lens branch review before merge.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ad spend and shop revenue can be compared in one currency, sales show net of VAT, B&C can set monthly Meta and Google ad budgets and see Meta pacing, a Meta Ads connection can run on a token that never expires, Instagram story numbers are kept, and order history goes past 60 days once Shopify allows it.

**Architecture:** Builds on Phase 2 as merged (`DataSource`, the `data.sync` job, `ShopOrder`, `AdDay`, `PostMetric`, the Performance tabs). One new global table of ECB rates filled by a small `fx.sync` job; one new per-brand budget table; new columns on `ShopOrder` and `PostMetric`. Order history reuses the existing `data.sync` backfill chain. Story reads get their own short job type `story.read`, outside the data-job cap, because they must run inside a 4-hour window.

**Tech Stack:** as Phase 2 (Next.js routes, Prisma 6, zod, vitest; web behind `WEB_FEATURES` `sales`/`ads`/`data`; `npm run sync:shared`).

**Estimate:** 8.5 dev days. Calendar waits (B&C's system user, Shopify `read_all_orders` approval, Meta app review for insights) are not counted.

---

## Decisions (owner, 2026-11-24)

1. Who sees Sales and Ads is set in the permission matrix (`crm.read`, `ads.read`). Already true; no work here.
2. Revenue = **net sales without VAT** (after discounts, refunds and edits; no shipping; no VAT).
3. Meta Ads: keep the personal login **and** accept a pasted **System User token**, which takes over when present.
4. Instagram **story numbers are tracked**, read inside their 24 h window.
5. Exchange rates: **ECB daily reference rate, fetched automatically**; each day uses its own rate.
6. Budgets for **Meta and Google from the start**; Google pacing stays empty until Phase 3 brings Google spend.
7. **Order history beyond 60 days** via `read_all_orders`.
8. The Shopify app is built **separately by the owner** (another session). We only consume its token through the existing paste screen; no Shopify app code here.

## My calls (owner may override)

1. **No VAT rate setting.** Shopify's own tax lines give the exact VAT on each order, also for orders taxed at another EU country's rate (OSS), so a typed 20 % is never used. Net ex-VAT = `netSales − itemTaxes` when `taxesIncluded`, else `netSales`. Whether `currentTaxLines` already contains shipping tax is **checked on a live order first** (Task 2 step 1); the formula follows that check.
2. **No reporting-currency setting.** Cross-source figures are shown in the **shop's currency** (the currency of the brand's `ShopOrder` rows in the range; several currencies → no figure, with a note). Budgets carry their own currency, chosen when entered (default: the ad account's currency).
3. **Rate for a day** = the latest ECB rate on or before that day (ECB publishes on TARGET working days only). A rate more than 7 days older than the day it serves is **stale**: still used, the figure labelled "uses a rate from <date>". No rate → figures stay per currency (as today).
4. **Cross rates go through EUR:** `amount_in_Y = amount_in_X / perEur[X] × perEur[Y]` (EUR's `perEur` = 1, never stored). Currencies are limited to one constant list, `ECB_CURRENCIES` (the ECB's ~30 reference currencies), everywhere a currency is accepted or fetched.
5. **System User token wins while it works:** a META_ADS connection whose `tokenExpiresAt` is null holds a system token (the OAuth adapter always sets an expiry; a test pins that). A later personal login leaves such an account alone **unless its META_ADS source is stopped at `permission` or `reconnect`**, in which case the personal login replaces it. Disconnect removes either kind.
6. **Stories:** one read per story at first frame's publish + 20 h (spread ±15 min by attempt id), 4 h before the first frame disappears. Stored in `PostMetric` like posts: views, replies, shares, navigation (taps) and interactions summed across frames; **reach is the highest frame's reach** (people overlap; labelled "highest frame"). Frames posted after the read (Post the rest > 20 h later) and frames confirmed by hand (no media id) get no numbers.
7. **History depth with `read_all_orders`:** 24 months, through the existing backfill chain (30-day windows on Shopify `created_at`, oldest first). Upserts are idempotent, so overlap with the daily `updated_at` sync is harmless.
8. **Budgets** are monthly per platform, one row per brand + platform + month; editing needs `commercial.manage` **and** `ads.read`. Pacing needs `ads.read`. "Shop revenue ÷ ad spend" needs `crm.read` **and** `ads.read`.

## Facts from the code (2026-11-24, checked by the plan review)

- `ShopOrder` (`prisma/schema.prisma`): `netSales` (currentSubtotalPriceSet), `discounts`, `shipping`, `taxes` (sum of `currentTaxLines`), `taxesIncluded`, `total`, `refunded`, `currency`; `createdAt` is **our** insert time, not Shopify's. Index `(brandId, processedAt)` only. Fields come from `ORDER_FIELDS` / `ORDERS_QUERY` in `server/data/shopify-orders.ts` (allow-list, no customer data; `orders(first: 100)`); rows are written by `upsertOrders` in `server/data/shopify-orders-sync.ts` (column list, `jsonb_to_recordset`, `ON CONFLICT … SET`, newer `updatedAt` wins).
- `server/data/shopify-orders-sync.ts`: `FIRST_RUN_DAYS = 60`; cursor = `updated_at` high-water mark in `DataSource.cursor`; 50 pages × 100 orders, `MAX_MS` 180 s per run. `grantedScopes()` in `server/catalog/shopify.ts`.
- `server/data/sources.ts`: `DATA_SYNC_JOB = "data.sync"`; payload zod `mode: z.enum(["daily","manual","backfill"])` (line 131); `SyncMode`; `registerSync(kind, runner)`; `backfillPlan(today, total, windowDays)`, `enqueueBackfill(source, plan)`, `nextBackfillWindow`, `advanceSyncedThrough`; `backfillRunning` matches keys `data:<id>:backfill:` and makes daily/manual runs re-queue behind a backfill (line 254); `spreadSecs(id)`; `enqueueDailyDataSyncs`; `MANUAL_LIMIT`.
- `server/jobs/queue.ts`: `enqueueJob` upserts on `idempotencyKey` with `update: {}` (an existing key returns the old job, whatever its status); `claimNextJob` caps `type LIKE 'data.%'` at `DATA_RUNNING_MAX = 2`, ordered by `runAt`.
- `server/data/sales-read.ts` `salesSummary(scope, range)`, `MAX_SALES_DAYS = 366`; `server/data/ads-read.ts` `totalsOf`, `adsSummary(scope, range)` (gets no permissions today), `adsCampaigns`, `adsExportRows`. Shared DTOs (`SalesSummaryDto`, `AdsTotals`, `PostMetricsDto`, …) live in **`shared/data-sources.ts`**. Mobile has no Performance screens (shared copy only).
- `AdDay` per `(brandId, platform, accountId, campaignId, day)`, index `(brandId, platform, accountId, day)`; `enum AdPlatform { META }`. `DataSource(META_ADS).settings = { currency, timeZone }`.
- Meta Ads: adapter `metaAds` in `server/integrations/providers.ts` uses **`META_APP_ID` / `META_APP_SECRET`** via `providerConfig("META_ADS")` (line 404); `call()` + `form()` for POST bodies; `call()` puts Graph's error text in `ProviderError`, so only the status is logged (as `server/integrations/meta-ads.ts:58` does). Sync errors: 190/102/401 → `markReconnect`; 10, 200–299, 403 → `permission`, connection stays ACTIVE (`server/data/meta-ads.ts:110`, `meta-ads-sync.ts:84`). `accessToken(conn)` returns the token as is when `tokenExpiresAt` is null. `saveConnections(...)` (`server/services/connections.ts:189`) upserts on `(brandId, provider, externalAccountId)` + `integration.connected` audit in one transaction; OAuth path calls it at line ~181. Shopify paste route: `app/api/v1/workspaces/[workspaceId]/brands/[brandId]/integrations/shopify/route.ts`. Rate limit helper: `hitRateLimit(key, limit, windowMs)` (`server/auth/rate-limit.ts`, used in `server/data/search-sync.ts:108`).
- Post metrics: `server/data/post-metrics.ts` (pure client; `classify` maps code 10 → permission) and `server/data/post-metric-sync.ts` (`duePosts` excludes `INSTAGRAM_STORY`). Stories settle PUBLISHED/PARTIAL in `finishStory` (`server/services/publishing.ts:632`) **and** in the lost-job / person-check paths (`publishing.ts` ~868, ~917, ~957). Frames and their media ids are in `target.progress` (`storyTargetOf`); frames confirmed by a person have no media id (`server/stories/publish.ts:29`). `PublicationAttempt` indexes: `(contentItemId, createdAt)`, `(status, runAt)`, `(brandId, status, publishedAt)`.
- `dailySweep()` (`server/jobs/runner.ts:162`) runs once a day, each step in its own try/catch; steps only queue work (no provider calls).

## Global constraints

Same as Phase 2 ("Global constraints" in `2026-11-23-phase-2-data.md`): branch `phase-2-followup` in each repo from `main`, worktrees **outside** `apps/`; migration timestamps after the latest on `main`; prisma migrate only with explicit local URLs; every query scoped `workspaceId AND brandId`; money `Decimal`, never summed across currencies **unless converted by this plan's FX rule and labelled**; tokens only through `accessToken(conn)`, never in URLs, logs, payloads or errors; tagged raw SQL only; en + fr copy (web `messages/*/performance` and connections namespaces); no new pollers; `shared/` edited in server then `npm run sync:shared`, synced copies committed in web and mobile with the same hash; commit messages describe the change only.

## Review focus

1. No figure ever adds two currencies without a conversion, and every converted figure says so (and when the rate is stale).
2. VAT: an order with `taxesIncluded = false` is untouched; shipping tax is never taken off twice or not at all; rows without the new data show no ex-VAT figure rather than a wrong one.
3. A personal Meta login never replaces a working system token (also when both happen at once); a broken system token can be replaced; a token for another app, a user token, an expiring token or one without `ads_read` is refused; the token never reaches a log, error or response.
4. Story reads run inside the 24 h window even when data jobs are busy; a missed one is caught; a story never enters the 30-day post refresh; a story read never puts the POST_METRICS source in ERROR.
5. History backfill and the daily sync: no duplicates, no gap, a capped or failed run never ends the history early.
6. Client reviewer / Viewer: no budget, pacing, revenue ÷ spend or converted figure in any route.

---

## Task 1: ECB rates (1.5 d)

**Files:** Create `server/data/fx.ts` (client, store, `fx.sync` handler, `rateTable`). Modify `prisma/schema.prisma` (+ migration), `server/jobs/runner.ts` (HANDLERS + sweep step `["fx", enqueueFxSync]`), `.env.example` none. Tests `tests/fx.test.ts`, `tests/db/fx.db.test.ts`.

**Data model:**
```prisma
/// ECB euro reference rates: 1 EUR = perEur units of currency on that day (TARGET working days only). Global, not per brand.
model FxRate {
  currency String
  day      DateTime @db.Date
  perEur   Decimal  @db.Decimal(18, 6)
  @@id([currency, day])
}
```

**Interfaces:**
- `ECB_CURRENCIES` constant (shared, for the budget picker too).
- `fetchEcbRates(currency, from, to, fetch?)`: currency must be in `ECB_CURRENCIES`; `GET https://data-api.ecb.europa.eu/service/data/EXR/D.<CUR>.EUR.SP00.A?startPeriod=<from>&endPeriod=<to>&format=csvdata`, `redirect: "error"`, 15 s timeout, response capped at 1 MB; parse `TIME_PERIOD` (must be `YYYY-MM-DD`) and `OBS_VALUE` (finite, > 0, fits Decimal(18,6)), bad rows dropped; **404 = no rows** (window without publications); other non-200 → fixed-text error; body never logged.
- Sweep step `enqueueFxSync` only queues one `fx.sync` job (key `fx:<UTC day>`); no network in the sweep.
- `fx.sync` handler: currencies = non-EUR values from `DataSource(META_ADS).settings.currency`, `AdBudget.currency`, and per brand `SELECT DISTINCT currency FROM "ShopOrder" WHERE brandId = … AND processedAt > now() − 60 days` (index-backed); for each currency: forward from (latest held − 7 days) to today; and **back-fill** when the oldest `AdDay.day` / `ShopOrder.processedAt` for any brand using it (per brand, index-backed `min`) is earlier than the oldest rate held, capped at 3 years; at most one back-fill currency per run (the next run takes the next). `INSERT … ON CONFLICT DO UPDATE`. One currency failing doesn't stop the others.
- `rateTable(currencies, from, to)`: one query from (from − 14 days) to `to`; `convert(amount, fromCur, toCur, day)` → `{ amount, rateDay, stale } | null`; same currency → unchanged.
- Ceiling (comment in code): ~250 rows per currency per year; loaded per request; fine for years × ~30 currencies.

- [ ] Tests: `CSV parsed to rows`; `zero or malformed OBS_VALUE dropped`; `404 → no rows`; `weekend uses Friday's rate`; `INR→EUR→USD cross rate`; `EUR is 1 and never stored`; `stale after 7 days`; `no rate → null`; `currency outside ECB_CURRENCIES never fetched`; `one currency failing still saves the others`; `older AdDay triggers a back-fill once`; db `rerun same window → same rows`.
- [ ] Commit: "Keep the ECB's daily euro rates so ad spend and sales in different currencies can be compared".

## Task 2: Net sales without VAT (1 d)

**Files:** Modify `server/data/shopify-orders.ts` (`ORDER_FIELDS`, row mapping), `server/data/shopify-orders-sync.ts` (`upsertOrders` columns, types, `ON CONFLICT SET`), `prisma/schema.prisma` (+ migration), `server/data/sales-read.ts`, `shared/data-sources.ts` (`SalesSummaryDto`), web `components/performance/sales-tab.tsx`, en/fr. Tests `tests/shopify-orders.test.ts`, `tests/db/sales-read.db.test.ts`, `tests/db/shop-order.db.test.ts`.

- [ ] **Step 1, live check first** (dev store or B&C once the owner's app is in): for one tax-excluded order with taxed shipping, compare `currentTotalPriceSet` with `currentSubtotal + shipping + sum(currentTaxLines)` and record in the code comment whether `currentTaxLines` includes shipping tax. Also log `extensions.cost.requestedQueryCost` for one page of the new query.
- **Fields:** add `shippingLines(first: 3) { nodes { originalPriceSet{shopMoney{amount}} discountedPriceSet{shopMoney{amount}} taxLines { priceSet { shopMoney { amount } } } } }` and `currentShippingPriceSet`. Keep `orders(first: 100)` only if the logged cost stays ≤ 800; otherwise drop the page to 50 (one constant, test on the cost). Never add customer fields (snapshot test on the allow-list).
- **Column:** `ShopOrder.shippingTaxes Decimal? @db.Decimal(14, 2)` = shipping tax lines scaled by current ÷ original shipping price (a refunded shipping charge removes its tax). Null on rows read before this change.
- **Formula** (one `Prisma.sql` constant in `sales-read.ts`): if the live check shows `currentTaxLines` **includes** shipping tax: `netExVat = netSales − (taxes − shippingTaxes)`; if it **excludes** it: `netExVat = netSales − taxes` and `shippingTaxes` is still stored (for `total` checks) but not subtracted. Tax-excluded orders: `netExVat = netSales`.
- **Re-read without touching cursors:** no migration resets `cursor`. After deploy, a one-off script `scripts/reread-shop-orders.ts` queues for each `SHOPIFY_ORDERS` source a backfill of the last 60 days through `enqueueBackfill` (windows on `created_at`, same mechanism as Task 6), spread by `spreadSecs`. Rows Shopify won't return (older than 60 days without `read_all_orders`) keep null.
- `salesSummary` adds per currency `netExVat` and `exVatFrom` (the earliest day from which every tax-included order has `shippingTaxes`); when the range starts before `exVatFrom`, `netExVat` covers only `exVatFrom..to` and the tab says "Excl. VAT from <date>" (one count query, same index).
- Sales tab headline becomes "Net sales (excl. VAT)"; existing figures stay below.

- [ ] Tests: `tax-included order: VAT comes off`; `tax-excluded order untouched`; `shipping tax handled per the live-check rule`; `refunded shipping removes its tax`; `fully refunded order → 0`; `query cost constant under limit`; `no customer field in ORDER_FIELDS`; db `pre-change rows → exVatFrom after them`; db `upsert fills shippingTaxes on re-read`.
- [ ] Commit (server, web, mobile shared): "Show net sales without VAT, using each order's own tax lines".

## Task 3: Budgets, pacing and revenue ÷ spend (2.5 d)

**Files:** `prisma/schema.prisma`: `AdPlatform` += `GOOGLE` in **its own migration** (Postgres `ALTER TYPE … ADD VALUE` can't be used in the same transaction; comment at the enum), `AdBudget` model + `Brand.adBudgets` back-relation. Create `server/data/budgets.ts`, route `.../ads/budgets/route.ts` (GET, PUT). Modify `server/data/ads-read.ts`, `app/.../ads/summary/route.ts` (pass `crm.read`), `shared/data-sources.ts` (`AdBudgetDto`, `PacingDto`, `shopRevenueOverSpend`), web `components/performance/ads-tab.tsx` (budget panel behind `ads`), en/fr. Tests `tests/budgets.test.ts`, `tests/db/budgets.db.test.ts`, `tests/db/ads-read.db.test.ts` (extended).

**Data model:**
```prisma
model AdBudget {
  id              String     @id @default(cuid())
  workspaceId     String
  brandId         String
  platform        AdPlatform
  /// first day of the month
  month           DateTime   @db.Date
  amount          Decimal    @db.Decimal(14, 2)
  currency        String
  updatedByUserId String
  updatedAt       DateTime   @updatedAt
  brand Brand @relation(fields: [brandId, workspaceId], references: [id, workspaceId], onDelete: Cascade)
  @@unique([brandId, platform, month])
}
```
Grep every `AdPlatform` switch/record when adding `GOOGLE`; the Meta Ads sync stays `META` only.

**Interfaces:**
- GET `ads/budgets?month=YYYY-MM` (`ads.read`): budgets for that month + pacing.
- PUT `{ platform, month, amount, currency }`: `authorizeBrandRoute(…, "commercial.manage")` **plus** an explicit `scope.perms.has("ads.read")` check (403 otherwise). zod: `amount` a decimal **string** `^\d{1,12}(\.\d{1,2})?$` (≥ 0); `currency` in `ECB_CURRENCIES` or `EUR`; `month` `YYYY-MM`, from 24 months back to 12 ahead. `amount = 0` deletes. Audit `ads.budget.set` / `ads.budget.cleared` with platform, month, amount, currency. `hitRateLimit` per brand+user (30/h).
- Pacing (META): `through` = the **minimum** `syncedThrough` across the brand's META_ADS sources, clipped to the month; null or before the 1st → "no data yet". Spent = `AdDay` spend from the 1st to `through`, converted to the budget currency (Task 1); `elapsed` = days 1st..`through`; expected = budget × elapsed ÷ days in month; `under` < 90 %, `on` 90–110 %, `over` > 110 %. Missing rate → "no exchange rate yet". GOOGLE → budget shown, "Google Ads spend arrives in Phase 3".
- `adsSummary(scope, range, { crmRead })`: `shopRevenueOverSpend` only when `crmRead` (the route holds `ads.read` already): net ex-VAT (Task 2) ÷ spend converted to the shop currency over the same range; null when spend is 0, the shop has several currencies, `netExVat` doesn't cover the range or a rate is missing; `rateNote` with the oldest stale rate day. Label: "Shop revenue ÷ ad spend (Shopify days and ad account days may differ by a few hours)". Reuse `totalsOf` and the existing Decimal helpers; the converted line is an extra field, never a replacement.

- [ ] Tests: `pacing on/under/over`; `no syncedThrough → no data yet`; `two accounts, one lagging → min used`; `INR spend vs EUR budget converted`; `no rate → no pacing`; `GOOGLE budget, no pacing`; `ratio absent without crm.read` (route test as a role with ads.read only); `client reviewer PUT → 403`; `commercial.manage without ads.read → 403`; `amount "0" deletes + audit cleared`; `amount 1e13 / "0.001" / "ZZZ" → 400`; db `other brand's budget never returned`.
- [ ] Commit (server, web, mobile shared): "Set monthly Meta and Google ad budgets, show Meta pacing and shop revenue per ad spend".

## Task 4: Meta Ads System User token (1 d)

**Files:** Route `app/.../integrations/meta-ads/system-token/route.ts` (POST, same shape as `integrations/shopify/route.ts`), `server/integrations/meta-ads-token.ts`, modify `server/services/connections.ts` (skip rule inside `saveConnections`' transaction for META_ADS OAuth saves), web Connections card (Meta Ads: "Use a system user token", behind `ads`), en/fr, `docs/meta-system-user.md` (steps for B&C's admin). Tests `tests/meta-ads-token.test.ts`, `tests/connections.test.ts` (extended).

**Interfaces:**
- POST `{ token }` (`integrations.manage`): `hitRateLimit("meta-ads:system-token:<brandId>:<userId>", 5, 1 h)` **before** any Meta call; token trimmed, `^[A-Za-z0-9]{20,512}$`. Never logged, echoed or stored unencrypted.
- App id/secret from `providerConfig("META_ADS")`; null → fixed 503. `debug_token` via `call()` with `form()` (POST body: `input_token`, `access_token = <appId>|<secret>`); if Graph refuses POST there, a Graph batch call with the request in the POST body. Log only the status. Require `is_valid`, `app_id` = ours, `type === "SYSTEM_USER"`, `expires_at === 0`, `scopes` ⊇ `ads_read`. Messages: "This token is for another app", "This is a personal token, not a system user token", "This token expires: in Business Manager choose 'Never' when generating it", "This token can't read ads", "This token can't see any ad account".
- `GET /me/adaccounts` (same fields as the OAuth adapter; token in header) → empty → error above; else `saveConnections(META_ADS, accounts, tokenExpiresAt: null, scopes from debug_token, audit metadata { kind: "system_user", replaced: [ids] })`. An account already connected by a personal login is replaced in place; its `DataSource` keeps working; the 7-day warning stops.
- OAuth META_ADS save, **inside the same transaction**: the upsert for an account becomes a conditional write that skips a row with `status = ACTIVE AND tokenExpiresAt IS NULL` unless its META_ADS `DataSource` `lastResult.reason` is `permission` or `reconnect`; skipped accounts are returned and shown "kept the system user token"; audit lists them. An empty result never crashes (`rows[0]`).
- Ceiling (comment): a system token revoked or stripped of the ad account shows as 190 (reconnect) or permission on the next sync; either lets a personal login take over.

- [ ] Tests: `valid system token saves accounts with no expiry`; `other app / user token / expiring / no ads_read / no accounts → refused with its message`; `replaces a personal login in place`; `personal login later keeps a working system token`; `system token stopped at permission → personal login replaces it`; `paste and OAuth at once → system token kept` (db, concurrent); `OAuth adapter always sets an expiry`; `token never in URL, log or response`; `client reviewer → 403`; `rate limit counts failed checks`.
- [ ] Commit (server, web): "Let a Meta ad account run on a pasted system user token that doesn't expire".

## Task 5: Instagram story numbers (2 d)

**Files:** Create `server/data/story-metrics.ts` (job `story.read`: handler, enqueue, sweep step). Modify `server/data/post-metrics.ts` (story metric list + per-frame read, "not enough viewers" handling), `server/services/publishing.ts` (enqueue after every path that settles a story PUBLISHED/PARTIAL: `finishStory`, lost-job, person-check), `server/jobs/runner.ts` (HANDLERS, sweep step), `prisma/schema.prisma` (`PostMetric.replies Int?`, `PostMetric.navigation Int?`; partial index on `PublicationAttempt(publishedAt) WHERE provider = 'INSTAGRAM' AND status IN ('PUBLISHED','PARTIAL')` in raw SQL migration), `server/data/post-metrics-read.ts`, `shared/data-sources.ts`, web `components/performance/posts-tab.tsx` (stories section, behind `data`), en/fr. Tests `tests/story-metrics.test.ts`, `tests/db/story-metrics.db.test.ts`.

**Why its own job type:** `data.%` jobs are capped at 2 runners and ordered by `runAt`, so a story read could wait behind 4-minute syncs and backfills past its window. `story.read` is a few seconds long and outside the cap; it does not touch the POST_METRICS source's `lastResult`, so a story's permission error can't put the source in ERROR.

**Interfaces:**
- Story metrics constant (checked against the current Graph version at build): `reach,views,replies,shares,total_interactions,navigation`; one GET per frame on `graph.instagram.com`, metrics in one call, token in header; at most 20 frames per story. Error 100 on one metric drops it as for posts. A frame already gone → skipped, others saved. Meta's "not enough viewers" refusal (code 10 with that message/subcode) → null numbers, **not** permission.
- Enqueue: `story.read` `{ attemptId }`, key `story:<attemptId>`, `runAt` = first frame's publish + 20 h ± `spreadSecs(attemptId)` mod 15 min. A failed enqueue is logged and left to the sweep.
- Sweep step: Instagram stories published 0–23 h ago (`publishedAt` partial index, join `ContentItem` for the channel) with `NOT EXISTS (SELECT 1 FROM "Job" j WHERE j."idempotencyKey" = 'story:' || a.id)` (exact match on the unique index) → enqueue with `runAt = max(now, first frame + 20 h)`. Older than 24 h never queued. Note: the sweep runs once a day, so it catches only stories within 0–23 h of it; the publish-path enqueues are the primary path.
- Handler: loads the attempt by id **and** its `brandId`/`workspaceId`, `provider = INSTAGRAM`, channel `INSTAGRAM_STORY`, status PUBLISHED/PARTIAL; its connection must be the same brand and ACTIVE; reads frames with a media id from `target.progress`; writes one `PostMetric` row via `upsertMetrics` (sums; reach = max). `duePosts` keeps excluding stories. Missing insights permission → logged with the provider; connection untouched.
- Ceiling (comment): a worker down through the 20–24 h window, or frames posted after the read, leave no numbers; nothing later can recover them.

- [ ] Tests: `queued at first frame + 20 h within spread`; `queued from finishStory, lost-job and person-check paths`; `sums frames, reach is max`; `frame without media id skipped`; `expired frame skipped, others saved`; `not enough viewers → nulls, not permission`; `sweep queues a missed story once`; `story older than 24 h never queued`; `story never in duePosts`; `story.read not counted in the data cap`; `token never in URL or log`; db `other brand's attempt id → no-op`.
- [ ] Commit (server, web, mobile shared): "Read Instagram story views, reach, replies and taps before the story disappears".

## Task 6: Order history past 60 days (0.5 d)

**Files:** Modify `server/data/shopify-orders.ts` (query by `created_at` window), `server/data/shopify-orders-sync.ts` (backfill branch on `ctx.window`; history check in the daily run), `server/catalog/shopify.ts` (`SHOPIFY_HISTORY_SCOPE = "read_all_orders"`), web Sales tab note, en/fr. Tests `tests/shopify-orders.test.ts`, `tests/db/shop-order.db.test.ts` (extended).

**Interfaces (reuse the existing backfill chain, no new mode or key):**
- Daily run: once a day (it already reads `grantedScopes` on turn-on; cache the result in `settings.scopesCheckedAt` + `settings.allOrders`), if `read_all_orders` is granted and `settings.backfill` is unset, save `settings.backfill = backfillPlan(today, 730, 30)` (merged into `settings`, not replacing it) and call `enqueueBackfill`.
- Backfill run (`ctx.window` set): query `created_at:>='<from>T00:00:00Z' AND created_at:<'<to+1>T00:00:00Z'` (bounds formatted by the server from the validated window), sort `CREATED_AT`, same allow-listed fields, upsert as today. The window counts as complete only when the last page has `hasNextPage = false` and the run has no stop reason (time cap, rate limit, abort); otherwise `advanceSyncedThrough(…, complete=false)` keeps it and the chain retries it, as for Search Console. The daily `updated_at` cursor is untouched by backfill runs.
- Daily/manual runs already re-queue behind a running backfill (`backfillRunning`). Same mechanism serves Task 2's one-off re-read.
- No `read_all_orders` → nothing changes (60 days). Sales tab: "Orders from <date> on" while the backfill hasn't reached its start.
- Ceiling (comment): 5,000 orders per run; a busy shop's two years take several chained runs.

- [ ] Tests: `backfill planned only with read_all_orders`; `window incomplete when capped or rate limited`; `walks to 24 months and stops`; `restart continues from syncedThrough`; `daily waits behind running backfill`; db `order seen by both syncs → one row`.
- [ ] Commit: "Load up to two years of Shopify orders once the store allows reading all orders".

## Build order

1 → 2 → 3 (needs 1 and 2); 6 before Task 2's re-read script runs (the script uses Task 6's created_at backfill branch), so build order is **1, 6, 2, 3, 4, 5**; 4 and 5 are independent. `npm run sync:shared` after each task that changes `shared/data-sources.ts` (2, 3, 5), committing web and mobile copies. Browser check per task with the `sma_p2_browser` seed extended (an INR ad account + EUR shop, a budget, a story attempt).

## Verification

- [ ] All Phase 2 checks green in the three repos; `npm run test:db` on `sma-testdb`.
- [ ] Live: one ECB fetch for INR in dev prints row counts only; Task 2 step 1 live check recorded.
- [ ] Browser: Sales headline ex-VAT; Ads tab budget editing (as owner), pacing, ratio; as viewer no budget/ratio and PUT 403; Connections system-token form refuses a personal token.
- [ ] Update `docs/HANDOVER.md` with what's done, what's live-checked and what waits.
- [ ] Four-lens branch review before merge.

## Waiting on others (calendar time)

- B&C: a Meta System User in their Business Manager with our app and their ad account assigned, token with `ads_read`, expiry "Never" (steps in `docs/meta-system-user.md`). Note: the token adds every ad account the system user can see; only the picker chooses which one syncs.
- Owner's separate Shopify app: `read_orders` + `read_all_orders` (Shopify approval), non-expiring Admin token.
- Meta app review for `instagram_business_manage_insights` (stories and posts alike).

## Review changes (2026-11-24 four-lens plan review)

- **Correctness:** history reuses the backfill chain (a capped run no longer ends history; no stuck idempotency key; Shopify `created_at` used, not our row time); story jobs wired as their own type and queued from every settle path; sweep 0–23 h; "not enough viewers" isn't a permission error; `upsertOrders` in Task 2's files; live check on shipping tax before the formula; shipping refunds scale shipping tax; pacing uses the min `syncedThrough`, null = no data; FX back-fills older days; budget `amount ≥ 0`.
- **Security:** skip rule inside the transaction and lifted when the system token stopped working; real env names via `providerConfig("META_ADS")`, status-only logging, POST body for `debug_token`; budget amount as a bounded decimal string, currencies limited to `ECB_CURRENCIES`, month bounded both ways, explicit second permission, audit on clear; `adsSummary` gets `crmRead` from the route; token charset and rate limit before Meta calls; scopes from `debug_token`; ECB response validated.
- **Performance:** query cost checked and page size tied to it; `story.read` outside the 2-runner data cap, spread ±15 min; exact-key `NOT EXISTS` and a partial index for the story sweep; currencies found per brand through existing indexes; no all-shops cursor reset; one FX back-fill currency per run; ≤ 20 frames.
- **Maintainability:** DTOs in `shared/data-sources.ts`, mobile shared copy only; Task 4 route next to the Shopify paste route; `hitRateLimit` reused; FX work in a job, not in the sweep; one `Prisma.sql` for the ex-VAT expression; Task 3 re-estimated to 2.5 d, Task 5 to 2 d, Task 6 down to 0.5 d (8.5 d total).
