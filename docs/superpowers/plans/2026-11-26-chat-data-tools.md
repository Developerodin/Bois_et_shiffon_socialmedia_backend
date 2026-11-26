# Chat tools for ads, posts and Search Console; ads alerts

> **Status:** plan, written 2026-11-26 against server, web and mobile `main` (server 1d0d49e, web 6dbb586, mobile 24cdb53; all three include `merged-review-fixes`). Run the four-lens branch review (correctness, security, performance, maintainability) before merge.

> **Review log:** 2026-11-26 four-lens plan review folded in (see "Review changes" at the end): owner answers applied to the body (D−3 for the conversion rules), web-search ask narrowed to explicit requests, a 12-call total cap, one recipient rule for the bell, brand-scoped alert keys, digest alerts by when they were raised. Estimate 6.5 → 8 d.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

---

**Goal:** The CMO chat can answer questions about Meta Ads (spend, impressions, clicks, purchases, ROAS by day or campaign, budgets and pacing, and shop revenue ÷ ad spend), post performance (posts and stories) and Search Console (site totals and top pages). Each answer is gated by the same key as its Performance tab, and saved chats are redacted for people who lose that key. Meta Ads problems are spotted after each daily sync: a spend jump, a ROAS drop, a campaign spending without purchases, or a budget running over pace. They reach the bell, the Monday digest and the chat.

**Architecture:** Feature 1 adds six read-only tools to `server/chat/tools.ts`. They read through the existing readers (`ads-read.ts`, `budgets.ts`, `post-metrics-read.ts`, `search-read.ts`) plus one small new `adsDays` query and one shared `liveSources` lookup. One permission map in `server/chat/turn.ts`, `CHAT_DATA_TOOLS` (tool → keys needed, call group), replaces the sales-only sets. Gating, call caps (per group and in total), the web-search lock and saved-chat redaction (`hideOutputs`, which replaces `hideSalesOutputs`) all read from it.

Feature 2 adds one table, `AdAlert`, and one short job type, `ads.alerts`. META_ADS registers an additive `afterRun` hook on `registerSync`, and the hook queues that job after a complete daily or manual run whose `syncedThrough` reached the end of its own window (account-local yesterday). The job evaluates four rules for that ad account: pure functions over `AdDay` rows plus `listBudgets` pacing. Spend and pacing use yesterday; ROAS and zero-purchase use the day 3 back. It inserts alerts with `ON CONFLICT DO NOTHING RETURNING`, and in the same transaction it writes one `AD_ALERT` notification per recipient (brand.read **and** ads.read, computed once per job) for each inserted alert. The bell's read queries gain a second visibility branch that checks the same rule at read time from the same role-and-grants load. The digest's ads section gains an optional `alerts` list (alerts raised during the digest week). The chat's `adsSummary` tool returns recent alerts.

**Tech stack:** As today: Next.js routes, Prisma 6, zod, vitest, the AI SDK `tool()`, and `npm run sync:shared`.

**Estimate:** **8 dev days.** Feature 1 is 3 d (Tasks 1–4) and Feature 2 is 5 d (Tasks 5–8). The handover's "~30–45 min" for the chat tools predates the redaction map, the call caps, the ratio's second key and the tests; it was a guess, not an estimate. The review added 1.5 d: the narrowed search ask and the total cap (T1), the shared source lookup (T2), the shifted conversion day and brand-scoped keys (T5), and the shared recipient rule across `hasOtherHolder`, the bell SQL and the digest loader (T6).

---

## Decisions

**Owner (2026-11-26):**
1. Alerts go to all three places: the bell, the Monday digest and the chat.
2. Thresholds are the sensible defaults below, fixed in code as named constants (no settings screen).

**My calls (the owner may override):**

3. **Six chat tools, not more.** Each tool definition is resent with every turn, which costs prompt tokens. The tools are `adsSummary`, `adCampaigns`, `adBudgets`, `revenuePerAdSpend` (see call 4), `postPerformance` and `searchPerformance`. Budgets and pacing are their own tool because they are asked per month, not per range.

4. **Shop revenue ÷ ad spend is its own tool, `revenuePerAdSpend`, needing `ads.read` and `crm.read`.** It is not a field on `adsSummary`. The ratio × spend gives revenue, so it is a sales figure. As its own tool, the redaction map stays one entry per tool (a list of keys, all needed). A field-level rule would need a second kind of redaction.

5. **Google Business Profile: deferred, with no tool** (owner answer 4). The reasons:
   - Google hasn't approved API access, and the quota is 0.
   - Its routes are gated by `inbox.read`, not a Performance key.
   - Reviews carry customer names and free text, which is personal data and a prompt-injection path.
   - A tool that always answers "not available yet" still costs tokens on every turn.

   Instead, the prompt gets one line saying Business Profile isn't readable from chat yet and lives in the mobile app. Revisit once Google approves access, as its own small task: `businessReviews` is already cached for 45 s and capped at 30 reads a minute per brand.

6. **Web search lock** (owner answer 4).
   - `revenuePerAdSpend` joins the strict set with the sales tools: once its output is in the conversation, web search is off even when asked for.
   - `adsSummary`, `adCampaigns`, `adBudgets`, `postPerformance` and `searchPerformance` join the catalogue-like set: web search is off unless the person's own message **explicitly asks to search the web**. Their text includes campaign names, post titles and page URLs typed by people.
   - **"Explicitly asks" is a fixed list of phrases** (`askedToSearch`, Task 1): "search the web / the internet / online", "web search", "look it up online", "look online", "google it / that", and in French "recherche(r) / cherche(r) sur le web / sur internet / en ligne", "recherche web". Words that merely name the data never count: "Google Ads", "Google search", "Search Console", "search results", "search terms", "online sales", "web shop". Today's rule (any of web, online, google…, search…, recherch…) matches exactly the turns that use the new tools, so planted text in a campaign name or URL could steer a search that carries figures out.
   - **Behaviour change:** the narrower ask applies to catalogue turns too (one rule). "Peux-tu rechercher les prix ?" no longer turns web search back on after product data; "recherche les prix sur internet" does.
   - The prompt also says: never put sales, revenue, ad or performance figures into a web search, even when asked (search for the benchmark, not with the numbers).
   - Ads figures are less sensitive than sales, and benchmarking ("is my CTR normal?") needs search.

7. **Call caps per group and in total.** Groups are `sales` (the five sales tools plus `revenuePerAdSpend`), `ads` and `analytics`, each at most 8 calls per message (`MAX_GROUP_CALLS = 8`, today's `MAX_SALES_CALLS`). On top, **at most 12 data-tool calls per message in all** (`MAX_DATA_CALLS = 12`): three full groups would be 24 calls and ~60k tokens, and every output is saved in the thread and resent with the next turns (within the 40-message window). A full sales report (4–5 calls) plus an ads check (2–3) fits well inside 12. `isStepCount(6)` still bounds a turn. Both caps are enforced in `gate` (counts, so parallel calls inside one step are limited) and in `activeTools` (switches tools off for later steps).

8. **Default ranges end at the data's last complete day, not today.**
   - Ads: the minimum `syncedThrough` across the brand's non-OFF META_ADS sources (`liveSources`, Task 2), 30 days back.
   - Search: the SEARCH_CONSOLE source's `syncedThrough`, 28 days back. Google lags 2–3 days; this follows the digest's `seoSection` precedent.
   - Posts: the last 30 brand-local days, since posts are read up to now.

   Ending at today would show the unsynced days as a false drop.

9. **Chat ads figures leave out switched-off ad accounts**, as pacing (`convertedSpend`) and `revenuePerAdSpend` already do, so the chat never contradicts itself. The Ads tab's `totals()` and `adsCampaigns` are unchanged and still count an OFF account's kept rows; the chat tools say "Switched-off ad accounts are left out." when the brand has one.

10. **Alerts are stored, in an `AdAlert` table.** Computing them on the fly was rejected:
    - The sync re-reads the last 7 days every day, so a computed alert could appear and then vanish.
    - The digest needs a stable list for the week.
    - A notification needs something to point at.
    - `Notification.dedupeKey` is pruned after 90 days, so it can't be the dedupe record.
    - The table is small: a few rows per brand per month.

11. **Alerts are evaluated per ad account, after its own sync.** Each META_ADS source has its own currency, time zone and `syncedThrough`, and runs as its own job. Over-pace is brand-wide; each account's job checks it and one unique key dedupes it.

12. **Alerts run in their own job, `ads.alerts`, not inline in the sync.**
    - The job key `ads-alerts:<sourceId>:<day>` makes the daily run and Sync now evaluate a day once.
    - A failed evaluation retries (`maxAttempts: 3`) without failing or re-running the sync.
    - It isn't `data.%`, so it stays outside the 2-runner data cap. It is DB-only and takes milliseconds.

13. **The chat sees alerts through a tool, not prompt context.** The system prompt is the cached prefix (`server/chat/prompt.ts`, see `pageNote`'s comment). Per-brand alert text there would miss OpenAI's prompt cache on every change. `adsSummary` returns `alerts`, and the prompt tells the model to mention open ones.

### Alert rules (constants in `server/ads/alerts.ts`)

**The two days** (owner answer 2). Let S be the account's `syncedThrough` after its run; the job runs only when S is account-local yesterday (`settings.reportsIn`), i.e. the end of the daily window it just read.
- **D_spend = S** (yesterday): `SPEND_UP` and `OVER_PACE`.
- **D_conv = S − 3** (`CONV_LAG_DAYS = 3`): `ROAS_DOWN` and `NO_PURCHASES`. Purchases attribute late (Meta keeps attributing for 7 days, `ATTRIBUTION_DAYS`), so the day 3 back is far more complete than yesterday.
- Each rule's baseline is the 7 account days before its own day: D_spend−7..D_spend−1 for `SPEND_UP`, D_conv−7..D_conv−1 for `ROAS_DOWN`.

| Kind | Day | Rule | Constants |
|---|---|---|---|
| `SPEND_UP` | D_spend | The account's spend on D_spend is at least 1.5 × the baseline average, **and** D_spend's spend minus that average is at least €20 (owner answer 1: the floor is on the increase). €20 is converted into the account currency at D_spend's ECB rate (`rateTable`). No check when the rate is missing (logged), never a guess. | `SPEND_UP_RATIO = 1.5`, `SPEND_UP_MIN_EUR = 20` |
| `ROAS_DOWN` | D_conv | The account's ROAS on D_conv is at most 0.7 × the baseline ROAS (baseline purchase value ÷ baseline spend). It needs D_conv's purchases ≥ 5 **and** the baseline's ≥ 20, and D_conv's spend ≥ €20 (converted at D_conv's rate). | `ROAS_DOWN_RATIO = 0.7`, `ROAS_MIN_PURCHASES_DAY = 5`, `ROAS_MIN_PURCHASES_BASE = 20` |
| `NO_PURCHASES` | D_conv | A campaign with spend > 0 and 0 purchases on each of D_conv−2, D_conv−1 and D_conv. Its 3-day spend must be ≥ €20 (converted at D_conv's rate), **and** it must have had ≥ 1 purchase in the 28 days before D_conv−2 (D_conv−30..D_conv−3). | `NO_PURCHASE_DAYS = 3`, `NO_PURCHASE_LOOKBACK = 28` |
| `OVER_PACE` | `pacing.through` | The brand's META pacing from `listBudgets(scope, month of D_spend)` is `state: "ok"` with `status: "over"` (the existing ratio > 1.1 rule in `budgets.ts`; no copy of the threshold), and `through` is at least the 3rd of the month. `through` is the slowest non-OFF account's `syncedThrough` (`metaPacing`), so it is yesterday once every account has synced. | `PACE_MIN_DAYS = 3` |

Why each guard is there (owner answer 3: keep them all, tune once Meta Ads is connected):
- **€20 floor:** the owner's minimum, on the increase.
- **Purchase minimums:** ROAS on 2 purchases is noise.
- **Prior-purchase rule on `NO_PURCHASES`:** `AdDay` has no campaign objective, so awareness and traffic campaigns always have 0 purchases and would alert every day.
- **`PACE_MIN_DAYS`:** one big first day of the month reads as 300 % pace.

**Baseline:**
- A day with no `AdDay` rows counts as 0 spend and 0 purchases. Meta returns no rows for a day without delivery, and every day up to `syncedThrough` was read.
- `SPEND_UP` needs `settings.backfill.start ≤ D_spend − 7`; `ROAS_DOWN` needs `settings.backfill.start ≤ D_conv − 7`. Otherwise that rule doesn't run (7 read days must exist).
- `NO_PURCHASES` has no backfill guard: a lookback that starts before the backfill only finds fewer earlier purchases, so it raises less, never more.
- A baseline average of 0 (an account just switched on, or resumed after a week paused) gives no `SPEND_UP`. Every day would be "infinite %". The ratio needs a non-zero baseline.

**Edge cases:**
- **New ad account:** no alerts until its 180-day backfill chain moves `syncedThrough` to yesterday. Daily runs never start `syncedThrough` (`advanceSyncedThrough`), so the hook's "S = the window's end" check holds them off.
- **New campaign:** it raises account spend, which is intended for `SPEND_UP`. It can't trigger `NO_PURCHASES` until it has 3 spend days *and* an earlier purchase, so the learning phase is quiet.
- **Paused or disabled account:**
  - Paused: no rows, so spend 0. That never triggers an alert; there is no "spend down" rule.
  - Disabled, or `ads_read` gone: the sync stops at `permission`, `syncedThrough` doesn't move, and no evaluation runs.
  - Source OFF: `runDataSync` returns before the hook.
- **Partial day:** the hook runs only after a non-backfill run with `complete === true` whose `syncedThrough` equals `outcome.window.to` (the account-local yesterday the run itself computed, not a fresh `zoneToday` at the end of the run, which can roll over midnight). A rate-limited or time-capped run evaluates nothing, and the next complete run (Sync now, or tomorrow) evaluates its own S. A missed day is not caught up; see Ceilings.
- **Attribution lag:** handled by D_conv (owner answer 2). D_conv's purchases can still grow for up to 4 more days, so each conversion alert's text says "purchases for <D_conv> can still grow a little".
- **Several ad accounts and currencies:**
  - `SPEND_UP`, `ROAS_DOWN` and `NO_PURCHASES` are per account, in the account's currency, and never summed across accounts.
  - The €20 floors are converted per account. An account currency the ECB doesn't publish never gets the €20-floored rules (see Ceilings).
  - `OVER_PACE` uses `metaPacing`, which already converts every account into the budget currency and waits for the slowest account.
- **Dedupe (one alert per episode, not per day):**
  - Each alert has a `subjectKey`, always with the brand in it (an ad account can be connected to two brands; a key without the brand would let one brand's alert swallow the other's):
    - `SPEND_UP:<brandId>:<accountId>`
    - `ROAS_DOWN:<brandId>:<accountId>`
    - `NO_PURCHASES:<brandId>:<accountId>:<campaignId>`
    - `OVER_PACE:<brandId>:<YYYY-MM>` (the month of `pacing.through`)
  - When the rule holds on its day X and an alert with the same `subjectKey` has `lastDay ≥ X−1` (for `OVER_PACE`, the same month), the job only sets `lastDay = GREATEST(lastDay, X)` and the latest `values`. There is no new notification.
  - Otherwise it inserts a new alert with `dedupeKey = <subjectKey>:<X>` (`OVER_PACE`: `<subjectKey>`, once a month) and notifies.
  - A rerun of the same day is a no-op. The job key and the unique `dedupeKey` both guarantee it.
  - Two accounts' jobs racing on `OVER_PACE` meet at the unique key: `ON CONFLICT DO NOTHING RETURNING`, and only the returned row notifies. The losing job's figures are not written; the next day's run updates them (see Ceilings).
- **"Open"** (`OPEN_DAYS`, per kind, against today in UTC):
  - `SPEND_UP`: `lastDay ≥ today − 2`.
  - `ROAS_DOWN`, `NO_PURCHASES`: `lastDay ≥ today − 5` (their day is already 3 back, so the spend window would never call them open).
  - `OVER_PACE`: its month is the current month.

**Owner answers (2026-11-26, after the first draft):**
0. Confirmed after the plan review: never put the person's own sales, revenue, ad or performance figures into a web search, even when asked. Generic searches (e.g. typical ROAS for furniture) are fine.
1. The €20 floor applies to the spend *increase* (yesterday − baseline average ≥ €20, converted).
2. Spend and pacing alerts use yesterday. ROAS and zero-purchase alerts use the day 3 days back (purchases attribute late), and their baselines shift the same way.
3. Keep the noise floors (ROAS: ≥5 purchases on the day, ≥20 in the baseline week; zero-purchase: €20 over 3 days and a purchase in the prior 28 days; pacing from the 3rd). Tune later once Meta Ads is connected.
4. Business Profile is deferred (no tool, one prompt line). After ads, posts or search data, web search is allowed only when the person asks; after sales or the ratio it is always off.

## Facts from the code (verified 2026-11-26 on `main`; line numbers re-read)

**Chat**
- `server/chat/tools.ts` (469 lines): `chatTools(scope)`.
  - `cleanTitle` (l. 31) strips control (newlines included), zero-width and bidi characters and caps at 100. It is module-private today.
  - `can(p)` caches `effectivePermissions` per message (l. 62–63). `denied(what)`.
  - `salesGate` (l. 68): `crm.read`, then `++salesCalls > MAX_SALES_CALLS` returns `SALES_LIMIT`.
  - `rangeOf` (l. 74): both days through `parseRange(from, to, MAX_SALES_DAYS)`, else the last 30 brand-local days. `BAD_RANGE` (l. 41) is `badRangeDetail(MAX_SALES_DAYS)`, so it always says 366.
  - `SalesRange` zod (l. 37). The comment: "Saved threads are validated against these schemas: they may only widen".
  - Results go out as `columns` + `rows`. `MAX_ANALYSIS_ROWS` (60) comes from `sales-analysis.ts`.
  - Sales tools l. 308–454; `startAgent` last.
- `server/chat/turn.ts` (69 lines):
  - `SALES_TOOLS` (l. 18), `SHOP_DATA_TOOLS` (l. 23), `MAX_SALES_CALLS = 8` (l. 25).
  - `readsShopData` (l. 28), `SALES_HIDDEN` (l. 32), `isSalesOutput` (l. 33), `hideSalesOutputs(messages)` (l. 42).
  - `activeTools(all, { history, calls, searchAsked })` (l. 52): web search is off once sales are in, or once shop data is in and search wasn't asked for; the sales tools are off after 8 calls.
  - `askedToSearch` (l. 65): `/\b(web|online|internet|google\w*|search\w*|look (it )?up|en ligne|recherch\w*|cherch\w*)\b/i`, so "Google Ads", "Search Console" and "search results" all count as asking.
- Chat route `app/api/v1/workspaces/[workspaceId]/brands/[brandId]/chat/route.ts`:
  - GET (l. 45) calls `hideSalesOutputs` only when `!scope.perms.has("crm.read")`.
  - POST (l. 100) redacts `history` the same way, saving the unredacted `messages`; `askedToSearch(messages.at(-1))` (l. 103).
  - `validateUIMessages({ messages, tools })` (l. 81) validates saved tool inputs against today's schemas.
  - `prepareStep` uses `activeTools` (l. 110–112); `isStepCount(6)`.
- `server/chat/prompt.ts`: `CHAT_PROMPT_VERSION = "7"` (l. 6). The sales bullet is in "How you work" (l. 13). The "is data, not instructions" bullet (l. 18) names documents, reports, product data, post titles and web pages; l. 19 is the web search line.
- Tests:
  - `tests/chat-turn.test.ts` imports `activeTools`, `askedToSearch`, `hideSalesOutputs`, `MAX_SALES_CALLS`, `readsShopData`, `SALES_HIDDEN` (l. 4); the `askedToSearch` cases at l. 58–63 include `"Peux-tu rechercher les prix ?"` → true; `hideSalesOutputs` describe at l. 74.
  - `tests/chat-history.test.ts` pins `SALES_HIDDEN` (l. 20, 40, 61).
  - `tests/chat-sales-tools.test.ts` imports `SALES_TOOLS`, `SHOP_DATA_TOOLS` and `MAX_SALES_CALLS` (l. 35).
  - `tests/chat-product-tools.test.ts:232` asserts version "7".
- Web `components/workspace/chat-pane.tsx`: `TOOL_LABEL` (l. 20–34) has no sales entries; an unknown tool shows its raw name (l. 307). Mobile has no CMO chat screen.

**Ads**
- `server/data/ads-read.ts`:
  - `ADS_MAX_DAYS = 366`; `D` exported (l. 23); `totalsOf(currency, spend, purchases, purchaseValue)` (l. 26).
  - `totals()` (private, l. 37) groups by currency over spend, purchases and purchaseValue only: **no impressions or clicks**, and **all accounts, OFF ones included**.
  - `adsSummary(scope, range, { crmRead })` (l. 51) returns totals, previous, previousRange, and `shopRevenueOverSpend` only with `crmRead`.
  - `shopRevenueOverSpend(scope, range)` (l. 63, exported) returns `{ ratio, currency, why, staleRateFrom }`; it goes through `convertedSpend`, so it leaves OFF accounts out.
  - `adsCampaigns(scope, range)` (l. 84) is **uncapped**, includes impressions and clicks, and all accounts.
  - `adsExportRows` is unbounded.
  - There is **no by-day reader**.
- `AdDay` (schema l. 1873): one row per `(brandId, platform, accountId, campaignId, day)`. It has spend, impressions, clicks, purchases, purchaseValue and currency, but **no objective**. Index `(brandId, platform, accountId, day)`.
- `server/data/budgets.ts`:
  - `currentMonth` (l. 17, private), `MonthSchema` (l. 20).
  - `convertedSpend(scope, from, to, currency)` (l. 48): its own `dataSource.findMany` of non-OFF META_ADS sources, then `adDay.groupBy({ by: ["currency", "day"] })` over those accounts.
  - `metaPacing` (l. 71, private): its own `findMany`; `no_data` when there is no source or any has a null `syncedThrough`; else `through` = min `syncedThrough` capped at the month's end; status `over` when ratio > 1.1.
  - `listBudgets(scope, month)` (l. 101, exported).
- `PacingDto`, `ShopRevenueOverSpend` and `AdsTotals` are in `shared/data-sources.ts` (l. 234–280).
- `server/data/fx.ts`: `rateTable(currencies, from, to)` (l. 182) gives `.convert(amount, from, to, day)`, which returns `{ amount, rateDay, stale } | null`; it loads 14 days before `from`. `STALE_DAYS = 7`.
- `server/data/meta-ads-sync.ts`:
  - `ATTRIBUTION_DAYS = 7`, `BACKFILL_DAYS = 180`.
  - `AdSettings = { currency, reportsIn, backfill }`.
  - The daily window is `ctx.window ?? dailyWindow(zoneToday(zone), ATTRIBUTION_DAYS)` (l. 79), ending yesterday in the account zone.
  - It returns `{ count, complete: !read.stoppedReason, reason, ...(ctx.window ? {} : { window }) }` (l. 94): `outcome.window` is set only on non-backfill runs.
  - It is registered with `registerSync("META_ADS", …)` (l. 74) and has no options.
- `server/data/meta-ads.ts:14`: "a day with no spend has no campaigns". Days without delivery have no `AdDay` rows.

**Sync completion**
- `server/data/sources.ts`:
  - `type SyncOptions = { halveOnCap? }` (l. 107); `registerSync(kind, runner, options)` (l. 111).
  - `badRangeDetail(maxDays)` (l. 145), `badRange` (l. 147).
  - `runDataSync` (l. 324):
    - Returns early for a missing or OFF source.
    - `window` is set only when `p.mode === "backfill"`.
    - Computes `syncedThrough` via `advanceSyncedThrough(held, read, complete)`.
    - Calls `recordSync(…)` (l. 370–374).
    - `if (outcome.stopChain) return` (l. 377).
    - Then the plan start, follow-ups and backfill chain.
  - `recordSync` (l. 284). `chainStart`, `spreadSecs` (l. 191).
  - `dayOf`, `dayDate`, `addDays`, `zoneToday`, `previousRange`, `parseRange` usage, `brandTimeZone` (l. 537).
- `server/jobs/queue.ts`: `enqueueJob` upserts on `idempotencyKey` with `update: {}`, so a reused key queues nothing. `claimNextJob` caps `data.%` at 2.
- `server/jobs/runner.ts`:
  - `HANDLERS` (l. 53).
  - The daily sweep at 05:00 UTC (l. 193) runs these steps: post-metric sources, data, fx, story reads, overdue, rechecks, prune (`pruneNotifications`, 90 days), shopify writes, digest.

**Notifications (the bell is task-only today)**
- `Notification` (schema l. 1629):
  - Fields: `userId`, `workspaceId`, `brandId`, `kind NotificationKind`, `taskId String?`, `actorId?`, `dedupeKey @unique`, `readAt`, `createdAt`.
  - Indexes `(userId, workspaceId, readAt, createdAt)`, `(createdAt)`, `(userId, workspaceId, createdAt desc, id desc)`, `(taskId)`, `(brandId, workspaceId)`.
  - `enum NotificationKind` (l. 1445): six `TASK_*`/`REVIEW_*` values.
- `server/notifications/list.ts`:
  - `FROM` (l. 18) is `"Notification" n JOIN "Task" t`, an **inner join**.
  - `notificationWhereSql` (l. 24) is `visibleTasksAcrossSql(userId, workspaceId, "t")`. It is `visibleTasksAcrossSql`'s **only** caller.
  - `listNotifications` returns unread grouped by `(kind, brandId)` (`DISTINCT ON`), then 20 read rows a page (`LIMIT 21`).
  - `countUnread` (l. 87) fences unread rows (`SELECT "taskId", "userId", "workspaceId" … OFFSET 0`), then `JOIN "Task"`, `LIMIT 100`.
  - `markRead(userId, workspaceId, ids | "all" | { kind, brandId, upTo })` (l. 104).
  - So a notice without a task is **never listed or counted**.
- `server/tasks/access.ts` `visibleTasksAcrossSql` (l. 142): loads `memberRole` + `brandMember` grants once (two queries), `FALSE` without a workspace role, per-brand id lists, and a `live` check (brand not archived) on `t."brandId"`. Its CRM rule: "a key in the workspace role reaches every brand; else only the brands whose grant adds one".
- `server/notifications/tasks.ts`: `notifyManyTx` uses `createMany(skipDuplicates)` with dedupe `<kind>:<userId>:<auditEventId>`; it is task-shaped and not reusable for alerts.
- `server/notifications/daily-tasks.ts`: `pruneNotifications` keeps 90 days.
- `app/api/v1/me/notifications/read/route.ts`: the body's group takes `kind: z.enum(NotificationKind)`, so a new enum value flows through.
- `shared/api/tasks.ts:82` `NotificationDto` = `{ id, kind, count, brandId, taskId, taskTitle, actor, readAt, createdAt }`.
- Web `components/shell/notification-bell.tsx` (**behind the `tasks` web flag**):
  - `notificationText` switches on the kinds; the default is "A task changed".
  - `openOne` returns when `!n.taskId`.
  - The empty text says "Task assignments and review requests show here."
  - It polls the count every minute while the tab is visible.
- Who holds a key:
  - `server/auth/permissions.ts` `hasOtherHolder(workspaceId, brandId, userId, key)` (l. 93–106): three queries (members, legacy roles, grants), in memory; a grant counts only for someone with a workspace role; client grants excluded; **no active-user filter**. Caller: `hasOtherApprover`.
  - `server/services/publishing.ts` `brandOwners(scope, { key, includeClients })` (l. 242): reads `roleRef` only (no legacy roles); its grant path checks the grant's own role for `key` without the workspace role's union and without requiring a workspace role; formats names.
  - `permissionsOf` is the workspace role ∪ grant (client grants included).
  - `rolePermissions` reads Owner and Admin from code. The catalog comment warns that `Role.permissions { has }` filters read a possibly stale stored copy.
- Roles: Manager, Project admin, Owner and Admin hold `ads.read`. Creator, Approver, Client reviewer and Viewer don't. Client reviewer holds `analytics.read`.

**Digest**
- `server/digest/build.ts`:
  - `sweepAt(weekStart)` (l. 35): the Monday 05:00 UTC sweep; `digestWeekStart` (l. 33).
  - `synced(scope, kind)` (l. 47): "has ever finished a sync": also true on `lastResult.okAt` with a null `syncedThrough`.
  - `adsSection(scope, week)` (l. 99) gives `{ kind: "ads", key: "ads.read", data: … | null }`.
  - `hasNews` (l. 177).
  - `brandSections` is memoised by `brand|week.from|keys`.
  - `readerAccess(userId, workspaceId)` (l. 191): `memberRole` + grants + non-archived brands, then `permissionsOf` per brand.
  - `buildDigest(userId, workspaceId, now, weekAt)`: its only caller is `runDigest`, with `weekAt = sweepAt(weekStart)`.
  - `refilterDigest` drops sections whose key the reader lost.
- `server/digest/job.ts`: digests run `AFTER_SWEEP_MS` (3 h) after the 05:00 UTC sweep, spread over an hour; the Monday data syncs are spread over 2 h.
- `shared/digest.ts:23` holds the ads section type.
- `server/digest/email.ts:34` holds the ads line (plain text).
- Web `components/digest/digest-view.tsx` has its ads case.
- Tests: `tests/digest-build.test.ts`, `tests/db/digest-build.db.test.ts`.

**Posts and Search**
- `server/data/post-metrics-read.ts`:
  - `POSTS_MAX_DAYS = 90`.
  - `postsWithMetrics(scope, range, now, { stories })` caps at `MAX_POSTS = 500`, ordered by reach. Each post has `metrics | null`, `readAt`, `final`, and `navigation` (stories).
  - Gated by `analytics.read` (`insights/posts` route).
- `server/data/search-read.ts`:
  - `searchSummary(scope, range, { manage })` returns `hasSite`, totals (with CTR and position already computed), previous, days, plus `siteUrl` only when `manage`.
  - `searchPages(scope, range, { sort, offset })` returns 50 pages (`SEARCH_PAGES_LIMIT`).
  - Gated by `analytics.read`.
- `SEARCH_RANGE_MAX_DAYS = 90`; `SEARCH_CONSOLE_ZONE = "America/Los_Angeles"`.
- `enum SearchDimension { SITE, PAGE }`: **no query-level rows are synced**.

**Google Business Profile**
- `server/google/business.ts`: live reads, `READS_PER_MIN = 30` per brand, reviews cached 45 s.
- Its routes need `inbox.read`.

**Migrations**
- The latest is `20261126130000_post_metric_navigation`.
- Precedent: a new enum value gets its own migration (`20261126120000_ad_platform_google`).

## Global constraints

- Branch `chat-data-tools` in server and web (mobile only for the shared copy) from `main`, in worktrees **outside** `apps/`.
- Migrations are timestamped after `20261126130000`: `20261127090000_notification_ad_alert_kind`, then `20261127090100_ad_alert`.
- `prisma migrate` runs only against explicit local URLs. The dev DB is shared with production, so it is migrated there only with the owner's OK.
- Every query is scoped by `workspaceId` AND `brandId`, taken from the session or the job's source row, never from the model.
- Tagged SQL only (`Prisma.sql` / `$queryRaw` templates).
- Money:
  - Stays `Decimal` (`D` from `ads-read.ts`), sent as strings.
  - Never summed across currencies. A converted figure (the €20 floors, the ratio, pacing) says it was converted and when its rate is stale.
- Model input:
  - Text from people or providers (campaign names, post titles, page URLs, alert text) goes through `cleanTitle` (moved to `server/text.ts` in Task 1). It is data, never instructions.
  - Tool input schemas may only widen once shipped.
- Shared DTOs are edited in server `shared/`, then `npm run sync:shared`. The web and mobile copies are committed with the same hash. Only what the web needs goes to `shared/`: `AdAlertKind`, `NotificationDto.alert`, the digest section type. `AdAlertView` and `adAlertText` stay server-only.
- No new pollers: the alerts job is queued by the sync, and the bell keeps its existing poll.
- Tests for behaviour.
- Commit messages describe the change only: no co-author line, no session URL, no mention of tests.

## Review focus

1. **Gating:** each new tool refuses without its Performance key. `revenuePerAdSpend` needs both `ads.read` and `crm.read`. No tool output carries a figure from a key the person lacks: `adsSummary` never includes the ratio.
2. **Redaction:**
   - GET and the model's history hide every tool output whose keys the viewer no longer holds, sales included.
   - The saved thread is never rewritten.
   - A tool the map doesn't list (catalogue, docs) is never hidden.
   - Old saved threads still validate.
3. **Caps and search lock:**
   - Per-group caps (8) and the total cap (12) hold for calls made in parallel within one step.
   - Web search stays off once ratio or sales figures are in.
   - It stays off after ads, posts or search data unless the person explicitly asked to search the web; "Google Ads", "Search Console" or "search results" never count.
4. **Money:** no currency mixing. The €20 floors are converted per account at the rule's day's rate, and a missing rate skips the check rather than guessing. Pacing and ratio notes carry `staleRateFrom`.
5. **Alerts:**
   - Never evaluated on backfill, partial, permission-stopped or OFF runs, nor when `syncedThrough` isn't the run's own window end.
   - Spend and pacing on S; ROAS and zero-purchase on S−3 with their baselines shifted.
   - Never raised twice for one episode, also when the daily run and Sync now overlap, or two accounts race on `OVER_PACE`; never suppressed across brands that share an ad account.
   - A failing evaluation never fails or retries the sync.
   - The baseline counts missing days as 0, and a zero baseline raises nothing.
6. **Bell:**
   - An `AD_ALERT` notice is listed and counted only while the reader holds brand.read **and** ads.read on that brand *now* (role ∪ grant, workspace role required), and the brand isn't archived. Recipients follow the same predicate.
   - Task notices behave exactly as before.
   - `countUnread` still reads through its index with the same number of queries; the minute-ly poll gets no new scan.
7. **Digest:** the alerts line is inside the `ads.read` section, so `refilterDigest` drops it for a reader who lost the key. Each alert appears in exactly one weekly digest. Old stored bodies without `alerts` still render. Alert text is cleaned before it reaches the plain-text email.

---

## Task 1: One permission map for chat data tools; redaction, caps and the search ask (0.75 d)

**Files:**
- Create `server/text.ts`: `cleanTitle` moved out of `tools.ts`, exported, unchanged (Tasks 2, 3, 5, 6 import it).
- Modify `server/chat/turn.ts`, `server/chat/tools.ts` (the gate, `rangeOf`, the range schema, the `cleanTitle` import) and the chat route `app/.../chat/route.ts`.
- Tests: `tests/chat-turn.test.ts`, `tests/chat-history.test.ts`, `tests/chat-sales-tools.test.ts` (imports updated to the new names).

**Interfaces (`server/chat/turn.ts`):**

```ts
export type ToolGroup = "sales" | "ads" | "analytics";
/** Chat tools that read the brand's data: the keys a person needs (all of them), the call group, strict = web search always off after it. */
export const CHAT_DATA_TOOLS: Record<string, { keys: PermissionKey[]; group: ToolGroup; strict?: true }> = {
  salesSummary: { keys: ["crm.read"], group: "sales", strict: true }, /* … the other four sales tools … */
  revenuePerAdSpend: { keys: ["ads.read", "crm.read"], group: "sales", strict: true },
  adsSummary: { keys: ["ads.read"], group: "ads" }, adCampaigns: …, adBudgets: …,
  postPerformance: { keys: ["analytics.read"], group: "analytics" }, searchPerformance: …,
};
/** Calls one group may make per message. */
export const MAX_GROUP_CALLS = 8;
/** Data-tool calls per message in all: each output is saved and resent with later turns (40-message window). */
export const MAX_DATA_CALLS = 12;
```

- **No aliases:** `SALES_TOOLS` and `MAX_SALES_CALLS` go; their three test files and `tools.ts` move to `CHAT_DATA_TOOLS` / `MAX_GROUP_CALLS`. `SALES_HIDDEN` stays (pinned by `chat-history.test.ts`).
- **Search lock sets:**
  - `STRICT_TOOLS` = entries with `strict`.
  - `SHOP_DATA_TOOLS` = `catalogueSummary`, `findProducts` and every `CHAT_DATA_TOOLS` name. The name stays; its comment and `readsShopData`'s are rewritten to say "the brand's catalogue, sales, ads and performance data".
- **`hiddenFor(keys)`:** a fixed refusal per missing key:
  - `crm.read` → `SALES_HIDDEN`;
  - `ads.read` → `{ error: "Your role can't see ads." }`;
  - `analytics.read` → `{ error: "Your role can't see performance numbers." }`.
- **`hideOutputs(messages, perms: ReadonlySet<string>)`:**
  - Replaces the output of every tool part whose `CHAT_DATA_TOOLS` entry has a key not in `perms`.
  - Returns the same array reference when nothing changes (cheap for full-permission readers).
  - `hideSalesOutputs` is removed; its two route callers and its test move to `hideOutputs`.
- **`activeTools`:**
  - The search rule reads `STRICT_TOOLS` (always off) and `SHOP_DATA_TOOLS` (off unless `searchAsked`).
  - A group's tools are off once its calls this turn reach `MAX_GROUP_CALLS`; every `CHAT_DATA_TOOLS` tool is off once all data calls this turn reach `MAX_DATA_CALLS`.
- **`askedToSearch(message)`:** true only for the explicit phrases in Decision 6, whole words, case-insensitive, English and French, from the person's own text parts. Written as a short list of alternatives (not "a search word near a web word", which would pass "Search Console clicks for my web shop"). Comment the negatives next to it.
- **`tools.ts`:**
  - `salesGate` becomes `gate(name)`. It checks every key of `CHAT_DATA_TOOLS[name]` through `can`, and returns `hiddenFor` on the first missing key.
  - It then counts: `++calls.total > MAX_DATA_CALLS` → `{ error: "Data tool limit reached for this message." }`; `++calls[group] > MAX_GROUP_CALLS` → `{ error: "<Group> tool limit reached for this message." }` (the sales text is unchanged). A refused call doesn't count against the group.
  - The sales tools call `gate("salesSummary")` and so on.
  - **`rangeOf(input, maxDays, defaultEnd?, defaultDays = 30)`:** both days through `parseRange(from, to, maxDays)`, else `defaultDays` days ending at `await defaultEnd()` (default: brand-local today, today's behaviour). Returns the range, a note when `defaultEnd` gives null, or `{ error: badRangeDetail(maxDays) }`, so each tool's refusal names its own maximum (366, 90). The sales tools pass `MAX_SALES_DAYS` and keep their behaviour.
  - **`rangeInput(defaultHint)`:** one small factory for the `{ from?, to? }` schema; `SalesRange` becomes `rangeInput("leave both out for the last 30 days")` with the same shape and descriptions.
- **Route:**
  - GET always returns `hideOutputs(thread.messages, scope.perms)`; the `crm.read` short-circuit goes.
  - POST: `history = hideOutputs(historyWindow(messages), scope.perms)`.

**Tests:**
- [ ] `hideOutputs hides a sales step for a viewer without crm.read` (the existing case, moved).
- [ ] `hides an ads step without ads.read, keeps the sales step with crm.read`.
- [ ] `revenuePerAdSpend hidden when either key is missing`.
- [ ] `catalogue and document steps never hidden`.
- [ ] `nothing to hide → same array`.
- [ ] `8 sales + 4 ads calls run; the 13th data call is refused with the data limit` (gate, in parallel).
- [ ] `9th ads call in parallel refused with the ads limit`.
- [ ] `activeTools: group off at 8, every data tool off at 12 total`.
- [ ] `web search off after revenuePerAdSpend even when asked`.
- [ ] `off after adsSummary unless asked`.
- [ ] `askedToSearch true`: "search the web for CTR benchmarks", "look it up online", "web search", "google it", "recherche sur internet", "cherche en ligne", "fais une recherche web".
- [ ] `askedToSearch false`: "how are my Google Ads doing", "Google search clicks this month", "Search Console clicks for my web shop", "search results for our online store", "top search terms", "how are my online sales", "Peux-tu rechercher les prix ?" (was true: the behaviour change), "What's on my website?".
- [ ] `BAD_RANGE names the tool's maximum`.
- [ ] Route `GET with ads.read lost hides ads outputs` (`chat-history.test.ts`).
- [ ] `the model's history is redacted, the saved thread isn't`.
- [ ] Existing sales gating and cap tests unchanged in behaviour and green.

**Commit (server):** "Gate and redact the chat's data tools from one permission map, cap data calls per message, and count only explicit requests to search the web"

## Task 2: Ads chat tools (1.25 d)

**Files:**
- Modify `server/data/ads-read.ts` (add `adsDays`), `server/data/sources.ts` (add `liveSources`), `server/data/budgets.ts` (`metaPacing` and `convertedSpend` read `liveSources`; export `currentMonth`) and `server/chat/tools.ts` (four tools).
- Tests: `tests/chat-ads-tools.test.ts` (new, mocked readers, like `chat-sales-tools.test.ts`), `tests/db/ad-day.db.test.ts` (add `adsDays`), the existing budgets tests (green and unchanged: the swap is behaviour-neutral).

**Interfaces:**
- **`liveSources(scope, kind)`** in `sources.ts`: one `dataSource.findMany` over the brand's sources of `kind` (`status`, `externalId`, `syncedThrough`). Returns `{ externalIds, syncedThrough, offCount }` for the non-OFF ones: `syncedThrough` is their minimum, null when there is none or any is null (exactly `metaPacing`'s rule today). `metaPacing` and `convertedSpend` use it in place of their own queries, with identical results. The digest's `synced()` keeps its own rule (it also accepts `lastResult.okAt`).
- **`adsDays(scope, range, accountIds)`** in `ads-read.ts`:
  - One `prisma.adDay.groupBy({ by: ["currency", "day"], _sum: { spend, impressions, clicks, purchases, purchaseValue } })`, scoped by workspace, brand, `platform: "META"`, `accountId in accountIds` and the range. The same shape as `convertedSpend`'s groupBy (comment it so); index-backed like `totals()`.
  - Returns `{ currency, day, spend: Decimal, impressions, clicks, purchases, purchaseValue: Decimal }[]` ordered by day.
  - Nothing else in `ads-read.ts` changes; the Ads tab keeps `totals()` and `adsCampaigns` as they are.
- **`adsRange(input)`** (`tools.ts`): `rangeOf(input, ADS_MAX_DAYS, async () => (await liveSources(scope, "META_ADS")).syncedThrough)`, one `liveSources` call per message shared by the ads tools (kept as a promise, like `perms`). A null end → `{ note: "Meta Ads isn't connected or hasn't finished its first sync." }`.
- **`adsSummary`** (`ads.read`, group `ads`). Description: Meta Ads totals per currency for a period (default the last 30 synced days), with the previous period, daily rows up to 31 days, and recent alerts.
  - Two queries: `adsDays(scope, range, ids)` and `adsDays(scope, previousRange(range), ids)`. Per currency, the rows fold through `totalsOf` (+ impressions, clicks). The reader `adsSummary()` isn't called, so the ratio can't leak in.
  - Per currency it returns `totals: { ...totalsOf(...), impressions, clicks, ctr, cpc }` and `previous` the same way.
    - `ctr = clicks ÷ impressions`, null at 0.
    - `cpc = spend ÷ clicks`, a 2-place string, null at 0.
  - `days: { columns: ["day","currency","spend","impressions","clicks","purchases","roas"], rows }` when `rangeDays ≤ 31`.
  - `syncedThrough`, `currencyNote: "Amounts are per ad account currency; never add currencies together."`.
  - `attributionNote: "Meta keeps attributing purchases for 7 days, so the last few days can still grow."`.
  - When `offCount > 0`: "Switched-off ad accounts are left out."
  - `alerts` is `[]` until Task 8.
- **`adCampaigns`** (`ads.read`):
  - Input: range plus `limit` 1..`MAX_ANALYSIS_ROWS` (60), default 20, and `rankBy: "spend" | "purchases" | "roas"`, default spend.
  - Calls `adsCampaigns(scope, range)`, keeps rows whose `accountId` is in `liveSources`' ids (in memory; the reader is unchanged), sorts by `rankBy` (ROAS nulls last) and takes `limit`.
  - Columns `campaign, account, currency, spend, impressions, clicks, purchases, roas, costPerPurchase`. The campaign is `cleanTitle(campaignName)`; the account is the `act_` id.
  - `moreCampaigns` count and the same notes.
- **`adBudgets`** (`ads.read`):
  - Input `month?: string`, validated with `MonthSchema` (default: `currentMonth()`, now exported from `budgets.ts`).
  - Returns `listBudgets(scope, month)` mapped to `{ budgets, pacing }`, plus one note per pacing state:
    - `no_data`: "no Meta spend synced for this month yet";
    - `no_rate`: "no exchange rate yet to convert spend into the budget currency";
    - `google_later`: "Google Ads spend arrives in Phase 3";
    - `ok` with `staleRateFrom`: "spend converted at ECB rates; uses a rate from <date>".
- **`revenuePerAdSpend`** (`ads.read` **and** `crm.read`, group `sales`, strict):
  - Input: range (default as `adsRange`).
  - Calls the exported `shopRevenueOverSpend(scope, range)` and returns `{ ...range, ratio, currency, why, staleRateFrom, notes }`.
  - The notes:
    - "Shop net sales without VAT ÷ Meta spend converted to <currency> at the ECB daily rates."
    - "Shopify days and ad account days may differ by a few hours."
    - When `staleRateFrom` is set: "uses a rate from <date>".
    - One fixed line per `why`.

**Tests:**
- [ ] `each ads tool refuses without ads.read (no reader called)`.
- [ ] `revenuePerAdSpend refuses with ads.read but no crm.read, and the reverse`.
- [ ] `adsSummary never returns shopRevenueOverSpend` (and never calls the `adsSummary` reader).
- [ ] `adsSummary makes two adsDays reads; totals fold per currency`.
- [ ] `default range ends at the min syncedThrough across accounts`.
- [ ] `no META_ADS source → note`.
- [ ] `two currencies stay separate rows`.
- [ ] `OFF account's rows left out of adsSummary and adCampaigns, with the note`.
- [ ] `ctr/cpc null at zero`.
- [ ] `days only up to 31 days`.
- [ ] `adCampaigns capped at 60, campaign names cleaned (bidi/zero-width/newline stripped)`.
- [ ] `rankBy roas puts null last`.
- [ ] `adBudgets rejects month 2026-13`.
- [ ] `stale rate note`.
- [ ] `revenuePerAdSpend why → note`.
- [ ] db: `adsDays sums per currency and day, only the given accounts, other brand's rows excluded`.
- [ ] db: `liveSources: min syncedThrough, null when one is unsynced, OFF counted apart`.

**Commit (server):** "Let the assistant read Meta Ads results, campaigns, budgets and pacing, and revenue per ad spend"

## Task 3: Post and Search Console chat tools (0.75 d)

**Files:**
- Modify `server/chat/tools.ts`.
- Tests: `tests/chat-analytics-tools.test.ts` (new, mocked readers).

**Interfaces:**
- **`postPerformance`** (`analytics.read`, group `analytics`):
  - **Input:** range (`rangeOf(input, POSTS_MAX_DAYS)`, default the last 30 brand-local days). `rankBy: "reach" | "views" | "likes" | "comments" | "shares" | "saves" | "interactions"`, default reach. `channel?: PostChannel`. `limit` 1..25, default 10, applied to posts and to stories.
  - **Reads:** `postsWithMetrics(scope, range, new Date(), { stories: true })`.
  - **Returns:**
    - `totals`: per channel, post count, how many were read, and sums of each metric over read posts, computed from **all** returned rows before any cap.
    - `top`: columns `title, channel, published, reach, views, likes, comments, shares, saves`. Rows are sorted by `rankBy`, with unread posts last, capped at `limit`; titles go through `cleanTitle`. `morePosts` count.
    - `stories`: columns `title, published, reach, views, replies, shares, navigation`, sorted the same way and capped at `limit`, with a `moreStories` count. Story `comments` is shown as replies, and `reach` is labelled "highest frame".
    - `notes`:
      - "Numbers are each post's latest read; posts under 30 days old can still grow (final: false)."
      - "Story reach is the highest frame's reach."
      - "Unread: the platform hasn't been read yet or the account lacks insights permission."
      - When 500 rows come back: "Only the top 500 posts by reach in this period were read."
- **`searchPerformance`** (`analytics.read`):
  - **Input:** range (`rangeOf(input, SEARCH_RANGE_MAX_DAYS, async () => (await liveSources(scope, "SEARCH_CONSOLE")).syncedThrough, 28)`, 28 days ending at it; with no `syncedThrough`, a note). Also `pageSort: "clicks" | "impressions"` (the values of `SEARCH_PAGE_SORTS`), default clicks, and `pages` 0..25, default 10.
  - **Reads:** `searchSummary(scope, range, { manage: false })`, which never returns the site URL, and `searchPages(scope, range, { sort, offset: 0 })`, sliced to `pages`.
  - **Returns:**
    - `hasSite`;
    - `totals` and `previous`: clicks, impressions, CTR and average position as `searchSummary` already computes them (passed through, not recomputed);
    - `days` only up to 31 days;
    - `topPages`: columns `page, clicks, impressions, ctr, position`; the page URL goes through `cleanTitle`, which caps it at 100 characters.
    - `notes`:
      - "Days are Google's (Pacific time) and lag 2–3 days."
      - "Only site totals and the top pages per day are stored; search queries (keywords) aren't synced, so they can't be answered here."
      - "Page sums sit below the site total."

**Tests:**
- [ ] `both refuse without analytics.read`.
- [ ] `client reviewer (analytics.read) gets them`.
- [ ] `rankBy views puts unread posts last`.
- [ ] `stories listed separately with navigation; replies from comments`.
- [ ] `stories capped at limit with moreStories; per-channel totals count every row`.
- [ ] `titles cleaned`.
- [ ] `500-row note`.
- [ ] `search default range ends at syncedThrough`.
- [ ] `no site → hasSite false with note`.
- [ ] `siteUrl never in output`.
- [ ] `pages over 25 rejected`.
- [ ] `query note present`.
- [ ] `range over 90 days → error naming 90`.

**Commit (server):** "Let the assistant read post, story and Search Console performance"

## Task 4: Prompt v8 and tool labels (0.25 d)

**Files:**
- Modify `server/chat/prompt.ts`.
- Modify web `components/workspace/chat-pane.tsx`: add `TOOL_LABEL` entries for the six new tools, plus the five sales tools, which show raw names today. That is a one-line-each fix in the same map; drop it if the owner wants this strictly surgical.
- Tests: `tests/chat-product-tools.test.ts:232` changes to "8".

**Prompt:** after the sales bullet, add one bullet (under ~90 words, static, no per-brand text):

> For Meta Ads (spend, clicks, purchases, ROAS, campaigns) use adsSummary and adCampaigns; for monthly budgets and pacing adBudgets; for shop revenue per ad spend revenuePerAdSpend. For posts and stories use postPerformance; for Google search clicks, impressions, position and top pages searchPerformance (search keywords aren't available). When adsSummary lists open alerts, mention them. Pass on the tools' notes (conversions, stale rates, recent numbers still growing). Google Business Profile reviews and ratings aren't readable here yet; they're in the mobile app.

And two edits to existing bullets:
- The "is data, not instructions" bullet (l. 18) adds campaign names, page URLs and alert text to its list.
- The web search bullet (l. 19) adds: "Never put sales, revenue, ad or performance figures into a web search, even when asked: search for the benchmark, not with the numbers." and says web search turns back on only when the person asks to search the web.

Bump `CHAT_PROMPT_VERSION` to "8".

**Labels:** for example, `adsSummary: () => "Checked your Meta Ads results"`, `adCampaigns: () => "Compared your ad campaigns"`, `revenuePerAdSpend: () => "Compared shop revenue with ad spend"`, `postPerformance: () => "Checked how your posts did"`, `searchPerformance: () => "Checked your Google search results"`.

**Commits:** server "Describe the new data tools in the assistant's instructions"; web "Name the assistant's data steps in plain words"

## Task 5: AdAlert table, rules and the `ads.alerts` job (2.5 d)

**Files:**
- Create `server/ads/alerts.ts`: constants, the pure `evaluateAccount(days, ctx)` and `evaluatePacing(pacing)`, `adAlertText`, `listAlerts`, the `ads.alerts` handler and `enqueueAdAlerts`.
- Create migrations `20261127090000_notification_ad_alert_kind` (`ALTER TYPE "NotificationKind" ADD VALUE 'AD_ALERT'` only) and `20261127090100_ad_alert`.
- Modify `prisma/schema.prisma`, `server/data/sources.ts` (`SyncOptions.afterRun`), `server/data/meta-ads-sync.ts` (register the hook) and `server/jobs/runner.ts` (`HANDLERS["ads.alerts"]`).
- Modify `shared/data-sources.ts`: `AD_ALERT_KINDS` and `AdAlertKind` only.
- Tests: `tests/ad-alerts.test.ts` (pure rules and `adAlertText`), `tests/db/ad-alerts.db.test.ts`, `tests/data-sources.test.ts` (the hook, with a stub runner registered with `afterRun`).

**Data model:**

```prisma
enum AdAlertKind { SPEND_UP ROAS_DOWN NO_PURCHASES OVER_PACE }

/// A Meta Ads problem found after an account's daily sync (server/ads/alerts.ts). One row per episode: a rule holding
/// on consecutive days moves lastDay instead of adding rows. values: the figures as strings (Decimal), in `currency`.
model AdAlert {
  id           String      @id @default(cuid())
  workspaceId  String
  brandId      String
  kind         AdAlertKind
  /// "act_123"; null for OVER_PACE (brand-wide)
  accountId    String?
  campaignId   String?
  campaignName String?
  currency     String
  /// The rule's own day: D_spend (SPEND_UP), D_conv (ROAS_DOWN, NO_PURCHASES), pacing.through (OVER_PACE)
  firstDay     DateTime    @db.Date
  lastDay      DateTime    @db.Date
  values       Json
  /// <kind>:<brandId>:<account>[:<campaign>] or OVER_PACE:<brandId>:<YYYY-MM> — the episode's subject, always brand-scoped
  subjectKey   String
  /// subjectKey + ":" + firstDay (OVER_PACE: subjectKey, once a month); globally unique because subjectKey holds the brand
  dedupeKey    String      @unique
  createdAt    DateTime    @default(now())
  updatedAt    DateTime    @updatedAt

  brand         Brand          @relation(fields: [brandId, workspaceId], references: [id, workspaceId], onDelete: Cascade)
  notifications Notification[]

  @@index([brandId, subjectKey, lastDay])
  @@index([brandId, lastDay])
  @@index([brandId, createdAt])
}
```

`Notification` gains `adAlertId String?` (FK, `onDelete: Cascade`) and `@@index([adAlertId])`. Add the back-relations on `Brand`.

The `AD_ALERT` enum value is in its own migration: the same rule as `AdPlatform.GOOGLE`, with a comment at the enum.

**Interfaces:**
- **`SyncOptions.afterRun?: (source, outcome, syncedThrough: string | null) => Promise<void>`**, additive:
  - `runDataSync` calls it after `recordSync` only when `p.mode !== "backfill"`, `!outcome.stopChain`, `outcome.complete` and `outcome.window` is set.
  - It runs inside `try/catch`, logging `[data] afterRun failed <kind> <brandId>` with the message only, never rethrown.
  - Other kinds have no hook and see no change.
- **META_ADS registration:** `registerSync("META_ADS", runner, { afterRun: enqueueAdAlerts })`. `enqueueAdAlerts` queues only when `syncedThrough === outcome.window.to` (the account-local yesterday the run computed itself):

  ```ts
  enqueueJob({ type: "ads.alerts", workspaceId, brandId,
    payload: { workspaceId, brandId, dataSourceId, day },   // day = S
    idempotencyKey: `ads-alerts:${source.id}:${day}`, maxAttempts: 3 })
  ```
- **The handler:**
  - It re-reads the source by id **and** the workspace, brand and kind `META_ADS`, not OFF. A mismatch is a no-op.
  - It requires `dayOf(source.syncedThrough) >= day`. `D_spend = day`, `D_conv = day − CONV_LAG_DAYS`.
  - **Reads:**
    - One `adDay.findMany` for the account, `platform: "META"`, from `D_spend − 33` (= `D_conv − 30`, the start of the `NO_PURCHASES` lookback; the ROAS baseline starts at `D_spend − 10`) to `D_spend`, giving per campaign and day spend, purchases and purchaseValue. That is 34 days × campaigns, index `(brandId, platform, accountId, day)`.
    - `rateTable(["EUR", currency], D_conv − 2, D_spend)` for the €20 floors (each rule converts at its own day).
    - `listBudgets(scope, month of D_spend)` for `OVER_PACE`.
    - The recipients (Task 6), once per job, before the writes.
  - **Rules:** the pure `evaluateAccount` returns candidate alerts `{ kind, day, subjectKey, campaignId?, campaignName?, values }`. `values` holds strings such as `{ day, now, baseline, ratio, minEur, rateDay?, stale? }`. `evaluatePacing(pacing)` uses `pacing.status === "over"` and `pacing.through`.
  - **Writes, in one transaction per candidate:**
    - `SELECT … FROM "AdAlert" WHERE "brandId" = … AND "workspaceId" = … AND "subjectKey" = … AND "lastDay" >= day − 1 FOR UPDATE`. For `OVER_PACE`, the condition is the month instead of `lastDay`.
    - If a row is found: `UPDATE lastDay = GREATEST(lastDay, day), values`, and no notification.
    - Otherwise: `INSERT … ON CONFLICT ("dedupeKey") DO NOTHING RETURNING id`, and on a returned id, `notifyAdAlert(tx, alert, recipients)` (Task 6). Until Task 6 lands this is a stub that writes nothing.
  - **Notes:**
    - `campaignName` is `slice(0, 500)` as stored. The cleaning happens in `adAlertText`.
    - A missing FX rate skips only the money-floored rules for that account, and logs it.
- **`adAlertText(a)`** (server-only, `alerts.ts`): one English line per kind, used by the bell, the digest email, the web digest and the chat. It runs the campaign name through `cleanTitle` itself (newlines, control, bidi and zero-width characters gone, 100 characters), so no surface can forget it and the plain-text email can't be forged with a line break. For example:
  - "Ad spend up 64% on act_123: 182.40 EUR on 2026-11-25 vs 111.20 a day before"
  - "Campaign "Spring sale" spent 46.10 EUR with no purchases for 3 days to 2026-11-22 (purchases can still grow a little)"
  - "Meta spend at 124% of the November budget pace"
- **`AdAlertView`** (server-only): `{ id, kind, accountId, currency, firstDay, lastDay, open, text, values }`, `open` by `OPEN_DAYS` per kind.
- **`listAlerts(scope, by, limit)`** (server-only), one reader for Tasks 7 and 8: `by` is `{ createdFrom, createdBefore }` (digest, index `(brandId, createdAt)`) or `{ recentFrom }` (chat, index `(brandId, lastDay)`: `lastDay >= recentFrom`, minus `CONV_LAG_DAYS` for the conversion kinds). Scoped by workspace and brand, ordered by `firstDay`, returns `{ alerts: AdAlertView[], more: number }`.

**Tests:**
- Pure rules, in `ad-alerts.test.ts` (S = 2026-11-25, so D_spend = 11-25 and D_conv = 11-22):
  - [ ] `spend up 50% and ≥ €20 on D_spend → SPEND_UP with day 11-25`.
  - [ ] `+60% but +€12 → none`.
  - [ ] `INR account: €20 converted at D_spend's rate`.
  - [ ] `EUR account, no rate table → all rules still run` (no conversion needed).
  - [ ] `non-EUR account, no rate → SPEND_UP, ROAS_DOWN and NO_PURCHASES skipped`.
  - [ ] `zero baseline → none`.
  - [ ] `missing days count as 0`.
  - [ ] `ROAS −35% on 11-22 with 6 and 25 purchases (baseline 11-15..11-21) → ROAS_DOWN with day 11-22`.
  - [ ] `ROAS drop only on 11-25 (yesterday) → none` (the conversion rules don't look at D_spend).
  - [ ] `−50% with 3 purchases on D_conv → none`.
  - [ ] `campaign spends with no purchases on 11-20..11-22, purchase on 11-10 → NO_PURCHASES with day 11-22`.
  - [ ] `no purchases on 11-23..11-25 only → none`.
  - [ ] `never had a purchase (awareness) → none`.
  - [ ] `purchase only on 10-22 (outside D_conv−30..D_conv−3) → none`.
  - [ ] `only 2 days → none`.
  - [ ] `3-day spend €15 → none`.
  - [ ] `pacing status over, through the 5th → OVER_PACE, day = through`.
  - [ ] `pacing ratio 3.0, through the 2nd → none`.
  - [ ] `pacing no_data/no_rate → none`.
  - [ ] `backfill.start after D_spend−7 → no SPEND_UP; after D_conv−7 → no ROAS_DOWN`.
  - [ ] `adAlertText strips a newline and bidi characters from the campaign name`.
  - [ ] `open: SPEND_UP last seen 3 days ago closed; NO_PURCHASES last seen 4 days ago open`.
- Hook, in `data-sources.test.ts` (stub runner with `afterRun`):
  - [ ] `afterRun not called for backfill, partial, stopChain or OFF`.
  - [ ] `afterRun error logged, sync recorded ok, job not retried`.
  - [ ] `queued only when syncedThrough = outcome.window.to`.
  - [ ] `daily + Sync now same day → one job (same key)`.
- db:
  - [ ] `same day twice → one alert`.
  - [ ] `D and D+1 → one alert, lastDay moved`.
  - [ ] `gap of a day → new alert`.
  - [ ] `two accounts' jobs → one OVER_PACE for the month (parallel transactions)`.
  - [ ] `two brands sharing one ad account → each gets its own SPEND_UP`.
  - [ ] `payload naming another brand's source → no-op`.
  - [ ] `other brand's AdDay never read`.
  - [ ] `listAlerts by createdAt and by lastDay, other brand's alerts never listed`.

**Commit (server, web, mobile shared):** "Find Meta Ads spend jumps, ROAS drops, campaigns without purchases and over-pace budgets after each daily sync"

## Task 6: Ads alerts in the bell (1.75 d)

**Files:**
- Modify:
  - `server/auth/permissions.ts`: `keyHolders` and the pure `holdsAll`, with `hasOtherHolder` built on them;
  - `server/tasks/access.ts`: `memberAccess` (the role-and-grants load) and `visibleTasksAcrossSql` → `visibleNotificationsSql`, returning the task and ads branches from one load;
  - `server/digest/build.ts`: `readerAccess` takes its role and grants from `memberAccess` (its brands query and `permissionsOf` stay its own);
  - `server/notifications/list.ts`;
  - new `server/notifications/ads.ts` holding `notifyAdAlert` (`notifyManyTx` is task-shaped);
  - `server/ads/alerts.ts`, which replaces the stub;
  - `shared/api/tasks.ts`, for `NotificationDto.alert`;
  - web `components/shell/notification-bell.tsx`.
- Tests: `tests/task-notifications.test.ts`, `tests/db/task-notifications.db.test.ts`, `tests/db/ad-alerts.db.test.ts`, a new db case for `hasOtherHolder`; web bell test (`tests/notification-bell.test.ts`, or the existing one: check at build).

**One recipient rule, two uses** (security #2 + maintainability #6 + performance #3):
- **`holdsAll(rolePerms, grantPerms, keys)`** (pure): someone with a workspace role holds `keys` on a brand when every key is in role ∪ grant. No workspace role → false.
- **`keyHolders(db, workspaceId, brandId, keys, opts: { clients: boolean; activeOnly: boolean })`:** `hasOtherHolder`'s in-memory logic lifted out (members with their DB or legacy role, legacy roles, the brand's grants), applying `holdsAll` per person. Returns user ids. Never uses `Role.permissions { has }` (Owner and Admin read from code).
  - `hasOtherHolder(ws, brand, userId, key)` becomes `(await keyHolders(…, [key], { clients: false, activeOnly: false })).some((id) => id !== userId)`. For one key, role ∪ grant is the same test as "role or grant", so it doesn't change; `activeOnly: false` keeps today's behaviour (no active filter). New db case pins it.
  - **Recipients:** `keyHolders(tx, ws, brand, ["brand.read", "ads.read"], { clients: true, activeOnly: true })`, after checking the brand isn't archived (archived → none). `clients: true` matches `permissionsOf`'s union; today no client role holds ads.read.
  - **Why not `brandOwners`:** its grant path checks one key on the grant's role alone (no union with the workspace role, no workspace-role requirement), it reads `roleRef` only, and it formats names. Changing that rule would change its task callers.
- **`memberAccess(workspaceId, userId)`** (`access.ts`): today's two queries of `visibleTasksAcrossSql` (`memberRole` + the person's grants, roles included). `readerAccess` uses it too.
- **`visibleNotificationsSql(userId, workspaceId)`** (replaces `visibleTasksAcrossSql`, whose only caller is the bell): one `memberAccess`, then
  - the task branch exactly as today, on alias `t`;
  - the ads branch on alias `n`: `FALSE` without a workspace role; else `n."brandId" IN (<brands where holdsAll(own, grant, ["brand.read","ads.read"])>)`, or every brand when the workspace role alone holds both; plus the `live` check (`Brand` not archived) on `n."brandId"` (t is NULL for these rows under the LEFT JOIN).
  - So the bell's query count is unchanged: two loads plus the main query.

**Interfaces:**
- **`notifyAdAlert(tx, alert, recipients)`:** writes `createMany(skipDuplicates)` rows `{ kind: "AD_ALERT", adAlertId, brandId, workspaceId, userId, dedupeKey: "AD_ALERT:<userId>:<alertId>" }`, with no `taskId` and no `actorId`. Recipients are computed once per job (Task 5).
- **Read rule:**
  - `FROM` becomes `"Notification" n LEFT JOIN "Task" t ON t.id = n."taskId"`.
  - `notificationWhereSql` becomes:
    ```
    n."userId" = … AND n."workspaceId" = …
      AND ((n."taskId" IS NOT NULL AND <task branch on t>)
        OR (n.kind = 'AD_ALERT' AND n."adAlertId" IS NOT NULL AND <ads branch on n>))
    ```
- **`countUnread`:** the fenced unread subquery stays and gains `"kind", "brandId", "adAlertId"`. The join becomes `LEFT JOIN`. Check `EXPLAIN` on the test DB: the unread fence still uses `(userId, workspaceId, readAt, createdAt)`.
- **List:** `COLUMNS` adds the alert's display fields through `LEFT JOIN "AdAlert" al ON al.id = n."adAlertId" AND al."brandId" = n."brandId"`. `EXPLAIN` the read page too: the OR across the LEFT JOIN must keep the `(userId, workspaceId, createdAt desc, id desc)` walk with `LIMIT 21`.
- **`NotificationDto` gains `alert: { kind: AdAlertKind; text: string } | null`**, additive. `text` is `adAlertText` on the server (cleaned there).
- **Web bell:**
  - `notificationText` gets an `AD_ALERT` case: single = `n.alert?.text ?? "Ads alert"`; group = "`<c>` ads alerts".
  - `openOne` for `AD_ALERT` opens `/performance?tab=ads`, switching brand first as for tasks. It is not blocked by `!n.taskId`.
  - The empty text becomes "Nothing new. Task updates and ads alerts show here."
  - The polling doesn't change. The bell stays behind the `tasks` web flag: without it, alerts reach only the digest and the chat.

**Tests:**
- [ ] `alert notifies Manager, Project admin, Owner and Admin (workspace role), not Viewer/Creator/Client reviewer`.
- [ ] `legacy enum role holder notified`.
- [ ] `grant without a workspace role → not notified, not listed`.
- [ ] `ads.read by grant on a role without brand.read on the brand → follows role ∪ grant` (holds both → notified; ads.read alone → not).
- [ ] `disabled user not notified`.
- [ ] `recipients and the read-time rule agree` (one fixture of mixed roles and grants: the notified set equals the set that can list the notice).
- [ ] `notice hidden and uncounted after the reader loses ads.read`.
- [ ] `hidden when the brand is archived` (also for a grant-only reader).
- [ ] `countUnread makes the same number of queries as before` (query count asserted).
- [ ] `task notices list and count exactly as before` (existing suite green).
- [ ] `hasOtherHolder unchanged` (existing tests, plus the new db case: an inactive other holder still counts).
- [ ] `group read for AD_ALERT marks only those`.
- [ ] `episode update sends no second notice`.
- [ ] `prune removes alert notices after 90 days, AdAlert stays`.
- [ ] web: `AD_ALERT opens the Ads tab, switching brand when needed`.
- [ ] web: `alert text rendered as text`.

**Commit (server, web, mobile shared):** "Show Meta Ads alerts in the bell for people who can see ads"

## Task 7: The week's alerts in the Monday digest (0.5 d)

**Files:**
- Modify `server/digest/build.ts` (`adsSection`, `brandSections`, `hasNews`; `AFTER_SWEEP_MS` moves here from `job.ts`, which already imports from `build.ts`, so no import cycle), `server/digest/job.ts` (imports it), `shared/digest.ts`, `server/digest/email.ts` (l. 34) and web `components/digest/digest-view.tsx`.
- Tests: `tests/digest-build.test.ts`, `tests/db/digest-build.db.test.ts`, a new digest email test; web digest page test.

**Interfaces:**
- **The ads section type** becomes `{ kind: "ads"; key: "ads.read"; data: … | null; alerts?: { kind: AdAlertKind; text: string; firstDay: string; lastDay: string }[]; moreAlerts?: number }`.
  - `alerts` is optional, so stored digests without it render as before.
- **Which alerts:** those **raised** in the digest's week, by `createdAt`, not by their day: `listAlerts(scope, { createdFrom: cutoff − 7 d, createdBefore: cutoff }, 10)` with `cutoff = weekAt + AFTER_SWEEP_MS` (`weekAt = sweepAt(weekStart)`, the 3 h after the sweep when digests start). A conversion alert's day is 3 days before it is raised, so a day-overlap rule would drop an alert raised on Monday–Wednesday for the previous week's days. With a fixed cutoff each alert lands in exactly one digest; Monday's own syncs (spread over 2 h) finish before it.
  - `brandSections` gets `weekAt` and adds it to the memo key.
  - Read even when `data` is null (an alert implies a synced source, but don't depend on it).
- **`hasNews`:** `ads` is news when `data?.length || alerts?.length`.
- **Email:** after the ads line, `  - alert: <text>` per alert (text already cleaned by `adAlertText`).
- **Web:** a short list under the ads figures.
- **Permissions:** unchanged. The section's key is `ads.read`, so `refilterDigest` drops the alerts with it.

**Tests:**
- [ ] `alert raised during the week listed; one raised after the cutoff waits for next week`.
- [ ] `ROAS_DOWN for Saturday 11-21 (D_conv), raised in Wednesday 11-25's run (S = 11-24) → in the Monday 11-30 digest`.
- [ ] `alert raised Monday 11-23 06:00 UTC (Monday's sync) → in the 11-23 digest (cutoff 08:00 UTC)`.
- [ ] `reader without ads.read gets no alerts (section dropped)`.
- [ ] `stored body without alerts renders` (email and web).
- [ ] `only alerts → digest still written`.
- [ ] email: `a campaign name with a newline stays on one line`.

**Commit (server, web, mobile shared):** "List the week's Meta Ads alerts in the Monday digest"

## Task 8: Recent alerts in the chat (0.25 d)

**Files:**
- Modify `server/chat/tools.ts` (the `adsSummary` output).
- Tests: `tests/chat-ads-tools.test.ts`.

**Interfaces:**
- **Reads:** `listAlerts(scope, { recentFrom: today − 7 }, 10)` (Task 5), newest first. `recentFrom` compares `lastDay + CONV_LAG_DAYS` for `ROAS_DOWN` and `NO_PURCHASES` (their day is already 3 back when raised), `lastDay` for the others, so every kind stays listed about 7 days after it was last seen.
- **`adsSummary` output:** `alerts: { columns: ["kind", "text", "day", "lastSeen", "open"], rows }`, `moreAlerts`, with `text` from `adAlertText` (cleaned) plus the note "Alerts are checked once a day after the Meta Ads sync; ROAS and no-purchase alerts look at the day 3 days back."
- The prompt line from Task 4 already says to mention open alerts. There is no new tool.

**Tests:**
- [ ] `open alert listed with open true`.
- [ ] `NO_PURCHASES with lastDay 4 days ago still open`.
- [ ] `SPEND_UP last seen 8 days ago left out; NO_PURCHASES with lastDay 9 days ago (raised 6 days ago) still listed, 11 days ago left out`.
- [ ] `other brand's alerts never listed`.
- [ ] `no ads.read → no alerts (tool refused)`.

**Commit (server):** "Tell the assistant about recent Meta Ads alerts"

---

## Build order

**1 → 2 → 3 → 4 → 5 → 6 → 7 → 8.**
- Task 1 first: 2 and 3 register their tools in its map and use its `rangeOf`; it also moves `cleanTitle` to `server/text.ts`, which Task 5 imports.
- Task 3 after 2: it uses `liveSources`.
- Task 4 after 2–3, because the prompt names the tools.
- Task 5 can start in parallel with 2–4 once Task 1 is in (different files, apart from `runner.ts`, `sources.ts` and `shared/`), but merge it after them so the prompt bump happens once.
- Task 6 needs Task 5's table, enum and `adAlertText`.
- Tasks 7 and 8 need Task 5 (`listAlerts`) and are independent of each other. Task 8 also needs Task 2's `adsSummary` tool.

`npm run sync:shared` after Tasks 5, 6 and 7, committing the web and mobile copies.

**Browser check:** the `sma_p2_browser` seed extended with an EUR and an INR ad account and a few weeks of `AdDay`, one campaign with 3 spend days and no purchases ending 3 days back, and a budget at 125 % on the 10th. The bell part needs `WEB_FEATURES` with `tasks`.

## Verification

- [ ] Server unit tests and `npm run test:db` on `sma-testdb` green; web tests green; `tsc` clean in the three repos.
- [ ] `EXPLAIN` on `countUnread` and the notifications list (unread groups and the read page), for a user with 1k task notices, before and after: the same index use. Record it in the PR notes.
- [ ] **Chat**, by hand on the dev seed:
  - As Manager: "how did my ads do last month", "which campaigns waste money", "are we on budget", "revenue per ad spend", "best posts this month", "how are stories doing", "top pages on Google", "what keywords bring traffic" (it should say keywords aren't available).
  - After an ads answer: "is my Google Ads CTR normal?" (web search stays off), then "search the web for typical Meta CTR" (it searches, without the brand's figures in the query).
  - As Viewer: ads refused.
  - As Client reviewer: posts and search allowed, ads refused.
  - Then remove `ads.read` from the Manager and reopen the chat: the ads steps show the refusal.
- [ ] **Alerts:**
  - Run the `ads.alerts` handler on the seed: four kinds raised once, the conversion ones dated 3 days back.
  - Rerun the same day: nothing new.
  - Next day with the condition still holding: `lastDay` moves and there is no second notice.
  - The bell shows them for Manager and Owner and not for Viewer, and opens the Ads tab.
  - The digest for the seeded week lists them.
- [ ] Update `docs/HANDOVER.md` and DATA_MODEL (AdAlert, `Notification.adAlertId`).
- [ ] Four-lens branch review before merge.

**Live check:** not possible until B&C connects Meta Ads. Its ad account and currency are unknown, so thresholds are checked on fixtures only.

## Ceilings (comments in code where the shortcut lives)

**Chat**
- **Outputs persist:** every tool output is saved in the thread and resent with later turns within the 40-message window. The 12-call total cap bounds one message; a long thread of data questions still grows the prompt until the window moves.
- **Redaction covers tool outputs only:** figures the assistant already wrote in its own text stay visible after someone loses a key (the existing, documented limit; with ads and performance tools it now covers more figures).
- **Chat vs Ads tab:** the chat leaves out switched-off ad accounts (as pacing and the ratio do); the Ads tab counts their kept rows. The tools say so when it applies.
- **`adCampaigns`** sorts all of a period's campaigns in memory. A year at ~100 campaigns is fine; past ~5k campaign rows per range, rank in SQL.
- **`postPerformance`** ranks only the top 500 posts by reach (`MAX_POSTS`). A brand posting more than 500 in 90 days gets a note.
- **Search:** no keyword data. Adding a `QUERY` dimension to `SearchDay` is its own feature, with storage around 10× PAGE.
- **`askedToSearch` is a phrase list:** a request worded outside it ("could you check the internet") doesn't turn search back on; the model says so and the person can rephrase. Add phrases as they turn up.

**Alert evaluation**
- **Once per account day:** if every complete run of a day fails, or the job dies after 3 attempts, that day is never evaluated. The next day evaluates only its own S (and S−3). Upgrade path: evaluate every unevaluated day up to `syncedThrough` (store the last evaluated day in `settings`).
- **`NO_PURCHASES` needs an earlier purchase as a stand-in for a sales objective.** A new sales campaign that never converted is not flagged. Upgrade: read the campaign objective from Meta into `AdDay`.
- **Non-ECB account currencies** (a currency `rateTable` has no rate for) never get the €20-floored rules: `SPEND_UP`, `ROAS_DOWN` and `NO_PURCHASES` are skipped and logged each day. Upgrade: a second rate source.
- **`OVER_PACE` race:** when two accounts' jobs insert the month's alert at once, the loser's figures aren't written; the next day's run updates `values`.
- **Thresholds are global constants.** A per-brand setting is the upgrade if brands differ wildly in size.

**Storage and delivery**
- **`AdAlert` is never pruned.** At a few rows per brand per month it is tiny; prune past 13 months if it ever matters.
- **Bell recipients are fixed when the alert is raised:** someone given `ads.read` later doesn't get old notices. The read rule hides notices from anyone who loses it.
- **The bell is behind the `tasks` web flag:** while it is off, alerts reach only the digest and the chat.
- **Digest timing:** the cutoff is 3 h after Monday's sweep. A Monday sync that finishes later puts its alert in the next week's digest (never lost); it reaches the bell and the chat at once.

## Not taken

- **Correctness minor 9 as written ("filter `adsSummary`"):** the Ads tab's reader `adsSummary`/`totals()` and `adsCampaigns` are not changed; only the chat tools leave OFF accounts out (via `adsDays` and an in-memory filter), so the tab keeps showing an OFF account's kept rows.
- **Maintainability 2, the digest's `synced()`:** not folded into `liveSources`. It is a different rule (it also accepts `lastResult.okAt` with no `syncedThrough`), and changing it would change which digests show "No data yet".
- **Maintainability 6, sharing `readerAccess` itself with the bell:** only its role-and-grants load is shared (`memberAccess`). `readerAccess` adds a brands query and a `permissionsOf` per brand, which would put more queries on the minute-ly bell poll (performance 3).
- **Maintainability minor, renaming `SHOP_DATA_TOOLS` / `readsShopData`:** comments fixed instead; a rename adds churn across tests for no behaviour.
- **Performance 6, 7 and security 7–9:** checked fine by the reviewers; nothing to change.

## Review changes (2026-11-26 four-lens plan review)

- **Correctness:** owner answers applied to the body (D_spend = S for spend and pacing, D_conv = S−3 with shifted baselines, read window S−33..S, per-rule backfill guards, `OPEN_DAYS` per kind, shifted-day tests); open questions and the "evaluate D−1" ceiling removed; digest alerts by `createdAt` against a fixed cutoff; `hasOtherHolder` kept unchanged via `activeOnly`; hook on `p.mode !== "backfill"` and `syncedThrough === outcome.window.to`; `OVER_PACE` dated by `pacing.through` with `GREATEST`; split no-rate test; non-ECB currencies, the `OVER_PACE` race and the `tasks` flag in Ceilings; chat leaves OFF accounts out.
- **Security:** `askedToSearch` narrowed to explicit web-search phrases (Google Ads / Search Console / search results never count), with a behaviour change for catalogue turns; one recipient predicate (brand.read + ads.read on role ∪ grant, workspace role required, active, non-archived) for notify and read; `brandId` in every `subjectKey`; `adAlertText` cleans campaign names for every surface; prompt lists campaign names, URLs and alert text as data and forbids figures in web searches; redaction limit in Ceilings.
- **Performance:** stories capped with `moreStories` and totals from all rows; a 12-call total cap on top of the per-group 8, enforced in `gate` and `activeTools`; `pages` max 25; outputs-persist ceiling; the bell's ads branch built from the same role-and-grants load with a query-count test and the archived check on `n."brandId"`; `adsSummary` from two `adsDays` reads; job read window fixed; `EXPLAIN` on the list query too.
- **Maintainability:** `adsSummary` folds `adsDays` rows through `totalsOf`; one `liveSources` for `metaPacing`, `convertedSpend`, `adsRange` and `searchPerformance`; `rangeOf(input, maxDays, defaultEnd)` and `rangeInput`; `pacing.status === "over"` (no `PACE_OVER`); one `listAlerts` for digest and chat; `keyHolders` lifted from `hasOtherHolder`, with why `brandOwners` doesn't fit; `cleanTitle` in `server/text.ts`; only `AdAlertKind` in `shared/`; `currentMonth` exported; aliases dropped and test imports updated; `searchSummary`'s CTR and position passed through; `server/notifications/ads.ts`; new tests for the digest email, `hasOtherHolder` and the `afterRun` stub runner.
