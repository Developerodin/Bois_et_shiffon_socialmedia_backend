# Phase 1: One Shared Task Record Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One task record (with comments, checklist, screenshots), work projects with milestones, web notifications, search, quick create, notes-to-tasks and LinkedIn/X by hand, so B&C's team sees what needs action, who owns it and what waits for approval across content, website and SEO.

**Architecture:** New Prisma tables and pure rule modules in `server/shared/` (status machine, DTO types) and `server/server/tasks/` (one SQL visibility predicate, assignment checks, services). Every task read goes through `visibleTaskSql`; Prisma reads only follow an id that SQL already let through. The web adds `/tasks`, `/projects`, a task side peek, Today groups, a bell, search and quick create behind the `tasks` flag. The phone only gets labels and the shared sync.

**Tech Stack:** Next.js route handlers, Prisma 6 on Postgres (Neon) with raw-SQL partial and trigram indexes, zod, vitest; web Next.js + React; mobile Expo.

**Spec:** `docs/superpowers/specs/2026-11-23-phase-1-tasks-design.md`. Revised 2026-11-23 after the plan's four-lens review (see the end).

## Global Constraints

- Three repos in `apps/` (server, web, mobile), each its own git, branch `phase-1` in each; merge to `main` after the four-lens branch review. Plans and specs stay untracked.
- `shared/` is edited in `server/shared/` only, then `npm run sync:shared` copies it into web and mobile; commit the synced copies there. Web `npm run typecheck` fails on drift; mobile typechecks against the same types.
- **Order:** Task 1 (phone labels) precedes Task 22 (LinkedIn/X). Server before web.
- Never run `next build` in web while `next dev` runs (dev servers are up on :3100/:3101).
- Every query scoped by `{ workspaceId, brandId }` from `authorizeBrandRoute(request, params, key)`; every linked id goes through `checkTaskLinks` (Task 5); same 400 "Invalid <field>" for missing and foreign ids; a task or child row not visible to the caller is 404.
- **Raw SQL:** tagged `$queryRaw`/`$executeRaw` and `Prisma.sql` fragments only. `$queryRawUnsafe`, `$executeRawUnsafe` and `Prisma.raw` are allowed only for constants defined in code (the open-status list), never input. Task 2 adds a lint check.
- Time zone: `BrandProfile.timeZone ?? DEFAULT_TIME_ZONE` (`server/catalog/campaigns.ts`, "UTC"); SQL receives the fallback as a parameter and uses `LEFT JOIN "BrandProfile"`.
- Creates are idempotent on `requestId` (`@@unique([brandId, requestId])`); a retry is answered before any rate limit.
- AI input (notes, member names) labelled as data, one JSON line per item as in `creator.ts`; output rendered as text.
- Errors: `TaskError(message, status, code?)` mapped by `problemResponse` (Task 5). Audit: `taskAudit(tx, scope, action, entity, metadata)` (Task 5); every write records one, deletes/cancels keep the title.
- Notifications are written through `notifyTx` (Task 5) in the same transaction as their cause.
- Web: no new 6 s pollers; task data polls at 60 s (`JOB_INTERVALS.tasks = [[Infinity, 60_000]]`), on focus, and after a `tasks:changed` window event. Links `rel="noopener noreferrer"`. Copy in en and fr; `docs/DESIGN_SYSTEM.md` rules (12 px floor, visible reasons for disabled buttons).
- Commit messages: the change and why. No co-author lines, no tool or session URLs, no mention of tests.
- Checks: server `npm test`, `npm run typecheck`, `npm run lint`; web `npm test`, `npm run typecheck`, `npm run lint`; mobile `npx tsc --noEmit`. **DB rules:** `npm run test:db` runs `tests/db/*.db.test.ts` against `TEST_DATABASE_URL` (a throwaway Postgres: Neon branch or `docker run postgres:17`), migrating it first; skipped with a printed notice when unset. Unit tests mock Prisma and cannot prove SQL; any rule that lives in SQL or an index gets a `.db.test.ts` case.

## Route permissions (key passed to `authorizeBrandRoute`, then service checks)

| route | key | service check |
|---|---|---|
| GET tasks, GET tasks/:id, GET comments, GET work-projects(/:id) | `tasks.read` | visibility |
| POST tasks, PATCH tasks/:id, POST tasks/batch, POST tasks/from-note, POST findings/:id/task, POST/PATCH work-projects, milestone writes | `tasks.manage` | links, assignees |
| POST tasks/:id (actions), checklist writes, POST comments | `tasks.read` | owner / reviewer / manage per action |
| attachments | `tasks.read` | owner + `content.create`, or manage |
| GET search | `brand.read` | `tasks.read` per kind; list-route permission per other kind |
| /me/notifications* | `requireWorkspaceMember` on `X-Workspace-Id` | rows `{ userId, workspaceId }` |

Each write route gets one 403 test for a caller without its key.

## Review Focus

1. Owner of a reviewed task tries IN_REVIEW → DONE by PATCH, `markDone` or a board drag; a manager swaps the reviewer mid-review: all refused; only the reviewer's `approve` finishes it. (Task 3, Task 5 `reviewerId PATCH refused in review`, Task 7.)
2. A client reviewer lists, opens, searches, reads comments, opens the bell and Today: sees only tasks they review or in a shared project, never internal comments, even after a project is shared later. (Tasks 4, 8, 12, 13.)
3. Two people click "Make a task" on one finding at once: one task. (Task 11 db test.)
4. An audit that crawled fewer pages: tasks whose pages weren't re-read stay open; a task moved to review during the job isn't closed. (Task 11.)
5. A brand with a creator and an approver: the creator can't self-review; a brand with one staff member can. (Task 4.)

---

### Task 1: Phone labels for unknown and new channels (mobile)

**Files:** Modify `mobile/src/ui/posts/format.ts:42-50` (`CHANNEL_LABEL`), `mobile/src/app/posts/[id].tsx` (`CHANNEL_NAME`), every `Record<PostChannel, …>` from `grep -rn "Record<PostChannel" mobile/src`.

**Interfaces:** Produces `channelLabel(c: string): string`: known label; `LINKEDIN_POST` → "LinkedIn", `X_POST` → "X"; otherwise the key title-cased ("SOME_THING" → "Some thing"). Every label lookup goes through it.

- [ ] **Step 1:** Add `channelLabel`; replace direct lookups.
- [ ] **Step 2:** `npx tsc --noEmit` → clean.
- [ ] **Step 3:** Commit "Show a readable label for channels the app doesn't know yet, and name LinkedIn and X".

### Task 2: Schema, migration, permission keys, DB test harness

**Files:**
- Modify: `prisma/schema.prisma` (spec §5 models/enums without the ContentChannel change; `MediaUpload` back-relation `taskAttachments TaskAttachment[]`), `shared/permissions.ts`, `server/auth/permissions.catalog.ts`, `package.json` (`"test:db"`), `eslint.config.*` (`no-restricted-syntax` on `$queryRawUnsafe`/`$executeRawUnsafe` member calls)
- Create: `prisma/migrations/<ts>_phase1_tasks/migration.sql` (Prisma output + raw SQL), `vitest.db.config.ts`, `tests/db/setup.ts` (skip notice when `TEST_DATABASE_URL` unset; else `prisma migrate deploy` against it and truncate between files), `tests/task-permissions.test.ts`

**Interfaces:**
- Produces: models and enums as spec §5; keys `"tasks.read"` (group "tasks", "See tasks and projects, and comment") and `"tasks.manage"` (group "tasks", "Create, edit, assign and cancel tasks and projects"), project scope.
- Raw SQL appended: `CREATE EXTENSION IF NOT EXISTS pg_trgm;` open-only partial indexes, all with the literal predicate `status IN ('TODO','IN_PROGRESS','IN_REVIEW')`:
  `task_open_owner (brandId, ownerId, COALESCE("dueOn",'infinity'::date), id)`, `task_open_reviewer (brandId, reviewerId, COALESCE(...), id)`, `task_open_due (brandId, COALESCE(...), id)`, `task_open_blocked (brandId) WHERE … AND "blockedReason" IS NOT NULL`, unique `task_open_finding (brandId, findingKind, findingId) WHERE … AND "findingId" IS NOT NULL`; plus `task_done (brandId, completedAt DESC, id) WHERE status = 'DONE'`, `task_recheck ("recheckOn") WHERE "recheckOn" IS NOT NULL AND status = 'DONE'`; trigram GIN on `Task.title`, `WorkProject.name`, `ContentItem.title`, `Product.title`, `Campaign.name`; `UPDATE "Role"` adding keys to existing system roles per spec §6 and `tasks.read` to custom project roles holding `content.create` (guarded by `NOT (permissions @> ARRAY[...])`).

- [ ] **Step 1: Failing test** `task-permissions`: owner/admin/manager/creator/commercial-owner hold both keys; approver, viewer, client-reviewer hold `tasks.read` only; member neither; project-admin both.
- [ ] **Step 2:** `npx vitest run tests/task-permissions.test.ts` → FAIL.
- [ ] **Step 3:** Schema + catalog; `npx prisma migrate dev --create-only --name phase1_tasks`; append raw SQL; `npx prisma migrate dev`; add `test:db` and the lint rule.
- [ ] **Step 4:** Test → PASS; `npm run typecheck`; `npm run lint`; `npm run test:db` prints the skip notice (or passes an empty suite).
- [ ] **Step 5:** `npm run sync:shared`; commit server and the synced web/mobile copies: "Add tasks, work projects, comments and notifications, with task permissions for each role".

### Task 3: Shared task rules and DTO types

**Files:** Create `shared/tasks.ts`, `shared/needs-action.ts`, `shared/api/tasks.ts` (export from `shared/index.ts`); modify `web/lib/calendar-filter.ts` (import `isOverdue`, `isBlocked` from shared). Test `tests/task-rules.test.ts`.

**Interfaces:**
- `TASK_STATUSES`, `OPEN_TASK_STATUSES = ["TODO","IN_PROGRESS","IN_REVIEW"] as const`, `TASK_AREAS = ["CONTENT","WEBSITE","SEO","GENERAL"]`, `TASK_PRIORITIES`, `WEBSITE_CHANGE_KINDS`, `TaskAction` union (`start|submitForReview|approve|requestChanges|markDone|block|unblock|checkedLive|cancel|reopen`).
- `type TaskRow` (plain: status, reviewerId, ownerId, url, blockedReason, blockedOnId, completedAt, checkedLiveAt, checkedLiveById, findingClearedAt, recheckOn — strings/ISO dates, no Prisma import).
- `type ActorRole = { userId: string; isOwner: boolean; isReviewer: boolean; canManage: boolean; soleStaff: boolean }`.
- `applyAction(task: TaskRow, action: TaskAction, actor: ActorRole, input: { reviewerId?: string; reason?: string; now: string }): { ok: true; patch: Partial<TaskRow> & { status?: string } } | { ok: false; reason: string }` with spec §6/§7 rules: reviewed task finishes only by approve; IN_REVIEW left only by approve/requestChanges/cancel; requestChanges needs a reason; only the reviewer approves; submitForReview needs a reviewer ≠ owner unless `soleStaff`; DONE and CANCELLED clear blocked fields; DONE sets completedAt; reopen clears completedAt, checkedLive*, findingClearedAt, recheckOn.
- `allowedActions(task, actor): TaskAction[]` (every action whose `applyAction` dry-run is ok, ignoring input-dependent refusals).
- `MANAGE_PATCH_FIELDS` (spec §6 list) and `pickPatch(body): Record<string, unknown>` (keeps only those).
- `shared/api/tasks.ts`: `TaskDto` (task fields + `owner/reviewer/blockedOn: { id; name; gone } | null`, `project: { id; name } | null`, `post: { id; title } | null`, `checklist: { done; total }`, `actions: TaskAction[]`), `TodayDto`, `WorkProjectDto`, `NotificationDto`, `SearchResultDto`.
- `isOverdue`, `isBlocked` moved verbatim from `web/lib/calendar-filter.ts`.

- [ ] **Step 1: Failing tests:** `reviewed task finishes only by approve`; `markDone without reviewer → DONE with completedAt`; `IN_REVIEW leaves only by approve, requestChanges, cancel`; `requestChanges needs a reason`; `only the reviewer approves`; `self-review only when sole staff`; `close clears blocked`; `reopen clears finding and live marks`; `pickPatch drops status and server-only fields`; `allowedActions for reviewer of IN_REVIEW is approve, requestChanges`.
- [ ] **Step 2–4:** FAIL → implement → PASS (server and web tests).
- [ ] **Step 5:** `npm run sync:shared`; commit in each repo "Put the task status rules, task DTOs and the needs-action rule in shared code".

### Task 4: Visibility and assignment

**Files:** Create `server/tasks/access.ts`; modify `server/auth/permissions.ts` (extract `hasOtherHolder`). Test `tests/task-access.test.ts`, `tests/db/task-visibility.db.test.ts`.

**Interfaces:**
- `type TaskViewer = { userId; workspaceId; brandId; canRead: boolean; canManage: boolean; client: boolean }`; `taskViewer(scope): TaskViewer` from the route scope (`perms`, `clientReviewer`), no extra read.
- `visibleTaskSql(v: TaskViewer, alias = "t"): Prisma.Sql`: staff → `t."workspaceId" = … AND t."brandId" = …`; client → plus `AND (t."reviewerId" = me OR EXISTS (SELECT 1 FROM "WorkProject" p WHERE p.id = t."workProjectId" AND p."clientVisible"))`; no `canRead` → `FALSE`. **The only definition of task visibility.**
- `visibleTasksAcrossSql(userId, workspaceId): Promise<Prisma.Sql>` for notifications: reads the person's brand grants once (staff brand ids, client brand ids) and returns `(t."brandId" IN (staff…) OR (t."brandId" IN (client…) AND <client clause>))`.
- `findVisibleTask(tx, v, id): Promise<{ id } | null>` (one `$queryRaw` with the predicate); every route that touches a task or its children starts with it (404 when null).
- `commentVisibility(v)`: client → `{ internal: false }`.
- `hasOtherHolder(workspaceId, brandId, userId, key: PermissionKey): Promise<boolean>`, extracted from `hasOtherApprover`, client grants excluded; `hasOtherApprover = (…) => hasOtherHolder(…, "content.approve")`.
- `isSoleStaff(workspaceId, brandId, userId) = !(await hasOtherHolder(…, "tasks.read"))`.
- `canBeAssigned(tx, scope, userId, task: { reviewerId: string|null; workProjectId: string|null }): Promise<boolean>`: holds `tasks.read` on the brand (one effective-permissions lookup shared with `setOwner` in `services/publishing.ts:252-259`, extracted as `brandMemberPerms(tx, scope, userId)`), and, if a client, the task is client-visible to them.

- [ ] **Step 1: Failing tests:** unit: `client predicate has the reviewer-or-shared clause`; `no tasks.read is FALSE`; `client never sees internal comments`; `assignee without tasks.read is refused`; `client assignee refused on a non-shared task`; `creator plus approver is not sole staff`; `one staff member is sole staff`; existing publishing tests unchanged. db: `client sees reviewed or shared only`; `across-brands form matches per-brand form` (same ids).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit "Decide who can see and be given a task in one place".

### Task 5: Task core: create, read, edit

**Files:** Create `server/tasks/service.ts`, `server/tasks/errors.ts`, `server/tasks/audit.ts`, `server/tasks/links.ts`, `server/notifications/tasks.ts`, routes `app/api/v1/workspaces/[workspaceId]/brands/[brandId]/tasks/route.ts` (POST), `.../tasks/[taskId]/route.ts` (GET, PATCH). Modify `server/services/publishing.ts` (`brandOwners(scope, { key = "brand.read", includeClients = false } = {})`, default unchanged; `lock` → `lockRow(tx, kind: "content"|"task", id)` keeping `lock` as the content alias). Test `tests/tasks-core.test.ts`.

**Interfaces:**
- `TaskError(message, status, code?)`; routes map it through `problemResponse` like `PublishingError`.
- `taskAudit(tx, scope, action: string, entity: { type: "Task"|"WorkProject"|"TaskComment"; id; title? }, metadata?)`.
- `notifyTx(tx, { userId; workspaceId; brandId; kind; taskId; actorId; auditEventId })`: key `<kind>:<userId>:<auditEventId>`; skips `userId === actorId`; `createMany … skipDuplicates`.
- `TaskInput` zod (title 1–200, description ≤ 10,000, areas ≥ 1, priority, ownerId?, reviewerId?, dueOn `YYYY-MM-DD`?, workProjectId?, contentItemId?, url/previewUrl http(s) ≤ 2,000?, changeKind?, acceptanceCriteria ≤ 4,000?, recheckOn?, requestId?).
- `checkTaskLinks(tx, scope, input, current?): Promise<void>`: every present linked id (workProjectId, contentItemId, auditReportId) re-read with `{ id, workspaceId, brandId }`; ownerId/reviewerId/blockedOnId through `canBeAssigned`; throws `TaskError("Invalid <field>", 400)`. Used by create, patch, batch, actions, make-task.
- `createTask(scope, v, input): Promise<TaskDto>` (requestId replay first; TASK_ASSIGNED to an owner ≠ creator; audit `task.create`).
- `getTask(scope, v, id): Promise<TaskDto>` (`findVisibleTask`, then one read with project/post titles selected, checklist counts via one `groupBy`, names from `brandOwners(scope, { key: "tasks.read", includeClients: true })`, `actions` from `allowedActions` with `soleStaff` resolved only when the actor is the owner).
- `patchTask(scope, v, id, body)`: `lockRow(tx, "task", id)`; `pickPatch`; `checkTaskLinks`; `reviewerId` refused while IN_REVIEW unless the current reviewer no longer passes `canBeAssigned`; areas/project/clientVisible-relevant changes re-check the current owner and reviewer; `url` change clears `checkedLive*`; TASK_ASSIGNED on owner change; audit `task.update` with changed field names.
- `toTaskDtos(scope, rows): Promise<TaskDto[]>` shared with Task 6.

- [ ] **Step 1: Failing tests:** `same requestId returns the same task`; `foreign workProjectId → 400` on create and on PATCH; `foreign contentItemId → 400` on PATCH; `PATCH ignores status`; `reader cannot PATCH (403)`; `reviewerId PATCH refused in review`; `reviewerId PATCH allowed when the reviewer lost access`; `url change clears checked live`; `create with another owner notifies them`; `gone owner flagged`; `post owner picker unchanged` (existing `brandOwners` callers get the same rows); audit event `task.create` / `task.update` written.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit "Add task create, read and edit with one link check, audit helper and notification writer".

### Task 6: Task list and Today

**Files:** Create `server/tasks/list.ts`; modify `.../tasks/route.ts` (GET). Test `tests/tasks-list.test.ts`, `tests/db/tasks-list.db.test.ts`.

**Interfaces:**
- `encodeCursor(view, key)` / `decodeCursor(view, s)`: base64url JSON; open views key `{ due: "YYYY-MM-DD"|"infinity", id }`, Done key `{ completedAt, id }`; a cursor from another view is a 400.
- `listSql(v, q): Prisma.Sql`: `visibleTaskSql` + view filter (open statuses as the `Prisma.raw` constant), area `= ANY(areas)`, workProjectId, ownerId; order `COALESCE("dueOn",'infinity'), id` with row comparison `(COALESCE("dueOn",'infinity'), id) > (${due}::date, ${id})`; Done view `status='DONE' AND completedAt > now-30d ORDER BY completedAt DESC, id`; `LIMIT 51`.
- `listTasks(scope, v, q): Promise<{ tasks: TaskDto[]; posts?: PostRow[]; nextCursor: string|null }>`: id page and `brandOwners` in `Promise.all`, then `toTaskDtos`; `posts` only for `view=mine` without cursor: SQL-filtered (owner = me, open statuses, at most 20) then `isOverdue`/`isBlocked` from shared.
- `todayTasks(scope, v): Promise<TodayDto>`: one raw query `count(*) FILTER (WHERE …)` for mine (owner = me, `dueOn <= brand-local today`), approvals (IN_REVIEW, reviewer = me), blockers (blocked, owner = me or blockedOn = me); one query for up to 15 rows; one `toTaskDtos`.

- [ ] **Step 1: Failing tests:** unit: `cursor round-trips`; `cursor from another view → 400`; `listSql uses the open-status literal`; `view=mine posts on page 1 only`. db: `keyset pages don't repeat or skip` (55 tasks, 12 without dueOn); `done view sorts by completedAt`; `today counts overdue in the brand time zone` (Europe/Paris brand, dueOn = Paris yesterday, now 23:30 UTC); `brand without profile uses DEFAULT_TIME_ZONE`; `client list is never short` (60 tasks, 10 visible → one page of 10).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit "List tasks by view with keyset pages, and count Today's tasks in one query".

### Task 7: Task actions

**Files:** Create `server/tasks/actions.ts`; modify `.../tasks/[taskId]/route.ts` (POST). Test `tests/task-actions.test.ts`, `tests/db/task-reopen.db.test.ts`.

**Interfaces:** `runTaskAction(scope, v, id, body: { action; reviewerId?; note?; reason?; blockedOnId? }): Promise<TaskDto>`: `findVisibleTask` → `lockRow` → `applyAction` with `soleStaff` from `isSoleStaff` (only for submitForReview) → `checkTaskLinks` for reviewerId/blockedOnId → approve/requestChanges also require the reviewer still passes `canBeAssigned` → write patch, APPROVED / CHANGES_REQUESTED comment (`note`/`reason`), audit `task.<action>`, `notifyTx` (REVIEW_REQUESTED on submitForReview). `reopen` catches unique violation (P2002 / 23505) → `TaskError(…, 409)`.

- [ ] **Step 1: Failing tests:** unit: `submitForReview notifies the reviewer once`; `resubmit after changes notifies again`; `actor gets no notification`; `approve writes APPROVED comment and DONE`; `reviewer who lost access cannot approve`; `blockedOnId must be assignable`; `submitForReview refuses a reviewer who can't be assigned`; audit per action. db: `reopen while another open task holds the finding → 409`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit "Move tasks through review with actions, and tell the people they affect".

### Task 8: Checklist and comments

**Files:** Create `server/tasks/checklist.ts`, `server/tasks/comments.ts`, routes `.../tasks/[taskId]/checklist/route.ts`, `.../checklist/[itemId]/route.ts`, `.../tasks/[taskId]/comments/route.ts`. Test `tests/task-checklist-comments.test.ts`.

**Interfaces:** every route starts with `findVisibleTask`; child ids are read with `{ id: itemId, taskId }` (404 otherwise). Checklist add/patch (text ≤ 300, done, position)/delete by owner or manage, under `lockRow(tx, "task", taskId)`. Comments `GET` with `commentVisibility(v)`; `POST { body 1–4,000, shareWithClient? }`: staff `internal = !shareWithClient`, client `internal = false`, `byClient = v.client`; append-only. Audit for each write.

- [ ] **Step 1: Failing tests:** `another task's checklist item → 404`; `client GET of a hidden task's comments → 404`; `staff comment is internal unless shared`; `comment on a private task stays hidden after the project is shared`; `client comment is never internal`; audit events.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit "Add checklists and comments to tasks, keeping staff comments from clients unless shared".

### Task 9: Attachments and the upload purge

**Files:** Create `server/tasks/attachments.ts`, routes `.../tasks/[taskId]/attachments/route.ts`, `.../attachments/[attachmentId]/route.ts`; modify `server/stories/uploads.ts` (`purgeStaleUploads` VERIFIED `where` adds `taskAttachments: { none: {} }`; the per-row delete catches P2003 and skips). Test `tests/task-attachments.test.ts`, extend the existing purge test.

**Interfaces:** add `{ mediaUploadId, role }` by the owner holding `content.create`, or manage; upload re-read inside the transaction: same workspace/brand, `status = "VERIFIED"`, `kind = "photo"`, `productId = null`; delete removes the row only. Web uploads come from `libraryApi.upload` (`web/components/library/`), which yields such uploads.

- [ ] **Step 1: Failing tests:** `attach refuses a product photo`; `attach refuses another brand's upload`; `owner without content.create gets 403`; `another task's attachment → 404`; `deleting an attachment keeps the upload`; `purge skips uploads a task uses`; `purge survives a row attached mid-run` (delete throws P2003 → skipped).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit "Attach before and after screenshots to tasks and keep them past the upload purge".

### Task 10: Work projects and milestones

**Files:** Create `server/tasks/projects.ts`, routes `.../work-projects/route.ts`, `.../work-projects/[projectId]/route.ts`, `.../[projectId]/milestones/route.ts`, `.../milestones/[milestoneId]/route.ts`. Test `tests/work-projects.test.ts`.

**Interfaces:** `WorkProjectInput` (name 1–120, description ≤ 4,000, ownerId? via `canBeAssigned`-style `tasks.read` check, startsOn?, dueOn?, campaignId? scoped, clientVisible?, status?, requestId?). List `?status=&cursor=` 30/page; progress `{ done, total }` from one `groupBy(['workProjectId','status'])` over the page. Client viewers: list and detail only `clientVisible` projects (detail 404 otherwise); detail task counts and lists go through `visibleTaskSql`. Detail: milestones, task counts by status, linked campaign's posts via the existing calendar-window content query. Turning `clientVisible` off → 409 "A client reviews tasks in this project" while a client reviews an open task in it. Milestones scoped `{ id, workProjectId }` under a project read with `{ id, workspaceId, brandId }`. Archive = `status: ARCHIVED`. Audit each write.

- [ ] **Step 1: Failing tests:** `campaign of another brand → 400`; `same campaign twice in a brand → 409`; `foreign project owner → 400`; `progress ignores cancelled`; `client lists only shared projects`; `client GET of an unshared project → 404`; `cannot hide a project a client is reviewing in`; `another project's milestone → 404`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit "Add work projects with milestones and progress, optionally tied to a campaign".

### Task 11: SEO findings to tasks, and closing them from the next audit

**Files:** Create `server/seo/finding-tasks.ts`, route `.../audit-reports/[reportId]/findings/[findingId]/task/route.ts`; modify `server/services/audit-reports.ts` (`saveAuditReport` enqueues `FINDING_CLEAR_JOB` only when `kind === "SEO"`), `server/jobs/runner.ts` (register). Test `tests/finding-tasks.test.ts`, `tests/db/finding-tasks.db.test.ts`.

**Interfaces:** `isStableFindingId(kind, id): boolean` (false for `/^content-\d+$/`). `taskFromFinding(scope, v, reportId, findingId): Promise<{ task: TaskDto; existed: boolean }>`: report read with `{ id, workspaceId, brandId }` (404); existing open task for `(kind, findingId)` returned; else create (areas `[SEO]` + `WEBSITE` when `urls?.length`; title; description = detail + fix + pages; `findingUrls = urls ?? []`; `url` when one page) and on unique violation return the winner. `FINDING_CLEAR_JOB = "tasks.clear-findings"`, payload `{ workspaceId, brandId, reportId }`; `clearFindings(payload)`: candidates = open tasks of that kind with stable ids absent from the report whose `findingUrls` are empty or ⊆ `metrics.pagesChecked`; one transaction: `UPDATE "Task" SET status='DONE', "completedAt"=now, "findingClearedAt"=now, "blockedReason"=NULL, "blockedOnId"=NULL WHERE id = ANY(${ids}) AND status IN ('TODO','IN_PROGRESS') RETURNING id`; comments, audit `task.cleared-by-audit` only for returned ids; IN_REVIEW candidates get a SYSTEM comment only.

- [ ] **Step 1: Failing tests:** unit: `second click opens the existing task`; `another brand's report → 404`; `keeps tasks whose pages were not re-read`; `closes when the finding is gone and pages were re-read`; `never closes a task in review`; `positional ids never clear`; `GEO reports enqueue nothing`. db: `concurrent make-task returns one`; `task moved to review mid-job is not closed` (status changed between select and update).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit "Make a task from an SEO finding, and close it when a later audit re-reads its pages and no longer finds it".

### Task 12: Daily task notifications and the notification API

**Files:** Create `server/notifications/daily-tasks.ts`, `server/notifications/list.ts`, routes `app/api/v1/me/notifications/route.ts`, `.../count/route.ts`, `.../read/route.ts`; modify `server/jobs/runner.ts` (`dailySweep` runs the three task steps **last**, each in its own try/catch that logs, so a failure never blocks billing renewals). Test `tests/task-notifications.test.ts`, `tests/db/task-notifications.db.test.ts`.

**Interfaces:** `notifyOverdueTasks(now)`, `notifyRechecks(now)`: one tagged `$executeRaw` each, `INSERT … SELECT … FROM "Task" t LEFT JOIN "BrandProfile" bp ON … WHERE t.status IN (<literal open>) AND t."dueOn" < (${now} AT TIME ZONE COALESCE(bp."timeZone", ${DEFAULT_TIME_ZONE}))::date AND t."ownerId" IS NOT NULL ON CONFLICT ("dedupeKey") DO NOTHING`, key `TASK_OVERDUE:<owner>:<task>:<local date>`; rechecks `status='DONE' AND "recheckOn" = local date`. `pruneNotifications(now)` (> 90 days). `listNotifications(userId, workspaceId, cursor?)` (20) and `countUnread(userId, workspaceId)` (capped at 100) share `notificationWhereSql(userId, workspaceId)` = `n."userId" = … AND n."workspaceId" = …` + join Task through `visibleTasksAcrossSql`. `markRead(userId, workspaceId, ids | "all")` updates only `{ userId, workspaceId }` rows. Routes use `requireWorkspaceMember`. Comment in `daily-tasks.ts`: `ponytail: runs at 05:00 UTC; brands west of UTC hear a day late. Hourly sweep firing per brand-local day if that matters.`

- [ ] **Step 1: Failing tests:** unit: `markRead with another user's ids changes nothing`; `non-member workspace → 403`; `count caps at 100`; `sweep failure doesn't stop renewals`. db: `overdue uses the brand's local date`; `sweep twice adds nothing`; `recheck only for DONE`; `client sees no notifications for hidden tasks`; `count and list agree after losing access`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit "Notify owners of overdue tasks and due re-checks each day, and serve the notification list and count".

### Task 13: Search

**Files:** Create `server/tasks/search.ts`, route `.../search/route.ts`. Test `tests/task-search.test.ts`, `tests/db/task-search.db.test.ts`.

**Interfaces:** `searchBrand(scope, v, q): Promise<SearchResultDto>` (5 per kind: tasks, projects, posts, products, campaigns); `q` trimmed 2–100, `%`/`_`/`\` escaped as in the chat product search; five tagged `$queryRaw` in `Promise.all`, `ILIKE` + `ORDER BY similarity(...) DESC`; tasks via `visibleTaskSql`, projects via the client rule, other kinds by their list-route permission (clients: posts only, as today). `hitRateLimit("search:<userId>", 30, 60s)` (`server/auth/rate-limit.ts`). Comment: `ponytail: title trigram indexes aren't brand-scoped; add btree_gin (brandId, title gin_trgm_ops) if search slows on large catalogues.`

- [ ] **Step 1: Failing tests:** unit: `search escapes wildcards`; `rate-limited after 30`; `under 2 chars → empty`. db: `search hides internal tasks from clients`; `search never returns another brand's rows`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit "Search a business's tasks, projects, posts, products and campaigns".

### Task 14: Notes to tasks and batch create

**Files:** Create `server/tasks/from-note.ts`, routes `.../tasks/from-note/route.ts`, `.../tasks/batch/route.ts`; modify `server/ai/models.ts` (`"tasks.from-note"` in `TIERS.light`). Test `tests/tasks-from-note.test.ts`, `tests/db/tasks-batch.db.test.ts`.

**Interfaces:** `proposeTasks(scope, v, text)`: text ≤ 8,000 (400 otherwise); `hitRateLimit` 10/h per user and 100/day per workspace; `generateObject` (`server/ai/provider.ts`) workflow `"tasks.from-note"`, schema `{ proposals: { title; description?; areas; owner?: string; dueOn?; priority }[] }` ≤ 20; note and member names as labelled data; owner names matched to `brandOwners(scope, { key: "tasks.read" })` ids, unknown dropped; audit `task.from-note` with counts only. `createTaskBatch(scope, v, { requestId, tasks })` (≤ 20): first returns existing rows whose `requestId` starts with `<requestId>:`; else `TaskInput` + `checkTaskLinks` per row, then `createManyAndReturn` with `requestId: "<requestId>:<i>"`, audit and TASK_ASSIGNED per row, one transaction; a P2002 race returns the existing rows.

- [ ] **Step 1: Failing tests:** unit: `note text sent as labelled data`; `unknown owner names dropped`; `11th call in an hour → 429`; `workspace daily cap → 429`; `over 8,000 chars → 400`; `reader gets 403 on from-note and batch`; `batch refuses a foreign project for any row` (nothing created). db: `batch retry creates nothing new and returns the same ids`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit "Turn a pasted note into proposed tasks, and create the confirmed ones in one batch".

### Task 15: Web: flag, nav, /tasks list and board

**Files:** Modify `web/lib/features.ts` (`"tasks"`), `web/lib/nav.ts` (Beat slot → "Projects & tasks" `/tasks`; new "Website" `/tasks?area=website` and "SEO" `/tasks?area=seo`; `feature: "tasks"`, `perm: ["tasks.read"]`), `web/components/workspace/use-job.ts` (`JOB_INTERVALS.tasks`). Create `web/app/(shell)/tasks/page.tsx`, `web/components/tasks/task-list.tsx`, `task-board.tsx`, `task-views.ts`, `web/lib/tasks-api.ts` (typed by `shared/api/tasks.ts`). Test `web/tests/task-views.test.ts`, extend `web/tests/features.test.ts`.

**Interfaces:** `TaskList({ view, area, workProjectId? })`, `TaskBoard({ area })`; `boardMove(task: TaskDto, toStatus): { action: TaskAction } | { refused: string }` reads `task.actions` only (onto In Review → `submitForReview` with a reviewer picker; not in `actions` → refused with the reason). View/layout in `localStorage` `tasks.view.v1` (try/catch). "Post" rows from `posts[]`; owner "No longer on this business" when `gone`.

- [ ] **Step 1: Failing tests:** `board refuses a move not in actions`; `board asks for a reviewer on In Review`; `features list includes tasks`.
- [ ] **Step 2–4:** FAIL → implement → PASS; `npm run typecheck`, `npm run lint` (no build).
- [ ] **Step 5:** Commit "Add the Projects and tasks page with list and board views behind the tasks flag".

### Task 16: Web: task peek and actions

**Files:** Modify `web/lib/workspace-view.ts` (`"task"` in `ITEM_PARAMS`, a `View` variant, a `parseViewParts` branch, id `^[A-Za-z0-9_-]{1,64}$`), `web/lib/recent.ts` (`RecentEntry` kind `task`), `web/components/workspace/peek.tsx`. Create `web/components/tasks/task-view.tsx`, `task-actions.tsx`. Test extend `web/tests/workspace-view.test.ts`, `web/tests/task-actions-ui.test.ts`.

**Interfaces:** `?task=<id>` opens the peek on `/tasks`, `/projects/*` and the Overview; header fields editable for managers (PATCH changed fields only, unsaved guard like the post editor); action buttons from `task.actions`; refusals shown as visible text; actions fire `tasks:changed`.

- [ ] **Step 1: Failing tests:** `task param parses and survives Recent`; `bad task id is a bad link`; `approve button only when actions include approve`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit "Open a task in the side peek with its fields and actions".

### Task 17: Web: checklist, screenshots, comments, website fields in the peek

**Files:** Create `web/components/tasks/task-checklist.tsx`, `task-attachments.tsx` (uses `libraryApi.upload`), `task-comments.tsx`, `website-fields.tsx`; modify `task-view.tsx` to mount them. Test `web/tests/task-comments-ui.test.ts`.

**Interfaces:** website fields when areas include WEBSITE (URL, kind, criteria, preview link, Before/After slots, "Checked on live site"); comments list with a "Share with client" toggle for staff when the task is client-visible; checklist add/tick/reorder.

- [ ] **Step 1: Failing test:** `share toggle shown only to staff on a client-visible task`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit "Show a task's checklist, screenshots, comments and website fields in the peek".

### Task 18: Web: projects pages

**Files:** Create `web/app/(shell)/projects/page.tsx`, `web/app/(shell)/projects/[projectId]/page.tsx`, `web/components/tasks/project-header.tsx`, `milestones.tsx`. Test `web/tests/project-progress.test.ts`.

**Interfaces:** list with progress bars; page: owner, dates, status, campaign link, "Visible to client" switch for managers (409 reason shown), milestones (add, tick, reorder), `TaskList` with `workProjectId`, the campaign's posts opening the post peek.

- [ ] **Step 1: Failing test:** `progress label "3 of 8 done" and 0 of 0 reads "No tasks yet"`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit "Add the Projects list and project pages with milestones, tasks and the linked campaign's posts".

### Task 19: Web: Today task groups and the bell

**Files:** Modify `web/app/(shell)/layout.tsx` (pass `features` and `perms` to `TopBar`), `web/components/shell/top-bar.tsx` (mount `<NotificationBell/>` only with the flag), `web/components/workspace/content-panels.tsx` (import and mount `<TodayTasks/>` only; no logic there). Create `web/components/tasks/today-tasks.tsx`, `web/components/shell/notification-bell.tsx`. Test `web/tests/notification-bell.test.ts`.

**Interfaces:** both poll with `JOB_INTERVALS.tasks`, refetch on focus and on `tasks:changed`; poll state stays inside each component; bell shows "99+" at 100; clicking a notification opens the task (brand switch through the existing unsaved-work guard).

- [ ] **Step 1: Failing test:** `badge reads 99+ at the cap and hides at 0`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit "Add task groups to Today and a notification bell to the top bar".

### Task 20: Web: search, quick create, notes dialog

**Files:** Modify `web/components/shell/top-bar.tsx` (mount search and "+"). Create `web/components/shell/search-box.tsx`, `quick-create.tsx`, `web/components/tasks/new-task-dialog.tsx`, `note-to-tasks-dialog.tsx`. Test `web/tests/search-results.test.ts`, `web/tests/note-proposals.test.ts`.

**Interfaces:** search Ctrl/Cmd+K, 250 ms debounce, grouped results, Enter opens the first; "+" items by permission (Task, Post from a brief = `new-post-dialog.tsx`, Project, Tasks from a note); notes dialog: textarea ≤ 8,000, editable proposals, untick, Create → batch with one requestId per dialog.

- [ ] **Step 1: Failing tests:** `results grouped in kind order and empty kinds hidden`; `unticked proposals not sent`; `same requestId reused on retry`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit "Add search and quick create to the top bar, and tasks from a note".

### Task 21: Web: "Make a task" on audit findings

**Files:** Modify `web/components/performance/audit-board.tsx` (button per finding, flag on and `tasks.manage`). Test `web/tests/audit-finding-task.test.ts`.

**Interfaces:** "Make a task" → POST; response `existed` → label "Open task"; opens `?task=<id>`.

- [ ] **Step 1: Failing test:** `label switches to Open task when the finding has an open task`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit "Let an SEO finding become a task, or open the one it already has".

### Task 22: LinkedIn and X by hand (after the Task 1 phone release)

**Files:** Modify `prisma/schema.prisma` (`ContentChannel` + `LINKEDIN_POST`, `X_POST`; migration `phase1_channels`), `server/services/manual-post.ts:16` (link patterns: linkedin.com `/posts/` and `/feed/update/`; x.com and twitter.com `/<user>/status/<id>`), `server/services/publishing.ts:45-64` (`IMAGES`, `CHANNEL_PROVIDER` = null, `TEXT_LIMIT`), `server/content/calendar.ts:8` (`WEEKDAYS_BY_CHANNEL`), creator image limit (`creator.ts:225`), `shared/content-limits.ts` (LinkedIn 3,000, X 280), web channel labels and filters, CSV channel names. Test extend `tests/manual-post.test.ts`, `tests/content-limits.test.ts`.

- [ ] **Step 1: Failing tests:** `accepts a LinkedIn post link`; `accepts an x.com status link`; `refuses a LinkedIn profile link`; `X caption over 280 flagged`; `publishing LinkedIn is refused`.
- [ ] **Step 2–4:** FAIL → implement → PASS; typecheck server, web; `npm run sync:shared`; mobile `npx tsc --noEmit`.
- [ ] **Step 5:** Commit in each repo "Plan LinkedIn and X posts and record them as posted by hand".

### Task 23: Handover

**Files:** Modify `docs/HANDOVER.md` ("Phase 1: tasks" section: what shipped, flag, migrations, deploy order, ceilings, whether `test:db` ran and against what, what still needs a browser).

- [ ] **Step 1:** Write the section. **Step 2:** Commit "Handover for Phase 1: tasks, projects, notifications, search".

---

## Changes from the plan's four-lens review (2026-11-23)

Correctness: DB-backed suite for SQL/index rules; one SQL visibility source with a multi-brand form; sole staff = no other `tasks.read` staff; one time-zone fallback + LEFT JOIN; clearing re-checks status in the UPDATE and resets blocked fields; clearing only for SEO; batch retry via prefix lookup + `createManyAndReturn`; `notifyTx` moved to Task 5 and create notifies; server-computed `actions`; Task 22 file locations; Task 16 View/Recent pieces; purge P2003; sweep steps last and isolated. Security: staff comments internal unless shared; reviewer freeze and re-check on approve; route permission table + 403 tests; child-row and project-detail scoping; notification scoping and `markRead`; no unsafe raw SQL + lint; project owner and PATCH link tests; report scoping; cap tests; audit assertions. Performance: COALESCE keyset index and row comparison; per-view sort; literal open-status predicate; names from `brandOwners`, grouped checklist counts, `Promise.all`; Today in one count query; posts capped in SQL; capped count; top-bar props from the layout; search ceiling documented. Maintainability: `checkTaskLinks`, `brandOwners` option, `lockRow`, plain `TaskRow`, DTOs in `shared/api/tasks.ts`, `generateObject` + light tier, `TaskError`, `taskAudit`, `libraryApi.upload`, `JOB_INTERVALS.tasks`, `content-panels` mount only; Tasks 5, 7, 11, 13, 15 split (now 23 tasks).
