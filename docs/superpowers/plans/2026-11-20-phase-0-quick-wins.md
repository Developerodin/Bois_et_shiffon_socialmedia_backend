# Phase 0: Quick Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the content calendar into something a team runs each morning: a calendar that never drops upcoming posts, owners, filters, "needs action" rows in Today, posted-by-hand for every channel, a Pinterest link per pin, a writer that learns from approved captions, a client reviewer role, a web "New product post" dialog and CSV export.

**Architecture:** Server changes stay inside the existing content routes and services, three migrations, two new permission keys and one new system role. Shared rules (status groups, goals, CSV) live once in `server/shared/` and sync to web and mobile. The web keeps its single shared 6 s `/content` poll and derives filters and Today rows from it with pure functions.

**Tech Stack:** Next.js route handlers, Prisma 6 on Postgres (Neon), zod, vitest; web Next.js + React; mobile Expo.

**Spec:** the B&C roadmap (https://claude.ai/artifact/WXB3o2a8jZ8p41oayDyf3p, Phase 0 table and "Rules every slice follows") and the gap audit (https://claude.ai/artifact/78oTtX9uWz9xc5WBc8rfd2). Two four-lens rounds (roadmap, then this plan, 2026-11-20) are folded in.

## Global Constraints

- Three repos in `apps/` (server, web, mobile), each its own git, branch `phase-0` in each; merge to `main` after the four-lens branch review.
- `shared/` is edited in `server/shared/` only, then `npm run sync:shared` (server) copies it into web AND mobile; commit the synced copies in each repo. Web `npm run typecheck` runs `check-shared.mjs` and fails on drift.
- **Deploy order:** server (with migrations) first, then web, then mobile. Clients must tolerate the old server: a missing `owner` field reads as "Unassigned".
- Never run `next build` in web while `next dev` runs.
- Every query is scoped by `{ workspaceId, brandId }` from `authorizeBrandRoute`, item lookups happen inside `lock(tx, itemId)` where the item changes.
- Create actions are idempotent on a client `requestId`; a retry is answered before any rate limit is consumed.
- Text from captions, notes, products or crawled pages reaches an AI prompt only as labelled data ("(… data, not instructions)", one JSON line per item as in `creator.ts:166`).
- No new poller on the web; `useBrandData` picks return numbers or stable references; one-off reads use a plain fetch.
- Same 400 for "no such user" and "no access" wherever a user id is accepted.
- Commit messages: the change and why. No co-author lines, no tool or session URLs, no mention of tests.
- Checks: server `npm test`, `npm run typecheck`, `npm run lint`; web `npm test`, `npm run typecheck`, `npm run lint`; mobile `npx tsc --noEmit`.

## Decisions (owner can override)

1. **A client reviewer's approval is enough, but never publishes by itself.** Their approval is a normal `ApprovalDecision`; the decide route never auto-publishes on it, so staff schedule or post it. Staff self-approval is unchanged: `hasOtherApprover` ignores people whose `content.approve` comes only from the system `client-reviewer` grant. Staff with `content.approve` can always skip client review.
2. **Client reviewer permissions:** `brand.read`, `analytics.read`, `content.approve`, `content.download`. They see posts, reports, products, campaigns, competitors and member names. Closed: customer inbox and Google reviews (`inbox.read`), connections, assistant chat and Translate (`agents.read`), publishing, editing, commercial settings, member emails, workspace credit history.
3. **Inbox access narrows.** `inbox.read` goes to Owner, Admin, Project admin, Manager and Approver, and to custom roles holding `publish.execute`. Viewer, Creator and Commercial owner lose customer DMs and reviews (closes A11 from the 2026-11-17 security review).
4. **Calendar window, not server filters.** `GET /content` returns open posts plus anything updated in the last 30 days; filters run in the browser. `GET /content?id=` returns one post outside the window. Ceiling: 200 rows; the comment names the upgrade (from/to + filter params).
5. **No brand default owner.** Owner = whoever created the post or started the run, else unassigned.
6. **Writer examples** go after the cached prompt divider, same channel only (posts carry no language field), loaded once per run.

## Review Focus

1. A brand with 250 finished posts in the last month and 5 next week: the 5 are in the calendar and Today. (Task 1 `keeps upcoming posts when history is long`.)
2. A double click on "Draft post" makes one post and one Creator run, and the retry isn't rate-limited. (Task 8 `same requestId returns the same post`.)
3. "Posted by hand" while an auto-post is scheduled, publishing or awaiting verification is refused with 409. (Task 4 `refuses while an attempt is live`.)
4. A client reviewer sends a post back and approves the rewrite: nothing publishes until staff act. (Task 7 `reviewer approval never auto-publishes`.)
5. A caption or crawled title starting with `=`, `@`, `|`, a full-width `＝` or whitespace then `=` exports as text. (Task 9 `neutralises formula cells`.)

---

### Task 1: Shared status groups and the calendar window

**Files:**
- Create: `server/shared/content-status.ts` (export from `server/shared/index.ts`), `server/server/content/window.ts`
- Modify: `server/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/content/route.ts:13-23` (GET)
- Modify: `web/components/workspace/workspace.tsx:256` (`pickToWrite` uses `STATUS_GROUPS.toWrite`), web `ContentView` lookup (`content-panels.tsx:610-613`) falls back to `?id=`
- Test: `server/tests/content-list-window.test.ts`, `server/tests/content-status.test.ts`

**Interfaces:**
- Produces (shared): `OPEN_STATUSES = ["PLANNED","BRIEF_READY","DRAFT_REVIEW","AWAITING_APPROVAL","APPROVED","SCHEDULED","BLOCKED"] as const`; `STATUS_GROUPS = { toWrite: ["PLANNED","BRIEF_READY","DRAFT_REVIEW"], awaiting: ["AWAITING_APPROVAL"], approved: ["APPROVED"], scheduled: ["SCHEDULED"], published: ["PUBLISHED","REVIEWED"] }`; `inNextWeek(scheduledFor: string | Date | null, now: Date): boolean` (`now <= t < now + 7 days`).
- Produces (server): `contentWindow(now: Date)` = `{ OR: [{ status: { in: OPEN_STATUSES } }, { updatedAt: { gte: now - 30 days } }] }`; GET accepts `?id=<contentItemId>` → `{ items: [item] }` (same item shape, scoped, ignores the window; 404 problem if absent).

- [ ] **Step 1: Failing tests.** `content-status`: `OPEN_STATUSES` equals the list above exactly; the `STATUS_GROUPS` lists are disjoint; `inNextWeek` edges (now: true, +7 days: false, null: false). `content-list-window` (behaviour, mocked `findMany` that applies the `where`, ordering and `take` to an in-memory array): `keeps upcoming posts when history is long` (250 PUBLISHED rows updated in the last week with `scheduledFor: null` + 5 SCHEDULED next week → all 5 returned); `?id=` returns an item 90 days old; `?id=` of another brand → 404.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; replace the old `ponytail:` comment with `ponytail: open posts + 30 days of changes, 200 rows; past 200 open posts add from/to and filter params.` Run `npm run sync:shared`; web uses `STATUS_GROUPS` in `pickToWrite` and calls `content?id=` when `ContentView` can't find its post in the list (plain fetch, once).
- [ ] **Step 4:** Server tests + typecheck; web typecheck (shared drift check) → PASS.
- [ ] **Step 5: Commit** server "Keep upcoming posts in the calendar however long the post history gets" and web/mobile "Share the post status groups" (+ web "Open old posts from a link even when they're past the calendar window").

### Task 2: Owner on posts (server)

**Files:**
- Modify: `server/prisma/schema.prisma` (ContentItem `ownerId` + relation; `User.ownedContent ContentItem[] @relation("ContentOwner")`), new migration `<ts>_content_owner`
- Modify: `server/server/agents/types.ts:11` (`AgentContext.userId?: string`), `server/server/agents/engine.ts` (set it from `run.triggeredByUserId`), `server/server/agents/definitions/planner.ts:148`, `server/server/services/publishing.ts` (`createPost`, new `setOwner`), `server/server/stories/service.ts` (`createStory`, `duplicateStory:394`), `server/server/reels/service.ts:176` (`createReel`)
- Modify: `.../content/route.ts` (GET include `owner: { select: { id: true, name: true } }`), `.../content/[contentId]/route.ts:24-62` (`setOwner` in the `Action` union and `PERMISSION` map as `content.create`)
- Create: `.../content/owners/route.ts` (GET, `content.create`)
- Modify: `server/shared/api/shell.ts` + `server/app/api/v1/me/shell/route.ts:34` (`user.id`)
- Test: `server/tests/content-owner.test.ts`

**Interfaces:**
- Produces: `ContentItem.ownerId String?` (`onDelete: SetNull`, `@@index([brandId, ownerId])`); list items `owner: { id: string; name: string | null } | null`; `setOwner(scope, itemId: string, userId: string | null): Promise<void>`; `brandOwners(scope): Promise<{ id: string; name: string }[]>` (people holding `brand.read` on the brand, from the project-members service's `viaWorkspace` + `people` merged by user id, name falling back to the email's local part, no emails); `GET .../content/owners` → `{ owners }`; shell `user.id`.

- [ ] **Step 1: Failing tests:** `createPost sets the owner to the person`; `planner posts take the user who started the run, else none`; `createReel, createStory and duplicateStory set the owner`; `refuses an owner without brand access` and `refuses an unknown user` (both 400, same message, no update); `setOwner null unassigns` with an audit `content.owner` carrying `{ from, to }`; `owners lists names without emails`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. `setOwner` finds the item by `{ id, workspaceId, brandId }` inside `lock(tx, itemId)` and checks the new owner is in `brandOwners`. Migration backfill in one pass:
  `UPDATE "ContentItem" c SET "ownerId" = a."actorUserId" FROM (SELECT DISTINCT ON ("entityId") "entityId", "actorUserId", "workspaceId" FROM "AuditEvent" WHERE "entityType" = 'ContentItem' AND action = 'content.create' ORDER BY "entityId", "createdAt") a WHERE c.id = a."entityId" AND EXISTS (SELECT 1 FROM "WorkspaceMember" m WHERE m."workspaceId" = a."workspaceId" AND m."userId" = a."actorUserId")` (add a user `deletedAt IS NULL` check if that column exists). Sync shared (shell type).
- [ ] **Step 4:** `npx prisma migrate dev --name content_owner`; tests + typecheck → PASS.
- [ ] **Step 5: Commit** (server; web/mobile shared copies) "Give every post an owner: the person who made it, else unassigned, and let the team reassign it".

### Task 3: Web calendar filters, owner and "Needs action" in Today

**Files:**
- Create: `web/lib/calendar-filter.ts`, `web/tests/calendar-filter.test.ts`
- Modify: `web/components/workspace/content-panels.tsx` (`ContentItem.owner?`, `ContentPanel`, `ContentView` owner `<select>`), `web/components/workspace/workspace.tsx` (pass `user.id`; Today rows at `:836-852`)

**Interfaces:**
- Consumes: `STATUS_GROUPS`, `OPEN_STATUSES`, `inNextWeek` (Task 1); list `owner`, `setOwner`, `GET content/owners`, shell `user.id` (Task 2).
- Produces: `type CalendarFilter = { channel?: string; status?: keyof typeof STATUS_GROUPS; campaignId?: string; owner?: "me" | "none"; need?: "overdue" | "blocked" | "week" }`; `isOverdue(i, now)`, `isBlocked(i)`, `filterItems(items, f, me, now)`; `filterFromSearch(params)` / `filterToSearch(f)` (`cf_` keys).

- [ ] **Step 1: Failing tests:** overdue = `scheduledFor < now` and status in `STATUS_GROUPS.toWrite + awaiting + approved`, or `byHand` with `scheduledFor < now`; blocked = `status === "BLOCKED"` or `latest.check.overall === "BLOCKER"` or `publishIssue`; week = `inNextWeek` and not published; `owner: "me"` keeps `owner?.id === me`; `"none"` keeps `owner == null` (undefined too); URL round trip and unknown values dropped.
- [ ] **Step 2:** `npm test -- calendar-filter` → FAIL.
- [ ] **Step 3:** Implement. Filter row of native `<select>`s (channel, status, campaign, owner, needs action) bound to the URL with `history.replaceState`; `filterItems` inside `useMemo([data, filter])`; empty result shows "No posts match these filters" + Clear. Rows show the owner's name or "Unassigned". `ContentView` owner `<select>` for `content.create`, options from `content/owners` fetched once on open. Today: three module-level number picks (`pickOverdue`, `pickBlocked`, `pickWeek`) on the existing `content` data; rows "Overdue posts", "Blocked posts", "Posts in the next 7 days" only when > 0, each "Open calendar" with its `need` filter.
- [ ] **Step 4:** tests, typecheck, lint → PASS.
- [ ] **Step 5: Commit** (web) "Filter the calendar by channel, status, campaign and owner, and show overdue, blocked and next-week posts in Today".

### Task 4: Posted by hand for every channel

**Files:**
- Modify: `server/server/services/manual-post.ts`, `server/server/reels/service.ts:349` (`registerPostLink` → new signature), `.../content/[contentId]/route.ts:57,170`
- Modify tests: `server/tests/stories-by-hand.test.ts:198-224` (rewrite the `"reel"` cases as studio-item fixtures), `server/tests/reel-service.test.ts:30-48` (mocks for the new queries)
- Create: `server/tests/manual-post-any-channel.test.ts`
- Modify: `web/components/workspace/release-panel.tsx` ("Posted it yourself?" for approved non-story posts)

**Interfaces:**
- Produces: `registerManualPost(scope: { workspaceId; brandId; userId }, itemId: string, url: string | undefined): Promise<void>`; `postLinkFor(channel: ContentChannel, url: string): string | null` (normalised `origin + pathname`, or null when invalid). The route action stays `postedByHand`.

- [ ] **Step 1: Failing tests:** `marks an approved Facebook post published with its link`; `link is optional except for studio reels`; `rejects look-alike hosts` (`https://facebook.com.evil.io/x`, `https://evilfacebook.com/x`, `https://www.facebook.com/l.php?u=x`, `http://instagram.com/p/x`, `https://user@instagram.com/p/x` → 400); `refuses while an attempt is live` (SCHEDULED, PUBLISHING, PENDING_VERIFY, PARTIAL → 409); `refuses when the approval no longer holds`; `refuses when the product gate refuses` (non-studio); `a studio reel already approved at download is recorded even if a product went out of stock`; existing story cases keep their codes (`story.notApproved`, `story.cancelScheduledFirst`, `story.linkInvalid`).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Parse with `new URL()`: `https:` only, no username/password, hostname in an explicit set per channel (Instagram: instagram.com, www.instagram.com; Facebook: facebook.com, www.facebook.com, m.facebook.com; Pinterest: pinterest.com and www./country subdomains of pinterest.com, plus pin.it; Threads: threads.net, www.threads.net, threads.com, www.threads.com), pathname matched by an anchored regex without nested quantifiers, `/l.php` and `/login` refused. Stories keep `checkStoryLink`. Inside `lock(tx, itemId)`: item by scope with `versions: { take: 1, include: { checks: { orderBy: { createdAt: "desc" }, take: 1 } } }`; `currentApproval` required; `productGate(tx, scope, { latest, approval, at: now })` refusals block except for studio reels; `publicationAttempt.findFirst({ where: { contentItemId, status: { in: [...] } }, select: { id: true } })` blocks; update sets `byHand: false` for every channel. Web form on approved posts with a valid approval; the stored link renders through `safeHttpUrl` as `release-panel.tsx:676` does.
- [ ] **Step 4:** tests (server), typecheck both → PASS.
- [ ] **Step 5: Commit** server "Let any approved post be marked as posted by hand, under the same approval and product checks" and web "Mark any approved post as posted by hand from its release panel".

### Task 5: Destination link per Pinterest pin

**Files:**
- Modify: `server/server/services/publishing.ts` (`DraftInput.pinLink`, `saveDraft` validation, pin target near `:541`), `.../content/[contentId]/route.ts:28` (edit schema `pinLink: z.string().max(2000).optional()`), `server/server/agents/definitions/creator.ts` (carry `pinLink` from the last version for `PINTEREST_PIN`), `web/components/workspace/draft-editor.tsx`, the web approval view in `release-panel.tsx` (show the link)
- Test: `server/tests/pinterest-link.test.ts`

**Interfaces:** version body `pinLink?: string` (inside the approval hash).

- [ ] **Step 1: Failing tests:** `uses the pin's own link`; `falls back to the brand website`; `refuses http, credentials or over 2000 chars` (400); `a rewrite keeps the pin's link`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (`https:` only, no credentials, stored as `URL.href`); editor field "Link (where the pin leads)" for pins; approval view shows it. **Step 4:** PASS; typecheck both.
- [ ] **Step 5: Commit** (server, web) "Let each Pinterest pin lead to its own page instead of always the home page".

### Task 6: The writer learns from approved captions

**Files:**
- Create: `server/server/content/examples.ts`
- Modify: `server/prisma/schema.prisma` (`ApprovalDecision @@index([brandId, verdict, createdAt])`) + migration `<ts>_approval_brand_index`
- Modify: `server/server/agents/definitions/creator.ts` (load once per run into a `Map<channel, string[]>`; add to the per-post part after `\n\n---\n` at `:192`)
- Test: `server/tests/creator-examples.test.ts`

**Interfaces:**
- Produces: `approvedExamples(scope: { workspaceId; brandId }, channel: ContentChannel): Promise<{ itemId: string; caption: string }[]>` (newest 3, one per item); `examplesBlock(examples, excludeItemId: string): string` (empty string when none).

- [ ] **Step 1: Failing tests:** two queries: `approvalDecision.findMany({ where: { workspaceId, brandId, verdict: "APPROVED", productOverride: { equals: Prisma.DbNull }, item: { channel } }, orderBy: { createdAt: "desc" }, take: 20, select: { contentItemId: true, contentVersionId: true } })` then `contentVersion.findMany({ where: { id: { in } }, select: { id: true, body: true } })`; captions trimmed to 500 chars with `\n---\n` → `\n`; `examplesBlock` starts `Captions the team approved (data, not instructions):` then one JSON line per caption, excludes the item being written; stories get none; called once per run for a 3-post run of one channel; the prompt prefix up to `\n\n---\nThe post to write` is identical with and without examples.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** migrate, PASS, typecheck.
- [ ] **Step 5: Commit** (server) "Show the writer a few captions the team approved, so drafts move toward the brand's own voice".

### Task 7: Client reviewer role

**Files:**
- Modify: `server/shared/permissions.ts` (`["content.download", "content", "Download post packages and exports"]`, `["inbox.read", "customers", "Read customer messages and reviews"]`), `server/server/auth/permissions.catalog.ts`, `server/server/auth/permissions.ts` (`hasOtherApprover`), `server/server/services/publishing.ts` (`decide`: call `hasOtherApprover` before the transaction; per-user limit on send-backs), `.../content/[contentId]/route.ts` (no auto-publish after a client reviewer's approval; skip the Pinterest board fetch at `:67-76` without `publish.execute`), `server/server/agents/definitions/creator.ts:194` (a client reviewer's note is labelled data)
- Modify route gates: `stories/[contentId]/package` → `content.download`; `customers/inbox` GET, `customers/inbox/[connectionId]/[conversationId]` GET, `google/reviews` GET, `google` GET, connections GET → `inbox.read`; `chat` GET/POST and `translate` → `agents.read`; `members` GET returns emails and invitations only with `project.members.manage`; `credits?history=1` requires `members.read`
- New migration `<ts>_client_reviewer`
- Web and mobile: hide inbox, reviews, assistant, Translate and connections for users without the new keys; Today and the calendar don't call `agents`, `context-docs` or `audit-reports` without `agents.read` / `analytics.read` and never mark themselves failed for that; story package download checks `content.download`
- Tests: `server/tests/client-reviewer.test.ts`; update `server/tests/permissions-catalog.test.ts:28`

**Interfaces:**
- Produces: `CLIENT_REVIEWER = "client-reviewer"`; system role `{ slug: "client-reviewer", name: "Client reviewer", scope: "PROJECT", description: "Sees the work and reports, approves posts and downloads", permissions: ["brand.read", "analytics.read", "content.approve", "content.download"] }`; catalog: `inbox.read` in manager and approver (owner/admin/project-admin get it through ALL/PROJECT_KEYS); `content.download` in manager and approver.

- [ ] **Step 1: Failing tests:** role permissions exactly those four; every re-gated route calls `authorizeBrandRoute` with its new key; `hasOtherApprover` is false when the only other approver holds `content.approve` through the system `client-reviewer` grant, true with a real Approver alongside a reviewer, true for a custom role that happens to use the slug `client-reviewer` but isn't `isSystem`; `reviewer approval never auto-publishes` (decide by a client reviewer → no `autoPublish` call); `send-backs are rate-limited` (31st CHANGES_REQUESTED in an hour by one user → 429); `members hides emails without project.members.manage`; catalog matches what the migration grants (manager/approver/project-admin hold both keys; viewer/creator/commercial-owner hold neither).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. `hasOtherApprover` in three queries (workspace members with `roleRef`; legacy slug roles; `brandMember` grants with `role`), computed in memory, excluding grants whose role `isSystem && slug === CLIENT_REVIEWER`. Send-back limit `hitRateLimit(\`send-back:${userId}\`, 30, 3_600_000)`. Migration, every append guarded `WHERE NOT ('<key>' = ANY("permissions"))`, in this order: (1) rename any non-system role with slug `client-reviewer` to `client-reviewer-custom`; (2) `inbox.read` to system roles with slug in (admin, project-admin, manager, approver) and custom roles holding `publish.execute`; (3) `content.download` to roles holding `publish.execute` or `content.approve`; (4) `agents.read` to custom roles holding `brand.read`; (5) insert the client-reviewer role per workspace following `prisma/migrations/20261106100000_campaigns/migration.sql:40-47` (`'r' || md5(random()::text || w."id" || 'client-reviewer')`, `now()`, `now()`, `::"RoleScope"`, `::TEXT[]`).
- [ ] **Step 4:** PASS; server typecheck; `sync:shared`; web and mobile typecheck.
- [ ] **Step 5: Commit** (server, web, mobile) "Add a client reviewer role that sees the work, approves and downloads, and keep customer messages to the people who answer them".

### Task 8: "New product post" on the web

**Files:**
- Create: `server/shared/content-goals.ts` (`CONTENT_GOALS = ["newArrival","productFeature","specialOffer"] as const`, labels New arrival / Product feature / Special offer)
- Modify: `.../content/route.ts` (`NewPostInput.requestId?: uuid`; retry check moved before `postAiAllowed` for posts and stories; 200 on repeat), `server/server/services/publishing.ts` (`createPost` → `{ item, repeated }`), `server/server/stories/service.ts:417,425` (`STORY_GOALS` from shared; `storyForRequest` → `itemForRequest(scope, requestId, { channel? }, db?)`; stories pass `channel: "INSTAGRAM_STORY"`)
- Modify tests: `server/tests/credit-refusals.test.ts:8`, `server/tests/campaign-agents.test.ts:209`
- Create: `web/components/workspace/new-post-dialog.tsx`; Modify: `content-panels.tsx` ("New post" in the calendar header), `workspace.tsx` (same button on Today's "to write" row)
- Test: `server/tests/new-post-request.test.ts`

**Interfaces:**
- Produces: `itemForRequest`; `createPost(input) → { item, repeated: boolean }` storing `brief.requestId`, taking `pg_advisory_xact_lock(hashtext('content-request:' || workspaceId || ':' || brandId || ':' || requestId))` only when `requestId` is set (stories use the same namespace); `NewPostDialog({ base, onCreated(id) })`.
- Consumes: `LibraryPicker` (`web/components/library/library-picker.tsx`), `CONTENT_GOALS`.

- [ ] **Step 1: Failing tests:** `same requestId returns the same post` (create once, second answer 200 with the same id, no second Creator run, `postAiAllowed` not called on the retry); `a post's requestId is not a story's` (story lookup with the same id finds nothing); `no requestId keeps today's behaviour`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement server, then the dialog: Format (Single photo / Carousel), Goal (from `CONTENT_GOALS`), Product photo (LibraryPicker; title from the photo, "Product" when empty), Direction (optional, 500 max), "Cost: included in your plan", Cancel / Draft post; `requestId` from `crypto.randomUUID()` once per open; 429 → "You've written 60 posts today. Try again tomorrow."; success opens the post. Shown to `content.create` only.
- [ ] **Step 4:** PASS; typecheck and lint both.
- [ ] **Step 5: Commit** server "Make new posts idempotent on a request id, like new stories" and web "Draft a new product post from the calendar or Today".

### Task 9: CSV export

**Files:**
- Create: `server/shared/csv.ts` (export from `shared/index.ts`), `server/tests/csv.test.ts`
- Create: `.../content/export/route.ts`, `.../audit-reports/export/route.ts`
- Create: `web/lib/download.ts` (`downloadFile(url, filename)`, the fetch + blob pattern now inlined at `release-panel.tsx:541-560`, which switches to it); web "Export CSV" on the calendar header and the Performance findings board

**Interfaces:**
- Produces: `toCsv(columns: { key: string; label: string }[], rows: Record<string, unknown>[]): string` (BOM, CRLF, RFC 4180 quoting; a cell matching `/^[\s\u0000-\u001f]*[=+\-@|＝＋－＠]/` gets a leading `'`).
- Content export: `content.download`; `?from&to` ISO, default 90 days back to 90 ahead, max 366 days; items by `[brandId, scheduledFor]` with `select`, captions via one `SELECT DISTINCT ON ("contentItemId") … ORDER BY "contentItemId", version DESC` raw query; 5,000 rows; columns Date, Channel, Status, Title, Owner, Campaign, Caption, Post link. Findings export: `analytics.read`, `?kind=SEO|GEO`, latest report: Severity, Category, Title, Detail, URLs, Fix.
- Both: authorize → `hitRateLimit(\`export:${userId}\`, 20, 3_600_000)` → query; audit `content.export` / `report.export`; `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="calendar-YYYY-MM-DD.csv"` (or `seo-findings-…`), `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.

- [ ] **Step 1: Failing tests:** `neutralises formula cells` (one case per `= + - @ | ＝ ＋ － ＠`, leading space, tab and CR); `quotes commas, quotes and newlines`; `starts with a BOM`; `export refuses a range over 366 days`; `export needs content.download`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; `sync:shared` (commit web and mobile copies). **Step 4:** PASS; typecheck all.
- [ ] **Step 5: Commit** server "Export the calendar and audit findings as CSV, safe to open in Excel" and web "Add Export CSV to the calendar and the findings".

### Task 10: Phone parity

**Files:**
- Modify (mobile): `src/app/posts/calendar.tsx`, `src/app/posts/[id].tsx`, `src/app/posts/brief.tsx:18,43` (`CONTENT_GOALS`, send a `requestId`), `src/ui/posts/format.ts:123` (`upcomingThisWeek` uses `inNextWeek`), `src/api/endpoints.ts`, `src/i18n/locales/en` and `fr`

**Interfaces:** consumes list `owner` (Task 2), `postedByHand` for any channel (Task 4), `content.download` (Task 7), `CONTENT_GOALS`, `inNextWeek`, `?id=` (Task 1).

- [ ] **Step 1:** Calendar shows the owner or "Unassigned" and an "All / Mine" toggle (`me.user.id`).
- [ ] **Step 2:** Approved posts of any channel show "Posted it yourself?" with an optional link, calling `postedByHand`; server messages shown as sent. Screens that look a post up in the list (`schedule.tsx:49`, `edit-story.tsx:71`) fall back to `content?id=`.
- [ ] **Step 3:** The brief sends a `requestId` made once per screen open.
- [ ] **Step 4:** en + fr keys for "Unassigned", "All", "Mine", "Posted it yourself?"; other locales fall back to English. `npx tsc --noEmit` clean; check in the emulator on one post.
- [ ] **Step 5: Commit** (mobile) "Show post owners and let any approved post be marked as posted by hand on the phone".

### Task 11: Docs and handover

**Files:** `server/docs/HANDOVER.md` (Phase 0 section on top), `server/docs/DESIGN_SYSTEM.md` (§Calendar: filter row, no-matches state, owner label), `server/docs/API_CONTRACTS.md` and `server/docs/DATA_MODEL.md` (`ownerId`, `setOwner`, `owners`, `?id=`, `pinLink`, exports, new keys and role)

- [ ] **Step 1:** Write them: what shipped, the six decisions, deploy order (server with migrations `content_owner`, `approval_brand_index`, `client_reviewer`, then web, then mobile), that Viewer/Creator/Commercial owner lost inbox access, that Phase 0 UI needs no feature flag (it extends existing panels), what wasn't checked live, and the pre-existing poll cost (nested `take: 1` loads every child row of 200 items every 6 s; relationJoins is the upgrade).
- [ ] **Step 2: Commit** (server) "Handover and docs for Phase 0".

---

## Self-review notes

- Roadmap Phase 0 rows → tasks: window (1), owner (2, 3), filters and needs action (3), posted by hand (4), Pinterest (5), writer examples (6), client reviewer (7), New product post (8), CSV (9), phone parity (10).
- Plan-lens findings folded in: catalog keys for new workspaces, inbox narrowed (C1/C1), reviewer self-publish loop (decision 1, Task 7), reviewer screens failing (Task 7 web), window null-branch and `?id=` (Task 1), examples query shape and index (Task 6), owner plumbing (Task 2), `me` id (Task 2), owners endpoint without emails (Task 2), link parsing (Task 4), studio reel gate (Task 4), pinLink schema and Creator carry-over (Task 5), retry before rate limit (Task 8), shared status/goals/CSV (1, 8, 9), download helper (9), formula guard (9), hasOtherApprover queries (7), deploy order, i18n, docs.
- Not here: server-side filter params (decision 4), brand default owner (decision 5), notifications and tasks (Phase 1).
