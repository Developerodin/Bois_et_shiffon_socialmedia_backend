# Phase 0 Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Important findings and useful minors from the second four-lens review of merged Phase 0, apply the owner's client send-back rule, and add an "agent finished" toast on the web that opens the agent and shows what its run did.

**Architecture:** The route check returns the permissions and client-reviewer flag it already reads; services take them instead of re-reading. One display-name rule on the server. Personal data inside stored story bodies is hidden on every read (stored bodies are never rewritten: their hash backs approvals). A cheap agents list feeds one shell-level watcher and a small toast stack; the agent view reuses the agent-log row to show one run.

**Tech Stack:** Next.js route handlers, Prisma 6 on Neon Postgres, vitest; web Next.js + React; mobile Expo.

**Spec:** second four-lens review of merged Phase 0 (ledger `server/.superpowers/sdd/2026-11-20-phase-0-quick-wins/progress.md`, "Main lens 2" lines), the plan's own four-lens review (2026-11-20, folded in), and the owner's answers: (1) a client reviewer may send back a post that is approved and not scheduled when that approval is their own; (2) when an agent's run is done, show a pop-up toast; clicking it opens the agent and shows what it did.

## Global Constraints

- Repos `apps/server`, `apps/web`, `apps/mobile`, each its own git; branch `phase-0-followup` from `main` in each; merge after the four-lens branch review.
- `shared/` is edited in `server/shared/` only; `npm run sync:shared` copies to web and mobile; commit the copies.
- Deploy order: server (with migrations) → web → mobile; clients tolerate the previous server.
- Every query scoped by `{ workspaceId, brandId }` from the route check.
- **Name rule:** `personName(u, { reveal })` — trimmed name if set; else the email's local part only when `reveal` (caller holds `project.members.manage`); else "A team member". No full email to anyone without `project.members.manage`. Clients only render the name the server sends.
- **Stored version bodies are never rewritten** (`packageHash` covers them; rewriting voids approvals and scheduled posts). Personal fields in bodies are hidden on read and before a body is sent to the AI.
- Agent/AI/crawled text (events, run errors) renders as plain React text: no Markdown, no auto-linking; links only from known `entityType` values mapped to in-app paths.
- No new 6 s pollers. The agent watcher polls at most every 20 s, pauses while hidden, joins the shared per-URL cache.
- Never run `next build` in web while `next dev` runs. If `prisma generate` hits EPERM (dev server holds the engine), report it; don't kill processes; don't use --no-engine.
- Commit messages: the change and why. No co-author lines, no tool or session URLs, no mention of tests.
- Checks: server `npm test`, `npm run typecheck`, `npm run lint`; web `npm test`, `npm run typecheck`, `npm run lint`; mobile `npx tsc --noEmit`.

## Review Focus

1. A client reviewer opens a brand whose story frames were rights-confirmed by a nameless staff member: no email or email part anywhere in the content list, `?id=`, or `latest.check`; approved and scheduled stories stay approved. (Task 2 `story rights never expose an email`.)
2. A post planned for next Thursday, or for last Monday, is posted by hand today: it is dated today in the calendar, CSV and phone. (Task 3 `posting by hand dates the post`.)
3. A client sends back an approved, unscheduled post that staff approved: 409; one they approved themselves: allowed; a staff re-approval racing the send-back is caught inside the transaction. (Task 3 `client send-back of an approved post needs their own approval`.)
4. A client approves a reel: the decision is stored `byClient: true` and never auto-publishes. (Task 1/3 `reel approval by a client is marked as client`.)
5. An agent run finishes while the person is on /products: one toast within ~20 s; clicking opens the Overview on that agent with the run's steps; reloading, or a second tab, doesn't toast it again (best effort); a "nothing to do" run doesn't toast as a failure. (Task 6 `toasts once per finished run`.)

---

### Task 1: The route check returns permissions and the client-reviewer flag

**Files:** `server/server/auth/access.ts` (`brandAccess` also returns `clientReviewer = !!grant && isClientGrant(grant.role) && !found.role?.permissions.includes("content.approve")` — the `isClientReviewer` formula from its existing reads), `server/server/auth/permissions.ts` (export `isClientGrant`), `server/server/api/brand-route.ts` (`authorizeBrandRoute` returns `{ userId, workspaceId, brandId, perms, clientReviewer }`); test `server/tests/brand-route.test.ts`.

- [ ] Step 1: Failing tests: returns the caller's `perms`; `clientReviewer` true for a client grant, false for staff who also hold a client grant, false for staff.
- [ ] Step 2: FAIL. Step 3: Implement. Grep every `{ ...scope` spread from `authorizeBrandRoute` into Prisma `where`/`data`, job payloads and audit metadata; where a receiver doesn't pick fields by name, pass `{ workspaceId, brandId, userId }` explicitly. Step 4: PASS + server checks.
- [ ] Step 5: Commit (server) "Have the route check hand back the permissions and client flag it already read".

### Task 2: One display-name rule, and no emails to clients

**Files:**
- `server/server/content/person-name.ts` (`personName(u, { reveal })` per Global Constraints; comment that clients only render the sent name; `accounts.ts:215` workspace-name split is a different purpose — leave it)
- Callers pass `reveal: scope.perms.has("project.members.manage")`: content list owner names and `?id=` (`content/route.ts`), CSV Owner (`content/export/route.ts`), `who()` in `releaseState` (`publishing.ts` ~1006, keep its "Someone" handling for missing users), `brandOwners(scope, { reveal })` + owners route (nameless people shown as "A team member", "A team member (2)", … so the picker can tell them apart), `members` GET for non-managers
- `brandOwners` excludes grants whose role is the system client-reviewer role
- `server/server/stories/sources.ts:76` stores `rights.name = personName(user, { reveal: false })` (never the email) from now on
- `server/server/stories/checks.ts:44`: the "Asset rights" note uses `personName(..., { reveal: false })`-style text, never an email
- Read-side redaction for callers without `project.members.manage`: in story version bodies strip `frames[].rights.by` and `.name` (shallow copy: `frames.map(({ rights, ...f }) => ({ ...f, rights: rights && { kind: rights.kind } }))`, keep any confirmed flag the UI reads — grep web/mobile for `rights.` first), and replace the "Asset rights" note in `latest.check.results` with the redacted wording — content list, `?id=`, and any other route returning story bodies or checks (grep stories/reels routes)
- Before a story body is sent to the AI (quality agent, `server/agents/definitions/quality.ts` ~111), strip `rights.by`/`rights.name`
- Create `server/scripts/redact-story-checks.ts` + npm script `redact:story-checks`: rewrites stored `QualityCheck.results` "Asset rights" notes that contain an email (QualityCheck rows are not hashed), recomputing from `rights.by` with `personName(user, { reveal: false })`; dry run by default, `--apply` to write, optional `--workspace`, cursor pages of 500, prints counts; `ponytail:` one-off, delete after it has run everywhere. Stored version bodies are NOT touched.
- Tests: `server/tests/person-name.test.ts`, extend `server/tests/client-reviewer.test.ts`, `server/tests/redact-story-checks.test.ts`

- [ ] Step 1: Failing tests: `personName` (trim, reveal, "A team member"); `story rights never expose an email` (list, `?id=`, `latest.check` for a client reviewer: no `@`, no local part; an approved story's `currentApproval` still holds); `owner names follow the rule` (list, CSV, owners, releaseState for a non-manager); `client reviewers are not offered as owners`; `quality never sends rights names to the AI`; script dry-run/apply on mocked prisma.
- [ ] Step 2: FAIL. Step 3: Implement. Step 4: PASS + server checks.
- [ ] Step 5: Commit (server) "Show people's names by one rule and never hand a member's email to someone who can't manage members".

### Task 3: Approvals: client send-back rule, byClient everywhere, hand-post dates, recent history

**Files:** `server/server/services/publishing.ts` (`decide`, `assertDecidable`), `server/server/reels/service.ts:314` (`sendReel` passes `byClient`), `.../content/[contentId]/route.ts` and the reels route (pass `byClient: scope.clientReviewer`), `server/server/services/manual-post.ts`, `.../content/route.ts` (recent half), mobile `src/ui/posts/format.ts`; tests `server/tests/client-reviewer.test.ts`, `server/tests/manual-post-any-channel.test.ts`, `server/tests/content-list-window.test.ts`, `server/tests/reel-service.test.ts`.

- `decide` input gains required `byClient: boolean` (typecheck fails on a missing caller); remove `isClientReviewer` from `decide`; keep `requirePermission(..., "rules.approve")` inside `decide`.
- `assertDecidable(…, { userId, byClient })` runs before and inside the transaction: a client's CHANGES_REQUESTED on an APPROVED, unscheduled post is allowed only if `currentApproval` is `byClient && userId === input.userId`; else 409 "This post was approved by the team. Ask them to reopen it."
- Order in `decide`: brand-scoped load → `assertDecidable` → (byClient only) `hitRateLimit(\`client-send-back:${workspaceId}:${brandId}\`, 20, 86_400_000)` → per-person `send-back:` limit → `beforeWrite` (post-AI). Rate-limit writes never inside a `Promise.all` with reads that can throw. `hasOtherApprover` only on the own-draft path (as now).
- `registerManualPost`: inside the transaction always set `scheduledFor: now` (dated when it went out).
- Content list recent half: order `updatedAt desc` before take/slice; merged list sorted afterwards as now.
- Mobile `upcomingThisWeek`: add `status` to the generic constraint and skip PUBLISHED/REVIEWED; check callers pass it.

- [ ] Step 1: Failing tests: `client send-back of an approved post needs their own approval` (staff approval → 409, own → ok, staff re-approval inside the tx → 409, scheduled → refused); `client send-backs are capped per brand` (21st → 429, staff unaffected, refused send-backs spend no cap or AI); `reel approval by a client is marked as client`; `posting by hand dates the post` (future, past and null → now); `recent history keeps the newest at the ceiling`.
- [ ] Step 2: FAIL. Step 3: Implement. Step 4: PASS + server checks + mobile tsc.
- [ ] Step 5: Commit server "Let clients reopen only what they approved, mark every client approval, and date hand-posted posts when they went out" and mobile "Leave published posts out of the phone's week ahead".

### Task 4: Cheaper reads

**Files:** `.../content/[contentId]/route.ts` (use `scope.perms` instead of `effectivePermissions` at its three call sites), `.../content/route.ts` (owner names via one `user.findMany` over the merged rows' distinct `ownerId`s, `select { id, name, email }`, skipped when empty; no owner include on the two halves), `publishing.ts` `setOwner` validation via `Promise.all([workspaceMember.findFirst(...role has brand.read...), brandMember.findFirst(...role has brand.read, not the system client-reviewer role...)])` + active-user check (keep `brandOwners` for the picker), `server/prisma/schema.prisma` ContentItem `@@index([brandId, updatedAt])` + migration `<ts>_content_updated_index` (if `EXPLAIN` on dev shows the planner ignoring it for the recent half, drop it and say so); tests extend `content-list-window`, `content-owner`.

- [ ] Step 1: Failing tests: `detail and actions don't re-read permissions` (no `effectivePermissions` call); `the list reads owners once`; `setOwner refuses a client reviewer and a no-read grant` (same 400).
- [ ] Step 2: FAIL. Step 3: Implement; migrate. Step 4: PASS + checks.
- [ ] Step 5: Commit (server) "Reuse the permissions the route check read, and make the calendar and post views cheaper".

### Task 5: Web and phone role fixes

**Files:** web `lib/nav.ts:26` (Business context needs `agents.read`), `app/(shell)/context/page.tsx` ("Your role doesn't include…" without `agents.read`, no fetch), Overview brand summary hidden when docs aren't readable, `components/context/context-board.tsx` (a 403 is not an error to retry); remove dead nullable `perms` handling (`content-panels.tsx` NextStep and ContentView, `release-panel.tsx:77` Props type + the `!perms` branch at ~120, and their callers) — `perms` is `readonly string[]`; story package download/save buttons need `content.download` (web `StoryByHand`, phone `ByHand`); phone `src/app/posts/[id].tsx` shows the connected label only with `publish.execute`; test `web/tests/nav.test.ts`.

- [ ] Step 1: Failing nav test. Step 2: FAIL. Step 3: Implement. Step 4: PASS + web checks + mobile tsc.
- [ ] Step 5: Commit web "Keep Business context and story downloads to the roles that can use them" and mobile "Only tell people a channel isn't connected when they can publish, and gate story downloads".

### Task 6: "Agent finished" toast that opens the agent's run

**Files:**
- Server: `.../agents/route.ts` — replace the in-memory `distinct: ["agentKey"]` read with one `$queryRaw` `SELECT DISTINCT ON ("agentKey") … ORDER BY "agentKey", "createdAt" DESC` scoped by workspace and brand (uses `[brandId, agentKey, createdAt]`), same response shape; `.../agent-events/route.ts` — optional `runId` (length ≤ 40, `[A-Za-z0-9_-]`), combined with the `{ workspaceId, brandId }` where, `orderBy id asc, take 200`, no cursor; tests `server/tests/agents-latest.test.ts`, `server/tests/agent-events-run.test.ts`.
- Web pure: `web/lib/agent-runs.ts` — `nothingToDo` moved here from workspace.tsx; `finishedRuns(prev, next, baseline): { key, name, runId, status: "done" | "failed" | "idle", error? }[]` where `baseline` is the newest `finishedAt`/`startedAt` from the first poll (server time, not `Date.now()`); a run seen QUEUED/RUNNING that finishes, or an unseen run finished after the baseline, counts once; test `web/tests/agent-runs.test.ts`.
- Web shared fetch: `components/agents/api.ts` exports `agentsUrl(base)`; the Overview's `fetchAgents` polling, `agents-board.tsx` and the watcher all go through `fetchShared(agentsUrl(base))` so one request serves them; `JOB_INTERVALS.agentWatch = [[Infinity, 20_000]]`.
- Web toast: `web/components/ui/toast.tsx` — stack bottom-right (safe-area aware), `role="status"` + `aria-live="polite"`, each toast a button plus a close control, auto-dismiss 10 s paused on hover/focus, max 3, `prefers-reduced-motion` respected, plain text only; `toast({ title, detail?, href?, tone })`, `<Toaster />`. No new dependency.
- Web watcher: `web/components/shell/agent-watcher.tsx`, mounted in `app/(shell)/layout.tsx` only when `activeWorkspaceId && activeBrandId && brandPermissions.includes("agents.read")`, `key={activeBrandId}`; `useJob` on `agentsUrl` with `agentWatch` intervals (pauses while hidden, catches up on visibility, backs off on errors, stops on 403); toasts "{Agent name} finished" (done) or "{Agent name} needs a look" + the run's `error` through `readable()` (failed); "idle" (nothing to do) doesn't toast; toasted run ids kept in `localStorage` (key per workspace+brand, last 50, try/catch) so a reload or another tab doesn't repeat it — `ponytail:` two tabs polling the same second can still both toast; GET /agents returns only each agent's newest run, so a run followed within 20 s by a new one can be missed.
- Web agent view: `View` agent gains `runId?: string`; `viewFromUrl` parses `runId` (validated), `viewSearch` writes it and its delete list includes `runId`; the toast href is `/?agent=<key>&runId=<id>` built with `encodeURIComponent`, navigation only to paths starting with "/"; `agent` must be a known agent.
- `components/agents/agent-log.tsx` exports its row as `<AgentEventRow>`; `components/agents/api.ts` `fetchEvents` gains optional `runId`; new `components/agents/run-events.tsx` `<RunEvents runId>` — one fetch for a finished run (re-read when the latest run's id/status changes while it runs), rows via `AgentEventRow`, events with `entityType === "ContentItem"` link to `?post=<id>`, plain text only. `AgentView` in workspace.tsx mounts `<RunEvents>` under a "What it did" heading for `runId` or the latest run.
- Test also: `web/tests/workspace-view.test.ts` round-trips `runId` (or the existing view-URL test file).

- [ ] Step 1: Failing tests (server and web as listed; `toasts once per finished run` covers done/failed/idle, repeat, pre-baseline).
- [ ] Step 2: FAIL. Step 3: Implement. Step 4: PASS + web and server checks.
- [ ] Step 5: Commit server "Read each agent's latest run cheaply and let the agent log be read for one run" and web "Say when an agent finishes, and open its run to show what it did".

### Task 7: Docs

**Files:** `server/docs/HANDOVER.md` (Phase 0 header: merged to main 2026-11-20, ranges server 78eaf75..248344a, web 8ed684b..4eb38b9, mobile 5c9ad7b..2700b63; "Next" = post-merge steps; the client_reviewer re-run limited to workspaces missing the role (`WHERE NOT EXISTS`) and noting step 3 re-adds content.download; assign the Client reviewer role only after the new server is live; "decide never auto-publishes" correction checked; new "Phase 0 follow-up" section incl. running `npm run redact:story-checks` per environment and that stored story bodies keep old names but are hidden on read), `server/docs/DATA_MODEL.md` (`ApprovalDecision.byClient`, migration `20261120070845_approval_by_client`, narrowed agents.read rule, the new index), `server/docs/API_CONTRACTS.md` (client send-back rule and cap, name rule and owners endpoint, story rights redaction, hand-post dating, agent-events `runId`, agents list shape), `server/docs/DESIGN_SYSTEM.md` (toast: placement, timing, motion, tone).

- [ ] Step 1: Write them against the code. Step 2: Commit (server) "Bring the handover and data docs in line with merged Phase 0 and its follow-up".

---

## Self-review notes

- Second-review Importants: security I1, I2 → 2; correctness I1 → 5, I2 → 3; performance I1 → 1+4, I2 → 3, I3 → 4; maintainability I1, I2 → 7, I3 → 2, I4 → 5.
- Plan-lens findings folded in: no body rewrite + quality-check notes + AI input redaction (C1 ×2, I1 ×2), perms/clientReviewer first (reorder), byClient required incl. sendReel, client rule inside the tx and check order, per-brand cap, always-now hand-post date, names on owners/members, agents list query, shared fetch, localStorage dedupe, nothing-to-do, brand switch reset, runId URL field, reuse of the agent-log row, plain-text rendering.
- Left out: extracting ContentView into its own file; leader election across tabs (documented ceiling).
