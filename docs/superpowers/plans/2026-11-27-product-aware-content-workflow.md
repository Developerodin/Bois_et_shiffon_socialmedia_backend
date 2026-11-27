<!-- Written 2026-11-27 by a read-only audit; owner brief in the session scratchpad. Not yet lens-reviewed. -->

# Product-aware content workflow: implementation plan

I audited the server, web and mobile repos read-only and wrote no files. The line numbers below are real and were checked with `grep -n`. Server paths are relative to `apps/server`, web paths to `apps/web`.

## 1. Audit findings

### 1.1 Agents: inputs, outputs, triggers

| Agent | Input schema | Reads | Writes | Starts next |
|---|---|---|---|---|
| Scout `server/agents/definitions/scout.ts` | `{}` strict (:39), `schedule:"daily"` (:40) | brand knowledge, last 40 ideas, live offers (:43-51) | `Opportunity` rows deduped by title (:73-97). Fields: channels, decision, reason, score. **No product ids.** | nothing |
| Planner `planner.ts` | `{chain?}` strict (:43) | up to 5 SHORTLISTED ideas, or the top 3 RECOMMEND (:60-74); campaign "needs" (:51-59); campaign products **as names in the prompt only** (:77-84) | `ContentItem` (opportunityId, campaignId, channel, date, `brief:{angle}`) (:153-166). **No productIds.** Ideas move to PLANNED (:170). Dates come from the deterministic cadence `nextSlot` (:139-150). | `brief {chain:true}` as an `event` trigger (:172) |
| Brief writer `brief.ts` | `{chain?, round?}` (:39) | every PLANNED item in the brand with no version (`WAITING`, :31), 8 per run (:26); ranks the active catalogue by keyword (`rankCandidates`, :70) | brief JSON plus `productIds` (at most 3 from the candidates), status BRIEF_READY (:102-107). **It overwrites `productIds` every time.** | `creator {chain, round}`, and its own next round if posts are still waiting, capped by `CHAIN_ROUNDS=6` (`chain.ts:6`) and `postAiAllowed` (:111-118) |
| Creator `creator.ts` | `{itemId?, chain?, round?}` (:52) | BRIEF_READY items, plus DRAFT_REVIEW items whose latest check is a BLOCKER or that an approver sent back (:80-84), 5 per run | an immutable `ContentVersion`. `body.productIds` comes from `item.productIds` on v1 and from the previous version after that (:87, :230); a compare-and-set under a lock (:234-252) | Quality: per batch in chain mode (:262-269); per item when `itemId` is set (:155, :255) |
| Quality `quality.ts` | `{itemId?, version?, round?}` (:55) | DRAFT_REVIEW items with an unchecked latest version (:59-64) | a `QualityCheck`, then AWAITING_APPROVAL, or DRAFT_REVIEW on a BLOCKER (:133-134) | **nothing.** A blocked draft is rewritten only if a later Creator round runs. |
| Analyst `analyst.ts` | `{}` | pipeline counts, checks, site reports | a `LearningNote`. **Nothing reads LearningNote** (no other reference in `server/`). | nothing |

Context passed between agents is **only the database rows** (status, `brief` JSON, `productIds`, `campaignId`, `opportunityId`). There is no run or workflow id. **Every downstream stage sweeps the whole brand by status**, not by run.

### 1.2 Engine, runs API and status
- `startAgentRun` (`server/agents/engine.ts:41`):
  - takes an advisory lock per brand and agent (:87);
  - **folds any in-flight run whose input is identical** (:88-96), so `{}` and `{chain:true}` do not dedupe;
  - charges `CREDIT_COSTS.manualRun` (5 credits) for **manual** triggers only (:73, `services/credits.ts:10`); Quality is free (`FREE_MANUAL_AGENTS`, credits.ts:13);
  - limits manual runs to 100 per workspace per day (:64).
- Chained runs use trigger `event`, so they are free. Their cost is capped by `postAiAllowed` (60 per day, `services/publishing.ts:171`) and by `CHAIN_ROUNDS`.
- Failures: the Job table allows 5 attempts by default (`schema.prisma:354`). `onAgentRunFailure` (engine.ts:239) moves the run back to QUEUED, or to FAILED with a refund when it is exhausted and `!delivered`. `delivered()` (engine.ts:230) only counts ContentVersions and story renders, so **a failed Planner is always refunded**. `NothingToDoError` ends a run FAILED with an INFO event.
- Runs API, `app/api/v1/.../agents/[agentKey]/runs/route.ts`:
  - POST reads `body.input` (:70) and requires a plan for the Planner (:55-62);
  - GET `?id=` returns `{status, output, reason:"nothing-to-do"}` (:20-38).
- `GET agents` (`agents/route.ts`) returns **only the latest run per agent** (lateral query). Chain rounds that end NothingToDo will show as "Failed".
- `AgentEvent` has `entityType/entityId` (`schema.prisma:416-417`), and agents log per ContentItem. There is no index on entityId.

### 1.3 Trigger paths and the web/mobile discrepancy (exact cause)

| Path | Call | Chain? |
|---|---|---|
| Mobile "Generate calendar" | `mobile/src/api/endpoints.ts:497` sends `body: { input: { chain: true } }` | yes |
| Monthly automation | `server/services/automations.ts:59`: `startAgentRun(... input:{chain:true}, prepaidChargeId)`, charge keyed `monthly-plan:<brand>:<month>` (:58) | yes |
| Web Ideas "Plan posts from these ideas" | `web/components/workspace/content-panels.tsx:209` sends `body: "{}"` | **no** |
| Web calendar empty-state "Plan posts" | `content-panels.tsx:459` calls `onRunPlanner`, which pushes `/?agent=planner` (`calendar-board.tsx:86`). The Run button there calls `startRun` (`workspace.tsx:1370`) | **no** |
| Web Overview tile, home list, chat | `startRun` (`components/agents/api.ts:57`) sends **no body** (callers: `agent-tile.tsx:55`, `workspace.tsx:1620`, `chat-pane.tsx:173`) | **no** |

**Cause:** web never sends `input.chain`. The route passes `undefined` through, the Planner's `chain` is falsy, and `planner.ts:172` does not start the Brief writer. `/social` has no agent entry points; its actions are Connect channel, Analytics and Open full calendar (`web/app/(shell)/social/page.tsx:43-58`).

### 1.4 Product catalogue (`schema.prisma:1123-1157`)
- **Fields:** `id`, `source` (WEBSITE/SHOPIFY/MANUAL/IMPORT/SITE), `externalId`, `sku`, `title`, `url`, `category`, `description`, `materials`, `dimensions`, `certifications` (the last three are entered by people), `price`, `compareAtPrice`, `currency`, `inStock`, `stockQuantity` (Shopify only), `stockCheckedAt`, `imageUrl`, `vendor`, `tags`, `collections` (AskCart only), `archivedAt`.
- **Variants:** one row per variant, grouped by URL handle.
- **Resolution:** `linkedProducts()` (`server/catalog/linked.ts:56`) is "the only way content code reads products". It scopes to workspace and brand, follows archived ids across sources, and returns `{id, row, group, name, state}`.
- **Facts for prompts:** `productFacts()` (`server/content/knowledge.ts:93`) puts id, name, stock, category, materials, dimensions, certifications and variant prices into the Creator and Quality prompts. It does **not** include url or description.
- **Products API:** `GET products?page&q&limit&stock` searches title and SKU server-side and pages the result (`products/route.ts:10-16, 45+`; `server/catalog/products.ts:138`).
- **Existing web product picker:** in the campaign editor (`web/components/products/campaigns.tsx:197`).

### 1.5 Product links today
- `ContentItem.productIds String[]` (`schema.prisma:936`): an id array, which the ponytail note there justifies over a join table. The Brief writer sets it.
- `ContentVersion.body.productIds` is the source of truth from v1 on (`creator.ts:87`; `linkedIds`, `product-checks.ts:67`).
- `Campaign.productIds` (:1195).
- **Opportunity has no product link** (:864-888).
- No ContentItem has a destination or connection id. The connection is chosen at schedule time (`publishing.ts:580-611`), and auto-publish takes the **first ACTIVE connection** for the provider (`automations.ts:89`). Precedent for a planned target: `plannedBoardId/Name` (`schema.prisma:948-949`).

### 1.6 Product-accuracy enforcement that already exists
- **Prompts:** no invented products, prices, materials, stock or certifications (`prompts/content.ts:9, :60, :79, :82`).
- **Quality rules:** deterministic product rows for stock and price, with a price snapshot (`productRows`, `quality.ts:93`), plus offer rows (:98).
- **Gate:** `productGate` re-checks stock and price at approval and scheduling (`publishing.ts:133`, used at :607), with an "Approve anyway" override (`ApprovalDecision.productOverride`).

So price and stock revalidation before publishing already exists.

### 1.7 Channels
- `IntegrationProvider` (`schema.prisma:734-744`): META is Facebook Pages, **one connection row per granted Page** (`server/integrations/providers.ts:237-246`), so there is no Meta parent row. INSTAGRAM, THREADS and PINTEREST are separate logins.
- `ConnectionStatus`: ACTIVE / ERROR (needs reconnect) / REVOKED.
- `CHANNEL_PROVIDER` in `server/services/publishing.ts:47-58` and `web/lib/social-channels.ts:17-27`: LinkedIn and X are `null` (by hand).
- `shared/channel-groups.ts:7` groups `meta` as FACEBOOK plus all Instagram formats; this group is only a calendar filter.
- Planner channels exclude Reels; LinkedIn and X are offered only with `PLANNER_HAND_CHANNELS=on` (`planner.ts:15-23` region), to protect older phone builds.

### 1.8 Status model, approval and publishing
- `ContentStatus`: PLANNED, BRIEF_READY, DRAFT_REVIEW, AWAITING_APPROVAL, APPROVED, SCHEDULED, PUBLISHED, REVIEWED, REJECTED, BLOCKED, CANCELLED (`schema.prisma:905-917`). Agents stop at AWAITING_APPROVAL.
- `decide()` (`publishing.ts:441`) writes an append-only `ApprovalDecision` bound to a version hash. A send-back is rate-limited (20 per day for clients, 30 per hour per person, :481-488) and starts Creator `{itemId}` (`content/[contentId]/route.ts:179`), which then starts Quality (`creator.ts:255`).
- `schedulePublication` requires APPROVED, a current approval and the product gate (:580-611).
- `PublicationAttempt` carries its own status (:1282-1318). This keeps agent run, editorial, approval and publication state separate.

### 1.9 Concurrency notes
- The planner.ts:35 ponytail: a chained run and a manual run can both plan the same campaign needs.
- A retry never re-plans the same idea (:124-126).
- Brief, Creator and Quality write with a compare-and-set, so concurrent sweeps waste AI calls but do not corrupt data.

## 2. Gap table

| Brief requirement | State | What's needed |
|---|---|---|
| Web Plan posts runs the full chain | **Missing** (1.3) | Phase 1 |
| One server orchestration for web and mobile | Partial: the same runs route, but web omits the input | Phase 1 server default, then a `content-workflows` service |
| Scout precedes Planner; start at Planner with shortlisted ideas | Partial: separate manual steps; the Planner takes *all* shortlisted ideas, not chosen ids | Planner `ideaIds`; workflow pause after Scout |
| Persisted workflow context (targets, products, mode, campaign, ideas, schedule, run id) | **Missing** | `ContentWorkflow` table plus `workflowId` columns |
| Product ids on ideas | **Missing** | `Opportunity.productIds` |
| Product ids on planned posts | Partial: set by the Brief writer only, and overwritten | Planner writes them; the Brief writer treats them as locked |
| Product ids on drafts, checks, approvals, publications | **Exists** (`body.productIds`; checks and approval bind to the version) | none |
| Manual product selection, locked | **Missing** | wizard picker (reuse the campaign picker) plus server validation |
| Scout recommends products with reasons | **Missing** | Scout input and output extension |
| Catalogue discovery pool | Partial (the Brief writer's `rankCandidates`) | Scout uses `rankCandidates` within the scope |
| Anti-fabrication rules | Mostly exists (1.6) | add url, "missing fact" flag and product-identity checks |
| Price and stock revalidation before scheduling | **Exists** (`productGate`) | none |
| Destination selection (Page vs IG account) | **Missing** (no destination on the post) | `ContentItem.connectionId` |
| Manual destinations marked for manual publishing | Partial (provider null → "export and post") | surface in the UI and timeline |
| Disconnected = draft-only, explicit | **Missing** | wizard rule plus `connectionId` null |
| Separate per-channel variants | **Exists**: one item per channel; the Creator writes per channel | Planner groupings per product and destination |
| No cartesian explosion, preview count | **Missing** | Planner propose/commit split, caps |
| Bounded Quality → Creator revision | Partial: only within `CHAIN_ROUNDS`; no per-item counter | per-item revision cap, then "needs attention" |
| Status component with Idle/Queued/Running/Completed/Needs attention/Failed | Partial (`GET agents` latest run only) | workflow status endpoint plus mapping |
| Per-post timeline | Partial (versions, checks, decisions, publications in detail; events by entityId) | timeline DTO plus an AgentEvent index |
| Entry points on /social, calendar, channel calendar | **Missing** | Phase 6 |
| Analyst feeds Scout and Planner | **Missing** | Phase 8 |
| Idempotent creation and retries | Partial (engine fold, Job idempotencyKey, the Planner's idea guard) | workflow `requestId` |

## 3. Design

### (a) Canonical workflow entry: a thin `ContentWorkflow` record, stages stay AgentRuns

**Choice:** add a small `ContentWorkflow` table and keep stage execution exactly as it is: AgentRuns plus the job queue plus status-driven sweeps. A `workflowId` goes into the agent input. Do not build a new state machine.

Reusing AgentRun alone can't hold the targets, product scope, schedule preferences, the paused "review ideas/plan" step or the idempotency key without overloading the JSON input. Because the stages are status-driven, **resume from a failed stage is just re-starting that stage with `{chain:true, workflowId}`**: completed upstream work is never redone, because its items have already moved status.

- **Service:** `server/content/workflow.ts`
  - `startWorkflow(scope, userId, input)`
  - `confirmIdeas(id, ideaIds)`
  - `confirmPlan(id, edits)`
  - `retryStage(id, stage)`
  - `cancel(id)`
  - `workflowStatus(id)`
- **Routes:** `POST/GET .../content-workflows`, `GET/PATCH .../content-workflows/[id]`, wrapped in `paidStart` like the runs route.
- **Input contract.** Optional fields only; the Planner and Scout schemas stay `.strict()` and gain optional fields, so older phone builds keep working.
  ```
  { requestId, source: "web-ideas"|"web-wizard"|"mobile"|"automation",
    start: "scout"|"planner",
    targets: [{ channel: ContentChannel, connectionId: string|null, draftOnly?: true }],
    productMode: "manual"|"scout"|"catalogue"|"none", productIds: string[],
    campaignId?, ideaIds?, schedule: { from, to, postsPerTarget, days?, times? },
    reviewPlan: boolean }
  ```
  - `ContentChannel` already encodes the format (`INSTAGRAM_CAROUSEL` and so on).
  - Approval is always required; it is not a flag.
  - The mobile and monthly paths become `startWorkflow({start:"planner", reviewPlan:false})`. Their behaviour is the same as today, but now there is one code path.
- **Idempotency:**
  - the workflow is unique on `(brandId, requestId)`; a repeat returns 200 "repeated" (the `itemForRequest` pattern);
  - stage starts keep the engine's fold;
  - a per-brand advisory lock around the Planner's write loop fixes the planner.ts:35 ponytail.
- **Cancellation:**
  - `status=CANCELLED`;
  - each stage reads its workflow at start and before each item, and stops chaining if it is cancelled;
  - the workflow's PLANNED and BRIEF_READY items with no version go to CANCELLED;
  - drafts that already exist are kept.

### (b) Migrations (all additive, nullable or defaulted)
1. **`ContentWorkflow`** table:
   - fields: `id, workspaceId, brandId, requestId, source, status (DRAFT|SCOUTING|REVIEW_IDEAS|PLANNING|REVIEW_PLAN|RUNNING|DONE|NEEDS_ATTENTION|FAILED|CANCELLED), input Json, chargeIds String[], createdByUserId, timestamps`;
   - constraints: `@@unique([brandId, requestId])`, `@@index([brandId, createdAt])`.
2. **`ContentItem.workflowId String?`** with `@@index([workflowId])`, plus **`ContentItem.connectionId String?`** (the planned destination, modelled on `plannedBoardId`).
3. **`Opportunity.productIds String[] @default([])`**, `Opportunity.productReasons Json?` and `Opportunity.workflowId String?`. Use an array, not a join table, to match ContentItem's convention and `linkedProducts`. Add a GIN index on `ContentItem.productIds` only when the calendar product filter ships (Phase 6), created `CONCURRENTLY` in its own migration as the schema ponytail asks.
4. **`AgentRun.workflowId String?`** with an index. `startAgentRun` copies it from the input so the status endpoint does not have to filter on JSON.
5. **`AgentEvent @@index([entityType, entityId])`**, for the timeline. Use CONCURRENTLY.

**Backfill:** none required. Old posts have null `workflowId`/`connectionId` and keep today's behaviour (auto-publish uses the first account). Optionally set `connectionId` for brands with exactly one ACTIVE connection per provider.

**No new `ContentStatus` or `ContentChannel` values.** "Ready for manual publishing" is derived from `CHANNEL_PROVIDER[channel] === null`, plus APPROVED.

### (c) Product context per agent: server-resolved only
- The client sends **ids only**. `startWorkflow` validates every product id with `linkedProducts(prisma, scope, ids)`: it drops ids whose row is null or outside the brand, and refuses the start if none are left in manual mode. Connections, the campaign and ideas are checked against `workspaceId/brandId`.
- **Scout** (workflow mode):
  - reads candidates via `rankCandidates` over the scope (manual: the locked ids only; catalogue: the active catalogue);
  - outputs `productIds` per idea plus a `productReason`;
  - unknown ids are dropped, as `brief.ts:101-103` does.
- **Planner:**
  - new optional `{workflowId, ideaIds, productIds, targets}`;
  - each plan row gains `productIds` (validated against the workflow scope) and a `connectionId` taken from the targets;
  - in workflow mode it skips the campaign "needs" unless the workflow names a campaign;
  - writes `productIds` and `workflowId` on the ContentItem.
- **Brief writer:** **if `item.productIds` is non-empty, its candidates are exactly `linkedProducts(item.productIds)` and it must not replace them** (change at `brief.ts:70, :103-107`). It ranks the catalogue only when the list is empty and the mode is not manual.
- **Creator and Quality:** already use `productFacts(linkedProducts(...))`. Add `url` (as a verified link) and a short `description` to `productFacts`.
- **Anti-fabrication additions** (bump `CONTENT_PROMPT_VERSION` to 13):
  - "Facts not in the linked product facts → omit or add to `questions`" (Brief writer);
  - the Creator gets a `needsConfirmation: string[]` field, stored in the body;
  - a Pin link may only be a linked product's `url`.
- **New deterministic Quality rows** (pure, in `product-checks.ts`):
  1. **Product identity:** `body.productIds` ⊆ the workflow's locked set (blocker in manual mode).
  2. **Product present:** a product-focused post (workflow `productMode≠none`) has at least one live linked id (blocker).
  3. **URL validity:** any product URL in the text or `pinLink` equals a linked row's `url` (blocker).
  4. **Unconfirmed facts:** a non-empty `needsConfirmation` produces a warn.
  5. Brand voice, platform and quality checks are unchanged.

### (d) Destinations
- **Destination list**, from server `listConnections` plus `CHANNEL_PROVIDER`, as one row per:
  - ACTIVE META connection (a Facebook Page);
  - ACTIVE INSTAGRAM, PINTEREST or THREADS connection;
  - LinkedIn and X (manual);
  - provider with no ACTIVE connection: shown as "Not connected, draft only", selectable only with an explicit checkbox.
- ERROR connections show "Needs reconnect" and are treated as draft-only. There is no "Meta" parent row, because META rows are already Pages.
- **Stored on the post:** `connectionId` (null for manual or draft-only).
- **Auto-publish and schedule:**
  - `autoPublish` (`automations.ts:89`) prefers `item.connectionId` when it is ACTIVE and never falls back to another account of a different identity;
  - with a null `connectionId` on a draft-only workflow, nothing auto-publishes;
  - the schedule dialog preselects `connectionId`.
- Manual channels end at APPROVED, shown as "Ready to post by hand" (the existing `registerManualPost` and `postUrl` flow).

### (e) Avoiding cartesian explosion
- The Planner proposes rows `{ideaId, productIds, channel, connectionId}` under hard caps:
  - `postsPerTarget × targets ≤ MAX_WORKFLOW_POSTS = 30`, which matches `CHAIN_ROUNDS` (30 drafts);
  - each product appears on at most N targets (the model is told to choose the best-fit channels, not all of them).
- **Preview without an extra AI call:** when `reviewPlan:true`, the Planner creates the items as PLANNED (these are the preview) and sets the workflow to REVIEW_PLAN **without chaining**. The wizard lists them with date, channel, product and idea. The user can delete rows (CANCELLED) or change product or destination, then **Confirm**, which starts `brief {chain:true, workflowId}`.
- Before the Planner runs, the wizard shows the upper-bound count (`postsPerTarget × targets`). More than 12 posts needs a second confirmation.

### (f) Charging
- One charge per **user-initiated AI stage**, never per chained stage: Scout in a workflow costs 5 credits, the Planner 5 credits, and Brief/Creator/Quality stay free `event` runs, as today. Both prices show in the wizard (`useRunPrice`).
- The workflow service charges with `spendCredits({refId:"workflow:<id>:<stage>"})`. The `CreditEntry @@unique([workspaceId, reason, refId])` makes retries of the POST unable to double-charge. It passes `prepaidChargeId` to `startAgentRun` (the monthly-plan pattern, `automations.ts:58-61`), and refunds if the engine folded the run into another one.
- A failed, exhausted Planner is refunded by the engine. A **retry** of that stage charges again with refId `workflow:<id>:planner:<attempt>`, and the button shows the price. Retrying a downstream stage is free, within `postAiAllowed`.
- Mobile and monthly keep their current single Planner charge.

## 4. UI plan (web)
- **`CreateWithAgentsDialog`** (`components/workflow/create-dialog.tsx`), with props `{preset: {channel?|filter?, connectionId?, date?, campaignId?}}`. Steps:
  1. **Destinations:** checkbox rows (icon, name, state, capability), using `CHANNEL_PROVIDER` and the connections API.
  2. **Products:** three radio modes plus a server-searched picker (`products?page&q`, chips with thumbnail, title, SKU, price, stock), extracted from `campaigns.tsx:197`.
  3. **Ideas:** "Find fresh ideas" (Scout) or "Use shortlisted" (a checklist from `opportunities`, REJECT hidden); campaign select.
  4. **Schedule:** defaults from the brand timezone and cadence.
  5. **Review:** after the Planner, the plan table and count.
  6. **Start.**
- The Scout step shows ideas with products and reasons; the user selects them, then the Planner runs.
- **Entry points:**
  - `/social`: a secondary "Create with agents" button added to `actions` (`social/page.tsx:43`), with no heading. A "Create posts with AI" item on each row in `social-landing.tsx` presets that row's `filter`.
  - Calendar: "Generate with agents" beside New post (`content-panels.tsx:434, :459`), inheriting `filter.channel` and the clicked day. The empty-state "Plan posts" stops routing to `/?agent=planner`.
  - Channel calendar header (`channel-calendar-header.tsx`): presets its provider's connection.
- **`AgentWorkflowStatus`:** a compact, collapsible component on /social and the calendar. It has one row per agent with a state, counts from the workflow status endpoint (items per status for active workflows; Analyst separate, with its own "Run analysis"), and actions gated by dependencies. Click-through reuses `run-events.tsx` and `agent-log.tsx`.
- **State mapping:**
  - QUEUED → Queued;
  - RUNNING → Running;
  - SUCCEEDED → Completed;
  - FAILED with last event INFO (nothing to do) → **Idle**, not Failed;
  - FAILED otherwise → Failed;
  - items stuck at a BLOCKER after the revision cap → Needs attention.
- **Per-post timeline:** in the post detail (peek). It is built server-side from:
  - the item's `workflowId`;
  - the Opportunity;
  - AgentEvents by entityId (the new index);
  - versions and checks;
  - decisions;
  - publication attempts.

  The stages are Idea, Planned, Brief ready, Drafting, Quality checked, Awaiting approval, Approved, then either Scheduled or Ready to post by hand, then Published. Agent run state is shown separately from editorial, approval and publication state.
- Calendar cards gain a compact product label; filters for product and stage come in Phase 6.

## 5. Phases (in the brief's priority order)

| # | Scope | Files | Migration | Tests | Size | Shippable checkpoint |
|---|---|---|---|---|---|---|
| **1** Orchestration parity | **Server:** `startPostsChain()` in `server/content/workflow.ts` (starts the Planner with `{chain:true}`); the runs route sends Planner starts there and **defaults `chain` to true unless `chain:false`**, so every client takes the mobile path. `automations.ts` calls the same helper. Add the per-brand advisory lock around the Planner write loop (planner.ts:35). **Web:** `content-panels.tsx:209` sends `{input:{chain:true}}` explicitly; `RunWatch` copy becomes "Planned, writing drafts…" (the chain keeps going after the Planner run ends). | runs route, planner.ts, automations.ts, new workflow.ts; web content-panels.tsx | **no** | the route passes chain to the Planner; Planner `chain` starts the Brief writer (mocked `startAgentRun`); `{}` and `{chain:true}` now fold; monthly regression (`automations.test.ts`); the lock stops a double campaign plan | 4–6 h | Web Plan posts, the calendar empty state and the Overview Run all produce drafts awaiting approval, the same as mobile. Side effect: PLANNED items left by earlier web runs are swept up by the first chained run (mention in release notes). |
| **2** Context persistence | `ContentWorkflow` and the columns from 3(b); `startWorkflow`/status/cancel/retry; `workflowId` threaded through all five agents' optional input; Brief writer keeps locked `productIds`; Planner `ideaIds`/`productIds`/targets; workflow routes and the shared contract (run `npm run sync:shared` and restamp the hash, as in recent commits) | prisma, workflow.ts, 5 agent defs, engine (copy `workflowId`), new routes, `shared/contract` | **yes** (1–5) | product-id survival from Planner to Brief, Creator and Quality; manual mode never substitutes; tenant isolation (foreign product, connection or idea ids refused); idempotent POST; resume re-runs only the failed stage; cancel stops chaining | 14–18 h | The API runs a product-locked workflow end to end; mobile is unchanged |
| **3** Selectors | Wizard steps 1, 2 and 4; product picker extracted from campaigns; destination list; Scout product mode (`Opportunity.productIds`, reasons); REVIEW_IDEAS pause | web `components/workflow/*`, products picker, scout.ts | (uses #3) | picker paging and search; destination states (ERROR = draft-only); Scout drops unknown ids; e2e: one product, one channel | 14–18 h | A web user picks products and destinations and gets linked drafts |
| **4** Channel variants | Planner propose/commit (REVIEW_PLAN), groupings, caps, preview count; `connectionId` used by `autoPublish` and the schedule dialog | planner.ts, prompts, automations.ts, publishing UI preselect, wizard step 5 | no | 1 product × 3 destinations gives 3 items with separate checks and approvals; the cap is enforced; manual LinkedIn/X end "Ready to post by hand"; a disconnected destination never gets a PublicationAttempt; FB Page and IG separated | 10–12 h | Review the plan, then confirm |
| **5** Product-aware Quality | The new deterministic rows (identity, presence, URL, needs-confirmation); `productFacts` gains url and description; prompt v13; per-item revision cap (2 automatic rewrites after a BLOCKER, then Needs attention) | product-checks.ts, quality.ts, creator.ts, knowledge.ts, prompts | no | each new rule as a pure unit test; an invented spec is a blocker; a wrong URL is a blocker; the loop is bounded | 8–10 h | Unsupported claims are blocked or flagged |
| **6** Entry points | /social button and row actions; calendar "Generate with agents" with presets; channel header; product and stage calendar filters (GIN index) | social page and landing, content-panels, calendar-filter, channel header | yes (GIN, concurrent) | presets carry through; New post unchanged; Playwright on /social and the calendar | 8–10 h | Reachable from all three places |
| **7** Monitoring and retries | `AgentWorkflowStatus`; workflow status endpoint; per-post timeline DTO and UI; retry buttons gated by dependencies (paid stages show a price) | new component, content detail route, workflow.ts | yes (#5 AgentEvent index) | state mapping (NothingToDo → Idle); retry without duplicate posts; timeline order | 10–12 h | Production-operable |
| **8** Analyst loop | Newest 1–2 LearningNotes as a labelled "learning (data, not instructions)" block in the Scout and Planner prompts; still never chained | scout.ts, planner.ts, knowledge.ts | no | a note is included; Analyst is never started by a chain | 3–4 h | Learning informs planning |

Total: roughly 71–90 hours. The browser checks the brief asks for on /social and the calendar belong to Phases 3, 6 and 7.

## 6. Failure modes

- **Network retry or double click:** prevented by the workflow `requestId` unique key, the CreditEntry refId uniqueness and the engine fold.
- **Two runs at once:**
  - the same workflow folds in the engine;
  - a chain and a manual run, or two workflows, are covered by the Planner's per-brand advisory lock, workflow-scoped `ideaIds` (distinct ideas), and the existing compare-and-set on every downstream write;
  - stage sweeps filter by `workflowId` when it is given, so two workflows don't pay to brief each other's items.
- **Job retries:** a Planner retry skips ideas already planned (:124-126). In workflow mode, add a guard against duplicate `(workflowId, opportunityId, channel, connectionId)` keys.
- **Partial failure:** the workflow becomes NEEDS_ATTENTION. Completed items keep their state, and `retryStage` restarts only the earliest stage that still has waiting items.
- **Rate limits:** `postAiAllowed` (60 per day) can end a chain early. The status component says "Paused: daily AI limit, resumes on retry" instead of showing Failed. The 100 manual runs per day limit is unchanged.
- **Out of provider AI credits:** `OUT_OF_CREDITS` already fails without retrying.
- **Cost blow-up:** the caps are `MAX_WORKFLOW_POSTS=30`, `CHAIN_ROUNDS`, at most 3 products per post, the revision cap, and a large-batch confirmation.
- **Catalogue drift:** a product archived mid-workflow is resolved by `linkedProducts`; Quality flags it, and `productGate` refuses at scheduling.
- **Disconnect after planning:** `schedulePublication` already requires ACTIVE. `autoPublish` skips the post and leaves it APPROVED.

**Out of scope:**
- mobile UI changes (mobile keeps working through the same service);
- Reels in the Planner (they are made in Studio);
- image generation;
- auto-publish when Quality passes (never);
- new publishing APIs for LinkedIn, X or Threads;
- per-post billing;
- a join table for products;
- analytics for channels that don't provide them.

## 7. Open questions for the owner

1. **Pricing:** should a workflow still cost only 5 credits for the Planner (plus 5 for Scout) no matter how many posts it makes, or should large batches cost more, for example per 10 posts?
2. **Overview "Run Planner" button:** should it always chain (Phase 1 default), or stay Planner-only, with chaining only from Plan posts and the wizard?
3. **Brand-only posts:** in "Scout recommends" mode, may some ideas be brand-only (no product), or must every post have a product unless the explicit brand-only switch is on?
4. **Revision cap:** is 2 automatic Creator rewrites after a Quality blocker the right limit before "Needs attention"?
5. **Hand channels on web:** should the wizard offer LinkedIn and X on web now, ahead of `PLANNER_HAND_CHANNELS` (which exists for older phone builds)?
6. **Draft-only:** may draft-only posts for disconnected channels be scheduled later once the channel connects (yes by default, via the normal approval and schedule flow)?

### Critical files for implementation
- `C:\Users\INTEL\Desktop\Social Media Agent\apps\server\server\agents\definitions\planner.ts`
- `C:\Users\INTEL\Desktop\Social Media Agent\apps\server\server\agents\definitions\brief.ts`
- `C:\Users\INTEL\Desktop\Social Media Agent\apps\server\server\agents\engine.ts`
- `C:\Users\INTEL\Desktop\Social Media Agent\apps\server\app\api\v1\workspaces\[workspaceId]\brands\[brandId]\agents\[agentKey]\runs\route.ts`
- `C:\Users\INTEL\Desktop\Social Media Agent\apps\server\prisma\schema.prisma`
- `C:\Users\INTEL\Desktop\Social Media Agent\apps\web\components\workspace\content-panels.tsx`

## Owner answers (2026-11-27, ~17:00 IST)

1. **Pricing:** flat, as planned: 5 credits for the Planner (+5 when Scout runs), whatever the post count.
2. **Chain from every Planner start, with a person's check at each step:** the Planner always starts the full chain
   (Phase 1 default), but the workflow pauses for a person where the plan already allows it: review Scout's ideas
   (REVIEW_IDEAS), review the planned posts (REVIEW_PLAN), and every post still ends at human approval. To confirm with
   the owner: whether Brief → Creator → Quality should also pause between stages, or run through to approval.
3. **Brand first:** posts are about the brand; a product is optional. When a post names a product, it must be one of the
   brand's own catalogue products and is checked against it (identity, facts, URL).
4. **Revision cap 2, then Needs attention:** the post shows the problem (the Quality findings), the suggested fix, and a
   Rewrite action (a Creator run with the findings).
5. **LinkedIn and X:** leave them out of agent planning for now (PLANNER_HAND_CHANNELS stays off).
6. **Disconnected channel:** a post planned for a channel that is disconnected stays a draft. If its date is in the
   future: a notification plus an attention badge on that channel's row on /social. If its date has passed: nothing.

**Answer 2, confirmed 17:22:** "one approval then move to next agent". A workflow pauses after each agent for one
approval of that stage's output (the batch, not each post one by one), then the next agent starts:
Scout → approve ideas → Planner → approve plan → Brief writer → approve briefs → Creator → Quality (the check runs on
each draft right away) → approve each post (the existing per-post approval). Workflow statuses: REVIEW_IDEAS,
REVIEW_PLAN, REVIEW_BRIEFS, then RUNNING/DONE. Applies to workflows started from the web (Plan / Create with agents).
The mobile "Generate calendar" and the monthly automation keep running straight through until the owner says otherwise.
