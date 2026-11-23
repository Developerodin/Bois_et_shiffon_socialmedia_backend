# Performance: SEO and GEO findings become tasks on their own

Date: 2026-11-23. Repos: server, web, mobile (shared sync only). Branch `performance-findings` in each, from main.

## Why
The owner wants the "SEO" list renamed **Performance**, and every SEO and GEO run to put what it finds (issues and
improvements, each with its fix) into that list, tagged SEO or GEO. Today a finding becomes a task only when someone
clicks "Make a task" on the reports page, GEO findings are filed as SEO, only SEO runs close fixed tasks, and the agents
run only when a business is created or someone presses Run.

## Decisions (owner)
- Rename "SEO" to "Performance" in the sidebar and on the tasks area tab.
- Each finished SEO or GEO report creates one task per finding, tagged SEO or GEO.
- SEO and GEO run on their own weekly (owner did not object to the proposal; one line to turn off).

## My calls (owner may override)
- Internal area value stays `SEO` (enum `TaskArea.SEO`, `?area=seo`); only labels change. No enum migration.
- The existing reports page `/performance` ("More" group) is relabelled **SEO & GEO reports** so the menu doesn't show
  "Performance" twice. Its path stays `/performance`.
- The tag comes from the task's existing `findingKind` (SEO | GEO). Tasks made by hand have no tag.
- A finding with an open task gets no second task. A finding whose latest task was **cancelled** by a person is not
  recreated (they decided not to fix it). A finding whose task was marked **done** but which the audit still reports gets
  a new task (it isn't fixed).
- Auto-created tasks: status To do, no owner, no reviewer, no due day; `createdById` = the user who started the run
  (null for scheduled runs). No notifications (nobody is assigned).
- Weekly = the daily sweep starts SEO/GEO for a brand when that agent has had **no run of any trigger** in the last
  7 days (so a manual run pushes the next scheduled one back; a missed sweep catches up next day).

## Tasks

### Task 1 (server): GEO AI-review finding ids from the title, not the position
`server/agents/definitions/geo.ts` gives AI content findings `content-1`, `content-2`… Change to
`content-<slug(title)>` (lower-case ascii, accents stripped, non-alphanumerics to `-`, max 60 chars), suffix `-2`, `-3`
on a collision within one report.
In `server/seo/finding-tasks.ts`:
- Clearing: every `content-` id stays **not** clearable by a later audit (AI rewording a title would close a task whose
  issue is still there). Rename/split `isStableFindingId` so the rule reads: legacy positional (`/^content-\d+$/`) = match
  only within the same report (as today); `content-<slug>` = match across reports for de-duplication; any `content-` id
  = never auto-cleared.
- `taskFromFinding` keeps working for both id shapes.
- Unit tests for the slug (accents, collision suffix, length cap, empty title → `content-untitled`) and the id rules.

### Task 2 (server): findings to tasks after every report
- New job `tasks.from-report` (`FINDING_TASKS_JOB`) in `server/seo/finding-tasks.ts`, registered in
  `server/jobs/runner.ts`. `saveAuditReport` (`server/services/audit-reports.ts`) enqueues it for **SEO and GEO** in the
  same transaction as the report, idempotency key `finding-tasks:<reportId>`.
- The clear job (`tasks.clear-findings`) is also enqueued for GEO reports now (it already ignores `content-` ids).
  GEO reports have no `metrics.pagesChecked`: site-wide GEO findings (no urls) clear normally; GEO findings with urls
  must still be able to clear, so the GEO agent stores `pagesChecked: facts.pages.map(p => p.url)` in its metrics.
- Job body: load the report (scoped by workspaceId, brandId); for each finding, in report order, cap 50 per report:
  skip if an open task exists for (brandId, kind, findingId) (for legacy positional ids: same report only);
  skip if the newest task for (brandId, kind, findingId) is CANCELLED; else create the task with the same fields
  "Make a task" uses (reuse `taskData`; no parallel copy), `auditReportId`, `findingKind`, `findingId`, `createdById`
  from the report's agent run's `userId` (null if none), and a `task.create` audit event with
  `metadata: { auditReportId, findingId, source: "audit" }`. A unique violation on `task_open_finding` (someone clicked
  "Make a task" meanwhile) is skipped, not an error. Each task in its own small transaction so one bad finding doesn't
  roll back the rest; the job is safe to run twice (idempotent by the open-task check + index).
- Tests (test:db): creates one task per finding; second run creates nothing; cancelled finding not recreated; done-but-
  still-reported finding recreated; GEO report tasks get `findingKind: GEO`; concurrent "Make a task" doesn't fail the job.

### Task 3 (server): weekly SEO and GEO
- `AgentDefinition.schedule` becomes `"daily" | "weekly"` (`server/agents/types.ts`); `seoAgent` and `geoAgent` get
  `schedule: "weekly"`.
- `startDailyAgents` in `server/jobs/runner.ts`: daily agents unchanged; a weekly agent starts for an ACTIVE brand that
  has a `websiteUrl` when `agentRun.count({ brandId, agentKey, createdAt >= now - 7 days })` is 0 (any trigger).
  Brands without a website are skipped (the agents would throw).
- Ceiling comment: one GEO run is ~8 AI calls (5 with web search), free to the user on schedule; at N brands that's
  ~8N calls a week. Upgrade path: stagger by brand id or make the cadence a brand setting.
- Test: weekly agent skipped when a run exists in the last 7 days, started otherwise; no website → skipped.

### Task 4 (server + shared): tag and filter
- `TaskDto` gains `findingKind: "SEO" | "GEO" | null` (`shared/` in server; the same change in `web/shared` and the
  phone's synced shared types; the two server/web copies must match).
- Task list API (`server/tasks/list.ts` and its route) accepts optional `source=seo|geo`, filtering on `findingKind`.
  Invalid value → 400. Works with keyset paging and every view.
- Test: filter returns only that kind; combined with `area=seo`.

### Task 5 (web): labels, tag, filter
- `web/lib/nav.ts`: entry id `seo` label "SEO" → "Performance" (href unchanged). Entry `performance` ("More", href
  `/performance`) label → "SEO & GEO reports"; its page `metadata.title` follows via `navFor`. Check the sidebar active
  logic (`components/shell/sidebar.tsx`) and the assistant panel still resolve.
- `web/components/tasks/task-views.ts`: area tab `seo` label → "Performance"; `AREA_LABEL.SEO` → "Performance".
  Page subtitle "content, the website and SEO" → "content, the website and performance".
- A small "SEO" / "GEO" tag on task rows (list), board cards and the task panel header when `findingKind` is set.
- On the Performance tab only: a filter All / SEO / GEO that sets `source` in the URL and the list query.
- Any other user-visible "SEO" that means the task area (not the SEO agent or report) → "Performance". The SEO agent,
  SEO report and GEO names stay.

### Task 6 (mobile): shared sync
- Sync the shared `TaskDto` change. No phone UI (the phone has no task list).

## Verification
- server: `npm run typecheck`, unit tests, `npm run test:db` (Docker Postgres `sma-testdb` on 55432).
- web: typecheck, lint, unit tests. Don't run `next build` while `next dev` runs (it breaks the dev server).
- Browser: Performance tab shows auto-created tasks with SEO/GEO tags after running both agents on a seeded brand.

## Amendments after the four-lens plan review (these override the tasks above)

Correctness / security
- A1. Auto-created tasks are made by the system: `createdById: null`, audit `actorUserId: null`, metadata
  `{ auditReportId, findingId, source: "audit", agentRunId, triggeredByUserId }` (the run field is `triggeredByUserId`;
  AuditReport has only a bare `agentRunId`, look the run up once with `{ id, workspaceId, brandId }`). Reason: starting a
  run needs only `agents.run`; creating tasks needs `tasks.manage`. Widen `taskAudit` (server/tasks/audit.ts) to
  `userId: string | null` (additive) instead of a parallel insert.
- A2. Every query in the job uses workspaceId/brandId from the report row loaded by `{ id, workspaceId, brandId }`.
- A3. GEO AI findings: keep only `urls` that are among the crawled `facts.pages` URLs (prompt-injected off-site links
  would otherwise land in tasks as clickable links). GEO metrics store `pagesChecked`.
- A4. GEO AI-review tasks must not pile up weekly (titles change between runs). My call, option (b): in the job for a
  GEO report, open `content-*` tasks that were auto-made (createdById null, audit source), still TODO, no owner, no
  reviewer, and whose id is not in the new report are CANCELLED with a SYSTEM comment "Replaced by the <day> GEO
  review". Tasks a person touched (owner, reviewer, not TODO, or made by "Make a task") are never touched. Test: two GEO
  reports with different AI titles leave only the newer set open.
- A5. Job start: return if a newer AuditReport of the same (brandId, kind) exists.
- A6. Skip recreating when the newest task for the finding is DONE with `completedAt` after the report's `createdAt`
  minus the run duration (use the agent run's `createdAt`, else report.createdAt), or has `recheckOn` in the future.
- A7. `not-recommended` counts as not measured (never auto-cleared) unless the report measured visibility: store
  `metrics.visibilityMeasured = aiProviderName() === "openai" && unbranded.length > 0` and extend `notMeasured`.
- A8. Slug never all-digit (fall back to `content-untitled`); test it.
- A9. The job has no legacy positional branch. Id rules are two named predicates: `isPositionalFindingId`
  (`/^content-\d+$/`, used by taskFromFinding) and `isAutoClearable` (not any `content-` id, used by clearFindings).
  Update tests/finding-tasks.test.ts; add: a slug `content-` id is never cleared by clearFindings for GEO.

Weekly schedule
- A10. Weekly due when no run of any trigger since `startOfUTCDay - 6 days` (avoid 8-day slip) AND
  `hash(brandId) % 7 === UTC weekday` (stagger: the serial job queue would otherwise take every brand's SEO+GEO on one
  day), with next-day catch-up: if no run in the last 8 days, due regardless of weekday. One `brand.findMany` with
  `profile: { websiteUrl: { not: null } }` for weekly agents (daily agents keep all ACTIVE brands), one
  `agentRun.groupBy` instead of a count per brand. Export as `startScheduledAgents`; update the `schedule` doc comment;
  test:db test calls it. Ceiling comment names the queue backlog and each run's cost (SEO: crawl + PageSpeed + 1 AI
  call; GEO: crawl + ~8 AI calls, 5 with web search).

Performance / maintainability
- A11. Job loads finding-task history once: `task.findMany({ workspaceId, brandId, findingKind, findingId in ids })`
  ordered by createdAt desc, decides in memory. New migration adds
  `@@index([brandId, findingKind, findingId, createdAt])` on Task.
- A12. One helper `createFindingTask(tx, scope with userId: string | null, report, finding, metadata)` and one
  `openFindingTask(...)` used by both `taskFromFinding` and the job. No second copy of the create path.
- A13. `TaskDto.findingKind` already exists (`string | null`); Task 4 narrows it to `"SEO" | "GEO" | null`. Shared copies
  are generated: run the server's `npm run sync:shared`; never hand-edit web/shared or the phone copy. Task 6 = commit
  the synced files.
- A14. `source` filter like `area`: zod `.transform(toUpperCase).pipe(z.enum(["SEO","GEO"])).optional()` in ListQuery,
  parameterised `Prisma.sql` after `visibleTaskSql(v)`. Test: source + cursor (next page keeps the filter).
- A15. Web: Surge's `role` "Performance" (nav.ts:56) also becomes "SEO & GEO reports". Derive the area tab label from
  `AREA_LABEL`. The 60 s first-page poll in task-list.tsx must send `source`. Reuse the existing slugify from
  create-brand.ts by moving it to a shared util with `max` and `fallback` (leave workspace-admin's copy).
