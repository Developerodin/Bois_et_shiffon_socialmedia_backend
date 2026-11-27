# Handover: mobile app on the real backend, Posts to Photoshoot (end of day 2026-11-02)

Branch `ai-reels` (not pushed, not merged). Today moved the app's Figma screens from sample data to the real server,
one module at a time. Each module was given a review for correctness, security, performance and maintainability,
tested on the emulator, fixed, and committed.

## Phase 1: tasks, projects, notifications, search (2026-11-23)

Branch `phase-1` in server, web and mobile (from main: server 73cb793, web 07cfa07, mobile f94e058). Spec:
`docs/superpowers/specs/2026-11-23-phase-1-tasks-design.md`; plan: `docs/superpowers/plans/2026-11-23-phase-1-tasks.md`.
Ledger and task reports: `.superpowers/sdd/2026-11-23-phase-1-tasks/`.
**Not checked in a browser, and the DB-backed suite has never run** (see "Before go-live").

Words: in roles and permissions, "project" means a business (a Brand, as in "project role"); a "work project" (the
Projects page, `WorkProject`) is a group of tasks inside one business.

### What changed for people
- Tasks: a list and a board per brand, with filters and a Needs-action rule shared with Today. A task opens in a panel
  (side peek on the Overview, full page under Tasks): status actions, owner and reviewer, due day, checklist, comments,
  attachments (before/after screenshots), links to a post, report or project. Review cannot be skipped; the reviewer is
  frozen while a task is in review; a blocked task records who it waits on.
- Projects: work projects with milestones and a progress count; a name-only "New project" form (the only way to create
  one from the web).
- Website and SEO queues: tasks with an area; SEO tasks carry the findings' page URLs and can be closed by hand ("checked
  live") or cleared automatically when a later audit no longer shows the finding.
- Make a task on findings: a button on each audit finding (one task per finding, or one per page list). A second task on
  the same finding is refused with "close the older task first".
- Today groups, a bell (notifications, 90-day prune), search (Ctrl/Cmd+K, five kinds) and quick create ("+"), notes to
  tasks (paste notes, the AI proposes tasks, you confirm; free, capped). These five are Tasks 19 and 20.
- LinkedIn and X posts are written with their own limits (3,000 and 280 characters) and recorded as posted by hand
  (link optional). The Planner offers them only with `PLANNER_HAND_CHANNELS=on` (default off). Publishing to them is
  refused; there is no connection.

### Flag
`WEB_FEATURES=tasks`, or per workspace `WEB_FEATURE_WORKSPACES=tasks:<id>` (`web/lib/features.ts`). The server API ships
unflagged but permission-checked, so it is harmless with the web flag off.

### Migrations and deploy order
- `20261123052135_phase1_tasks`: `pg_trgm`, Task, work project, checklist, attachment, comment, notification tables,
  partial and trigram indexes, role keys.
- `20261123180000_phase1_channels`: LinkedIn and X channels.
- Order: server `prisma migrate deploy` first, then web. The phone labels for the new channels are on mobile `phase-1`
  (Task 1); they reach people only with the next phone build.

### Permissions
- New keys `tasks.read` and `tasks.manage` (project scope, group "tasks"; `shared/permissions.ts`).
- Defaults: `tasks.read` for owner, admin, project-admin, manager, creator, approver, viewer and client-reviewer.
  `tasks.manage` for owner, admin, project-admin, manager and creator; `tasks.all` for owner, admin and project-admin
  (2026-11-23: commercial-owner merged into manager, see the task-assignment plan). `member` has none. Custom PROJECT roles holding `content.create` get `tasks.read`.
- Notes to tasks needs `tasks.manage`. Search filters each kind by that kind's own list permission.

### Rulings that change behaviour
- Custom workspace-scope roles with `content.create` do not get `tasks.read`; give the key by hand.
- A due day is a calendar day in the brand's time zone; a brand without one counts in UTC.
- The person a task is blocked on may unblock it, as well as owner and managers.
- Editing a task's project re-checks owner and reviewer visibility; changing areas does not.
- `view=mine` returns posts only when no area filter, or the Content area, is set. Today groups sort by due day, then id.
- GET task detail includes checklist and attachments; comments have their own route. Staff comments are internal unless
  shared; the detail carries `clientVisible` and `viewerIsClient`.
- A positional finding that already has an open task returns 409 (`task.findingTaken`) rather than reusing an old task.
- The pagespeed clearing job does nothing when PageSpeed did not run in the audit.
- Screenshots upload through the existing stories upload flow (slot, PUT, verify).
- A new "tasks" nav entry sits in an unrendered "page" group, not "more".
- A reviewer swapped in on a task in review gets a REVIEW_REQUESTED notice.
- Final review rulings:
  - The Planner offers LinkedIn and X only when `PLANNER_HAND_CHANNELS=on` (default off), until the phone build with
    their labels is released. Cost: nobody gets them planned until it is turned on.
  - The audit clear never closes a task that has a reviewer (SYSTEM comment only, as for a task in review): reviewed
    tasks finish only by approval. Cost: reviewed SEO tasks need a manual approve after the audit clears.
  - PATCH `reviewerId: null` is refused (409 `task.reviewed`) on a task with an APPROVED or CHANGES_REQUESTED comment,
    which closes the cancel, reopen, mark done path around review. Cost: a manager picks another reviewer instead.
  - GET tasks/people is 403 for client reviewers; every task person carries `client`. Owner, blocked-on and
    project-owner pickers list staff only; the reviewer picker includes clients.

### Ceilings
- Daily checks run in the 05:00 UTC `system.daily-sweep`: brands west of UTC get daily notifications a day late. Fix:
  run hourly and fire each brand once its local day has started.
- Search is `ILIKE` ranked by trigram similarity, always limited to the open business; 3 to 100 characters (shorter
  answers empty); 5 results per kind; 30 requests/min per user. Ceiling: the trigram indexes span every brand, so common short queries scan other brands'
  matches before filtering; add `btree_gin` (brandId, title gin_trgm_ops) if search slows on large catalogues.
- Notes to tasks: 10/hour per user, 100/day per workspace. Batch create: 20 tasks. Task create, batch and comment:
  60/min per user each.
- Task list is keyset-paged; Today uses one count query.

### Before go-live
- Done 2026-11-23: `npm run test:db` on a Docker Postgres 17 (`docker run -d --name sma-testdb -e POSTGRES_PASSWORD=test
  -p 55432:5432 postgres:17-alpine`, then `TEST_DATABASE_URL=postgresql://postgres:test@localhost:55432/<db>`): every
  migration applies from empty; 10 files, 30 tests pass.
- Done 2026-11-23: browser pass (Playwright, seeded throwaway DB, `WEB_FEATURES=tasks`): project create and page, quick
  create, panel, start, checklist, comment, send for review, block with reason, every view, board, Ctrl+K search, Overview
  Today and Blockers, bell, and approval as the reviewer. Not covered: brand switch on a project page (the seed has one
  brand), screenshot upload (needs bucket CORS), notes to tasks (needs AI credits).
- Second four-lens review 2026-11-23 fixed: owner made their own reviewer while in review (409 `task.reviewerIsOwner`),
  month 00/13 dates crashing date checks (now 400).
- Merged to main 2026-11-23 (server 7bf4717, web 9e76bb7, mobile f843cdd); not pushed. Third four-lens review on main
  fixed: whoever sent a task for review can't approve it unless sole staff (409 `task.selfApproval`; closes hand the
  task away, name yourself reviewer, submit, approve), and the bell count no longer seq-scans Notification (measured
  38 ms → 0.08 ms at 1M rows). Known: the panel still shows Approve to the submitter (allowedActions doesn't know who
  submitted); the click answers with the refusal.
- Fourth four-lens review 2026-11-23 (evening) on main (server 1367941..69672c7, web fefbe27..a3b0252, mobile 1d113f1; not
  pushed). Owner decisions: the submitter hears approve / changes (TASK_APPROVED, TASK_CHANGES_REQUESTED, bell only:
  phone push exists only for reels); rechecks catch up a missed week, keyed by recheckOn; overdue fires once, then
  weekly, keyed by dueOn + week; unread bell notices group per kind and business (count, opens /tasks?view=…, marks
  the group read up to its newest); a staff reviewer's note is staff-only unless "Share with client"; both New project
  forms stay. Fixes: clearFindings locks each task and re-reads under the lock; post picker searches posts only under
  its own limit; Notification indexes (userId, workspaceId, createdAt desc, id desc), (taskId), (brandId, workspaceId);
  Approve hidden from the submitter; Send for review uses the unsaved reviewer;
  task list re-reads loaded pages on poll; caption limits in one shared map; editor blocks >5 hashtags only on
  Instagram (was every channel). Migration 20261124090000_phase1_review_fixes. Not browser-checked.
  Follow-up (62873f5): Approve is hidden from the submitter on list rows too (one audit read per page, in
  toTaskDtos); pin descriptions over 500 are a content-rule blocker (Pinterest itself takes 800; not checked at publish);
  Task ownerId/reviewerId/blockedOnId/createdById indexed. Migration applied to the Neon dev DB 2026-11-23. The phone
  app has no task approve screen, so shareWithClient needs nothing there.
- Storage bucket CORS must allow browser PUT for screenshot uploads.
- Set `PLANNER_HAND_CHANNELS=on` only after the phone build with the LinkedIn and X labels is released.

### Deferred minors
Task rules
- checkedLive is refused on IN_REVIEW though it changes no status.
- The submitForReview refusal says "in progress" though TODO is allowed too.
- No tests for block/unblock, or for allowedActions as owner and as manager.
- A missing reason returns 409, not 400. A missing `view` is a 400 (the web always sends one).

Server
- Legacy-enum workspace roles are not counted by the task people and visibility checks (as in setOwner).
- `isSoleStaff` reads outside the transaction; soleStaff and brandOwners each read memberships (a double read).
- Moving a task to another project fails if the stored blocked-on person left (unblock first).
- Any P2002 on project create reads as campaignTaken.
- Attachment purge removes the row before the file, so a crash can orphan a file. The same upload can be attached
  twice. An orphan PENDING upload waits for the daily purge.
- Checklist positions can tie (the order then falls back to id).
- addComment reads brandOwners on every POST. Create, patch and action responses do 3 extra reads; getTask does 2
  round trips.
- getTask signs attachment keys without a read-time brand filter (safe through the write-time check).
- The audit clear writes `auditEvent.createMany`, not taskAudit. A task in review or with a reviewer gets the same
  SYSTEM comment again from each later audit.
- Turning a project's client sharing off while a client reads it can race (one read may still show it).
- Overdue and re-check notices are still written for archived brands and departed owners (the bell hides archived
  brands).
- startScheduledAgents throwing skips the daily task steps.
- The per-user hourly note-to-tasks count is spent when the workspace cap refuses.
- Next migration: a Notification createdAt index, Notification.taskId and Task.auditReportId indexes. Today counts
  run one query per index.
- Maintainability: typed shared enums for DTO fields; one parse helper; rename isPostOverdue.
- DB tests: the finding tests depend on order and a fixed slug; the pagination DB test is shallow.

Web
- Finding buttons reset to "Make a task" after a reload (needs task ids in the report payload); the FindingTask key
  sits on the returned element, where it does nothing; Make a task also shows on GEO findings.
- Milestone reorder sends parallel PATCHes without rollback.
- The NOT_YOURS reason is a guess for any action missing from `task.actions`. The board dialog's sending flag is not
  reset when a write throws.
- No upload control for OTHER-role attachments.
- A usePeople hook; a dynamic import for the quick-create dialogs.

Phone and channels
- LinkedIn and X labels are not translated on the phone (CHANNEL_NAME); a plain-object lookup and a default tile.
- No hashtag-count check for X and LinkedIn.
- The refusal wording is the existing "can't be published automatically", not "no connection".

### Commits (base..head)
- Task 1: mobile f94e058..a4b7ded. Task 2: server 73cb793..6df7625, web 07cfa07..5416705, mobile ..80860cb.
- Tasks 3 to 14: server 6df7625..d14357e (task 3 ends 59af7d7, 4 cb2b00b, 5 cc2f53f, 6+7 18105f7, 8+9 d81d0aa,
  10+11 68549c5, 12 2271fb5, 13+14 d14357e).
- Task 22 (channels): server d14357e..a4de10d, web e54ea6e, mobile cce70ac. Client flags: server a4de10d..8c1b9cb,
  web a872053, mobile d39674e.
- Web: Task 15 fe16afd..7923ca2; 16+17 7923ca2..da7df89; 18+21 da7df89..b216a3e; 19 b216a3e..bd3f7f7; 20
  bd3f7f7..0104d4e.
- Final fixes: server d5c0af2..98b0c59, web 0104d4e..03013ea (shared sync c5465f5), mobile 0fb8198 (shared
  sync); anything later: see git log.

## Overview side peek (2026-11-20)

Branch `overview-peek` in web (server and mobile carry only the shared `ContextDocKind` list). Plan:
`docs/superpowers/plans/2026-11-20-overview-side-peek.md`. Task reports: `.superpowers/sdd/2026-11-20-overview-side-peek/`.
**Not checked in a browser.** There are no DOM tests; every behaviour below was read against the code and covered at the
pure-function level only (focus restore, the slide, the flash, the Recent menu and R need a hands-on pass first).

### What changed for people
- A post, document, agent or competitor now opens in a side peek over the right of the Overview. The board behind stays
  as it was (the Today panel no longer gets replaced). X or Esc closes it; a "Closed ..." toast offers Reopen (6 s).
- Buttons that point at a panel bring it into view: a collapsed panel is expanded and one not on the board is added
  (both saved), then the page scrolls to it and flashes it. No toast is involved.
- A **Recent** menu beside Layout lists the last 8 items opened here; R reopens the last closed one.
- Unsaved work is guarded per editor, so a post's caption and its release form each count and the person is asked once.
- Drag a panel's header onto the "Open in preview" box (top-right corner, shown only while dragging) or pick
  "Open in preview" in its ... menu: the panel opens in the side peek (`?peek=<panelId>`), the board unchanged. A
  previewed panel is left out of the board until the preview closes (layout not saved); not in Recent.
- Content calendar: List | Month switch (`cal.view.v1` per browser). Month reads its grid range with `GET content?from&to`
  (ISO instants, span <= 62 days, 500 rows, `truncated` when capped); past months poll slower. Closing a panel offers Undo.
  Ideas cards carry their next step (Plan into posts / Open post); the Ideas top bar is pinned.
- Every Overview panel has an X in its header (same as Hide panel; it comes back from Layout).
- The sidebar's "Your agents" can be reordered by dragging or Alt+Up/Down; the order is kept per browser
  (`nav.agentOrder.v1`, ids only, `lib/agent-order.ts`). Drag doesn't work on touch.

### URL rules (`lib/workspace-view.ts`)
- `?post=` and `?competitor=` match `^[A-Za-z0-9_-]{1,64}$`; `?agent=` matches `^[a-z][a-z0-9-]{0,39}$`; `?doc=` must be in
  `DOC_KINDS` (server `shared/context-docs.ts`); `runId` must match `RUN_ID_PATTERN` and only applies to an agent.
- Anything else is a bad link: it opens home and the URL is replaced at once (no history entry). When several item
  parameters are present, the first of post, doc, agent, competitor wins.
- A URL never sets `run`: a link, reload or Recent cannot start a paid run. Unknown agents are dropped once the list loads.
- A brand or workspace switch strips the item parameters after the person agrees to discard unsaved work.
- Sidebar `?panel=` is still an insert into the saved board, by choice (owner's request). Only that path can add a panel;
  every in-page button reveals.

### Recent storage (`lib/recent.ts`)
- localStorage key `recent:<workspaceId>:<brandId>:<userId>`; nothing is kept without a user id. Entries are
  `{kind, id, at}`, newest first, 8 at most, dropped after 30 days or when `at` is more than 1 min in the future.
- Reads are strict: entries are rebuilt, never spread, and each must parse through `parseViewParts`. Reads happen on menu
  open and on push, not in render. Re-opening the item already on top writes nothing.
- Titles come from data the Overview holds (shared content cache, docs, agents); competitor names are fetched only when
  the menu opens. "No longer available" covers documents, agents and competitors only, and only when the relevant list loaded
  and lacks it; a failed fetch purges nothing. Posts are never marked gone (the list is only the calendar window); the peek
  says so on a real 404. An item is recorded only once it has resolved (doc/agent in the loaded list, post/competitor loaded by its view).
- Sign-out removes every `recent:` key in the browser, and so does a session expiry (`redirectToLogin` and the login page
  on `?expired=1`; the middleware redirect for a missing cookie does not carry `expired`, sign-out already cleared it). A brand switch clears the last-closed item (so R and Reopen cannot
  carry it across). Reopen and R open by kind and id alone.

### Deferred
- **A3, two peeks side by side**: not built. Each peek is a narrow column over a board that is already two or three
  columns wide; two would hide the board, and the unsaved-guard and focus rules are per single peek. Revisit if people ask.
- Not built either: full pages for posts and documents; hover prefetch. (Competitors got its own page on 2026-11-26.)
- Minors: the peek shows a skeleton forever if the agents or docs fetch fails (no retry there); an item opened and edited
  during a brand-switch request is dropped without a new ask; during the 200 ms slide-out an agreed-to-discard editor's
  guard is off, but opening another item inside that window can ask again; picking the already-active brand leaves
  nothing to strip; a post outside the calendar window is titled "Post" in the peek header (its own h1 has the real title);
  the peek's views keep their own h1 under the header; import order in `workspace.tsx`; the reveal closure is untested
  (DOM); reveal before the saved layout loads.

## Phase 0: B&C quick wins (2026-11-20)

Merged to `main` in server, web and mobile on 2026-11-20 (not pushed). Plan: `docs/superpowers/plans/2026-11-20-phase-0-quick-wins.md`
(untracked, like the earlier ones). Commit ranges: server `78eaf75..248344a`, web `8ed684b..4eb38b9`, mobile `5c9ad7b..2700b63`.
Each task got a review and fix round, then a four-lens branch review and its fix wave
(`.superpowers/sdd/2026-11-20-phase-0-quick-wins/final-fix-report.md`). Phase 0 extends existing panels, so it needs
no feature flag. The work after the merge (a second review and the owner's answers) is in "Phase 0 follow-up" below.
**Next: the post-merge steps in "Deploy order" and "Phase 0 follow-up".**

### What shipped
1. **Calendar window.** `GET .../content` returns open posts plus anything updated in the last 30 days (two queries, open
   first, 200 rows in all). `?id=` opens one post of any age (404 if cancelled). Filters run in the browser.
2. **Post owner.** `ContentItem.ownerId` (migration `content_owner`, backfilled). Owner = who created the post or started
   the run, else unassigned. `POST content/:id` `{ action: "setOwner", userId | null }`; `GET content/owners` lists names
   (no emails) of people on the brand; the shell now carries the user's id.
3. **Calendar filters and "needs action"** (web): channel, status, campaign, owner (Anyone / Mine / Unassigned),
   needs action, with a "No posts match these filters" state and an owner label on each card. Blocked means work still
   needing action (finished posts are not blocked).
4. **Posted by hand.** `{ action: "postedByHand", url? }` records that someone posted an approved post themselves; the
   link is checked per channel and kept. Studio reels need the link; other posts do not. Story hand-posting also passes
   the product gate.
5. **Pinterest.** `pinLink` in the post body (up to 2000 chars); carried over when a Creator revises a pin.
6. **Writer examples.** The Creator's prompt gets up to three of the brand's best earlier captions, same channel only,
   loaded once per run, after the cached prompt divider, as labelled data.
7. **Client reviewer** role (migration `client_reviewer`): `brand.read`, `analytics.read`, `content.approve`,
   `content.download`. A send-back path for their review; the members list is trimmed to names and role names unless
   the caller has `project.members.manage`.
8. **New product post.** A "New post" dialog from a product; `POST content` takes an optional `requestId` (uuid) and a
   retry is answered before any rate limit is used.
9. **CSV.** `GET content/export?from&to` (calendar, `content.download`) and `GET audit-reports/export?kind=SEO|GEO`
   (`analytics.read`). Both rate limited (20 per hour per user); the calendar export is audited.
10. **Phone parity** (mobile): owner, filters, `?id=`, posted by hand, pinLink, goals from `CONTENT_GOALS`.

### The six decisions (owner can override)
1. A client reviewer's approval is enough, but **a client reviewer's approval never auto-publishes; staff approvals behave
   as before**. (`decide` itself never publishes for anyone; the content route skips `autoPublish` when the decision
   has `byClient`, and staff approvals still call it unless `noAutoPublish` or an override.) It is a normal `ApprovalDecision` with `byClient` set (stored at decision time); staff schedule or post
   it. Staff self-approval is unchanged (`hasOtherApprover` ignores
   people whose `content.approve` comes only from the system `client-reviewer` grant). Staff can always skip client review.
2. Client reviewer permissions as in item 7. They see posts, reports, products, campaigns, competitors and member names.
   Closed to them: customer inbox and Google reviews, connections, assistant chat and Translate, publishing, editing,
   commercial settings, member emails, workspace credit history.
3. Inbox access narrows: `inbox.read` goes to Owner, Admin, Project admin, Manager, Approver and custom roles holding
   `publish.execute` (closes A11 from the 2026-11-17 security review).
4. Calendar window, not server filters (ceiling 200 rows; the upgrade, from/to plus filter params, is named in the code comment).
5. No brand default owner.
6. Writer examples go after the cached prompt divider, same channel only (posts carry no language field).

### Deploy order
Server first, with migrations `20261120054624_content_owner`, `20261120060816_approval_brand_index`,
`20261120061605_client_reviewer`, `20261120070845_approval_by_client`; then web; then mobile. Clients tolerate the old
server (a missing `owner` reads as Unassigned, a missing `byClient` as staff). `npm run sync:shared` is already done in
all three repos.
- **Re-run the guarded `client_reviewer` steps by hand against production, only for workspaces missing the role.** A
  workspace created between `migrate deploy` and the switch to the new server gets the old catalog from the old server.
  Limit step 5 (the role insert) with `WHERE NOT EXISTS` on that workspace's `client-reviewer` role, so a role someone
  has since edited is not reset (the migration's own `ON CONFLICT DO UPDATE` would overwrite it). Steps 2 and 3 are
  guarded appends, but step 3 re-adds `content.download` to any role holding `publish.execute` or `content.approve`,
  including one where someone removed it on purpose; check before running it.
- **Assign the Client reviewer role only after the new server is live.** An old server reads a missing `byClient` as a
  staff approval, which can auto-publish.
- **Confirm the owner backfill on a production snapshot first:** compare the `content.create` audit rows with the posts
  whose `ownerId` was filled (`content_owner`); the counts were never compared (the dev DB is nearly empty).
- The `client_reviewer` migration was corrected in place after the branch review (step 4: `agents.read` only for custom
  roles holding `content.create` or `agents.run`, never the renamed role; step 1: the renamed slug carries the role id).
  It had only run on the dev database, whose recorded checksum was updated by hand; production runs the corrected file once.

### Access changes people will notice
- **Viewer, Creator and Commercial owner lose customer inbox and Google reviews** (`inbox.read`). The connections list now
  needs any of `inbox.read`, `publish.execute`, `integrations.manage` (`CONNECTIONS_READ`), so publishing roles still work.
- **Members without `members.read` lose the credit history** (`GET credits?history=1`). Old phone builds ask for it and
  get a 403 for those people until they update.
- **Custom roles holding `content.create` or `agents.run` gained `agents.read` through the migration**, so they keep the
  assistant chat and Translate (both spend credits; `agents.read` also opens the Agent log, runs and AI spend). Read-only
  custom roles did not. Tell the owner; revoke per role if unwanted.
- Roles with `publish.execute` or `content.approve` gained `content.download`.
- A custom role using the slug `client-reviewer` is renamed `client-reviewer-custom-<role id>` by the migration.

### Out of plan
Web `0d9d6a3`: the New campaign dialog scrolled sideways; fixed with `grid-cols-[minmax(0,1fr)]` on the dialog grid
(the new post dialog uses it too). It sits inside the Task 3 range; include it in the branch review.

### Not checked live
No browser (web screens only unit-tested), no emulator (mobile only typechecked), no live publish or hand-post against a
real channel, no real OpenAI run with writer examples. The caption query (`DISTINCT ON`) was only checked to parse and bind
on the empty dev DB (no versions, so no row data seen). The owner backfill row counts were never compared. Walk these
first: filters and the no-matches state, set owner, posted by hand, pin link, New post from a product, both CSV downloads
in Excel, a client reviewer login (what they see and cannot open), the phone calendar.

### Deferred minors
- Window: mobile Stories Posted tab loses stories finished more than 30 days ago; `ContentView` lookup not keyed by id
  (one stale frame); campaigns fetch has no cancel flag; a post late on day +7 drops off the phone Today agenda
  (`inNextWeek` is under 7x24h).
- Owner: the setOwner race is commented only.
- Hand-posting: a publishing or published post gets "Approve the post first"; Facebook `permalink.php`/`watch?v` and
  `pinterest.co.uk` links are refused (not stored).
- Pinterest: `pinLink` kept on non-pin channels; encoded href can exceed 2000.
- Examples: only 2 when the revised item is one of the 3; no test for missing version or empty caption.
- CSV: date-only `to=` excludes the last day; no truncated flag at 5,000 rows (ponytail comment at `MAX_ROWS`); undated
  posts not exported.
- Content list sort: two undated posts compare as `-Infinity - -Infinity = NaN`, which `||` treats as a tie and falls
  through to creation time. Keep the `||` (commented in `content/route.ts`).
- Phone: `me()` fetched per calendar mount with swallowed errors; the server's success text is not shown.

### Open question (answered)
- May a client reviewer send back an approved-but-unscheduled post? Answered 2026-11-20: only one they approved
  themselves. See "Phase 0 follow-up".

### Pre-existing cost to know about
The calendar poll (every 6 s) loads, for up to 200 items, every child row behind the nested `take: 1` includes (versions,
checks, decisions, publications). Not new, and the window keeps it at 200 items, but it is the first thing to fix if the
poll gets slow. Upgrade: Prisma `relationJoins`.

## Phase 0 follow-up (2026-11-20)

Branch `phase-0-followup` in server, web and mobile, from the merged Phase 0. Plan:
`docs/superpowers/plans/2026-11-20-phase-0-followup.md` (untracked). Ranges (after the second review's fixes): server `248344a..707a099` (this docs
commit on top), web `4eb38b9..141aa11`, mobile `2700b63..c2a77ed`. Ledger and reports:
`.superpowers/sdd/2026-11-20-phase-0-followup/` (`progress.md`, `task-*-report.md`, `track-*-report.md`). Not merged or
pushed when this was written.

### The owner's two answers
1. **Client send-back only on their own approval.** A client reviewer can send a post back to the writer only when the
   current approval is theirs (`approval.byClient` and the same user). A post the team or another client approved gets a
   409 "This post was approved by the team. Ask them to reopen it." Staff can still send back anything. Clients are also
   capped at 20 send-backs a day per brand (429); the per-person 30 an hour applies as before.
2. **Agent-finished toast.** The web shell toasts "<agent> finished" (green) or "<agent> needs a look" (amber, with the
   error) when a run ends, linking to `/?agent=<key>&runId=<id>`, where the agent log shows that run's events.

### What shipped
- **Route check hands back more.** `authorizeBrandRoute` returns `perms` and `clientReviewer` (read once); post detail,
  actions and `setOwner` reuse them instead of reading again. `isClientReviewer` was removed; `decide` takes a required
  `byClient`. The catalog-sync job payload is only `{ workspaceId, brandId }` (the route scope used to be passed whole).
- **One name rule** (`server/content/person-name.ts`): the trimmed name; else the email's local part, only for callers
  with `project.members.manage`; else "A team member". Never the whole email: managers reading an old stored name that
  is an email get its local part, never the address. It covers the post owner, the CSV Owner
  column, `content/owners`, decision `by` names, members for non-managers and story rights. Client reviewers are not
  offered as owners.
- **Story rights are hidden, not rewritten.** A story's asset-rights note and `frames[].rights` no longer reach people
  who can't see names (list, `?id=`, check results) or the Quality agent's prompt. **Stored story bodies keep their old
  names and emails in the database; they are hidden on every read.** New bodies store "A team member", not the email.
- **Hand-posted posts are dated when they went out:** `scheduledFor` is set to now (a planned date is lost).
- **Calendar and post views are cheaper:** the owner joins the item read (no separate owners query); the recent half of the list is ordered by
  `updatedAt desc` and can use the new index `ContentItem(brandId, updatedAt)` (migration
  `20261120082134_content_updated_index`). With 20,000 scratch rows the planner used it; the dev table has 5 rows.
- **Agents list** is a per-key `LATERAL ... LIMIT 1` query on `[brandId, agentKey, createdAt]` (same JSON shape). **`agent-events?runId=`** returns one run's
  events oldest first (up to 200; `after` and `limit` ignored; `runId` is `[A-Za-z0-9_-]{1,40}` or 400).
- **Web:** the shell agent watcher and toast; the agents request goes through the shared per-URL fetch, so the Overview,
  board, post panels and watcher make one request; view and URL parsing moved to `lib/workspace-view.ts`. Business
  context and story downloads are kept to the roles that can use them.
- **Phone:** the week ahead leaves published posts out; "channel not connected" shows only to people who can publish.

### Rulings
- Stored story bodies are never rewritten (no approval or hash risk; cost: old names stay in the database).
- Client send-back is limited to the client's own approval ("post he has approved"). If the owner meant any approved
  post, clients are refused on staff-approved ones.
- Hand-post always sets `scheduledFor` to now.
- Runs with nothing to do ("No ideas...", "Nothing to...") do not toast.
- Toasts are deduped across tabs by localStorage (last 50 run ids per workspace and brand), no leader election: two tabs
  in the same second can both toast. `GET /agents` sends only each agent's newest run, so a run followed within one poll
  by another can be missed.
- Two implementers ran in parallel by repo (server track, web/mobile track); the web coded against the `runId`
  contract before the server landed.
- The new index stays (EXPLAIN uses it at 20k rows).

### Post-merge steps
1. Run migrations in every environment (`npx prisma migrate deploy`), including `20261120082134_content_updated_index`.
   Then stop the server dev, run `npx prisma generate` (it hit EPERM because the running dev server holds the engine, so
   the client was not regenerated; only an index changed) and restart it.
2. Per environment: `npm run redact:story-checks` (dry run, prints counts), then `npm run redact:story-checks -- --apply`
   (optional `--workspace <id>`). It rewrites only passing "Asset rights" notes in story quality checks that contain
   `@`; it never writes story bodies. It logs one line per page, counts the checks it skipped (an email in the note but
   no story body to rebuild it from: look at those by hand) and, with `--apply`, writes one `story-checks.redacted`
   audit event per workspace (a failed audit write is logged, not thrown). When every database is done, delete the script, its npm script and
   `tests/redact-story-checks.test.ts`.
3. One-off DB grep for `@` in older story `QualityCheck` notes outside "Asset rights" (the script only handles that row).
4. The guarded `client_reviewer` re-run (only workspaces missing the role) and assigning the Client reviewer role only
   after the new server is live: see "Deploy order" above.

### Not checked live
No browser and no emulator were driven for this work (web and mobile were only unit-tested and typechecked). The toast
has not been seen on screen: placement, timing, the link into the agent's run and the two-tab case are unchecked.
Nothing was run against a real channel or OpenAI. Walk first: a client reviewer approving and then sending back (own and
staff-approved posts), names on the calendar and the CSV, a hand-posted post's date, the toast after a real agent run.

### Deferred minors
- Server: a refused client send-back can still spend a cap slot (the cap is spent before the per-person limit); the 409
  says "the team" even when another client approved; members GET for managers also returns a `client` flag.
- Names: owners numbering ("A team member (2)") shifts with membership and can differ from the list's plain
  "A team member"; a real display name containing `@` is treated as an email and hidden.
- Web and phone: Send back to clients can show on team-approved posts (the server answers 409 readably); the mobile
  `StoryFrame` type (`api/endpoints.ts`) still says confirmed rights are `{ kind, by, name }`.
- Left after the final review (2026-11-20): a refused send-back (per-person limit, AI allowance or in-transaction
  refusal) can still spend one client-cap slot; new story bodies store "A team member" even for viewers who are
  managers; a no-change story re-save may create a new version once stored names differ from re-resolved
  names (confirm when touched); `decide` with override still re-reads permissions via requirePermission (rare path).
- RunEvents shows at most 200 events and does not refresh mid-run (upgrade: page by `after`); the toast timer restarts
  after hover; the watcher takes its baseline only from an answer fetched after it mounted, so a run that ends in the
  first poll gap (up to 20 s) is not toasted.
- Redaction script: one-by-one updates (about 150 ms each); add a prefilter or batching if a table is very large.
- The Phase 0 minors above still stand.

## End of day 2026-11-19 — start here tomorrow

Everything below is committed on `main` in each repo (local only, no remotes, nothing pushed). Server, web and mobile
are each their own repo, side by side in `apps/`. Last commits: server `add2255`, web `8ed684b`, mobile `5c9ad7b`.
Checks at the end of the day: server 1,021 tests, web 375 tests, typecheck and lint clean, mobile typecheck clean.
Dev servers: server `npm run dev` on 3101, web `npm run dev` on 3100 (never run `next build` in web while dev runs:
both write `.next`; if a page shows "Internal Server Error", stop dev, delete `web/.next`, start again).

### What was done today (afternoon/evening)
- **Products pagination** (web + server): server pages `?page&limit&q&stock`, URL-synced table, native history, pages
  cached and neighbours prefetched, loading bar/spinner; one shared `components/ui/pagination.tsx` now also on the
  admin People, Workspaces and Activity lists. Stock filter follows `stockLabel` (0 + inStock true = in stock); `%`, `_`
  are literal in searches.
- **Speed**: `brandAccess` reads member, brand and grant in parallel (every brand route). Dev slowness is mostly
  ~150 ms per Neon round trip from India to eu-central-1; production runs in the database's region.
- **Espanda chat**: redesigned panel (greeting, page-aware starters, composer card, labelled replies), set in a card;
  the top bar now spans the page and the chat column. Chat reads the product catalogue (`catalogueSummary`,
  `findProducts`), knows the open page (saved per message), has an expand mode, keeps long threads on the prompt cache,
  and turns web search off once product data is in the conversation unless the person asks.
- **Overview**: SEO and GEO tiles show their scores; opening a draft document marks it reviewed (Overview click, or
  picking one on Business context; the default document shown there isn't).
- **Languages** (section below): team working language + post language, asked once before the first run, Settings →
  Languages, Translate on ideas and documents.
- **Housekeeping**: root-repo archive branches deleted (only `main` and `desktop-shell` left there); this account's
  workspace added to `UNLIMITED_CREDIT_WORKSPACES` in `server/.env` (local only; the old id in that list is probably a
  wiped workspace).

### Not verified yet (do these first)
1. Nothing from today was seen in a browser (Claude in Chrome was off) except through the owner's screenshots. Walk:
   Products paging (jump far, rows per page, back/forward), admin People/Workspaces/Activity pager, the chat panel
   (card, top bar, expand/collapse, Escape, starters per page), SEO/GEO tiles, opening a draft document.
2. No real OpenAI turn was run for the chat's product tools, the page note or Translate. Try on Products: "Explore my
   catalogue", "Analyse my pricing", "What's out of stock?"; then Translate on Opportunities and on a document.
3. Languages: on a business with no team language, press any Run → the dialog; Cancel starts nothing; Save and run
   starts it; Settings → Languages shows and changes both. Then run Opportunities and check ideas come out in the team
   language while post copy stays in the post language.

### Known gaps / left as notes
- Server-started runs (Research on brand creation, automations) and the welcome page don't ask the language question;
  they keep the old behaviour until a team language is set in Settings.
- Only English and French are offered (`shared/languages.ts`); adding one also needs the content features that read
  the post language (stories, Google replies) to handle it.
- Translations are cached in process memory only (lost on restart); no credits are charged, limits are per AI call.
- Plans for today's two features (untracked like the earlier ones): `docs/superpowers/plans/2026-11-19-chat-products-expand.md`,
  `docs/superpowers/plans/2026-11-19-languages.md`.
- Next feature after these checks, per the earlier plan: feature 4 (stories on the web).

## Languages: team working language, post language, Translate (2026-11-19)

On `main` in server, web and mobile (mobile only got the synced `shared/`). Plan with both four-lens rounds folded in:
`docs/superpowers/plans/2026-11-19-languages.md`.

- Two languages per business (`shared/languages.ts`, en / fr): the team working language (`preferences.workLanguage`)
  for what agents write for the team, and the post language (`locales[0]`, as before) for what customers read.
  `GET/PATCH …/brands/[brandId]/languages` (GET brand.read, PATCH context.edit, audited with the old values).
- Every agent call ends its system prompt with one language line (`languageLine`, engine.ts) once a team language is
  set; search questions count as customer-facing, so GEO still measures the market's searches. Changing a language
  resets that brand's OpenAI prompt cache once. Unset: prompts as before.
- Web: Settings → Languages; before the first run from the app (any Run, Research, Planner, chat Start) a dialog asks
  once; Cancel starts nothing; a failed save still runs and isn't asked again in that tab. Runs the server starts on its
  own (research on brand creation, automations) and the welcome page keep today's behaviour until a language is set.
- Translate (ideas, documents): `POST …/translate` by reference only (idea ids or a document version), light tier,
  12k characters per AI call, rate-limited per AI call (40 per person, 150 per workspace, per 10 min), in-process cache;
  shown as "Machine translation", never saved. The grader's injection-echo check skips `TRANSLATE_WORKFLOW` only.
- Not checked live: no browser and no real OpenAI run. Try: Settings → Languages; a first Run on a business without a
  team language; Translate on the Opportunities list and on a document.

## Chat: product access, page context, expand mode (2026-11-19)

On `main` in server, web and mobile (mobile only got the synced `shared/`). Plan with the four-lens amendments:
`docs/superpowers/plans/2026-11-19-chat-products-expand.md`. Plan lenses and final lenses both ran; fixes applied.

- Two read-only chat tools (`server/chat/tools.ts`), `brand.read`, scoped from the session: `catalogueSummary`
  (variants, stock in / out / unknown, price min / median / max per currency in SQL, top categories, last sync time
  only, never its error text) and `findProducts` (Products table's own search and stock filter, 10 rows by default,
  25 at most, columns + rows, links only when asked). Rows are variants. `CHAT_PROMPT_VERSION` is "3".
- The stock filter now follows `stockLabel` (moved to `shared/products.ts`): a count of 0 with inStock true is
  "in stock", in the chat and in the Products table filter alike.
- Page context: the web sends the open page's nav id; the server keeps it only if it is in `shared/chat-pages.ts`,
  saves it on the user message's metadata and turns it into a note on that message (`withPageNotes`). Not in the
  system prompt, so OpenAI's cached prefix survives page switches.
- Web: page-aware starters (Products: catalogue, pricing, out of stock), a "Context: <page>" chip, the panel as a card,
  and an expand button (wide view over a scrim; Escape or the scrim collapses; collapses on navigation).
- Not checked live: no browser (Claude in Chrome was off) and no chat turn run against OpenAI. Try on Products:
  "Explore my catalogue", "Analyse my pricing", "What's out of stock?", then expand and collapse.
- Follow-ups fixed the same day: the model reads 20–40 recent messages with a start that moves 20 at a time
  (`server/chat/turn.ts` historyWindow), so long threads keep hitting the prompt cache; `%`, `_` and `\` in a product
  search (chat and Products page) are literal characters; web search is switched off for a turn once product data is in
  what the model sees, unless the person's own message asks to search (prepareStep). Prompt version "4".

## Feature 3c: reels render, review and publish on the web (2026-11-19)

Branch `feature-3c-reels` in the server, web and mobile repos (not merged). Spec
`docs/superpowers/specs/2026-11-18-feature-3-reels-design.md`, sections 5 to 7. This finishes the reel page: a reel can
now be made, reviewed and published without the phone. Behind `WEB_FEATURES=reels`.

- **What was built.** **Make video** on the Storyboard (the page's one primary button, with the price from the server).
  A finished reel's Storyboard shows **Watch the video** instead. The **Video** step shows the render's progress, a
  sentence when it fails (X01) with **Try again**, **Edit storyboard** and, when the voice was deleted, **Change voice**,
  and **Review your reel** when it is done. The **Review** step has the video with captions on by default, the
  transcript, the quality checks, an editable caption and hashtags (with **Discard** while there are unsaved changes),
  **Download video** (which approves this version) and **Continue to Publish**. An unsaved caption holds Download and
  Continue to Publish ("Save or discard the caption first."). The **Publish** step reuses the Overview's release
  panel: Publish now, Schedule (with the time zone shown) and Cancel schedule. On an unapproved reel, Publish now
  approves and posts as one action (still with its confirm press). While the checks run, the Publish step links to
  Review ("See the checks"), where the wait runs. The reels home gets **Posted it? Add link** on an approved reel
  with no post link, for people who can publish. In the Overview, a studio reel's release panel asks for no video
  link, and its content view shows **Open in Reels** (only with the reels flag on) instead of the draft editor.
- **Web kit.** `ChecksList` (the Overview's quality check list, now shared) and the `PreviewFrame` captions props (see
  `docs/DESIGN_SYSTEM.md` section 7).
- **Paid buttons.** Make video and Try again use the shared paid press rules: the price shows from the server, a
  double click makes one render and one charge, and a 402 opens the paywall.
- **Server changes.**
  - `startRender` refuses with 409 `render.alreadyDone` when the version already has a video (unless `again`), and
    never reuses a refunded attempt's charge id.
  - The release state says when a reel was made in the studio (`requirements.studio`).
  - Caption edits on a studio reel keep the plan's hook and script from the scenes, and refuse more than 5 hashtags,
    a hashtag over 100 characters, or a caption over 2200. A lost version race has the code `draft.changed`.
  - The reel read carries `captions` (cues timed from the voice and clip lengths, in `server/reels/captions.ts`), and
    the download link carries the file name `reel-<8>.mp4`.
  - `captions` and `draft.changed` are in `shared/`, synced to web and mobile. `CAPTION_LIMITS` gains
    `hashtagLengthMax` (100); the reel plan, the studio-reel caption guard and the web Review all read their limits
    from it.
  - `autoPublish` skips studio reels, so approving one never books a post, whichever client approves it (the web
    and the phone also send `noAutoPublish`). Every phone build approves a reel only on its way to its own publish
    call, so none relied on the auto-booking.
  - These are additive for old phone builds. The one earlier change that was not is corrected in 3b below.

**Calls made**
- The failed reel card says "Didn't work" without "N credits back". The owner chose this on 2026-11-19; the spec
  (section 5.2) asked for it. The list has no credits for a reel; adding `render.credits` to it would bring it back.
- Captions use one cue per scene, not per sentence.
- The Review's checks wait stops after 10 minutes (the spec names no end). It then says "The checks are taking long."
  with **Check again** (people who can create) or **Read again**. Creators also get one quiet recheck at 90 s.
- The Review polls its own checks wait; the page's read does not wait for checks.
- The release state's `studio` flag is set in `releaseState`, not passed to `publishRequirements`.
- `ChecksList` comes from the Overview's Quality check section; the release panel has no checks list.
- "Change voice" on a deleted voice opens the Script & voice step, not the Voices sheet.
- The Overview hides the next-step prompt for studio reels too, not only the draft editor.
- The time zone line on the schedule input shows for posts as well as reels.
- The Review's primary button is **Continue to Publish**; Download and Save caption are outline.
- The Instagram line on the Publish step reads the connections list, since the release state lists only active
  accounts. It shows only when an account needs reconnecting. With no account at all, the release panel's own
  "Connect an account…" line says it.
- The Publish step doesn't poll the checks. While they run it links to Review, whose wait is bounded and has Check
  again; a second wait on Publish would be a second clock for one state.
- A Download with no answer or a server error reads the reel again before the button comes back (the approval may
  have gone through), as a refused one already did.
- Overview bundle: `reelHref` lives in `components/reels/href.ts` (no imports), so `/` and `/context` don't load
  `reel.ts`. First load `/` 214 to 210 kB, `/context` 172 to 168 kB.
- `/reels` home first load grew about 0.8 kB gzip (159 to 160 kB): the shared `reel.ts` chunk now carries the Review
  helpers. Splitting `reel.ts` would fix it with no behaviour change; not worth it for under 1 kB.
- Caption edits send only caption and hashtags. The phone's edit is unchanged.

**Copy written without a source, for the owner to approve** (desktop-only lines, not from the phone's `reels.json`)
- Review: "Transcript", "Make the video first. Download and Publish open once it's made.", "This reel can't be sent
  in its current state.", "Changes were asked for (see the history under Publish). Change the caption or the plan and
  it's checked again.", "This reel was rejected. Change the caption or the plan to send it through review again.",
  "Checking… usually under a minute", "The checks are taking long.", "Read again", "No checks for this version yet.",
  "Saving the caption runs the checks again.", "Hashtags (separated by spaces)", "Save caption", "Discard", "Save or
  discard the caption first.", "A reel takes at most 5 hashtags.", "The post is over 2200 characters. Shorten the
  caption or the hashtags.", "Wait for the download to start.", "Downloading approves this version.", "Couldn't start
  the download. Try again.", "Your role can't approve reels, so Download (which approves) isn't here.", "Continue to
  Publish". ("Already checking. The result will appear here." is the phone's `alreadyChecking`.)
- Video step: "No video yet.", "Go to the storyboard", "It's safe to leave this page.", "Review your reel", "Making it
  again costs … now; the last try cost …". ("Failed at" and "N reserved credits released" are the phone's
  `recovery.json`.)
- Storyboard: "Wait for the plan to finish saving."
- Publish: "Make the video first.", "See the checks", "Publishing approves draft vN first.", "Connect an account for
  Instagram to publish it.", "Instagram needs reconnecting.", "Your role can't publish reels. Someone who can publish
  will post it.", "Your role can't approve reels, so it can't publish this one.", "Time zone: …"
- Overview: "Made in Reels. Change its plan, video and caption there."
- Reels home: the Add link dialog's "Post link" field label. (The dialog's title and text and "Posted it? Add link"
  are the phone's `reels.json`.)

**Manual checks for the owner**
- [ ] Double-click Make video: one render, one charge.
- [ ] A finished reel's storyboard shows "Watch the video". A forced render call (`{ action: "render", version }` on
  that version) gets 409.
- [ ] A 402 on Make video and on Try again opens the paywall.
- [ ] The player and every Review control by keyboard. Captions are on by default and in step with the voice.
- [ ] A sixth hashtag is refused before sending.
- [ ] Download saves `reel-<8>.mp4` and the reel shows as approved.
- [ ] Publish now on an unapproved reel approves and posts as one action (its confirm press included). After a failed
  publish, the next press doesn't approve again.
- [ ] Type a caption on Review without saving: Download and Continue to Publish are held with "Save or discard the
  caption first."; Discard brings back the saved caption and hashtags.
- [ ] Open Publish while the checks run: "See the checks" opens Review, and Publish opens once the checks land.
- [ ] Approving a studio reel in the Overview doesn't book it by itself (the server skips auto-publish for studio
  reels too).
- [ ] Schedule shows the time zone. Cancel schedule works.
- [ ] 375 px: no horizontal scroll on Video, Review and Publish.
- [ ] A studio reel in the Overview: the release panel asks for no video link; the content view shows "Open in
  Reels" and no draft editor.
- [ ] "Posted it? Add link" on an approved reel with no post link (people who can publish).
- [ ] The Overview's Quality check section looks as before (it now uses `ChecksList`).

**Not checked live:** renders were never run (no provider credits). The Video step, X01 and the captions' timing
against a real video are unseen. No browser check was done on the new steps; the list above is the owner's.

**Known limits**
- Captions are on our preview only, not burned into the video (spec Q2b).
- Nobody is told a render ended once they leave the page (Q3).
- The failed reel card says "Didn't work" without its credits (the owner's choice).
- The Review's checks wait stops after 10 minutes.
- Viewers can still save the video from the player. The approval gate covers the approval act, not the file.
- A failed publish attempt in History shows the platform's own message, as for posts.
- A scheduled reel that comes due while the page is open isn't noticed until the page is read again.
- "Open in Reels" shows only with the reels flag on.
- `/reels/{id}` still has no `scripts/audit-ui.ts` entry (no fixture reel).

## Feature 3b: reels steps and voice on the web (2026-11-19)

Branch `feature-3b-reels` in the server and web repos (not merged). Spec
`docs/superpowers/specs/2026-11-18-feature-3-reels-design.md`, section 7. Make video, Video, Review and Publish are 3c.

- **What was built.** Three more steps on `/reels/{id}`. **Presenter**: pick a brand presenter or none, preview a
  template, and "Create a presenter". **Photos**: pick the photo for each scene, or move a photo to another scene;
  nothing changes until you save. **Script & voice**: edit each scene's text, pick the reel's voice, and give a scene
  its own take by recording in the browser or uploading a file. The **Voices sheet** lists the workspace's voices and
  the ElevenLabs library (search, filters, "More voices"), with samples. **Clone a voice** records a reading and
  makes a voice from it. Behind `WEB_FEATURES=reels`.
- **Web kit.** `AudioRecorder` and `VoiceRow` (see `docs/DESIGN_SYSTEM.md` section 7). The microphone is on only
  while recording; closing the dialog stops it and sends nothing.
- **Paid buttons.** Make a presenter, the template preview and Create the voice use the shared paid press rules: the
  price shows from the server, a repeat never charges twice, and a 402 opens the paywall.
- **Server changes** (additive, with one change for old phone builds: a fast clone retry now gets 409 `clone.stillMaking`). Error code `reel.changed`; `clone.stillMaking`; an
  optional `consentVersion` on clone; the recording bucket is keyed by scope; library previews are https only. A take
  on a web-made reel now works (Task 1, S9).

**Calls made**
- The spec's "Play take" on a saved scene is not built. The server keeps no playable link for a take, so the record
  dialog plays only the take it just sent.
- A FAILED presenter shows the spec's "Didn't work · N credits back", not the phone's "You weren't charged".
- A voice pick saves on **Use this voice**, not on the radio change. Web radios fire on every arrow key, so saving
  on change would save while someone is only looking.

**Copy written without a source, for the owner to approve** (desktop-only lines, not from the phone's `reels.json`)
- Presenter step: "Pick one of your brand's presenters to speak on camera, or keep the reel on your product.",
  "Presenter removed: pick another.", "Presenters not ready", "Plan a reel first: a presenter is added to a reel's script."
- Presenter dialog: "Give them a name and pick a few traits. The rest is chosen for you.", "Presenters are AI-made
  people. Reels with a presenter are labelled as made with AI.", "One presenter is made at a time."
- Photos step: "Pick the photo for each scene, or move a photo to another scene. Nothing changes until you save.",
  "The photo for each scene.", "Stand-in: this photo doesn't show what the scene talks about.", "The plan changed:
  pick the photos again.", "Plan a reel first: photos belong to its scenes."
- Script step: "Plan a reel first: the script belongs to its scenes.", "The plan changed: edit the script again.",
  "This reel's voice isn't available any more. Pick another.", "From the ElevenLabs library", "Uses the voice above",
  "Editing this text drops its recording.", "Save your script changes before recording."
- Voices sheet: "Listen to a sample, then pick the voice that reads your reel.", "Search voices (name, style…)",
  "No voices match these filters.", "You can listen to every library voice now. Reels can use them once our
  ElevenLabs plan is upgraded.", the delete dialog text "The voice is deleted for the whole workspace, at ElevenLabs
  too. Reels using it need another voice. This can't be undone.", "Withdraw consent and delete".
- Record dialog: "Your browser will ask to use the microphone. The recording is sent to us only to check it and make
  your voiceover.", "Or upload an audio file, up to 15 seconds", "Checking what we heard…", "We heard" / "We heard
  something different", "Nothing. Check your microphone and record again, a little closer.", "Keep it, and the
  scene's text becomes what you said, so approvers read what is spoken. Or record again.", "This scene isn't in the
  plan any more."
- Clone dialog: "Your browser will ask to use the microphone. The reading is sent to us only to make this voice, and
  isn't kept.", "Reading language", "Record again?" and "Your reading so far is replaced.", "That recording is too
  large.", "Still being made…".

**Manual checks for the owner**
- [ ] Record a take in Chrome, Firefox and Safari: accepted.
- [ ] Upload an M4A and a WebM: accepted. An Ogg or an MP3: the server's 400. A 20 s file: "Keep it under 15 seconds."
- [ ] Clone: the consent text matches the server's, and there is no upload.
- [ ] A 402 opens the paywall from Make a presenter, the template preview and Create the voice.
- [ ] Keyboard through every radio group, the recorder and the photo moves.
- [ ] Arrow through voices: nothing saves until **Use this voice**.
- [ ] 375 px: no horizontal scroll on each new step.
- [ ] Mic denied: the sentence says "Your browser blocked the microphone…", and "Or upload an audio file, up to 15 seconds" still works. No microphone: "…or upload a file instead."
- [ ] Close the record dialog during the permission prompt and mid-recording: the mic indicator goes off and no take is sent.
- [ ] A take on a web-made reel works.

**Not checked live:** Presenter, preview and clone were never run for real (no provider credits). Browser checks on
the new steps are the owner's list above.

**Known limits**
- ElevenLabs sample and library preview links (`storage.googleapis.com`, ElevenLabs) are outside the report-only CSP
  `media-src`. Enforcing the CSP needs those origins added.
- There is no `Permissions-Policy` header today. If one is added it must allow `microphone=(self)`.
- A take's audio can't be played back after the dialog closes (the server keeps no playable link).
- Clone challenges are capped at 20 an hour per person.
- "More voices" can render up to 50 pages with no virtual list.
- The photoshoot studio still has its own press code; it could adopt `usePaidPress`.

## Feature 3a: reels plan and storyboard on the web (2026-11-18)

Branch `feature-3a-reels` in the server, web and mobile repos (not merged). Plan:
`docs/superpowers/plans/2026-11-18-feature-3a-reels-plan-storyboard.md`; spec `docs/superpowers/specs/2026-11-18-feature-3-reels-design.md`.

- **What was built.** `/reels` (the home: plan a new reel from a prompt, an idea or a template; the brand's presenters
  and templates; "Your reels") and `/reels/{id}` (one reel: a steps rail, the plan chat, the storyboard with a preview
  and scene by scene view). Behind `WEB_FEATURES=reels`. The assistant on `/reels` is a drawer; on other pages it stays docked.
- **Shared contract.** `shared/reels.ts` in the server holds the reel idea shape, the chat message limit, the reel stage
  rule and the video model names. The web uses it; the phone mirrors it by hand (comments in `index.tsx`, `review.tsx`
  and `storyboard.tsx` under `src/app/reels/`).
- **Server changes** (additive). Planning and chat are safe to repeat: a message carries a request id, and a repeat
  gets the first answer back. A second message on a reel still being planned gets 409 `reel.stillPlanning`. The reel
  list and the single read carry what the web needs to build the rail.
- **Web kit.** `StepsRail` and `PreviewFrame` (see `docs/DESIGN_SYSTEM.md` section 7). The signed link cache and the
  "don't charge or send twice" press logic were lifted out of the photoshoot into shared files (`lib/presser.ts`);
  photoshoot behaves as before.
- **Planning on the web.** Plan creates one reel, and closing the tab mid-plan and reopening finds that one reel, not
  two. A message sent while the network dies keeps its request id, so sending again is one turn.

**Calls made**
- The in-flight marker lasts 150 s, not the spec's 6 minutes (owner approved 2026-11-18, for a quick recovery after a
  killed run). Route `maxDuration` is not enforced on the self-hosted api (`node server.js`), and a live turn
  (scriptwriter, a retry, director) can outlive the marker, so a second send can then run alongside it. That overlap is
  safe: each run drops only its own marker, and a repeat that loses the version race gets the turn already saved under
  its request id. It costs at most one extra scriptwriter run, counted against the 20 an hour, never a duplicate turn.
  The owner may want to revisit the ttl.
- Revise pressers live at module level per business, brand and reel, as in photoshoot, so a kept id survives leaving the page.
- Ideas are read once when the reels home mounts (and again after an idea is planned), not each time the dialog opens.

**Copy written without a source, for the owner to approve**
- The ideas dialog description: "Pick one and the plan starts from it."
- The two reels gate lines, shown on both reels pages (`components/reels/access.tsx`): "Reels belong to a business. Create or pick one from the
  sidebar, then its reels show here." and "Your role cannot see this business's reels. Ask a workspace admin for access."
- The template title fallback in `components/reels/home.tsx`: a template with no label shows its id as the title.

**Manual checks for the owner**
- [ ] Flag off: `/reels` and `/reels/{id}` are 404 and there is no nav entry.
- [ ] Plan from a prompt, from an idea and from a template.
- [ ] Open a phone-made reel on the web.
- [ ] Close the tab mid-plan and reopen: there is one reel.
- [ ] A phone and a tab send a message on one reel at once: one is told to wait, both see the reply, and the waiting tab keeps its text.
- [ ] Send, kill the network mid-stream, send again: one turn.
- [ ] Press Plan while offline: the offline line shows, no wait.
- [ ] A Viewer sees the list and the reel with no composer.
- [ ] No plan: a banner shows, and Plan opens the paywall.
- [ ] Keyboard through the rail, the chips and the templates.
- [ ] 375 px: no horizontal scroll.
- [ ] Switch business on `/reels/{id}`: "Couldn't load this reel", no loop.
- [ ] At 1440 px on `/reels` the assistant is a drawer: Tab never reaches it while closed; once open, its Close button, the scrim and Escape close it and focus returns to the toggle; it is docked on other pages.

**Not checked live:** nothing in 3a was seen in a browser or on the emulator (build, typecheck, lint and unit tests
only). No live plan was run (no provider credits). The drawer, the 375 px layout, the offline and two-tab cases, the
paywall banner and the slide animation between docked and undocked pages at wide widths are all unseen.

**Known limits**
- `/reels/{id}` has no `scripts/audit-ui.ts` entry because no fixture reel exists. Run the audit by hand against a real reel id.
- The rendered reel video carries no on-screen text, only the "Made with AI" mark. The web preview hides its text
  overlay while the video plays, so what the owner sees on the photo is not in the finished video.
- `listReels` has no studio index, so it gets slower as a brand's reel count grows. Add an index for it before a brand has thousands of reels.
- The signed link cache never evicts. One entry per reel seen in a tab; a tab left open for days grows slowly. Evict by age if it ever matters.
- The library page's inline gate is not moved onto `featureAccess`; only the reels pages use it. Move it when the library is next touched.

## Feature 2: photoshoot on the web (2026-11-18)

Branch `feature-2-photoshoot` in the server, web and mobile repos (not merged). Plan:
`docs/superpowers/plans/2026-11-18-feature-2-photoshoot.md`; spec `docs/superpowers/specs/2026-11-18-feature-2-photoshoot-design.md`.

- **What was built.** `/photoshoot` (the studio: product or fashion setup, one Generate button with its price, the
  shoot in progress, and "Past photoshoots" with an All / Product / Fashion filter) and `/photoshoot/[id]` (one shoot:
  large photo, four thumbnails, Compare original, Download, the staging summary, and Variation on finished shoots only).
  Behind `WEB_FEATURES=photoshoot`. The photo is chosen in the feature 1 `LibraryPicker`. The shoot's id is in the
  address (`/photoshoot?shoot=<id>&b=<business>`), so a reload keeps the card.
- **Shared contract.** `shared/photoshoot.ts` in the server holds the request shape, tiers, credit prices, ratios and the
  brief limit (600). The server's zod schema and the web read it; the phone's `SHOOT_TIERS` is built from it.
- **Server changes** (additive, except the first). Media upload now needs `content.create` instead of `publish.execute`.
  Each shot of a single shoot read carries a `downloadUrl` that saves as `photoshoot-<first 8 characters of the id>-<n>.jpg`; the list and the
  create answer do not sign download links. The list signs only the source and the first shot of each shoot (what a
  card shows); the other shots come with their key and no `url` (`Shoot.shots[].url` is optional in the shared type).
  The single read and the create answer sign every shot. Uploads are limited to 60 an hour per user.
- **Kit.** `SegmentedRadios` (the pill radio group; the library's `SourceSwitch` now wraps it) and `ChoiceCards` (see
  `docs/DESIGN_SYSTEM.md` section 7). `JobProgress` and `LibraryPicker` now have their consumer. `useJob` gained `stopOn`
  and `status`; `SIGNED_LINK_STALE_MS` (`lib/signed-links.ts`) is the one rule for when signed links are re-read.
- **Double-press guard.** Generate and Try again ignore the second click of a double-click and stay off for 1.5 s
  (`PRESS_COOLDOWN_MS` in `components/photoshoot/press.ts`) after a shoot starts, so a held Enter can't start a second,
  charged shoot. Variation stays off after it succeeds until the studio replaces the page.

**Calls made in the spec** (cost if wrong is one string or one condition each)
- Creators may spend credits on a shoot, same as the phone (owner answer to the feature 1 question).
- Failed shoots read "Your N credits are back. Try again, or pick another quality." (the phone's wording).
- Unlimited (test) workspaces show no price on Generate or Variation, as elsewhere.
- Generate, Try again and Variation stay disabled until the plan's prices have been read, so the price is on the button
  that spends it. If that read fails, the reason shows and "Read prices again" appears.
- A press whose outcome is unknown re-sends with the same request id, so a double click or a retry is one shoot and one
  charge. No answer or any 5xx keeps the id; a 4xx or a success starts a new one, and so does a changed request.
- Variation runs the same setup again and charges again; it is not offered on running or failed shoots.
- While "This shoot" runs, only it polls (5 s for 2 minutes, 10 s to 10 minutes, then 30 s); the list polls (10 s)
  only for other running shoots, and reads once more when "This shoot" ends so its card updates (once again 5 s later
  if that read fails). The shoot page polls
  on the same steps.
- A shoot the server never finishes is failed by the server after an hour; until then its poll keeps going.
- Switching business on `/photoshoot?shoot=...` shows an empty "This shoot", never a loop (404 and 403 stop polling).

**Manual checks for the owner**
- Flag off: `/photoshoot` is 404 and there is no nav entry.
- Double-click Generate: one shoot, one charge. The credits chip drops after Generate and rises after a refund.
- A 402 opens the paywall dialog.
- Custom scene with a blank brief: Generate is blocked, with text saying why.
- A Creator can upload in the picker. A Viewer sees a read-only studio.
- Keyboard through every radio group (arrows move, space selects). Enter on a radio card does not start a shoot.
- 375 px: no horizontal scroll, on the studio and on a shoot page.
- Switch business mid-shoot: no 404 loop. On `/photoshoot?shoot=...`, switching shows an empty "This shoot".
- Download saves a file (not opens a tab). Reload with `?shoot=` keeps the card.
- A new shoot appears in "Past photoshoots" at once.
- A page left open over an hour still shows its photos and downloads (links are re-read after 50 minutes).

**Not checked live:** no browser or emulator run of either page (build, typecheck, lint and unit tests only); a real
generation (no provider credits); the 402 dialog; the 60-an-hour upload 429 (and whether the phone handles an upload
429 well); the 60-photo 409; signed links after an hour; the feature 1 picker against real photos.

**Known limits**
- `/photoshoot/[id]` has no `scripts/audit-ui.ts` entry because no fixture shoot exists; the studio does (320 px and
  1280 px). Run the audit by hand against a real shoot id.
- Custom roles need `content.create` to upload photos. A custom role with `publish.execute` but not `content.create`
  now gets 403 on upload. The dev DB has no custom roles (wiped to admins on 2026-11-17); an admin adds the permission.
- Creators can fill the brand library (60 photos), and only `context.edit` can empty it.
- The upload limit (60 an hour per user) counts refused files too.
- An upload with no Content-Length (a chunked body) gets 411; over 4 MB gets 413. fetch with a FormData body sends the
  length, so the web and the phone are unaffected. The photoshoot start checks permission before it reads the body.
- The "don't charge twice" press rule lives in two places: web `components/photoshoot/press.ts` and the phone's
  `src/ui/photoshoot/start.ts`. Each has a comment pointing at the other; keep them in step. Both use the shared
  `shouldKeepRequestId` and `shootRequestKey` (`shared/photoshoot.ts`): no answer or any 5xx (JSON or a gateway page)
  keeps the id, a 4xx clears it. A 409 `request.idTaken` (the kept id's try was already refunded) is retried once,
  silently, with a new id, so the press after a refunded 500 works. After a press that kept its id the web reads the
  list and the balance again, and once more 15 s later (one timer per tab: a later unknown press replaces it); the
  phone does not (its results list reads again each time it is opened).
- The phone's option lists (`src/ui/photoshoot/options.ts`) are only type-checked against the shared contract, not
  built from it: a new shared value will not show on the phone by itself.
- Signed links last an hour; the web re-reads at 50 minutes. The source thumbnail in the setup is not re-read (preview only).
- Bundle: first-load JS is about 153 kB for `/photoshoot` and 148 kB for `/photoshoot/[id]` (shared 102 kB). Nothing
  checks bundle size; `check:bundle` only looks for secrets and Prisma in the output.
- Small things left: "Open full size" (a shot with no download link) may be blocked as a popup; Download gives no
  feedback while a stale shoot is re-read; a 403 on a shoot shows "Couldn't load" with Try again; a missing shoot returns
  HTTP 200 with the not-found page; the empty filter reads "No photoshoots yet."; focus is not moved to "This shoot" after
  Generate; the brief field lacks `aria-required`; each shoot read signs its links twice (2N presigns).
- Opening `/photoshoot?shoot=<finished id>` reads the list twice on load.
- A missing or flag-off page shows the 404 page with HTTP 200 (a soft 404). This was already the case before.
- The website copies the phone's English wording by hand (`components/photoshoot/labels.ts`, `shoot.ts`, from the
  phone's `photoshoot.json`); nothing checks the two match, so keep them in step.

## Feature 1: brand look and photo library on the web (2026-11-17)

Branch `feature-1-brand-library` in the server, web and mobile repos (not merged). Plan:
`docs/superpowers/plans/2026-11-17-feature-1-brand-library.md`.

- **What was built.** One `/library` page, labelled "Brand & photos": photo grid with add and remove, brand colours
  (colour dialog), tones, and a read-only logo. Behind `WEB_FEATURES=library`. `LibraryPicker` (`onUse(photo)`, `children`
  for feature text) is used by the photoshoot (feature 2); `putShared`/`sharedAt` in `use-job.ts` and live regions in `JobProgress`.
- **Shared contract.** `shared/brand-look.ts` in the server; the web uses it, mobile took only the copy (wording), not
  the module.

**Defaults taken for the owner questions** (owner said "yes start"; cost if wrong is renaming or moving one page)
- One page, "Brand & photos". Files over 4 MB are refused in the browser, before any request.
- Server permissions: add photo = `publish.execute` (feature 2 changed it to `content.create`, so Creators can upload); remove photo, colours and tones = `context.edit`.
- Logo is read-only; fonts, tagline and audience are not shown.
- Answered 2026-11-18: Creators may spend the workspace's credits on a photoshoot, as on the phone.

**Manual checks for the owner**
- Flag off: `/library` is 404 and there is no nav entry.
- Add 3 JPEGs. A HEIC file and a 6 MB file are refused with no network request.
- Remove a photo: focus lands on "Add photos". Refresh makes exactly one GET.
- Keyboard through the switch, grid, tones and colour dialog.
- 375 px: no horizontal scroll. Switch business: the page reloads that business's look and photos.
- A role without `context.edit`: remove, colours and tones are unavailable.

**Not checked live:** the 60-photo 409, signed links after an hour, the picker (until the photoshoot exists).

**Open minors (deferred)**
- Route `.max(5)` literal vs `MAX_COLORS`; `HUES`/`SHADES` not readonly; `brand-summary` import mid-file; no shade
  step < 0 test.
- 50-minute link staleness is only re-checked on render (documented ceiling); extra `pickUploads`/`paletteAfter` edge tests.
- `busyKey=""` magic value; Lock icon on the no-permission state; 16 px gap from empty live regions; focus moves on a
  failed remove.
- Tones Save enabled when re-picked back to the saved set; disabled Save shown to non-edit roles; an unchanged colour
  save sends a no-op (the phone does the same).
- Invented empty titles "No photos" / "No uploads" in the picker.
- Closed: the 0c minor "JobProgress needs a live role" (it has live regions; the photoshoot now renders it).

## Foundations 0c: website UI kit and accessibility (2026-11-17)

Branch `foundations-0c` in the server and web repos (not merged). Plan:
`docs/superpowers/plans/2026-11-17-foundations-0c-web-ui-kit.md`. Server commits `e224188..HEAD` (the subscription route
now also returns each action's price and `freeAgents`; additive), web `7ed2fef..HEAD`.

- **Kit.** `PageHeader`, `PageSection`, `StatusBadge` (one status-to-tone map in `lib/status.ts`), `JobProgress`,
  `CreditsChip` and `PaywallDialog` (now a real dialog), `PageSkeleton`; all in `docs/DESIGN_SYSTEM.md` §7. Settings,
  Products, Connections and the other pages use them.
- **Nav and shell.** Route names and groups from `lib/nav.ts` (`navFor`); page titles derived from it. Below 768 px the
  sidebar lives in a sheet opened from the Menu button. "Create a business" is a real menu item that opens its dialog.
  The Overview panel menu (move, hide, collapse, expand) keeps keyboard focus.
- **Prices.** Paid buttons show their price from the server, including the two run triggers outside the plan's file
  list ("Get ideas", "re-read it now"). The plan/credits store now queues one follow-up read after an in-flight one.
- **Audit script** `scripts/audit-ui.ts` (web) also checks every shell route at 320 px and counts content pushed past
  the right edge.

**Decisions that change what people see**
- Page titles are `text-3xl` (were smaller).
- Badge colours come from one map: admin `RUNNING` is now indigo (info); text on tints uses the new `--success-ink` and
  `--warning-ink` so contrast passes 4.5:1. Admin run/call `ESCALATED` and `FELL_BACK` stay amber (warn).
- Unlimited (test) workspaces show no price: their charges are zero, a price would be false.
- The Overview feed's icon-only run buttons carry the price in `aria-label`/`title`, so it shows on hover and to a
  screen reader, not on screen. Ask if it should be visible text.
- No sidebar below 768 px; use the Menu button.
- `JobProgress` was built here; the photoshoot (feature 2) is its consumer.
- Route names/groups follow plan Decision 12 and sit behind flags that are off by default.

**Audit not run.** It needs the admin login and both servers up. With the server on :3101 and the web built
(`npm run build --prefix .`) and started (`npm run start --prefix .`) on :3100, from the web repo:
`SEED_ADMIN_EMAIL=... SEED_ADMIN_PASSWORD=... npm run audit:ui --prefix .`.
Expect: every `narrow` line shows `overflow: none` and `offscreen: 0`; no `color-contrast` rule on pages with badges;
`page-has-heading-one` absent for /agents. A nonzero `offscreen` must be read through the names it lists: rows that are
meant to scroll sideways count too, and overflow can read none while offscreen is above 0 (that is the clipped case).
Note which routes really rendered (admin may be redirected to /welcome or /admin).

**Not checked live (manual, by hand)**
1. Credits chip, its popover and the 402 dialog (the dialog was never reached in a manual check).
2. Priced buttons against a real balance.
3. Overview panel menu by keyboard: Move and Hide keep focus, Escape and Collapse return focus to "panel options".
4. The menu sheet at 320, 767 and 768 px; also the Settings members table at 768 to 1280 px: a wide table scrolls inside
   its card instead of spilling out.
5. Wide screens (1280 px and up): horizontal scroll, now that the page-level overflow clip is gone.
6. "Create a business" by keyboard: Enter opens it, focus lands in the name field, Escape returns to "Select business",
   and the page is still clickable afterwards. Radix can leave `pointer-events: none` on the page after a menu-to-dialog
   handoff; judged unreachable today (the menu has no exit animation), but an animate plugin would make it real. Fix then:
   open the dialog from the menu's `onCloseAutoFocus`.
7. `JobProgress`: now used by the photoshoot; see feature 2's manual checks.

**Deferred minors (for a final fix round)**
- `ai-models-tab`: missing `pb-0` when ready (about 32px dead space); check the long `usedBy` badge on a narrow screen.
- `JobProgress`: the slow/failed notices need a live role (the failed line has none; they mount with their content, so
  screen readers may skip them). Fixed before feature 2 rendered it. Also aria-valuenow is not clamped and empty steps read
  "Done".
- Credits chip: "Couldn't read the balance" shows when only the /subscription read failed; reword so it says what failed.
- Open owner question: the Overview feed's run-button price is only in hover and screen-reader text (see above).
- Before relying on the layout, run the UI audit at 320 px and 1280 px in a fresh browser (command above). The Overview's
  layout hint now sits above the panel columns (not in the top bar), which fixed the top bar overflowing at 1024 to
  about 1600 px.
- Sheet stays open if the viewport widens to md while open; a modifier or middle click on a sheet link also closes it.

## Foundations 0b: website plumbing (2026-11-17)

Branch `foundations-0b` in the server, web and mobile repos (not merged). Plan:
`docs/superpowers/plans/2026-11-17-foundations-0b-web-plumbing.md`. Web commits `663cc50..HEAD`, mobile `dbb5a17..HEAD`.

- **Transport.** Per-call timeouts, `X-Client: web/<version>` on every request, `requestId()`. One `request()` keeps the
  server's error body, merges headers (a `FormData` upload still sends no `content-type` of ours) and reads NDJSON
  streams; a stream that breaks mid-answer is `ApiError` status 0.
- **Paywall.** A recognisable 402 (credits or plan refusal; a gateway page or unknown body does not) opens the paywall
  event; a per-workspace plan/credits store (an answer lands under the workspace it was asked for) and a stub dialog.
- **Shared contract check.** `scripts/check-shared.mjs` in web and mobile runs as part of `typecheck`. The hash
  normalises CRLF to LF; the server's `sync-shared.mjs` does the same. Failures read
  `check-shared: <dir> was edited by hand.` (the copy differs from its own `.hash`) or
  `check-shared: <dir> is older than the server's shared/.` Fix for both: `npm run sync:shared --prefix .` in the server
  repo, then commit in web and mobile. Never edit the copies.
- **`useJob`** on the shared per-URL cache: one request in flight per URL (panels and StrictMode share it), reload
  fetches afresh, backoff, 429 waits 60 s, pause in a hidden tab, per-episode cap and "slow". `StoryFrames` and
  `ReleasePanel` poll through it.
- **Feature flags** `WEB_FEATURES` and `WEB_FEATURE_WORKSPACES` (`feature:workspaceId`).
- **Headers.** `X-Frame-Options: DENY`, `frame-ancestors 'none'`, and a report-only CSP with a per-request nonce and
  `STORAGE_ORIGIN` (cleaned to an http(s) origin, else left out).
- **Hardening.** `safeHttpUrl` for doc-pane and products-board links, `react/no-danger`, `twilio`, `fflate` and
  `@elevenlabs/*` banned from the website, and the bundle check fails on secret-looking `NEXT_PUBLIC_*` names.

New web settings: `WEB_FEATURES`, `WEB_FEATURE_WORKSPACES`, `STORAGE_ORIGIN` (see `docs/DEPLOY_EC2.md`).

**Also watch.** Static pages (e.g. `/login`) prerender without the nonce, so the report-only CSP lists their scripts.
While a story is publishing, the shared `content/:id` poll re-signs frame links every 5 s and the frame pictures reload.
`ReleasePanel`'s "due within a minute" is time-based and only re-evaluates on a render.

**Report-only to enforcing CSP.** Read the violation reports for a while, then: make the static pages dynamic (so
their scripts get the nonce; today they do not), confirm scripts carry the nonce on a dynamic page with the Server
running, and only then switch the header from `Content-Security-Policy-Report-Only` to `Content-Security-Policy`.

**e2e was not run.** The dev database was wiped down to the admin users at the owner's request, so the owner will test
by hand once the web is built.

**Not checked live yet**
1. One forced `/credits` + `/subscription` read after a paid start or a 402.
2. One request per URL across the Overview's panels (DevTools network tab).
3. Story and release polling in the browser.
4. Script nonces on a dynamic page with the Server running (required before enforcing the CSP; static pages like
   `/login` must become dynamic first).
5. A `javascript:` product URL rendering as plain text.

## Foundations 0a: server safety (2026-11-17)

Branch `foundations-0a` in the server, web and mobile repos (not merged). Plan:
`docs/superpowers/plans/2026-11-17-foundations-0a-server-safety.md`; spec `docs/superpowers/specs/2026-11-17-foundations-design.md` §5.

- **Voice-clone challenge.** `GET …/voices/clones/challenge?lang=xx` returns the clone passage shuffled into rounds
  (≥140 words); `POST …/voices/clones` needs its `challengeId` and checks the transcript against it
  (`clone.notTheChallenge` 422, `clone.challengeExpired` 410). The phone reads the challenge.
- **One charge per submit.** Optional `requestId` (UUID) on `POST /photoshoots`, `/voices/clones` and `/reels`: a
  repeat returns the first record (200); another workspace's id is 409 `request.idTaken`; a reel still being planned
  is 409 `reel.stillPlanning`.
- **Reel planning** needs a plan and is capped at 20 scriptwriter runs per brand per hour; edits only check the plan.
- **Re-render** of a version that already has a video is 409 `render.alreadyDone` unless the body says `again: true`.
- **Cross-origin check** for cookie writes in `middleware.ts` (`CSRF_MODE`, `WEB_ORIGINS`); `serverFetch` sends the
  website's origin (`WEB_ORIGIN` in the web repo).
- **WebM recordings** accepted next to M4A; ffmpeg is always told the format.
- **Inbox and Google reads** cached 45 s per brand (`TransientEntry`), cleared on a reply or post.
- **Brand routes** read the member, the brand and the project grant once; balance reads no longer write the starter
  grant (made at workspace creation; a migration backfills it).
- **`X-Client`** tag (`web/…`, `mobile/…`), `PAID_STARTS_OFF_FOR`, and a `paid.start` log line per paid start.

Deliberate breaks: an app build without the challenge gets 409 `clone.updateApp` when cloning; a second render of a
version that has a video needs `again: true`.

New settings: server `WEB_ORIGINS`, `CSRF_MODE`, `PAID_STARTS_OFF_FOR`; web `WEB_ORIGIN`. First deploy with
`CSRF_MODE=log`.

Shared code: edit `shared/` in the server repo, then `npm run sync:shared --prefix .` copies it to `../web/shared` and
`../mobile/src/shared` and writes the same `.hash` into all three; commit in each repo.

Not yet checked live: cloning and a photoshoot double-tap on the emulator (they call paid providers).

## Server / Web Frontend split (end of day 2026-11-16)

**Merged into `desktop-shell` (`2cbfef1`), not pushed.** The `sma-split` worktree is removed; the
`server-web-split` branch is kept. `apps/brandpilot-ai` (the unused Reddit Devvit starter) was removed after the merge
(`ae8e5cf`).

**Check first tomorrow**
1. Rerun the checks on the merged `desktop-shell` (not run since the merge and the brandpilot removal):
   `npm run typecheck`, `npm test`, `npm run lint`, `npm run build:server`, `npm run build:web`,
   `npm run build:worker -w server`, `npm run check:web-bundle`, and e2e.
2. Click through the web frontend in a real browser (Claude in Chrome was turned off today). Only an HTTP walk was
   done after the merge: sign-in, all 15 pages 200, brand switch, expired-session redirect, health direct and via
   :3100. The owner signed in and opened Overview by hand on 2026-11-16 (see item 3).
3. Overview panels wait about 2.5 s for their data (Documents, Agents, chat), since the browser now fetches each panel
   from the Server instead of the page arriving with it. Each API call takes about 2 s in dev: several queries in a row
   to the Neon database in Frankfurt, plus the first compile. Decide whether that is acceptable or worth trimming
   (fewer queries per request, or the Overview's first data rendered on the web server via `serverFetch`).
   The loading placeholder (`ListSkeleton`, `apps/web/components/settings/shared.tsx`) was a white card on a white
   panel and read as an empty box; it is now grey (`bg-muted`). That changes every list that uses it (Overview,
   settings tabs, products, campaigns, audits); look at one or two in the browser.

**Checked after the merge**
- Phone app on the emulator against the split server (:3101): Today, Stories and Settings → Posts planner load real data
  (credits, brand, post awaiting approval with image, agenda, planner); all 19 API calls answered 200/204.

**Local setup after the merge** (values not shown)
- Server env is in `apps/server/.env` (AWS_* storage keys renamed to STORAGE_*). `apps/web/.env` holds only
  `SERVER_URL=http://localhost:3101`. The phone's `EXPO_PUBLIC_API_URL` is `http://192.168.0.12:3101`.
- Start with `npm run dev:server` (:3101) and `npm run dev:web` (:3100). Dev workers skip the paid daily sweep unless
  `WORKER_DAILY_SWEEP=true`.
- Emulator: the SDK is at `C:\Users\INTEL\Android\sdk`. Start Pixel_10 with
  `emulator-37.3.5-backup\emulator.exe -avd Pixel_10 -no-snapshot-load -gpu swiftshader_indirect` (the default GPU
  mode crashes system_server). `adb reverse` to Metro was very slow, so point the app at Metro directly: write
  `debug_http_host=10.0.2.2:8081` into the app's `shared_prefs/com.espanda.app_preferences.xml` via `run-as`, then
  launch. Screenshots: `adb emu screenrecord screenshot <file>` (`screencap` aborts on this emulator).

What follows was written before the merge.

Branch `server-web-split` in the worktree `C:\Users\INTEL\Desktop\sma-split`, committed, **not pushed, not merged**
(branched from `desktop-shell`). Spec `docs/superpowers/specs/2026-11-16-server-web-split-design.md` (with an "As
built" note at the end), plan `docs/superpowers/plans/2026-11-16-server-web-split.md`. Four-lens review reports in
`docs/handover/2026-11-16-server-web-split-review/` (security, correctness, operations, separation): no Critical, 6
Important, **all fixed** (`cdb20a6`..`22de034`), plus the cheap Minors (`7c8b328`, `be8ad38`).

**What was built**
- `apps/server` (package `server`, :3101): every API route, `server/`, Prisma, Auth.js, jobs and a standalone worker
  (`worker/main.ts`, bundled to `dist/worker.js`). `apps/web` (package `web-frontend`, :3100): pages and components
  only, reaching the Server over HTTP (`serverFetch` server-side, relative `/api` in the browser; dev rewrites `/api/*`
  to :3101). `packages/shared` (`@espanda/shared`): types and helpers, no dependencies. `apps/mobile` is `mobile-app`.
- New endpoints: `/api/v1/me/shell`, `/api/v1/me/context`, `/api/v1/admin/*` and the two `…/visit` POSTs. Login and
  welcome run on `next-auth/react`. `GET /api/v1/me`, the phone API, the login wording and the cookie names are unchanged.
- Deploy: Dockerfiles (server targets api / worker / migrate; web), `docker-compose.yml` with nginx, and
  `docs/DEPLOY_EC2.md` (ALB rules, `docker run` lines, worker lifecycle-hook step, env per role, deploy order).
- Review fixes: lint now catches imports by workspace package name, `@/..`/`./..` climbs and `import()`; the worker runs
  `WORKER_CONCURRENCY` (default 4) claim loops and stops claiming on SIGTERM; the admin overviews' latest rows are all
  time again; `KEEP_ALIVE_TIMEOUT=335000` in both images; api and worker refuse a non-https `AUTH_URL` and missing
  storage keys in production.

**Done and checked** (2026-11-16, after the fixes): `npm run typecheck`, `npm test` (server 806, web 51), `npm run
lint` (0 errors, 9 older warnings), `npm run build:server`, `npm run build:web`, `npm run build:worker -w server`,
`npm run check:web-bundle` (2470 files clean), `npm run test:e2e` (12 passed, 5 skipped for missing seed data; the only failure is the known products spec, which needs `E2E_PRODUCTS_BRAND`, and its 3 dependants did not run).

**Docker, checked locally** (2026-11-16): `docker compose build` builds all four images. The web image has no secret
names and no `.env` file. Both server images run as `node`, with fonts, email assets, Linux ffmpeg/ffprobe, sharp and
the Prisma client working. `KEEP_ALIVE_TIMEOUT=335000` is set. `docker compose up` with a self-signed cert and
`AUTH_URL=https://localhost` starts migrate (no pending migrations), worker, server-api (healthy), web (healthy) and
nginx. Over https through nginx, sign-in works and every shell and admin page loads. The brand switch, the 404 for a
foreign workspace and `/login?expired=1&next=` all behave. Port 80 answers 301 to https, both health checks answer,
and the nginx log has no query strings. A probe job of an unknown type was claimed and released with its attempt
uncounted. `docker compose stop worker` waited for the two jobs in flight (21 s) and then exited.
- Fixed on the way: the migrate image ran `npx prisma`, which skips PATH and fetched the latest prisma (8.0 rc).
  That version refused the command, so nothing ran. It now calls the pinned CLI directly.
- Watch out: a fresh worker after 05:00 UTC queued that day's sweep, which runs the paid agents. The local check did
  that once on the dev database: 6 agent runs and 4 catalogue syncs. Since `3129768` the sweep is queued only when
  `WORKER_DAILY_SWEEP` is on (unset: only with `NODE_ENV=production`). The images set production, so a local docker
  worker needs `WORKER_DAILY_SWEEP=false` in its env file (`apps/server/.env.example` has the line commented out, so a
  copied template keeps production on).

**State machine audit and fixes** (2026-11-16): two audits in `docs/handover/2026-11-16-server-web-split-review/`
(`state-machines-a.md`: queue, agent runs, voices, credits; `state-machines-b.md`: content, publishing, renders, auth),
committed in `849cfb1`. Fixed, one commit each:
- B-I1 (new with the split, double post): each publisher calls `beforePublish` just before its irreversible call; a
  CAS that the attempt is still PUBLISHING and this runner still holds the job's lease (`holdsLease`, FOR SHARE, a
  minute to spare). The 10-minute `releaseState` rule stays, documented: it can no longer double-post (`aa3e4ad`).
- A-I2: AgentRun RUNNING/SUCCEEDED/FAILED writes are CAS on the expected status; SUCCEEDED also needs the lease; the
  failure hook refunds in the same transaction as FAILED; `holdLease` logs failed and lost renewals (`079117f`).
- A-I1: a job out of tries is parked (pending in a minute, no tries left) and dead-lettered only after its failure hook
  succeeded; a hook that throws, or a process that dies, is retried through the "cut off" branch, which never reruns the
  job (`ecf64e6`). Chosen over a daily repair sweep: one place for every hook, recovery in a minute.
- A-I3: the daily sweep reclaims abandoned clone reservations in every workspace, reusing createClone's clean-up
  (`787f05a`).
- Minors: B-M1 reel JOIN claim heartbeat (`0477e37`); B-M4 a publish whose job died before claiming is FAILED (or
  PARTIAL) instead of SCHEDULED forever (`ed59600`); B-M7 `failStoryStart` guard and stale 300 s comments (`8b2ddd5`);
  A-M1 catalog-sync comment corrected, overlap judged harmless (`656c2e3`); B-M2 advisory lock on phone code requests
  (`7721d31`); A-M2 renewal failures are logged (in `079117f`).
- Cleanup (`3129768`): `WORKER_DAILY_SWEEP`, `WORKER_CONCURRENCY` clamped to at least 1, `.env.example` unquoted for
  `docker run --env-file`, DB pool size and idle polling in `docs/DEPLOY_EC2.md`.
- Audit Minors still open: A-M3 a failed clone deletes a row archived meanwhile, and `makeSample` can write after the
  delete; A-M4 the daily sweep is all-or-nothing per day; A-M5 email can send twice on a kill, FAILED rows keep their
  links; A-M6 `/api/v1/jobs/run` ignores `RUN_JOBS_IN_API=false` (no impact while `CRON_SECRET` is unset); A-M7 a
  charge can be taken with no run to refund it; A-M8 mixed-version safety is one-way; A-M9 concurrent `enqueueJob`
  upserts (uncertain); B-M3 a disconnect racing the publish claim; B-M5 a lost lease can fail and refund a shoot, asset
  or render that then finishes (now logged, not prevented); B-M6 two token refreshes at once (uncertain); B-M7's
  asset stale sweep at one hour, `REVIEWED`/`CANCELLED` with no writer, and `maxDuration` exports kept on routes.
  Nothing caps a job's run time.
- Checked after these fixes: `npm run typecheck`, `npm test` (server 832, web 51), `npm run lint` (0 errors, the 9
  older warnings), `npm run build:server`, `npm run build:web`, `npm run build:worker -w server`, `npm run
  check:web-bundle`, `npm run test:e2e` with `RUN_JOBS_IN_API=false` (12 passed, 5 skipped; the products spec fails
  without `E2E_PRODUCTS_BRAND` and its 3 dependants did not run, as before; no job was left queued).
- Review of that round (`.superpowers/.../sm-fix-review.md`, 2 Important) fixed: the lease margin is required only
  before the platform call, so a late renewal no longer strands an agent run RUNNING or a publish PUBLISHING, and a
  stopped publish (or a DB error in its re-check) ends FAILED "Nothing was posted" (`8c8b861`); `WORKER_DAILY_SWEEP`
  ships commented out, reads true/1/false/0 in any case, and warns daily when off in production (`e2541d2`);
  `WORKER_CONCURRENCY=0` is one loop (`aeda290`); the clone reclaim can't fail the sweep (`beb5c0b`); a retried hook
  keeps the job's real error (`3d646f0`). Still open from that review: a parked job reads as "in progress" while its
  hook retries, a hook that always throws retries every minute with no cap, a hung reel join keeps its claim fresh
  (its downloads have no timeout), `WORKER_INTERVAL_MS` is unclamped, and a test for a parked job claimed by another
  runner before its dead-letter write.

**Still open**
- From the operations first-build checklist, still unchecked: the http `AUTH_URL` refusal, streaming and >60 s
  requests through nginx, and an EC2 run.
- A browser walk of the website on :3100 (the controller couldn't use Chrome), and the phone on the emulator against :3101.
- Minors left open (details in the reports): visit POST inside `Promise.all` (an audit-write failure fails the page);
  `/me/context` exact-origin check fails on `127.0.0.1` in dev; Google button
  flash on login; silent workspace-switch failure; unknown-type jobs churn and inflate counts (and never dead-letter);
  `?before=garbage` cursor and the `queryOf` comment; a signed-in `/login` shows the form briefly; the Server's
  `authorized` callback is dead; three server-only helpers in shared; the server's unused React Vite plugin;
  `check:net`'s `react-server` condition; ALB XFF settings, the internal ALB's security group and HSTS are not in the
  guide; migrate gets the whole Server env; visit POSTs have no Origin check; the web image bakes the dev `/api`
  rewrite; invitation-accept cookies lack `secure`; `next build` copies `.env` into standalone (deploy only via images);
  root devDependencies in the server image; no worker liveness signal; job types and payloads are not in the
  one-release compatibility rule; compose re-runs migrate; no TLS issue/renew steps; `apps/server/.env.example` misses
  some variables the code reads; ENV_SETUP's `neon env pull` note; the `PINTEREST_PIN: 500` literal.

**At merge time (env, by hand; none of these files is in git)**
1. `apps/mobile/.env.local`: `EXPO_PUBLIC_API_URL` → `:3101`.
2. Copy the main tree's `apps/web/.env` to `apps/server/.env`, renaming `AWS_*` to `STORAGE_*` (table in
   `docs/ENV_SETUP.md`).
3. A new `apps/web/.env` holding only `SERVER_URL=http://localhost:3101`.

## Instagram stories (end of day 2026-11-13)

Branch `desktop-shell`, committed, **not pushed** (`main` still at `08e5fb1`). Spec
`docs/superpowers/specs/2026-11-13-instagram-stories-design.md`, plan `docs/superpowers/plans/2026-11-13-instagram-stories.md`
(commits `f7e6ef6` to `e033d6b`). Each task had its own review (most had a fix round). The whole-branch four-lens
review ran at the end of the day: no Critical findings and 8 Important, **all fixed by 2026-11-16** (list below; full reports in
`docs/handover/2026-11-13-stories-final-review/`). Web: 756 vitest tests pass, tsc clean; phone: tsc clean, `expo lint`
shows only 4 older errors in the reels screens.

**What it does**
- A story is 3–5 frames, each a photo or a clip (15 s window, sound on or off), with headline/body text, a CTA on the
  last frame and an optional brand mark, rendered on the server (`server/stories/render.ts`, ffmpeg + sharp, text burned in).
- Frame sources: phone upload (one-tap rights confirmation, single-use upload slots, 20 per brand per hour), catalogue
  products, the brand's earlier work (library, posts, photoshoots, finished reels), and Generate (Photoshoot or the Reels
  studio, with **Use in story** bringing the result back to its frame).
- The agents plan and write stories (Planner slots Wed + Sat); an app-requested story costs 5 credits, refunded if writing fails.
- Checks: story rules plus the shared text, product and offer checks.
- Two ways out: Schedule (published frame by frame, never a frame twice, partly-posted state with Post the rest / Mark
  done) or Post by hand (a checked zip package plus a due list and in-app reminder; the pasted story link is kept).
- Web: calendar, lists, content workspace with approval, schedule, download, post by hand. Phone: Stories and Today
  screens, approve / schedule / post by hand, and the editor (frames, text, CTA, picker, crop with Fit/Fill, trim, sound).

**How to try it**
- Seed a draft: `npx tsx --env-file=.env scripts/seed-story.ts` in `apps/web` (pinned to the dev workspace and brand;
  only database hosts listed in `SEED_ALLOW_DB_HOSTS`); `--reel` seeds a finished reel to pick; `--remove` cleans up.
- Phone deep links: `espanda://posts/edit-story?id=<id>`, `espanda://posts/story/<id>`.

**Before it can go live**
- Scheduling needs an Instagram **Business** account connected; it was not run end to end against the Graph API.
- Generate needs Higgsfield credits for new Photoshoot or Reels results (picking existing ones works).
- The in-app due card works today; only a push reminder for by-hand stories waits for Firebase push setup.
- Check that `next build` traces `ffprobe-static` and the fonts (`next.config.ts` outputFileTracingIncludes); not run.
- A new phone dev build is needed (expo-media-library, expo-clipboard and the `app.json` plugins).
- New phone strings are English only in this branch; the other 23 languages need translating.
- A release build is needed to confirm an upload retries after the app returns from the background, and pinch-to-zoom
  needs a real device.

**Known gaps (documented, not built)**
- Generate for a product story opens Photoshoot's product setup at 9:16 but doesn't preselect the product photo
  (catalogue products aren't linked to the photo library); owner to confirm that reading of "product preset".
- Clips picked from the library or posts (not uploaded, not reels) take their size from the player, so a rotated one may
  preview a little off; the render is right.
- The server doesn't strip a crop sent on a reel frame (the phone never sends one).
- Deferred minors from the per-task reviews: library list has no cap, list GET exposes media keys, calendar thumbnails
  re-signed on each poll, no per-version frame history.

**Final review Important items: all fixed 2026-11-16** (`a927ccc`..`9f712cf`; reports in `docs/handover/2026-11-13-stories-final-review/`)
1. Duplicated story rewritten by the agents: the Brief writer now only takes PLANNED items with no version.
2. By-hand steps: one list in `server/stories/by-hand-steps.ts`, shown in the web panel and written to the zip's
   `steps.txt` with the link; the unused `steps` field left the package JSON. The phone keeps its translated steps.
3. Clip-first thumbnails: the clip render stores a poster JPEG beside the MP4 (`posterKeyFor`), and `coverUrl` hands it
   to the content list and the due list. Clips rendered before this get a poster only when their render is reused.
4. Unwritten Planner story: the detail hides Edit until there's a version and says it isn't written; the card says
   "Not written yet". No "Write it now" action (would need a new paid server action).
5. VoiceOver: the card offers Duplicate and Delete as accessibility actions.
6. Refusal strings: en strings for the reachable save, render, upload, posting and by-hand codes; frame refusals send
   `{ n }` as data and a failed render keeps it (`renderErrorData`). Posting outcomes stored on attempts
   (`dailyLimit`, `businessOnly`, `refused`…) still show the server's text.
7. Editor failed read: error and Try again in the status line, read-only until the read succeeds.

**Minor fixed 2026-11-16** (`8e68f95`..`747d6e6`)
- Clip metadata: `-map_metadata -1 -map_chapters -1`, `RENDERER_VERSION` 3. Checked with real ffmpeg: its MP4 output
  already dropped location tags, but a source clip's title and comment went through; now nothing does.
- Money: a run that SUCCEEDED is left alone on failure; a paid run that saved a version or queued its story render keeps
  its charge; calendar Creator runs skip paid New stories not yet written (one whose own run failed stays unwritten
  until deleted, where before a calendar run wrote it free).
- By-hand stories refuse edits (`story.byHandOn`) until posting by hand is stopped; the phone hides the edit.
- A retried final render step starts Quality when the version has no check.
- Only a person's failed render shows as the story's render error.
- Emulator-checked 2026-11-16: items 3, 4, 6, 7 of the Important list (5 needs VoiceOver/TalkBack; 1, 2 are tests only).

**Also fixed 2026-11-16** (`b44c0f6`..`baf6420`)
- Web: the content list shows the by-hand day and time (`dayTime` in `lib/time.ts`); the by-hand field has `min` now.
- A story whose first save is still rendering shows "Preparing frames…" (content list `rendering`), emulator-checked.
- Story limits defined once in `stories/body.ts` (`FRAME_MAX_BYTES`, `MIN_CLIP_SECONDS`, `LOGO_MAX_BYTES`); 12
  file-only exports made local. Nothing from the final review is left open; the go-live list above still is.

## Reels templates, presenters and voices (end of day 2026-11-12)

Branch `desktop-shell`, everything committed, **not pushed** (`main` still at `08e5fb1`). Built from
`docs/superpowers/specs/2026-11-12-reels-templates-actors-voices-design.md`, one commit per step; each step had a
four-lens review (Fable, medium: correctness/money, security, phone UI + i18n, spec + simplicity) and every finding was
fixed before its commit. Web: tsc clean, 492 vitest tests pass. Phone: tsc + lint clean on the touched screens.

| Commit | What it does |
|---|---|
| `9708b6b` | A chat revision keeps the voice (and template) picked in the app. |
| `34f73c8` | R12 templates: six server templates (`server/reels/templates.ts`), generic preview clips, paid per-brand previews (10 credits) as `ReelAsset` rows. |
| `8a4f81a` | R10 presenters: AI Influencer character sheets (2 credits); presenter scenes on Seedance reference-to-video (4 credits/s, at least 4 s, one retry, cuts only); shared paid-asset job `server/reels/assets.ts`; ownership checks at save and before charging (`server/reels/ownership.ts`). The app reads reel and scene lengths from the server. |
| `e68dba3` | Voices: OpenAI five + six ElevenLabs stock voices, Voices screen with samples; unknown voices refused; ElevenLabs spoken one scene at a time with 429 backoff (2 min cap). |
| `b739bc9` | R11 recorded voiceovers: per-scene takes (expo-audio, up to 15 s), ffmpeg to 24 kHz WAV, speech-to-text check with Keep it / Record again, recordings follow their text, 30-day sweep (`server/reels/recordings.ts`). |
| `1c68ab4` | Voice cloning (`server/reels/clones.ts`): `voices.manage` (Owner/Admin, workspace-only; a data migration adds it to existing Admin roles), 2 per workspace, 10 credits (placeholder), charge first, refund + ElevenLabs delete on failure, consent record; delete / withdraw / member removal queue the ElevenLabs delete in the same transaction; audit events. "Made with AI" for presenter or cloned-voice reels: caption line in the reel's language (shown to approvers, added at publishing, can't be edited out) and a corner mark burned into the video. |
| `b13aa36` | ElevenLabs voice library (`server/reels/library.ts`): Voices > Library tab, one row of filter buttons (language = the reel's by default, gender, age, use) opening a sheet, search, previews; picking saves `library:<id>`. |

**What needs money before it can be tried live**
- Higgsfield credits (the account answers `403 not_enough_credits`): generic template previews
  (`npx tsx --env-file=.env scripts/render-template-previews.ts <workspaceId> <demoBrandId>`; use our own demo brand
  only, every customer sees them), a real presenter, a presenter reel, and the A/B audio comparison
  (`scripts/compare-presenter-audio.ts`; delete it after the owner chooses A or B). Guesses to confirm on that first
  run (AI Influencer result field, Seedance reference body) are listed in the spec.
- ElevenLabs paid plan (Starter or above): cloning (the free plan can't), and speaking with library voices (the free
  plan answers 402 `paid_plan_required`; until then a render with one is refused before charging). At the upgrade,
  check whether a library voice must first be added to our account (`POST /v1/voices/add/{public_owner_id}/{voice_id}`,
  uses a voice slot); if so, that step needs adding. Then check the 10-credit clone price and the margin estimates
  (`PREVIEW_COST_USD` in templates.ts, `PRESENTER_COST_USD_PER_SECOND` in presenters.ts) against real invoices.

**Before release**
- About 250 new phone strings in 23 languages are machine translations (`gpt-6.1-terra`): a native speaker should review.
- Confirm ElevenLabs' and Higgsfield's data-processing agreements and "no training" terms (cloned voices).

**Known gaps (documented, not built)**
- No account deletion exists; when built it must archive the person's clones and queue `voices.delete` as
  `removeMember` does. Deleting a workspace (no path yet) would drop clone rows without deleting them at ElevenLabs.
- A recording's audio stays in storage when its reel is deleted (only the row cascades; no reel-delete path yet).
- Withdrawing consent uses brand routes: an owner with no brand access must ask an admin.
- The data migration re-adds `voices.manage` to a system Admin role an owner had trimmed.
- The disclosure line adds about 15 characters at publishing; a caption right at the channel limit fails then, not at review.
- Three reel screens (`generating`, `review`, `scheduled`) have lint errors that predate this work.

**Test data:** the test presenter was deleted. The test reel "Tête de lit Sculpture II"
(`cmwd6rj9e0005v620hne74fvm`, Bois & Chiffons) still names it: pick "No presenter" on its Presenter screen (or delete
the reel). Its test recordings are removed by the daily sweep after 30 days.

**Running it on this Windows machine**
- Web: `npm run dev` in `apps/web` (port 3100). Stop it before `npx prisma generate` (Windows locks the engine DLL);
  ours is the node process whose command line contains `Social Media Agent`. The `Cad` node and python processes
  belong to another project: leave them.
- Phone build: the SDK's default CMake 3.22.1 (ninja 1.10) can't build `react-native-worklets` past the 260-character
  path limit, even with Windows long paths on. `apps/mobile/android/local.properties` (git-ignored) sets `cmake.dir`
  to CMake 3.31.6 (ninja 1.12). Build with `gradlew.bat app:assembleDebug -PreactNativeArchitectures=x86_64` in
  `apps/mobile/android` (ANDROID_HOME = `C:\Users\INTEL\Android\sdk`), then `adb install -r` the APK. After changing
  `app.json` plugins, run `npx expo prebuild --platform android --no-install` first (android/ is generated; re-add the
  `cmake.dir` line if prebuild rewrites local.properties).
- Metro: another project's agent holds port 8081, so run `npx expo start --dev-client --port 8082`; the installed
  app's dev host is set to `10.0.2.2:8082` (its shared prefs `debug_http_host`). A fresh install loses that setting.
- Memory is tight (31 GB, often about 3 GB free): the emulator, Metro, the web server and a Gradle build together got
  processes killed once; start them one at a time.

**Next, in order (to agree with the owner):** top up Higgsfield and render one presenter reel end to end; decide A or
B for presenter audio; upgrade ElevenLabs and try cloning and a library voice; then the older open items below
(Shopify live test, CSV import).

## Session of 2026-11-12 in short

Branch `desktop-shell` (still not pushed). Owner picked the phone offer check and the campaigns-screen follow-ups.
- Campaigns screen (`1f6f308`): the section sits above the product table; 24-hour HH:MM time fields; timezone is a
  list of readable names ("Paris (Central European Time)"); a warning when the offer wording and discount % disagree;
  product picker search with a ticked count. Offer issues now say "(Paris)", not "Europe/Paris" (web and phone).
- Phone (`7ad85a0`): "Approve anyway" on the post screen for people with `content.approve` + `rules.approve` when
  every refusing issue is overridable (same rule as the web); approved issues read "(approved anyway)"; a waiting post
  reads "Waiting for approval", not "Draft ready". 7 new strings machine-translated (`gpt-6.1-terra`): review first.
- Checked: web tsc + full vitest; `e2e/campaigns.spec.ts` in Chrome, 3 of 4 pass. The fourth ("post with an ended
  offer") fails only because the catalogue was last synced 7 days ago: Julia's stock is unconfirmed, so the post also
  shows "Suggest another product". Sync the catalogue before running it. Phone: tsc + lint, and on the emulator a
  seeded ended-offer post → empty-note error → Approve anyway → Approved, Schedule unlocked.
- Host IP is now 192.168.0.14 (`apps/mobile/.env.local` updated).
**Open, in order:** Shopify live test (needs the owner's store); CSV import.

## Session of 2026-11-05 in short

Branch `desktop-shell` (not pushed; `main` still at `08e5fb1`). Owner's priority: the B&C brief's base work first.
Done today, each planned → reviewed → built → code-reviewed → run on real Bois & Chiffons data → committed:
- Product catalogue (`d51b285`), products in briefs, drafts, checks, approval and publishing (`9355d8a`),
  offers, campaigns and standing priorities (`bb64cd0`, `84ce85c`). Details under "Product catalogue" below.
- Phone post status label and connect wording (`10e98ed`); all phone strings translated into 23 languages
  (`08189c8`, machine translation: review before release).
**Next session (owner, 2026-11-05): before starting anything, ask the owner which of the open items below to do
first.** Open, in order: phone check of a post with an offer; the five campaigns-screen follow-ups listed below; Shopify
live test (needs the owner's store); CSV import. Dev environment: web on :3100 (`npm run dev` in `apps/web`; stop it
before `prisma generate`), Metro on :8081, emulator Pixel_10 (screenshots with `adb emu screenrecord screenshot`).

## Start here next time (checked against the code on 2026-11-05)

Branch `desktop-shell` now holds everything: it contains `ai-reels` (with Marketing, `ab830c2`) and `audit-fixes`
(Phases 1-4, see `docs/handover/2026-11-03-*.md`). Each module below goes through the same steps: wire it, review
it, test it on the emulator, fix it, commit it.

1. **Website Studio is hidden until the brief's base work is done** (owner's call, 2026-11-05; the B&C functional
   brief doesn't cover it). The Marketing card, the drawer link, the Plans tool row and the Professional plan's
   "Website Studio & custom domain draft" line are gone, and the three Figma screens (`marketing/website`,
   `website-edit`, `website-publish`), `ui/marketing/sample.ts` and their strings are deleted. Restore them from
   `17b7438` if needed. The owner's direction when it comes back: show the issues on the brand's own site against
   standards. Research's SEO agent (PageSpeed performance, SEO, accessibility and best-practice scores, on-page
   checks), the GEO agent and the competitor site audit already produce this; the phone just doesn't show it.
2. **Stories** (`posts/stories`, `posts/edit-story`) is a "coming soon" page. It needs server work first: a story
   channel in the publish chain.
3. **AI actor** (`reels/actor`): the sample voice is shown as "coming soon". The reel voice is OpenAI
   gpt-4o-mini-tts, so samples could come from there.
4. **Reels templates** (`reels/templates`) is still a fixed list of four with Bois & Chiffons photos
   (`ui/reels/sample.ts`). Picking one does send a real request to the chat. `ui/reels/sample.ts` also holds the
   Espanda logo and mark the chrome uses; that part is app branding, not sample data.
5. **Plans has no payment.** That's deliberate for now: an admin turns plans on.
6. **New strings are English only.** Other locales still hold older text; re-run `scripts/i18n-translate.mjs`
   once the owner approves the wording.
7. **Photoshoot fashion tiers are untested live.** The Higgsfield account has no credits. Before selling fashion
   shoots:
   - Top up Higgsfield.
   - Run one fashion shoot per tier.
   - Confirm two guesses (in `server/reels/higgsfield.ts` and `server/photoshoot/tiers.ts`): the image status
     answers with `images[].url`, and Marketing Studio Flare takes `input_images`.
8. **Check the tier costs against real invoices.** `costUsd` in `tiers.ts` are estimates. The server refuses to
   start if any tier drops under the 70% margin floor.
9. **Push and merge** `desktop-shell` when the owner says so (`main` is still at `08e5fb1`, 2026-10-30).

**Product catalogue (brief A7) is in** (2026-11-05, spec `docs/superpowers/specs/2026-11-05-product-catalogue-design.md`).
Next steps on it, in order:
1. **Done (2026-11-05): products in briefs, drafts, checks, approval and publishing** — gap audit B1, B2, B6.
   Plan: `docs/superpowers/specs/2026-11-05-products-in-content-design.md` (ninth draft, after an adversarial
   review and seven review → fix rounds). Posts link products at the brief stage (`ContentItem.productIds`, then
   the version body's `productIds`); app posts link the product of their photo. Products are judged per product
   group (same `/products/<handle>`). Quality adds stock and price rows; the price snapshot is the `kind:"price"`
   rows in `QualityCheck.results` (`productRows` writes, `snapshotOf` reads). One gate (`productGate` in
   `publishing.ts`) refuses approval, scheduling and publishing when a linked product is gone / out / unconfirmed
   (synced stock older than 50 h) or a recorded price changed. "Approve anyway" (needs `content.approve` +
   `rules.approve`, note ≤ 500) covers stock only, never prices. "Ask for changes" + "Suggest another product"
   (web and phone) makes the Creator swap to an in-stock product. Typed stock, prices and facts need
   `rules.approve` (Managers lose fact editing).
   Code: `server/catalog/linked.ts`, `server/content/product-checks.ts`, the Brief/Creator/Quality agents
   (prompt version 8), `server/content/knowledge.ts`, `publishing.ts`, the content and products routes,
   `release-panel.tsx`, `products-board.tsx`, mobile `posts/[id].tsx` and `business/product/[id].tsx`.
   Checked: 4-lens code review (2 medium, 8 low, all fixed); real runs on Bois & Chiffons with the real AI (post
   linked to Chaise "Julia" → draft with its price → Quality pass → sold out → approve refused → approve anyway
   with a note); web `e2e/product-gate.spec.ts` in Chrome; on the emulator the phone showed the issue, the
   prefilled note and "Suggest another product", and "Ask for changes" made the Creator swap to an in-stock sibling
   chair with its own price and photo, after which Schedule was enabled.
   Also checked live: stock confirmed 60 h ago shows "hasn't been confirmed for over two days" and refuses
   scheduling of an approved post. Publish-time refusal is covered by tests only (no connected account).
   `e2e/product-gate.spec.ts` needs a seeded post: the seed/unseed helpers live in the git-ignored
   `apps/web/scripts/_tmp/` (copy `run-products.ts`'s setup if they're gone). New strings are English only.
2. **Done (2026-11-05): offers, campaigns and priorities** — brief A7 (rest), B2/B6 "expired offer", B7 commercial
   owner. Plan: `docs/superpowers/specs/2026-11-05-offers-campaigns-design.md` (fifth draft: adversarial review +
   two 4-lens reviews). One `Campaign` table: offer (has terms, needs an end), dated campaign, standing priority (no
   end). Times have hours and follow `BrandProfile.timeZone` (`zonedInstant`/`wallTime` in
   `server/content/offer-checks.ts`: a spring-forward gap time is refused, a fall-back overlap takes the first one).
   New `commercial.manage` permission + "Commercial owner" role. Planner gives each campaign/priority up to 2 posts
   per 30 days (inside a dated campaign's window); Brief/Creator/Quality/Scout get the campaign facts; Quality checks
   every discount % in the text against the linked offer or a compare-at price. The gate holds a post when its offer
   ended (overridable with "Approve anyway"), was withdrawn, changed terms or products, or would go out before it
   starts (all three: ask for changes). Web: "Campaigns and offers" on /products (timezone control, affected-posts
   warning on edit/withdraw); posts show a campaign line and the offer issues (web and phone).
   Checked: tsc + full vitest; 4-lens code review (2 medium, 7 low, all fixed); real run on Bois & Chiffons with the
   real AI (-20 % flash sale + code → draft → Quality pass → offer really ended → approve refused → approve anyway;
   terms changed to -15 % → refused, not overridable).
   Browser: `e2e/campaigns.spec.ts` passes in Chrome (create/edit/withdraw an offer, viewer read-only, a post whose
   offer ended → Approve anyway; seed with `scripts/_tmp/seed-offer.ts`, clean up with `unseed-offer.ts`).
   Phone post screen with an offer: checked on the emulator 2026-11-12, with "Approve anyway" now on the phone
   (`7ad85a0`). The five UI follow-ups from the browser check are done (`1f6f308`, see the 2026-11-12 summary at the
   top). Known limits: "réduction de
   30 %" is always read as a discount; a standing priority starting later today can get a 09:00 UTC post a few hours
   early. Seed helpers for e2e live in the git-ignored `apps/web/scripts/_tmp/`.
3. Test Shopify Admin live: a custom app with `read_products` + `read_inventory` on a real store, connect on the web
   Connections page, Sync now. The query cost and throttle handling follow Shopify's documented rules but have
   never met a real store.
4. CSV import of products.

**Brief gap audit:** `docs/handover/2026-11-05-brief-gap-audit.md` lists every acceptance criterion of the B&C
functional brief against the code (built, partial or missing). Use it to pick the base work.

### Done on 2026-11-05

- **Planner "Generate calendar" shows the outcome.** New `GET …/agents/:agentKey/runs?id=` (`agents.read`) returns
  the run's status, its output, and a reason only when the run had nothing to do (other failure text stays in the
  log). P09 polls it every 5 s and then says how many posts were planned, or that planning didn't finish and the
  5 credits are back, with Try again.
- **Photoshoot brief note:** "French prompt" (a Figma leftover; the brief is sent as typed) is now "Required" for a
  custom scene and "Optional" otherwise. The orphan key is removed from all locales.
- **`ui/posts/sample.ts` → `ui/posts/format.ts`.** The unused `POSTS`, `POST_COPY` and `getPost` and the
  `bunting-tv-unit.jpg` they used are deleted.
- **Checked on the emulator (Pixel_10, test account, Bois & Chiffons):** Marketing home, drawer and Plans tools
  without Website Studio; photoshoot brief note "Optional"/"Required"; planner "nothing to plan" outcome with
  refund and Try again. Two fixes came out of it (`f6ea36d`): a duplicate `briefRequired` key, and the run status
  route now starts a stalled job queue (a run sat QUEUED for minutes). The planner's success message was not seen
  on screen: the account has no ideas left to plan.
- **Product catalogue:** `Product` table, website feed sync (public Shopify `/products.json`, 1,394 Bois & Chiffons
  variants in ~7–11 s; only changed rows are written), Shopify Admin sync code (untested live), manual products,
  daily sync + "Sync now", web Products page (search, 50 rows at a time, facts edit, add/delete manual), Shopify
  connect card (checks the token's scopes), phone Business → Products list + product detail (facts edit, Sync now).
  Materials, dimensions and certifications are person-owned: no sync touches them. 4-lens review done and fixed.
  Checked: `e2e/products.spec.ts` passes in Chrome (run with `PLAYWRIGHT_CHANNEL=chrome
  E2E_PRODUCTS_BRAND=<workspaceId>/<brandId>`), and on the emulator (first sync from the phone, facts saved).
- Already fixed before today, so dropped from the list: the Reels home's Bois & Chiffons logo and photo, and the
  `photos.table` fallback in `reels/publish`, `scheduled` and `script`.

## What changed today (oldest first)

| Commit | Module | What |
|---|---|---|
| `98b6956`, `9da7b8b` | Posts | List, detail, edit, schedule, calendar, brief, planner on real posts; the agent chain (Planner → Brief → Creator → Quality); self-approval when nobody else can approve |
| `6998521` | Recovery | Video failed, low credits, reconnect, import failed show the real reason, balance, account or address |
| `aecb8d7` | Business | Switching business, details, brand, photos (library upload), connections, billing, account, automations (monthly plan on the 1st, auto-publish after approval) |
| `ebeb02d` | Plans | Making a reel and generating the calendar need an active plan. There is no payment yet: an admin turns plans on |
| this commit | Photoshoot | Quality tiers the person picks, real shoots, results, detail |

## Photoshoot (Figma "04 Photoshoot")

- **Tiers.** All prices are for a shoot of four photos. Base is preselected.

  | Tier | Price | Product shoot | Fashion shoot |
  |---|---|---|---|
  | Base | 4 credits | OpenAI GPT Image 2, low | Higgsfield Soul 2, 720p |
  | Moderate | 6 credits | Higgsfield Qwen Image 3 edit, 2k | Soul 2, 1080p |
  | Higher | 12 credits | GPT Image 2, medium | Marketing Studio Flare, 2k |
  | Ultra | 24 credits | GPT Image 2, high | Flare, 4k |

  - Nano Banana Pro was the plan for Higher and Ultra fashion. It isn't in Higgsfield's API, so Flare fills in.
  - The phone keeps its own copy of the prices (`SHOOT_TIERS` in `apps/mobile/src/api/endpoints.ts`). The server
    is what charges. Keep the two in step.
- **Server** (`apps/web/server/photoshoot/shoot.ts`, job `photoshoot.run`):
  - A shoot needs a plan, like reels.
  - It is paid up front, and a failure refunds it in the same transaction that marks it failed.
  - OpenAI tiers:
    - make all four photos in one call;
    - get one job attempt only, because a retry would pay OpenAI again.
  - Higgsfield tiers:
    - submit four jobs, then poll every 15 s;
    - send the same signed link and the same Idempotency-Key on every resend;
    - fail at once (and refund) if Higgsfield refuses the request, e.g. `not_enough_credits`.
  - A status read that fails counts as a hiccup, not a failure. A shoot gives up after one hour.
  - Shots are cropped to the ratio asked for and saved as JPGs in the brand's media, so posts can use them.
  - The app is never shown the provider's error text, only that the shoot failed and was refunded.
- **App:**
  - Setup screens pick from the brand's photo library and can upload a photo.
  - The generating screen polls the shoot. Results polls while a shoot is running.
  - The detail screen shows the four photos and can compare with the original. Download and Share open the share
    sheet. Variation runs the same setup again and is charged again.
- **Tested on the emulator (test account, Bois & Chiffons):**
  - A Base product shoot made four real photos of the Dimona buffet, product intact.
  - A fashion shoot failed on Higgsfield credits and showed "4 credits refunded". The test workspace is
    unlimited, so nothing was charged in the first place.
- **Left out:**
  - **Quality check of each shot against the original.** It was in the plan; skipped for now. Add it when bad
    shots show up.
  - **"More options" and "Expand".** Both were inert in the design and have been removed.
  - **Business switch during a shoot.** If the business is switched while a shoot is open on the generating
    screen, its poll asks the new business for the shoot and keeps getting 404.
  - **Duplicate POST.** A POST retried after a timeout makes a second shoot. The app doesn't retry, so there is
    no idempotency key yet.

## How to run and test

- **Web:**
  - Server: `npm run build -w server && npm run start -w server` (port 3101); website: `npm run build -w web-frontend && npm run start -w web-frontend` (port 3100).
  - Stop the server before `prisma generate`: it locks the engine DLL (EPERM).
- **Phone:**
  - Run Metro in `apps/mobile` with `EXPO_PUBLIC_API_URL=http://localhost:3100 npx expo start --dev-client --port 8081`.
  - Emulator: `Pixel_10`, emulator build `37.3.5-backup`, `-gpu swiftshader_indirect`.
  - `adb shell screencap` crashes on this GPU. Take screenshots with
    `adb emu screenrecord screenshot <absolute path>` instead.
  - Open screens with deep links, e.g. `adb shell am start -a android.intent.action.VIEW -d espanda://photoshoot/results`.
- **Test account:** `emu-test@cmo.local`, owner of dev workspace `cmvhqkx8h0001v630qd3rb7gb`.
- **To test without a plan:** start the server with `UNLIMITED_CREDIT_WORKSPACES=none`.
- **Plans:** `npm run set-plan -w server -- <workspaceId> <starter|professional|none>`.
- **Copy:** after adding English strings, run `node scripts/i18n-translate.mjs --model gpt-6.1-terra` from
  `apps/mobile`. It only translates missing keys, so changed wording needs a new key.
- **Never use the live database as Prisma's shadow database** (`migrate diff --shadow-database-url`): it wipes it.
  Write migrations by hand and apply them with `npx prisma migrate deploy`.

## Phase 2 in progress (2026-11-23, 17:20)
- Merged to main today (not pushed): reports-bulk-tasks, task-assignment (admins see/assign every task, role-owned tasks, invite/role/project checks), chat-posts (assistant lists posts and knows where things are; prompt v5).
- Phase 2 plan: `docs/superpowers/plans/2026-11-23-phase-2-data.md` (four-lens reviewed; decisions in `2026-11-23-phase-2-review-notes.md`). Both untracked here; commit them with the branch.
- Branch `phase-2-data` (worktree `C:/Users/INTEL/Desktop/sma-server-p2`, outside apps/ because a worktree inside apps/ breaks the npm workspaces) has: crm.read/ads.read permissions + role migration `20261125090000_crm_ads_read`, Shopify orders client, Facebook post_id fix, Search Console client, post-metrics client. Typecheck clean, 1537 unit tests green.
- Not done: Task 1b foundation (DataSource table, `data.sync` job, sweep, routes) on `p2-foundation` (worktree `sma-p2-foundation`); wiring clients into the job; screens; Meta Ads; print/export; held items (FX, VAT, budgets) waiting on owner answers. Run `npm run sync:shared` at merge (shared/permissions.ts changed).
- Open owner decision: block giving crm.read/ads.read to the Client reviewer role (as tasks.all is)?
- Crash recovery: zeroed `.git/refs/heads/<branch>` → restore from `.git/logs/refs/heads/<branch>`; zeroed worktree index → move it aside and `git reset`; zero-filled working files → trust the committed branch.

## Phase 2 merged (2026-11-23, 18:15)
- On main in all three repos (not pushed): server `d98365e`, web `22c4d5d`, mobile `08d6182`. Plan, review notes and pre-merge fix list are in `docs/superpowers/plans/2026-11-23-phase-2-*.md`.
- Built: DataSource sync state + one `data.sync` job (daily sweep, backfill chains that restart, Sync now with limits, data jobs capped at 2 so publishing isn't starved); Search Console (SITE + top 500 pages/day), Shopify orders (no customer data), post metrics (Instagram/Facebook/Threads, decaying refresh), Meta Ads (own `ads_read` login, one account per brand, 180-day backfill); read routes for search/sales/insights/ads + ads Excel/CSV export; permissions `crm.read`, `ads.read`. Web: Performance page tabs Search, Posts, Sales, Ads behind `WEB_FEATURES` flags `data`, `sales`, `ads`.
- Checks at merge: server 1603 unit + 133 DB tests, web 622, mobile typecheck. Four-lens review + Meta Ads review, all important findings fixed. Browser check (local DB `sma_p2_browser`, owner@p2.test / viewer@p2.test, password `P2-browser-check-1`): all tabs pass as owner; viewer sees no Sales/Ads and gets 403. It found the Search site picker 500 (import cycle around `ReconnectNeeded`), fixed in `d98365e` but not re-checked in the browser.
- Dev DB (Neon) has all Phase 2 migrations (four were applied early by mistake during the build, the last three on purpose at merge).
- Not done / open: FX rate, VAT, budgets and pacing (waiting on owner answers, plan "Held" section); live data needs Meta app review (`ads_read`, insights), Google verification and Shopify `read_orders` (add `META_ADS_REDIRECT_URI` to the Meta app); confirm on one live free-shipping order whether Shopify's total discount includes shipping (gross sales caveat); unchecked in browser: date presets, the Sync now limit message, print layout, ad account picker. Skipped review items: S15 one problem mapper, S17 zone parameter in sales/insights SQL, S3 dropping `PostMetric_brandId_idx`, S11 POST code exchange.

## Phase 2 owner answers (2026-11-24)
- All 8 open questions in `docs/superpowers/plans/2026-11-23-phase-2-data.md` answered; see "Owner answers (2026-11-24)" there. H1 is unblocked with changes: daily ECB rate instead of one hand rate, net sales ex-VAT (20 % VAT incl. assumed, to confirm), budgets for Meta and Google. New work: System User token paste for Meta Ads, story metrics within 24 h, new Shopify app with `read_orders` + `read_all_orders`.

## Product import merged (2026-11-24)
- Part A of `docs/superpowers/plans/2026-11-24-product-import.md` merged to main in all three repos (not pushed): server `e805615`, web `f4a6cca`, mobile `7bf9692`. Products page has "Import file" (CSV comma/semicolon/tab, UTF-8/UTF-16/Windows-1252, .xlsx first sheet; 5 MB, 5,000 rows, 50 columns). Columns auto-matched (en + fr headers) with a preview; re-import matches by SKU → link → name, keeps ids, links and typed facts, archives IMPORT rows missing from the file. Price/stock/facts columns need `rules.approve`. New `ProductSource` values `IMPORT` and `SITE` (SITE is for Part B). Also: a 401/403 product feed now says "Your website blocks our product reader" (reason `blocked`).
- Checks at merge: server 1655 unit + 151 DB tests, web 638, mobile typecheck; four-lens plan and branch reviews done, all Critical/Important fixed (quadratic htmlText, xlsx scanner, Unicode name keys, Excel float prices, ambiguous "1.299" prices flagged, sync lock timeout). Browser check with Playwright on local DB `sma_p2_browser` (owner@p2.test): French CSV, re-import (update + archive), xlsx with Greek/CJK names.
- **Open:** (dev DB migrated 2026-11-24.) Web copy is English only (the web app has no i18n). Known limits: text price "1299.999" reads as 1,299,999 (pre-existing amountOf behaviour); per-process parse cap 2; server lint has 3 pre-existing errors in tests/db (crm-ads-read, task-assignment).
- Next: Part B (website product-page reader, Tasks 5–9) on a new branch.

## Website product reader merged (2026-11-24)
- Part B of `docs/superpowers/plans/2026-11-24-product-import.md` merged to main in all three repos (not pushed): server `50586da`, web `0afe6bf`, mobile `6344c43`.
- What it does: a brand whose website isn't a Shopify store (feed says "not a feed") gets its products from the product pages in its sitemap (schema.org Product JSON-LD). Job `catalog.pages` (own cap: 1 runner) reads ≤ 1,000 pages per brand per UTC day and ≤ 1,500 per host, one request at a time per host (≥ 1 s, Crawl-delay ≤ 10 s), robots.txt respected (5xx = stop for the reader; crawlSite stays lenient), 5,000-page cap per brand, re-read when lastmod changes or after 7 days with ETag/If-Modified-Since. Products archived only after a complete discovery, a second 404 on a later day, or 3 failed days; a burst of emptied pages pauses the run. Every outside fetch now uses a pinned DNS lookup (undici Agent) against rebinding. Products page shows "Reading your website's product pages: N of M"; Sync now limited to 6/h.
- Checks at merge: server 1713 unit + 188 DB tests, web 645, mobile typecheck; four-lens plan + per-task + branch reviews, all Critical/Important fixed. Live check on camif.fr (local DB `sma_p2_browser`, brand "Camif live check"): sitemap → 5,000 pages (capped), one 3.5-min run read 123 pages → 123 products with SKU, EUR price, link; Camif publishes no availability, so stock is unknown (correct).
- **Open:** (dev DB migrated 2026-11-24.) A worker (or RUN_JOBS_IN_API) must be running for the daily chain to progress. Known limits: one runner serves ~55 brands/day at full budget; pages without JSON-LD produce nothing (no microdata fallback).

## Phase 3 CRM, Task 1 (branch `phase-3-crm`, 2026-11-24)
- Web flags `crm` (Sales & CRM screens; the Sales & CRM tab on Tasks, shown only to people holding `inbox.read` or `crm.manage`), `blog` (articles to Shopify) and `digest` (weekly digest), all off by default (`WEB_FEATURES` / `WEB_FEATURE_WORKSPACES`).
- Permission `crm.manage` (customer records, notes, quotes) on Owner, Admin, Project admin and Manager; task area `CRM`, whose tasks only `inbox.read`/`crm.manage` holders see or can be given. Migrations `20261125126000_task_area_crm`, `20261125127000_crm_manage`: not yet on the dev DB (apply at merge).

## Phase 3 CRM, weekly digest (Tasks 2–3, branch `phase-3-crm`, 2026-11-24)
- `digest.build` jobs are queued by the Monday sweep for every active member, whatever the web `digest` flag (the server can't read `WEB_FEATURES`); the flag only hides the page, the Overview link and the email toggle. Turning it on shows weeks already built.
- Brands west of UTC get the week before the one that just ended (their Sunday isn't synced at the 05:00 UTC sweep); each brand section shows its own dates.
- Rotating the credentials key (`CREDENTIALS_KEY_VERSION`) voids every unsubscribe link already emailed; people then turn the email off from the account menu.
- Deploy: the sending domain's DKIM signature must cover the `List-Unsubscribe` and `List-Unsubscribe-Post` headers (Gmail and Yahoo require it for one-click unsubscribe). Check the SMTP provider's settings before turning the email on.

## Shopify MCP connection (branch `phase-3-crm`, 2026-11-24)
- Connections → Shopify → "Connect with Shopify MCP": the store's .myshopify.com address or its own domain. Products only, through Shopify's Storefront Catalog MCP (`POST https://{store}/api/ucp/mcp`, `server/shopify/catalog-mcp.ts`); no install, no token, no orders or customers. The Sales tab says "Orders need our app (AskCart)" and the orders turn-on answers 422 for it. Saved as a SHOPIFY connection marked `mcp` in `scopes` (like AskCart's marker); the same address already connected through AskCart or a token is 409.
- Agent profile: `GET /api/v1/ucp/profile` (catalogue search + lookup only). Env `UCP_PROFILE_URL`, default `AUTH_URL` + `/api/v1/ucp/profile`. Shopify fetches it on every request and refuses http ("Https required") and anything it can't reach ("profile_unreachable"), so in dev set `UCP_PROFILE_URL` to a public https copy (a tunnel, or the JSON hosted anywhere public); without an https URL the option shows "Not set up".
- Sync: `search_catalog` with no query, `filters.available` true then false, 50 a page, until `has_next_page` is false; complete → archives what it didn't see. Ceiling: products not on the Online Store or hidden from search are never seen (and archived); no total to check against; 100 pages per walk and 5,000 variants, else partial (nothing archived); no resume across runs. No stock count (availability only), no product type.
- Live check 2026-11-24 on boisetchiffons.fr with Shopify's example profile (ours isn't public yet): the custom domain answers; tools/list and filter-only searches work; recorded in `tests/fixtures/catalog-mcp.ts`. Not yet tried with our own catalogue-only profile: check that its tools/list still offers `search_catalog` on the first live connect.

## End of day 2026-11-24: Phase 3 Tier 1 almost ready to merge

**Branch `phase-3-crm`:**
- **Committed tips:** server `3768bd9` (Shopify MCP fixes), web `eb08e88`. Mobile has only the synced shared copies.
- **Built:** crm.manage, the weekly digest, confirmed Shopify writes (ShopifyWrite, HMAC confirm token, adapter), the AskCart PKCE connect (adapter is a stub until AskCart ships the partner token endpoints), the blog that publishes to Shopify articles, quotes as draft orders (validity counted from send, reminders on day 7 and 21, status sync, cancel) and the read-only Shopify Catalog MCP connection (`/api/v1/ucp/profile`).
- **Review fixes:** the quotes review fixes and the MCP review fixes are committed.

**Stopped mid-work (session usage limit):**
- One combined four-lens branch review was done on Sonnet and found 3 important and 9 minor issues.
- The fix agent was stopped partway. Its edits sit **uncommitted** on `phase-3-crm` in the server repo, about 20 files; it was on the digest change.
- The uncommitted `docs/HANDOVER.md` and `docs/superpowers/plans/2026-11-23-phase-2-data.md` changes are from the main session, not the agent.
- **Fix list:**
  1. `editQuote` refuses while a PENDING or UNKNOWN write exists.
  2. `deleteArticle` gets the same guard.
  3. The digest enqueues with chunked `createMany({ skipDuplicates })` and runs last in `runner.ts`.
  4. Connection DELETE disconnects first, then revokes at AskCart with a 5 s abort.
  5. Existing reminder `requestId`s are read once in status-sync.
  6. ~~MCP connect warns if the store host ≠ the brand's `websiteUrl` host.~~ Done 2026-11-24: server `eb972d7`, web `e66983c`.
  7. A brand's quote currency is persisted when it has no Shopify products; this may add a migration.
  8. Discount values are validated by kind: PERCENT has at most 2 decimals and stays within 0–100.
  9. The PKCE `codeVerifier` is encrypted.
  10. A shared settle helper from `writes.ts` is used in `earlierCreates`, and `target()` is defined once.
  11. ~~`shopifyMcpOnly` is computed once per request, and the two `hitRateLimit` calls run in parallel.~~ Done in the uncommitted fix-agent edits (`writes.ts`, `blog/shopify-articles.ts`); commits with them.
- **Deferred:** unifying error codes and problem helpers across the quotes, blog and shopify-write routes, and caching `listBlogs`.

**Next steps:**
1. Finish fixes 1–11 on top of the uncommitted edits (check `git diff` first), with a test per behaviour change.
2. Run the full checks: server unit and DB tests (on a throwaway DB), web tests and lint, mobile tsc.
3. Merge `phase-3-crm` to main in all three repos.
4. With the owner's OK, `npx prisma migrate deploy` on the dev DB. The new migrations are `20261125135000_oauth_state_pkce`, `20261125142000_quote_valid_from_send` and any from fix 7.

**Rules learnt today:**
- Run one agent at a time; the owner asked to keep usage slow.
- Commit through a temporary index (`GIT_INDEX_FILE=$(mktemp)`).
- Never run npm install or npm ci without `--prefix .` in an app folder.

**Waiting on others:**
- **Tier 2 (stored inbox, customers, follow-ups):** Meta app review and AskCart customer access.
- **Tier 3:** the Google Ads developer token.
- **AskCart:** a public app with per-brand links, with write scopes to be added later.
- **Phase 2 follow-up plan:** about 8.5 days, reviewed, not built.

## Phase 3 Tier 1 merged (2026-11-24, late)
- Fixes 1–11 done: server `eb972d7` (MCP store-address warning, fix 6), `228fb02` (fixes 1–5, 7–11); web `e66983c`. Fix 2 was widened: deleting a blog article is refused while *any* write of it is PENDING or UNKNOWN (code `blog.writeInFlight`, was `blog.createInFlight`).
- Checks before merge: server tsc, 1830 unit tests, 317 DB tests (throwaway `sma-testdb`, port 55432); web tsc, 675 tests, eslint; mobile tsc. All clean.
- `phase-3-crm` merged to main in server, web and mobile. Not pushed.
- **Still open:** `npx prisma migrate deploy` on the dev DB (owner's OK): `20261125135000_oauth_state_pkce`, `20261125142000_quote_valid_from_send`, `20261125143000_brand_quote_currency`. Shopify MCP live check with our own profile (needs a public https `UCP_PROFILE_URL`). The web quote form still asks for a currency each time for brands without a Shopify catalogue; the server uses the saved one and refuses another, but the form doesn't show it yet. Leftover double blank line in `server/blog/shopify-articles.ts`.

## AskCart order lines and the chat's sales tools (branch `askcart-order-lines`, 2026-11-25)
- **What it adds:** order line items, order statuses and discount codes from AskCart, product vendor, tags and collections, and five read-only sales tools for the CMO chat.
- **Migration:** `20261125150000_shop_order_lines`. It is already applied to the dev DB, which production shares. It adds `ShopOrderLine`, four `ShopOrder` columns, three `Product` columns, a `SET lock_timeout='5s'`, a nullable line `title` and `netUnitPrice`. Never edit it again; any later change needs a new migration.
- **Depends on AskCart `3e05bfc` being deployed** (its final partner contract). Until then orders come without line items. Nothing breaks: the per-product tools say line items aren't available yet, and order totals work as before.
- **Backfill once AskCart is redeployed:** `npm run reset:shopify-orders -- <brandId>` (`scripts/reset-shopify-orders.ts`). It clears the orders source's cursor, so the next run re-reads 60 days. It is safe to repeat and doesn't start a run (use the daily sync or Sync now).
- **Sync behaviour:**
  - AskCart pages are 25 orders. A page cut short with `rateLimited` waits its Retry-After (up to 30 s, inside the 3-minute cap) and resumes from the cursor.
  - A run reads up to 200 pages (about 5,000 orders).
  - An order whose lines came incomplete (`lineItemsTruncated`, fewer than 100 lines stored, updated in the last 24 h) holds the cursor so it is read again.
  - A product sent with `variantsTruncated` stops that catalogue walk from archiving.
- **Chat tools:** `salesSummary`, `salesBreakdown`, `topProducts` (`rankBy`, `group`), `productSales`, `stockRisk`.
  - All need `crm.read`, like the Sales tab. Prompt version is 6.
  - Revenue is net: current quantity × AskCart's net unit price.
  - Discount codes used on fewer than 2 orders show as "(other codes)".
  - Once sales data is in a conversation, web search stays off even when asked for. Sales tools switch off after 8 calls in a turn.
  - The Sales tab and the tools share `brandBounds`/`countedOrders` in `server/data/sales-read.ts`.
- **Ceilings:**
  - Results are capped at 60 rows, split across currencies.
  - Every call sums raw rows, so past about 100k orders in a range add per-day rollups.
  - Range bounds are computed in SQL, so the planner can't estimate them; pass literal timestamps if plans go wrong.
  - At most 100 lines per order come from AskCart.
  - Re-reading incomplete orders costs re-reading up to a day of orders per run while one is pending.
- **SQL checks:** the SQL was run against PGlite (Postgres in WASM, every migration applied) from a scratch harness; it is not committed. `npm run test:db` needs a throwaway `TEST_DATABASE_URL` and wasn't run.

## End of day 2026-11-25: Shopify live, review findings and chat tools for tomorrow

**Live today**
- Pushed: server `main` 1e88c88, web `main` 6fac0e3. EC2 env set (server `ASKCART_URL`/`ASKCART_SECRET`; web `WEB_FEATURES=tasks,data,sales,ads`, no `crm` so Quotes stays hidden).
- AskCart EC2: `PARTNER_STORE_DOMAIN=687541-22.myshopify.com` (the store's permanent handle; `boisandchiffons.myshopify.com` is only an alias and gave 503 store_not_connected). `/shop`, `/products`, `/orders` all 200.
- Orders sync turned on from Performance → Sales: first run stored 969 orders / 1205 lines in ~2 min (some older orders came in because they were updated in the last 60 days).
- Meta Ads: `ads_read` added (Marketing API use case); both `…/integrations/meta_ads/callback` URIs in Facebook Login for Business → Settings. Not yet connected.
- Google Business Profile: user to enable My Business Account Management + Business Information APIs, add the `…/integrations/google_business/callback` URIs, `business.manage` scope + test user, and file Google's API access request (quota starts at 0).

**Local, not pushed**
- Web `main` df13201: Custom date range on Performance (any days up to the latest complete day, max 90). Page state keeps the chosen range itself, not just its length.
- This handover section (uncommitted).

**Tomorrow 1: fix the four-lens review findings (verified by the reviewers, none fixed yet)**
Correctness:
1. HIGH `server/data/shopify-orders-sync.ts:270-272`: cursor held at the earliest truncated order even when the run stopped `capped`/`rate_limited`, so a busy store can pin the cursor for up to 24 h. Hold only when the run reached the end; else save `cursorEnd` and re-read truncated rows separately.
2. MED `server/data/shopify-orders.ts:366`: `byId.set` keeps a re-read order in its first Map slot with a newer updatedAt; a deadline abort then sets `cursorEnd` too far and skips orders. `delete` before `set`, or sort by updatedAt before writing.
3. MED web: Pulse/Surge/Hum sidebar links don't switch the tab when already on `/performance` or `/settings` (tab is `useState(initialTab)`; client state is kept on query-only navigation). Key by tab or sync from search params. The e2e test starts from /products so misses it.
4. LOW-MED `server/shopify/askcart.ts:219-220`: `503 store_reconnect_needed` marks our connection for reconnect, but the contract says our token stays valid; treat as temporary. Give `403 insufficient_scope` its own reason (current text says "Open AskCart in Shopify admin").
5. LOW `server/chat/tools.ts` productSales: `revenue.toFixed` throws on SQL NULL (lines with quantity 0 and no net price). COALESCE in SQL.
Performance:
6. Partial/rate-limited orders runs aren't re-queued until the daily sweep; queue one follow-up (keyed by cursor, capped chain) when the cursor moved.
7. AskCart requests aren't paced to 60/min (orders and catalogue share the budget); keep ≥1.1 s between requests per token.
8. Each chat sales tool runs `truncatedOrders` plus up to 2 queries in parallel; compute truncated once per turn, merge productSales' queries.
Security (both low):
9. Sales tool outputs stay readable in a saved chat after the user loses `crm.read`; blank sales tool parts on GET/history, or document as accepted.
10. The "personal code" threshold counts orders, not customers (`sales-analysis.ts:202-206`); fix the comment or count distinct hashed customers.
Maintainability:
11. `salesBreakdown` by collection/vendor duplicates `topProducts` with `group`; keep one path.
12. `BreakdownResult.basis` is unused; the tool recomputes `lineBased`.
13. Two `useWide` hooks (1280 in assistant-state, 1024 in panel-layout); one `useMediaQuery` in lib with named wrappers.
14. `useListSelection` relies on hand-repeated heading ids in quotes-board/blog-board; have the hook return them.
15. `CRM_READ` in web `lib/nav.ts:26` holds `"crm.manage"`; rename `CRM_MANAGE`.
16. `tests/chat-sales-tools.test.ts:4-5` points at handover notes; point it to `tests/db/sales-analysis.db.test.ts`.
Docs now wrong: `schema.prisma:1756` (lineItemsTruncated "or some were unreadable"), `schema.prisma:1768` (lines "replaced as a set"), DATA_MODEL.md:380 (pasted-token defaults only on insert), :391 (net fallbacks: `quantity` when no currentQuantity, `discountedTotal ÷ quantity` when no netUnitPrice), :392-393 (lines deleted only when the order was sent whole), this file's AskCart order lines section title (merged as e832580) and its last line (the db SQL test is committed in 1e88c88).

**Tomorrow 2: chat tools for the rest of the data (~30-45 min, read-only, gated like their Performance tabs)**
The chat has sales and catalogue tools only. Add, reusing the existing read functions:
- Meta Ads (`server/data/ads-read.ts`): spend, impressions, clicks, purchases, ROAS by day/campaign.
- Post performance (`server/data/post-metrics-read.ts`): reach, views, likes, comments, shares, saves; best posts in a period.
- Search Console (`server/data/search-read.ts`): clicks, impressions, position, top queries and pages.
- Google Business Profile (`server/google/business.ts`, live reads, quota-capped): rating and recent reviews; works only once Google approves API access.

**Other open items**
- Optional: merge branch `design-doc-emptystate` (4d69e95 + 4c32c51).
- Remove worktree `Desktop/server-fix2` (`cmd /c rmdir` its node_modules junction first, then `git worktree remove`); delete the empty locked folder `apps/server-lines` after a reboot.
- One server unit test failed once and passed on rerun (not identified); look for a flaky timing test.
- AskCart runs on a bare IP (13.232.66.119); an Elastic IP or a domain would stop a restart from breaking the link.
- Orders older than 60 days need Shopify to approve `read_all_orders` for the Shop Assistant app.
- Business Profile and the customer inbox (Instagram DMs, Messenger) are mobile-app screens only; there is no web page for them yet.
- Naming: the sidebar main-menu item that opens the Performance *tasks* list is now "Performance tasks" (web 0dbb7f3, local); the data page `/performance` is still reached only via Surge/Pulse or "Growth reports" in More. Consider a main-menu link to it.

## Money layer, Meta system token, story numbers, order history (branch `phase-2-followup`, 2026-11-26)

Plan: `docs/superpowers/plans/2026-11-26-phase-2-followup.md` (Tasks 1–6, all built). Four-lens branch review done;
its findings fixed on the branch.

**Deploy steps, in this order (the owner's call; never against the dev DB from a branch):**
1. `prisma migrate deploy`: `20261126100000_fx_rate`, `20261126110000_shop_order_shipping_taxes`,
   `20261126120000_ad_platform_google` (its own migration: a new enum value can't be used in the same transaction),
   `20261126120100_ad_budget`, `20261126130000_post_metric_navigation`. All additive, nullable, no table rewrite.
2. **Required:** right after the deploy, `npm run reset:shopify-orders -- <brandId>` for every brand with a
   SHOPIFY_ORDERS source (today: B&C). It re-reads 60 days so the rows carry `shippingTaxes`. Until then, tax-included
   orders the old code wrote on or after `SHIPPING_TAXES_SINCE` (2026-11-26 00:00 UTC) count as "VAT couldn't be read"
   (`exVatMissing`), and the Sales headline, the digest and revenue ÷ ad spend leave them out. B&C is affected little:
   971 of its 973 stored orders are tax-excluded (their net sales already have no VAT).
3. The next daily sweep queues `fx.sync` (ECB rates) and `story.read` catch-ups; nothing else to start by hand.

**Live-checked 2026-11-26:** ECB INR fetch (23 rows a month, 765 for three years; a weekend window is an empty 200).
B&C orders: `currentTaxLines` include the shipping tax. AskCart sends `shippingLines` on every order.
**Not live-checked:** the token path's query cost (no store uses a pasted token; the first page a process reads logs
`requestedQueryCost`), Meta `debug_token` with a real system user token, a story read (Meta app review for insights
pending), `read_all_orders` (the history stays dormant until AskCart stops answering pending). Browser checks not done.

## Review fixes, sync status and the Growth reports rename merged (server 22d641b, web 2f54cad, 2026-11-26)

- **Sync status:** each data source says when a sync is queued or running and when the last one started
  (`DataSourceDto.sync`, `lastResult.runningSince`); a first run shows no last result. The Growth reports tabs poll once
  per page while any source has a run queued or running, quietly, and not while the tab is hidden.
- **AskCart pacing:** requests are spaced 1.1 s apart per token, keyed by a hash of the bearer (never the token). The
  connect checks skip the waits. An orders sync that stops partway carries on a minute later (a follow-up keyed by the
  job that queues it).
- **Sales chat:** saved sales figures are hidden from, and kept out of the model's input for, someone without
  crm.read; a period's incomplete orders count once per message; salesBreakdown's collection and vendor groups read
  through topProducts.
- **Rename:** "SEO & GEO reports" is now **Growth reports** (shared page names, More menu). The Overview's "See the
  SEO & GEO reports" link stays: it opens that tab.

## Competitors page merged (server 9f72da4, web 729edce, 2026-11-26)

- Competitors moved from an Overview panel to its own page, `/competitors` (brand.read). A competitor's audit
  (`?competitor=`) and the Competitors agent (`?agent=competitors`, from Find) open in a side peek over the list. Old
  `/?panel=competitors` and `/?competitor=` links redirect after the account checks, keeping the competitor.
- The assistant knows when the person is on the Competitors page.

## Blocked-site audits merged (server 03b7b48, web 03be652, 2026-11-26)

- A site that refuses automated readers gets a **partial audit**: PageSpeed scores and a marketing summary from public
  search results, no page checks or findings. The marker is `approach.partial` in SiteAudit's JSON (no new column).
- A fresh full audit stays shown over a newer partial one.
- After a "blocks automated readers" failure the server refuses another audit of that domain for this workspace for
  `AUDIT_BLOCK_DAYS` (7) days, with a 409 `audit.siteBlocked` and no charge; the failed run is refunded as before. Once
  the block lifts the row says softly when it was last tried, and Audit is back.
- Merge commit 4a49f18 kept git's default message; history, left as it is.

## Compact Competitors list, Find more and Audit all merged (server 992dc18, web 9d1c329, 2026-11-26)

- The page is a compact list: name, AI mentions, four score chips, checked date and two icon actions per row. **Find
  more** opens the Competitors agent; under three competitors the list also asks for more.
- **Audit all** (POST `competitors/audit-all`, agents.run, at most 50 ids, rate limit 10 presses an hour per brand)
  audits the stale and never-audited sites in the page's order (most named by AI first) until credits run out. It
  stops at the daily run cap (429) or when site audits are off for the brand (409) instead of charging and refunding per
  site.
- `credits.unlimited` tells the page a workspace in `UNLIMITED_CREDIT_WORKSPACES` is never charged, so Audit all doesn't
  cap at the balance.

## Merged-main review fixes (branch `merged-review-fixes`, 2026-11-26, not merged)

Four-lens review of everything merged today; its fixes, plus two the owner found in the browser:
- **Audit all no longer times out.** Eight sites took about 7 s each inside the request (remote DB round trips). The
  route now answers at once (202 `{ queued, skipped }`, only not-tracked ids skipped there) and queues a
  `competitors.audit-all` job keyed by the press id (`pressId`, required in the body); the job runs
  auditAllCompetitors with every stop rule. The web keeps the press id until the server answers (makePresser), toasts
  "Starting N audits…" and polls the list fast for two minutes. **Server and web must deploy together** (the request
  and answer changed). A job that stops on "disabled" or the daily cap only logs it; the page shows nothing running.
- **Competitors list:** one `DISTINCT ON (domain)` query instead of every fresh audit in memory, no findings or
  approach in the list (the peek reads them from GET `competitors/:id/audit`), polled every 6 s only while an audit
  runs or was just queued, else every minute. `credits` only for agents.run; the header reads "Unlimited credits" in
  an unlimited workspace. The agents peek's poll pauses while the tab is hidden (useAgentsPoll, shared with the agents
  board).
- Meta Ads refuses a login or system token that sees more than 50 ad accounts. A sync waiting behind a history window
  keeps its follow-up count; a pending run more than 10 minutes late no longer shows as queued.
- The competitor types moved to `shared/competitors.ts`; DATA_MODEL §12 describes the money layer.

## End of day 2026-11-26

**Merged to main today (all unpushed):** the review fixes with the sync status and the Growth reports rename
(22d641b), the Competitors page (9f72da4), blocked-site audits (03b7b48), the compact Competitors list with Find more
and Audit all (992dc18), and the money layer with the Meta system token, story numbers and order history (0c7e80d).
The fixes from the review of those merges are on `merged-review-fixes` in server, web and mobile, waiting to merge.

**Migrations:** the five money-layer migrations (`20261126100000_fx_rate`, `20261126110000_shop_order_shipping_taxes`,
`20261126120000_ad_platform_google`, `20261126120100_ad_budget`, `20261126130000_post_metric_navigation`) are applied
to the dev DB. See DATA_MODEL §12.

**Deploy steps, in order:**
1. Merge `merged-review-fixes`, then push server, web and mobile (server and web together: Audit all's request and
   answer changed).
2. Deploy; `prisma migrate deploy` applies the five migrations.
3. Right after, `npm run reset:shopify-orders -- <brandId>` for B&C (every brand with a SHOPIFY_ORDERS source), so its
   orders carry `shippingTaxes` (see the money layer section above).

**Waiting on outside parties:**
- The Meta Ads connection for B&C.
- Shopify approving `read_all_orders` for the Shop Assistant app; order history past 60 days stays dormant until then.
- Meta's app review for Instagram insights; story numbers can't be live-checked until it passes.

**Open small items:**
- `tests/crawl.test.ts` is flaky (failed once, passed on rerun); find the timing it depends on.
- Remove the `sma-money` worktrees; their `node_modules` are junctions, so remove those with `cmd /c rmdir`.

**Next:** chat tools for ads, posts and Search Console, then ads alerts.

## Chat data tools and ads alerts (branch `chat-data-tools`, 2026-11-26, not merged)

Plan: `docs/superpowers/plans/2026-11-26-chat-data-tools.md`. Server, web and mobile worktrees in `../sma-chat`.

**What was built:**
- **Chat data tools.** The assistant reads Meta Ads (`adsSummary`, `adCampaigns`, `adBudgets`, `revenuePerAdSpend`),
  post and story performance (`postPerformance`) and Search Console (`searchPerformance`) from our own rows. One
  permission map (`CHAT_DATA_TOOLS`, server/chat/turn.ts) gates every data tool and hides outputs from a reader who
  lost the key; at most 8 calls per group and 12 data calls per message. Switched-off ad accounts are left out. Web
  search stays off while a sales read (the sales tools and `revenuePerAdSpend`) is in the conversation the model sees;
  after any other data read it stays off unless the person's own message asks for it with a verb ("search the web for…", "do a web
  search", "cherche sur internet"); a bare "web search" or a phrase ending in shop or sales words doesn't count.
  Prompt version 8 (`CHAT_PROMPT_VERSION`) describes the tools; the web chat names each step in plain words.
- **Ads alerts.** After an ad account's complete daily or manual sync, the `ads.alerts` job checks four rules and
  stores what it finds in `AdAlert`, one row per episode: SPEND_UP, ROAS_DOWN, NO_PURCHASES and OVER_PACE (thresholds
  and ceilings at the top of server/ads/alerts.ts). OVER_PACE is only raised while the day is in the current UTC month.
- **Where alerts show:** the bell (an `AD_ALERT` notice per person holding brand.read and ads.read, hidden again once
  they lose a key or the brand is archived), the Monday digest (the week's alerts, web page and email), and the chat
  (`adsSummary` lists the recent ones and the prompt asks to mention the open ones).
- Pre-merge four-lens review fixes: the bell's unread groups now pick one row per group from the fenced unread
  notices before joining the task, actor and alert (EXPLAIN ANALYZE at 40k unread: 37 → 28 ms); narrower search asks;
  month-end pacing; the episode lookup bound. Not taken: maintainability 8 (keyHolders' unused `db`), security 2–3
  (accepted designs), performance 3 (query counts fine).

**Migrations still to apply to the dev DB:** `20261126140000_notification_ad_alert_kind` (the `AD_ALERT` value, in its
own migration as Postgres can't use a new enum value in the same transaction) and `20261126140100_ad_alert` (the
`AdAlert` table and `Notification.adAlertId`). See DATA_MODEL §13.

**The bell sits behind the `tasks` web flag:** the top bar shows it only when `WEB_FEATURES` includes `tasks`, so ads
alerts reach the bell only in a workspace with tasks on. The digest and the chat show them either way.

**Next:**
1. Merge `chat-data-tools` in server, web and mobile; apply the two migrations to the dev DB.
2. Browser-check the bell's alert line and its link to `/performance?tab=ads`, the digest's alerts and the chat's step
   labels.
3. Live-check the rules and tune the thresholds once B&C's Meta Ads is connected.
4. Decide whether ads alerts need the bell outside the `tasks` flag.

## SEO depth (branch `seo-depth`, 2026-11-26, not merged)

Plan: docs/superpowers/plans/2026-11-26-seo-depth.md. Server, web and mobile (shared sync only) on `seo-depth`.

- **Migrations to apply** (none applied to the dev DB yet, in order): `20261126150000_search_query_day`,
  `20261126150100_site_crawl`, `20261126150200_seo_alert`. Check each keeps `SearchDay`'s and `SearchQueryDay`'s INCLUDE indexes.
- **Search Console queries** (Task 1): each day also reads the top 500 queries and top 500 query-page pairs into
  `SearchQueryDay` (400-day retention by housekeeping). Google's limits, read from its docs on 2026-11-26, are in the
  header of server/data/search-console.ts. Existing sources get queries from their next daily run; no query backfill.
- **Top queries** (Task 2): `GET search/queries` (analytics.read), the Search tab's "Top queries" table with its
  coverage line, and the chat's `searchPerformance` (`topQueries`, `queryCoverage`, `queriesSince`; prompt v9).
- **Broken links, full-site weekly crawl** (Task 4, job `seo.links`, server/seo/site-crawl.ts; tables `SiteCrawl`,
  `SiteCrawlUrl`, DATA_MODEL §14). The weekly SEO agent starts a cycle (`startSiteCrawl`) and reports the last finished
  one (`lastCompleteCrawl`: COMPLETE or PARTIAL, same site as today's websiteUrl, finished within 14 days) as
  `links-broken` (high), `links-server-error` (medium) and `links-redirect-chain` (low) findings plus
  `metrics.links`; a fix shows as cleared one to two weeks later. Link findings count in the audit score like any other.
  A `links-*` task clears only when `metrics.links.complete` is true (a COMPLETE cycle), without the pagesChecked rule.
  Discovery: every sitemap page (newest first, ≤ 2,000; day cache `site-all-pages:<host>:<day>`), else link-following
  from the home page (≤ 500 pages, ≤ 3 clicks); ≤ 2,000 link targets, 1-byte GETs.
  **Budgets:** shares the site reader's host lock, robots.txt day cache and host bucket `site-pages:<host>:<day>`: the
  crawl stops for the day at 1,000 of the reader's 1,500, so the catalogue keeps ≥ 500; 1,000 requests per brand per
  day (`site-crawl-brand:<brandId>:<day>`); ≥ 1 s apart (Crawl-delay up to 10 s); runs of ≤ 240 s, the next queued a
  minute later; `catalog.pages` and `seo.links` share one queue slot (`PAGES_RUNNING_MAX`). A refused budget hit rolls
  back, so it costs the reader nothing. 429, 503 with Retry-After or 5 server errors in a row pause the cycle
  (Retry-After, ≤ a day, else 00:10 UTC tomorrow); a URL's first 429 or 5xx is tried again at the end of the cycle
  (a second 429 is "unknown"). robots.txt unreadable, a bot wall (16 of the last 20 answers 401/403) or not one page
  readable (`unreadable`) stop it with nothing reported; a cycle not done in 6 days ends PARTIAL; a changed website
  abandons it. Not enforced weekly: any SEO agent run with no RUNNING cycle starts one (bounded by the budgets).
  Ceiling: the five-in-a-row pause counts re-checks too, so a site with ~30 persistently failing targets keeps pausing
  a day per five and may end PARTIAL.
  A lost chain (no write for a day, not paused) is re-queued by the next weekly start.
  Live check still to do (plan's Verification): run the SEO agent on B&C, watch the rows fill and the bucket stay
  ≤ 1,000 from the crawl, then spot-check three "broken" targets by hand.
- **Declining pages** (Task 5, job `seo.declines`, server/seo/declines.ts; table `SeoAlert`): queued by the
  SEARCH_CONSOLE runner's afterRun after each complete daily or manual run; compares the 28 Google days ending 3 days
  before syncedThrough with the 28 before. CLICKS_DOWN (≥ 30 before, ≥ 40 % and ≥ 15 lost), POSITION_DOWN (≥ 200
  impressions both windows, top 20 before, ≥ 3 places worse), SITE_DOWN instead of page alerts when the site fell
  ≥ 40 % too; pages missing on days with 500 page rows count at that day's lowest clicks; ≤ 20 a run; needs 56 read
  days. Shown on the Search tab ("Pages losing search traffic", with "Make a task" behind the `tasks` flag), the URL
  page's alerts, the digest's seo section (count and up to 3 paths, no query text) and the chat's
  `searchPerformance.decliningPages`. `GET search/declines` (analytics.read). The ads alerts now share the episode
  step (server/alerts/episode.ts), behaviour unchanged.
- Waits on Search Console verification for B&C: everything above but the link check ships tested against fixtures and
  stays empty until then. Web components weren't browser-checked on the branch (no dev server or build was run).

### SEO depth: where it stopped (2026-11-26, 17:40)
- Branch `seo-depth` in the worktrees `C:\Users\INTEL\Desktop\sma-seo\{server,web,mobile}` (not merged, not pushed). Plan: `docs/superpowers/plans/2026-11-26-seo-depth.md` (four-lens reviewed, owner answers recorded).
- Done and committed: Task 0 (one same-page URL rule, `cleanText`), Task 1 (Search Console queries and query-page pairs, kept 400 days), Task 2 (top queries on the Search tab and in the chat).
- In progress, uncommitted on disk: Task 3, the URL history page. Server: `server/seo/url-history.ts`, `app/api/v1/.../seo/`, `tests/db/url-history.db.test.ts`, `shared/seo-url.ts`. Web: `app/(shell)/performance/url/`, `components/performance/url-history.tsx`, `lib/seo-links.ts` and edits to the Search tab, the audit board and the task view.
- Still to do: finish Task 3, then Task 4 (the full-site link crawl), 5 and 5b (declining-page alerts, bell included), 6 (AI briefs), then the four-lens branch review and merge.
- The worktree's server `node_modules` is a folder of junctions plus private Prisma copies; remove the junctions with `cmd /c rmdir` before deleting the worktree. Its test DB is `sma_test_seo` in the `sma-testdb` container.
- Update 17:45: Task 3 (URL history page) is now committed: server 88bf4ca, web a5d33ac, mobile 0108faf. Its typecheck, web tests and DB test (11/11) pass. Next is Task 4, the full-site link crawl.
- Update 2026-11-27: Task 4 (the full-site weekly link crawl, `seo.links`) is done and committed on the server worktree (web and mobile untouched: no shared change). Migration `20261126150100_site_crawl` is NOT applied to the dev DB (only to the throwaway `sma_test_seo`); apply it with the owner's go-ahead. Next is Task 5 (declining pages), then 5b and 6.
