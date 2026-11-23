# Phase 1: one shared task record (design)

Date: 2026-11-23. Revised the same day after a builder check and a four-lens review (correctness, security,
performance, maintainability); §13 lists what changed. Source: the Bois & Chiffons workspace feature list (PDF: "Projects
& Tasks", "Website", "SEO", "How I'd arrange the workspace") and the B&C roadmap
(https://claude.ai/artifact/WXB3o2a8jZ8p41oayDyf3p), Phase 1, ~20.5 developer days. Phase 0 (calendar filters, post
owners, Needs action, posted by hand, client reviewer role, CSV) is merged and is the base.

## 1. Intent

B&C's team should open the workspace each morning and see **what needs action, who owns it, and what's waiting for
approval** across content, website changes and SEO, not only posts. Today only posts have owners and a review flow.
Phase 1 adds one task record that every tab reads, so one piece of work ("fix the meta description of the Spring
collection page") has one owner and one status wherever it shows: SEO, Website and its project.

Success: the team runs one real B&C launch (collection page update, blog brief, pins, reels) from a Project page, and
each specialist works it from their own queue without a second spreadsheet.

## 2. Goals, non-goals, anti-goals

Goals (the nine roadmap items):
1. Tasks, task comments and projects (with milestones).
2. My Tasks: list and board, details in the side peek, To Do → In Progress → In Review → Done, blocked with a reason.
3. Website change queue: URL, change kind, acceptance criteria, preview link, before/after screenshots, "checked live",
   client approval.
4. "Make a task" on each SEO finding; it closes itself when a later audit re-reads its pages and no longer finds it;
   an optional re-check date.
5. Today gains My tasks, Approvals and Blockers.
6. Web notifications: assigned to you, waiting for your review, overdue, re-check due.
7. Search and Quick create in the top bar.
8. Notes to tasks: paste a note, AI proposes tasks, a person confirms before anything is created.
9. LinkedIn and X as channels planned in the calendar and posted by hand.

Non-goals (Phase 1):
- Phone screens for tasks, projects or notifications; task push notifications (the phone registers its notification
  texts up front in `server/notifications/push.ts`, so new kinds need a phone release). The phone gets the shared
  types and labels only.
- Comments on posts (post feedback stays the approval note on `ApprovalDecision`). Comment edit/delete.
- CRM and ADS task areas (added with their visibility rules in Phase 3).
- A task calendar view, Gantt, dependencies, recurring tasks, time tracking, @mentions, email notifications.
- Bulk catalogue work (one task per selected product).
- LinkedIn and X publishing APIs; X threads.
- Replacing Campaign. A WorkProject may link to one.

Anti-goals:
- A second approval system for posts. A task can link to a post but never approves it.
- Two rows for one piece of work: an SEO + Website task is one row with two areas.
- Tasks, comments, titles or counts reaching someone who can't see them (another brand, or a client reviewer outside
  what is shared with them), through any reader: list, search, notifications, Today, project counts.
- New 6-second pollers.

## 3. Constraints (from the code and the roadmap rules)

- Three repos: server (Next.js API, Prisma on Neon Postgres), web (Next.js), mobile (Expo). Shared code lives in the
  server's `shared/` and is synced to the phone.
- Every query scoped by `workspaceId` + `brandId` from the route check (`server/auth/access.ts`). **Every linked id
  (workProjectId, contentItemId, auditReportId, campaignId, mediaUploadId, ownerId, reviewerId, blockedOnId) is
  re-read with `{ id, workspaceId, brandId }` (or the membership check for people) on create, PATCH, batch and attach**;
  single-column FKs don't stop cross-brand ids.
- Permission keys live in `shared/` and are re-exported by `server/auth/permissions.catalog.ts`.
- Due dates are calendar days in the brand's `BrandProfile.timeZone` (fallback the existing `DEFAULT_TIME_ZONE`,
  "UTC", passed into SQL as a parameter so TS and SQL agree), stored `@db.Date`; "today" is computed on the server.
- Create actions carry a client request id, like posts and stories.
- Background work goes through the job queue; daily checks hook into `system.daily-sweep` (`server/jobs/runner.ts`),
  which runs at 05:00 UTC (`worker/main.ts`). Ceiling: brands west of UTC get daily notifications a day late; fine for
  B&C (Paris). Upgrade path: run the task checks hourly and fire each brand once its local day has started.
- AI input (notes, member names) reaches the model only as labelled data; output is shown as plain text.
- Web pages behind a new `tasks` flag: add `"tasks"` to `WEB_FEATURE_LIST` in `web/lib/features.ts`
  (`WEB_FEATURES=tasks` or `WEB_FEATURE_WORKSPACES=tasks:<id>`). The server API ships unflagged but permission-checked.
- Links render with `rel="noopener noreferrer"`; URL fields accept http(s) only. Nothing on the server fetches them.

## 4. Approaches considered

**Where a project lives.** A) Grow `Campaign` into the project: one record per launch, but non-marketing work
(catalogue cleanup) becomes a fake campaign. **B) A new table linking optionally to one Campaign: chosen by the owner,
2026-11-23.**

**How one task appears in several tabs.** A single area + linked copies drifts apart. **An `areas` array on one task
(my call).**

**Website/SEO fields.** Separate 1:1 tables (`TaskWebsite`, `TaskFinding`) keep the task row lean but add a join to every
list and two more write paths. **Nullable columns on Task (my call)**: Phase 1 has only two areas with fields; if CRM/ADS
in Phase 3 bring their own, move them to 1:1 tables then.

**Where tabs live in the web app.** **One `/tasks` page with area tabs; new Website and SEO sidebar entries link to
`/tasks?area=website|seo` (my call).** Separate pages would duplicate the list.

**Naming.** The code already says "project" for a brand (project roles, `project.members.manage`, "Project admin").
**The model is `WorkProject` (field `workProjectId`, routes `/work-projects`), the UI says "Projects" (my call)**, B&C's
own word. Brand-meaning "project" copy is left alone in Phase 1.

## 5. Data model (Prisma, server)

New enums:
```
enum TaskStatus        { TODO IN_PROGRESS IN_REVIEW DONE CANCELLED }
enum TaskPriority      { LOW NORMAL HIGH URGENT }
enum TaskArea          { CONTENT WEBSITE SEO GENERAL }
enum WebsiteChangeKind { PRODUCT_PAGE COLLECTION MENU HOMEPAGE LANDING_PAGE BUG CORRECTION OTHER }
enum WorkProjectStatus { ACTIVE DONE ARCHIVED }
enum TaskCommentKind   { COMMENT APPROVED CHANGES_REQUESTED SYSTEM }
enum NotificationKind  { TASK_ASSIGNED REVIEW_REQUESTED TASK_OVERDUE TASK_RECHECK }
enum TaskAttachmentRole { BEFORE AFTER OTHER }
```
`ContentChannel` gains `LINKEDIN_POST` and `X_POST`.

**Task**
| column | type | notes |
|---|---|---|
| id, workspaceId, brandId | | composite FK to Brand (brandId, workspaceId), cascade |
| title | String | 1–200 |
| description | String? | ≤ 10,000 plain text |
| status | TaskStatus | default TODO |
| priority | TaskPriority | default NORMAL |
| areas | TaskArea[] | ≥ 1; default [GENERAL] |
| ownerId | String? | FK User SetNull |
| reviewerId | String? | FK User SetNull; set when the task needs review |
| createdById | String? | FK User SetNull |
| dueOn | Date? | brand-zone day |
| blockedReason | String? | non-null = blocked (on any open status) |
| blockedOnId | String? | FK User SetNull; who can unblock |
| workProjectId | String? | FK WorkProject SetNull |
| contentItemId | String? | FK ContentItem SetNull |
| url | String? | affected page, http(s), ≤ 2,000 |
| changeKind | WebsiteChangeKind? | |
| acceptanceCriteria | String? | ≤ 4,000 |
| previewUrl | String? | http(s) |
| checkedLiveAt, checkedLiveById | DateTime?, String? | cleared when `url` changes or the task reopens |
| auditReportId | String? | FK AuditReport SetNull |
| findingKind, findingId | AuditKind?, String? | the finding this task came from |
| findingUrls | String[] | the finding's pages when the task was made (empty = site-wide) |
| findingClearedAt | DateTime? | set by the audit that no longer finds it |
| recheckOn | Date? | SEO: look at performance again |
| completedAt | DateTime? | set on DONE, cleared on reopen |
| requestId | String? | `@@unique([brandId, requestId])` |
| createdAt, updatedAt | | |

Indexes (raw SQL in the migration where Prisma can't express them):
- partial, `WHERE status IN ('TODO','IN_PROGRESS','IN_REVIEW')`:
  `(brandId, ownerId, dueOn NULLS LAST, id)`, `(brandId, reviewerId, dueOn NULLS LAST, id)`,
  `(brandId, dueOn NULLS LAST, id)`, `(brandId) WHERE blockedReason IS NOT NULL` (also open-only).
- partial unique `(brandId, findingKind, findingId) WHERE status IN (open) AND findingId IS NOT NULL`: one open task per
  finding, race-safe.
- `(brandId, status, completedAt)` for the Done view; `(workProjectId, status)`; `(contentItemId)`;
  `(recheckOn) WHERE recheckOn IS NOT NULL AND status = 'DONE'`; trigram GIN on `title`.
- No GIN on `areas` (low cardinality; the brand index leads).

**TaskChecklistItem**: id, taskId (cascade), text (≤ 300), doneAt?, doneById?, position. Index `[taskId, position]`.

**TaskAttachment**: id, taskId (cascade), mediaUploadId (FK MediaUpload **Restrict**), role, createdById, createdAt.
Only VERIFIED photo uploads of this brand with `productId = null`, re-read inside the attach transaction. Removing an
attachment or deleting a task never deletes the upload or its file. `purgeStaleUploads` (`server/stories/uploads.ts`)
excludes uploads a TaskAttachment references in its `where` (not a per-row catch), so the purge can't throw and stop
the daily sweep.

**WorkProject**: id, workspaceId, brandId (composite FK), name (1–120), description?, ownerId? (FK SetNull), status
(default ACTIVE), startsOn?, dueOn?, campaignId? (FK SetNull, `@@unique([brandId, campaignId])`), clientVisible
Boolean default false, requestId? (`@@unique([brandId, requestId])`), timestamps. Index `[brandId, status, dueOn]`;
trigram GIN on `name`. Progress = done / (all − cancelled), computed for a page of projects with one
`groupBy(['workProjectId','status'])`.

**WorkProjectMilestone**: id, workProjectId (cascade), title (≤ 120), dueOn Date, doneAt?, position. Index
`[workProjectId, dueOn]`.

**TaskComment**: id, workspaceId, brandId, taskId (cascade), authorId? (null for SYSTEM), kind, body (1–4,000),
byClient Boolean, internal Boolean, createdAt. Append-only (no edit or delete). Staff comments default `internal =
true` on a task a client can see, with a "Share with client" toggle; client comments and APPROVED / CHANGES_REQUESTED
are never internal. Index `[taskId, createdAt]`.

**Notification**: id, userId, workspaceId, brandId, kind, taskId? (cascade), actorId?, dedupeKey `@unique`, readAt?,
createdAt. Keys: event kinds `<kind>:<userId>:<auditEventId>`; daily kinds `<kind>:<userId>:<taskId>:<brand-local
yyyy-mm-dd>`. Indexes `[userId, workspaceId, readAt, createdAt]`, `[createdAt]` (90-day prune in the daily sweep).

Migration 1 runs `CREATE EXTENSION IF NOT EXISTS pg_trgm` and adds trigram GIN indexes on `ContentItem.title`,
`Product.title`, `Campaign.name` too, for search.

Every write (task create/update/status action, checklist, attachment, comment, project, milestone, automatic DONE by an
audit, notes-to-tasks call) records an `AuditEvent`; deletes and cancels keep the title in the event.

## 6. Access

New project-scope keys: `tasks.read` (see tasks and projects, comment), `tasks.manage` (create, edit, assign, cancel any
task or project).

**One visibility predicate, `visibleTaskWhere(access)`, in SQL, used by every reader** (lists, Today, search,
notification list and count, project counts, attachments, comments). It resolves once per request from the
`brandAccess` result already loaded (no second permission read):
- staff with `tasks.read`: all tasks of the brand;
- a client reviewer (the `clientReviewer` flag from `access.ts`, not the role slug): tasks where `reviewerId = me`, or
  whose WorkProject has `clientVisible = true`. Comments with `internal = true` are left out for them.

Notifications resolve the person's readable brands once per request (one role read + one grants read) and filter with
`brandId IN (...)` joined to Task through the same predicate; `/count` uses the same query.

**Who may be owner, reviewer or blocked-on:** someone who passes `visibleTaskWhere` for that task (holds `tasks.read` on
the brand; a client only if the task is client-visible to them). Re-checked when areas, project or clientVisible change;
a change that would hide the task from its current owner or reviewer is refused. Names come from the existing
`content/owners` source (`brandOwners`), extended to accept `tasks.read`; no emails.

**What each person may change (PATCH allow-list):**
- server-only, never in PATCH: status, completedAt, checkedLive*, finding*, auditReportId, createdById, requestId.
- `tasks.manage`: title, description, priority, areas, ownerId, reviewerId (not while IN_REVIEW, except to replace a
  reviewer who can no longer see the task), dueOn, workProjectId, contentItemId, url, changeKind, acceptanceCriteria,
  previewUrl, recheckOn.
- the owner without `tasks.manage`: checklist, attachments (only if they also hold `content.create`, since the upload route
  needs it), and the block/unblock action.
- Status moves only through actions (§7).

**Review rules (copying the post rule, reusing `hasOtherApprover` from `server/auth/permissions.ts`):**
- A task with `reviewerId` set reaches DONE only through `approve`. A task without a reviewer may go straight to DONE.
- `submitForReview` needs a reviewer who isn't the owner, unless `hasOtherApprover` finds nobody else on the brand, in
  which case the owner may review their own task (no deadlock in a one-person brand). The owner can't pick
  themselves otherwise; a client reviewer counts as a reviewer but never as the "other approver".
- IN_REVIEW is left only by `approve` (→ DONE), `requestChanges` (→ IN_PROGRESS, reason required) or `cancel`
  (`tasks.manage`).
- Only the reviewer may approve or request changes, and only while they still pass `visibleTaskWhere`.

Role defaults (migration): owner/admin/manager, creator and commercial-owner get both keys; approver and viewer get
`tasks.read`; the client reviewer gets `tasks.read`. Custom project roles holding `content.create` get `tasks.read`.
(The workspace "member" role has no project keys and gets nothing; project-admin already holds every project key.)

## 7. API (server, under `/api/v1/workspaces/:ws/brands/:brand/`)

- `GET tasks?view=mine|approvals|due-today|overdue|blocked|open|done&area=&workProjectId=&ownerId=&cursor=`: 50 per
  page, keyset on `(dueOn NULLS LAST, id)` (two-part cursor). `view=mine` returns `posts[]` on the first page only:
  your posts that need action, by the Phase 0 rule moved from `web/lib/calendar-filter.ts` (`isOverdue`, `isBlocked`)
  into `shared/` so the web, server and phone use one copy.
- `GET tasks?view=today`: counts and the first 5 of My tasks (yours, due today or overdue), Approvals (IN_REVIEW, you
  review) and Blockers (blocked, and you own it or are blocked-on).
- `POST tasks` (requestId), `GET tasks/:id` (with checklist, attachments, visible comments, linked post/project titles),
  `PATCH tasks/:id` (allow-list above).
- `POST tasks/:id { action }`: `start`, `submitForReview { reviewerId? }`, `approve { note? }`, `requestChanges
  { reason }`, `markDone` (no reviewer only), `block { reason, blockedOnId? }`, `unblock`, `checkedLive`, `cancel`,
  `reopen`. Who may: owner or `tasks.manage` for all but approve/requestChanges (reviewer) and cancel (manage).
  - DONE and CANCELLED clear `blockedReason`/`blockedOnId`.
  - `reopen` (DONE/CANCELLED → TODO) clears completedAt, checkedLive*, findingClearedAt, recheckOn; it returns 409 if
    another open task already holds the same finding.
  - Notifications are written in the same transaction as the action that causes them.
- Checklist: `POST tasks/:id/checklist`, `PATCH|DELETE tasks/:id/checklist/:itemId`.
- Attachments: `POST tasks/:id/attachments { mediaUploadId, role }`, `DELETE .../:attId`.
- Comments: `GET|POST tasks/:id/comments` (`{ body, shareWithClient? }`).
- Work projects: `GET work-projects?status=&cursor=`, `POST`, `GET work-projects/:id` (milestones, task counts by status,
  linked campaign's posts in the calendar window), `PATCH`, milestones like the checklist. No hard delete: status
  ARCHIVED.
- `POST audit-reports/:reportId/findings/:findingId/task`: returns the open task for `(kind, findingId)` or creates it:
  areas [SEO] (+ WEBSITE when the finding lists pages), title, description = detail + fix + page list, `findingUrls` =
  the finding's pages, `url` when exactly one. The partial unique index turns a race into "return the existing one".
- `POST tasks/from-note { text, requestId }` (`tasks.manage`): `{ proposals: [{ title, description?, areas,
  ownerId?, dueOn?, priority }] }`, nothing stored. `POST tasks/batch { requestId, tasks }` (≤ 20) runs every check
  POST tasks runs, then `createMany` tasks and audit events in one transaction.
- `GET search?q=` (≥ 2 chars; `tasks.read` or `brand.read` per kind): tasks (through `visibleTaskWhere`), work projects,
  posts, products, campaigns; `ILIKE '%q%'` on the trigram-indexed columns, ranked by `similarity`, 5 per kind, five
  tagged `$queryRaw` queries in `Promise.all`. Each kind is filtered by the same permission as its own list (products
  and campaigns hidden from client reviewers unless their role reads them today). Rate limit 30/min per user via
  `hitRateLimit` (`server/auth/rate-limit.ts`).
- User level: `GET /api/v1/me/notifications?cursor=`, `GET /api/v1/me/notifications/count`,
  `POST /api/v1/me/notifications/read { ids | all }`, all for the current workspace.

zod at every route; ids match the existing patterns.

## 8. Behaviour

**Website tasks.** Area WEBSITE shows URL, change kind, acceptance criteria, preview link, Before/After screenshot
slots and "Checked on live site" (needs a URL; records who and when). Client approval: the task's reviewer is the
client reviewer; the side peek shows criteria, preview, screenshots and Approve / Request changes. The Website tab's
"Waiting for client" view = IN_REVIEW with a reviewer from the brand's client-reviewer set (resolved once per request).

**SEO tasks.** "Make a task" on each finding row of the audit screen (`web/components/performance/audit-board.tsx`).
When a new SEO `AuditReport` is saved, a job (enqueued after the save, so the agent run never waits on it) checks open
tasks of that kind with a `findingId`:
- clear only if the finding's id is absent from the new report **and** every one of the task's `findingUrls` is in the
  new report's `metrics.pagesChecked` (for a site-wide finding, the same pages were re-read is not required; absent is
  enough);
- never touch tasks that are IN_REVIEW (a client approval may be pending): those get a SYSTEM comment only;
- otherwise set `findingClearedAt`, add a SYSTEM comment "The <date> audit no longer finds this" and move to DONE, in one
  transaction (`updateMany` + `createMany`).
- Positional AI-review ids (`content-1`, `content-2` from `agents/definitions/geo.ts`) never clear; one exported
  predicate `isStableFindingId` in `server/seo/` decides.
- A finding that comes back on a DONE task reopens nothing.
`recheckOn` (offered as +28 days when an SEO task goes DONE) creates TASK_RECHECK for the owner on that day, only if
the task is still DONE.

**Today (Overview).** Three groups above the Phase 0 post rows from `GET tasks?view=today`. Each row opens the task in
the side peek; each header links to `/tasks?view=...`. Polls every 60 s (not the 6 s `useBrandData` rate), refetches on
window focus and after any task action.

**My Tasks page** (`/tasks`, flag `tasks`). Area tabs (All, Content, Website, SEO). Views: Mine, Approvals, Due today,
Overdue, Blocked, All open, Done (30 days). List by default (title, areas, owner, due, priority, status, project);
Board toggle (four status columns; dragging follows the action rules: onto In Review asks for a reviewer, off In Review
or onto Done of a reviewed task is refused with the reason shown). View and layout remembered per browser. Mine shows
your posts that need action with a "Post" tag, opening in the post peek. Details open in the side peek (`?task=<id>`,
added to `lib/workspace-view.ts` ITEM_PARAMS and Recent). An owner who left the brand shows as "No longer on this
business" (from the brand's member set, read once). Projects: `/projects` list and `/projects/:id` page (owner, dates,
status, progress, linked campaign, milestones, tasks by status, the campaign's posts, a "Visible to client" switch for
`tasks.manage`).

**Nav.** The "Projects & team" (Beat) slot becomes "Projects & tasks" → `/tasks`, with `/projects`; new entries Website →
`/tasks?area=website` and SEO → `/tasks?area=seo`; all behind the `tasks` flag and `tasks.read`.

**Notifications (web).** A bell in the top bar with the unread count (60 s poll, on focus). TASK_ASSIGNED when ownerId
changes to someone other than the actor; REVIEW_REQUESTED on `submitForReview`; TASK_OVERDUE once per task per brand-local
day for open tasks past `dueOn`; TASK_RECHECK on `recheckOn`. The daily kinds are one set-based
`INSERT … SELECT … ON CONFLICT (dedupeKey) DO NOTHING` per kind, computing each brand's local date from
`Brand.timeZone`. The menu lists the latest 20 with "Mark all read"; clicking opens the task (switching brand through
the existing unsaved-work guard).

**Search and Quick create.** Top bar search (Ctrl/Cmd+K), debounced 250 ms, grouped results. Quick create "+": Task,
Post from a brief (Phase 0 dialog), Project, Tasks from a note; each shown only with its permission.

**Notes to tasks.** Dialog with a textarea (≤ 8,000 chars). The server sends the note and the brand's member names (both
labelled as data), today's brand-local date and the area list to the light model tier with structured output (≤ 20
proposals). Owners are matched to member ids server-side; unknown names are dropped. The person edits, unticks or keeps
each, then creates. Free (like translate; no `CREDIT_COSTS` entry). Limits: 10/hour per user and 100/day per workspace.

**LinkedIn and X.** Through the planner, writer limits (LinkedIn 3,000 chars, X 280), checks, labels, calendar filters
and CSV. `server/services/manual-post.ts` gains linkedin.com (`/posts/`, `/feed/update/`) and x.com / twitter.com
(`/status/`) link patterns; the per-channel maps (`IMAGES`, `CHANNEL_PROVIDER` = null, `WEEKDAYS_BY_CHANNEL`, the
creator image limit) get entries. Publishing is refused (no connection); they use posted-by-hand (link optional, as for
other channels today). **Order:** the phone ships a fallback label for unknown channels and the two new labels first;
the server offers LinkedIn/X in the planner only after that phone release.

## 9. Failure modes

- Double click / retry on create: `requestId` per brand returns the first record. Two people making a task from one
  finding: the partial unique index; the loser gets the winner's task.
- Two people editing a task: last write wins per field (PATCH sends only changed fields). Ceiling noted in code; add an
  `updatedAt` precondition if conflicts are reported.
- Owner or reviewer loses access: lists show "No longer on this business"; `tasks.manage` reassigns; the reviewer of
  an IN_REVIEW task may be replaced.
- Audit crawls fewer pages: tasks whose pages weren't re-read stay open. Crawl of 0 pages already throws in the agent.
- Daily sweep twice: notification dedupe keys. Purge vs attach race: attach re-reads the upload in its transaction; purge
  excludes referenced uploads in SQL.
- Project archived: tasks keep their link; campaign deleted: project continues without it.
- AI note junk or injection: schema-validated output, owner ids from the member list only, nothing created without
  confirmation, output rendered as text.

## 10. Rollout

1. Phone: fallback label for unknown channels + LinkedIn/X labels; shared-types sync. Release.
2. Server: migrations (pg_trgm, tables, raw indexes, role keys), API, sweep and audit job. Harmless with the web flag off.
3. Web behind `tasks`, on for the B&C workspace only; run one real launch as a Project; then everyone.
4. LinkedIn/X offered in the planner.
Each slice gets the four-lens review before merge.

## 11. Left to the builder

- Web component split; reusing the post peek shell for the task peek.
- Board drag: the library the Overview panels already use.
- Copy (en and fr), following the design system doc.
- Plan task order, as long as migrations come first and the phone label release precedes LinkedIn/X in the planner.

## 12. Calls made without the owner (check these)

1. Several areas per task; areas limited to Content, Website, SEO, General in Phase 1.
2. One `/tasks` page with area tabs; Website and SEO are new sidebar entries pointing at it.
3. Client reviewers see only tasks they review or that sit in a project marked "Visible to client" (off by default);
   staff comments on those are internal unless shared.
4. An audit that re-reads a task's pages and no longer finds the issue moves it to DONE (not while in review).
5. A task without a reviewer can go straight to Done; once a reviewer is set, only their approval finishes it.
6. No phone task screens or task push in Phase 1.
7. Notes to tasks is free, capped per user and per workspace.
8. Bulk catalogue tasks, comments on posts, comment editing deferred.
9. One SEO task per finding (not per page).
10. Model named `WorkProject`; UI says "Projects".
11. Role defaults: creators and commercial owners can manage tasks; approver, viewer and client reviewer read.
12. Today's task groups and the bell poll every 60 s.
13. Website/SEO fields stay as nullable columns on Task.

## 13. Changes from the reviews (2026-11-23)

Builder check: one task per finding with page list; naming; client vs ADS; role list; Today polling; notes cost; no
page count on AuditReport (corrected: `metrics.pagesChecked` lists them); new nav entries; upload purge; nullable
`createdById`; pg_trgm. Four lenses: cross-brand id checks and `@@unique([brandId, campaignId])`; review can't be
skipped, reviewer frozen in review, one-person brands; one `visibleTaskWhere` for every reader; assignees must see the
task; internal comments and `clientVisible`; PATCH allow-list; attachment rules and purge in SQL; notes-to-tasks needs
`tasks.manage`, workspace cap, audit coverage; partial indexes for open tasks and keyset; search indexes on all five
columns; set-based sweep inserts; prune index; clearing as a job with batched writes; grouped progress; posts only on
page 1; shared Needs-action rule; comments on tasks only and append-only; CRM/ADS areas dropped; reuse
`hasOtherApprover`; event-based dedupe keys; reopen/close field resets; LinkedIn/X link patterns and per-channel maps;
phone label release first; 05:00 UTC sweep ceiling. Kept despite review: website/SEO columns on Task (§4), milestones
(the feature list asks for them).
