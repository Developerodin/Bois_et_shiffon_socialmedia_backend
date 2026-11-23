# UI/UX Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the confirmed findings of the two 2026-11-20 web UI/UX audits (shell/Overview and pages), under the owner's four rulings.

**Architecture:** Web-only changes in `apps/web` (no server change was needed: see Task C3 and Task B3). Three tracks with disjoint files run in parallel. Fixes reuse existing primitives (`Button`, `toast` with `action`, `Dialog`, `ConfirmDialog`, `ListSkeleton`, `SegmentedRadios`, `useUnsavedGuard`, `EmptyState headingLevel`). Tests are vitest in node: logic tests where there is logic, source-scan tests (as `tests/no-hsl-var.test.ts` and `tests/page-titles.test.ts` do) for copy and class fixes.

**Tech Stack:** Next 15.5, React 19.1, Tailwind 4.3.3 (has the `pointer-coarse:` variant), tailwind-merge 3, Radix, vitest 5 (node env).

**Spec:** `apps/server/.superpowers/sdd/2026-11-20-panel-peek/uiux-audit-shell.md` and `uiux-audit-pages.md`; owner rulings in the task brief (restated in Global Constraints). Design rules `apps/server/docs/DESIGN_SYSTEM.md`, tokens `apps/web/app/globals.css`.

Paths are relative to `apps/web/` unless they start with `server:`. Audit line numbers have drifted (web HEAD is now 7ddbb99, audit read c8f2409); locate by the quoted code, not the number.

## Global Constraints

- Ruling 1, agent names: in-app copy uses the agent's role name as the code names it. Built agents' names come from the server definitions (`server:server/agents/definitions/*.ts` `name:`): Research, SEO, GEO, **Opportunities** (key `scout`), Planner, Creator, Brief writer, Quality check, Analyst, Competitors, Site audit. Never "Scout" in visible copy. Sidebar persona names (Spark, Beat, Wave, Echo, Pulse, Hum, Surge, Drift) stay in the sidebar; inside the Overview they appear only as a small subtitle under the role. The calendar is "Content calendar" everywhere.
- Ruling 2, brand context: the server feeds agents the **latest** version, draft or confirmed (`server:server/content/knowledge.ts:13-14` "Confirming is an optional reviewed mark; it never gates what agents read"; `server:server/agents/definitions/geo.ts:110` `latestContext`). Copy must say that. Do not change server behaviour; it is listed as an open question. Opening a document never marks it Reviewed.
- Ruling 3, reels: Download never approves. Approve and Download are separate buttons.
- Shortest diffs; no new dependencies; reuse primitives and tokens; `text-xs` (12 px) is the floor for visible text.
- Do not run `next build` (dev server is running). Web checks: `npm test`, `npm run typecheck`, `npm run lint` (in `apps/web`).
- Commits: what changed and why. No Co-Authored-By, no tool or session URLs, never mention tests.
- `components/workspace/content-panels.tsx` and `components/workspace/panel-layout.tsx` are being edited by another builder (calendar day popup + resize). Only Task A7 touches them and it **starts after the calendar work lands**.

## Review Focus

1. Touch growth (`pointer-coarse:h-11` on `sm`, `pointer-coarse:size-11` on `icon`) widening rows that were tight: Today rows, peek header, chat composer, panel headers on a phone. Expect wrap, not overflow. Pinned by Task A1's scan + the A2 Today-row wrap scan.
2. Undo toasts acting on a page that is gone (chat Undo after the drawer closes, member-role Undo after leaving Settings). Expect the action to be cleared (`clearActionToasts`) or harmless. Task A5 and B4 tests assert the toast carries `action.label === "Undo"` and the restore callback only touches local state of a mounted component (B4: re-sends the old role, which is idempotent).
3. Reel already approved (APPROVED/SCHEDULED/PUBLISHED) vs awaiting approval: Download must work without a second approval; Approve must not show. Task C3 `reelActions()` table test.
4. Connect returning to the page it started from when sessionStorage is empty (other tab, private mode): expect Settings → Connections as today. Task B3 test of `connectReturnPath(null)`.
5. The Overview route skeleton on non-"/" paths must stay the existing `PageSkeleton`. Task A4 scan asserts both branches.

---

## Track A: shared primitives, shell, Overview (7 tasks, A7 last)

### Task A1: Button touch size, radius scale, dead motion classes, info toast

**Files:**
- Modify: `components/ui/button.tsx` (`size.sm`, `size.icon`)
- Modify: `app/globals.css:82` (`--radius-xl`)
- Modify: `components/ui/dialog.tsx`, `components/ui/dropdown-menu.tsx`, `components/ui/sheet.tsx` (remove `animate-in`, `animate-out`, `fade-*`, `zoom-*`, `slide-in-from-*` classes: no plugin defines them, they are no-ops)
- Modify: `components/ui/toast.tsx` (`ToastTone`)
- Modify: `apps/server/docs/DESIGN_SYSTEM.md` §4 and Toast "Tone"
- Test: `tests/uiux-shell.test.ts` (create), `tests/toast.test.ts`

**Interfaces:**
- Produces: `ToastTone = "success" | "warning" | "info"`; `info` border `border-border`. Used by A5, A7, B4.

- [ ] **Step 1: Write failing tests.** In `tests/uiux-shell.test.ts` (source scan like `no-hsl-var.test.ts`): `button.tsx` contains `pointer-coarse:h-11` and `pointer-coarse:size-11`; `globals.css` does not contain `--radius-xl: calc(var(--radius) + 4px)`; none of `components/ui/{dialog,dropdown-menu,sheet}.tsx` contains `animate-in`. In `tests/toast.test.ts`: `toast({ title: "Closed Ideas", tone: "info" })` then `currentToasts()[0].tone === "info"`.
- [ ] **Step 2:** `npm test -- uiux-shell toast` → FAIL.
- [ ] **Step 3: Implement.** `sm: "h-8 px-3 text-xs pointer-coarse:h-11"`, `icon: "h-9 w-9 pointer-coarse:size-11"`. `--radius-xl: calc(var(--radius) - 4px)` (12 px, below the 16 px `rounded-2xl` cards; fixes inner boxes rounder than their card). Toast: add `"info"` tone mapping to `border-border` in the tone class switch. DESIGN_SYSTEM §4 line 55: add "`rounded-xl` (12 px) for boxes inside cards"; Toast Tone: add "`info` (border `border`) for neutral events such as closing a panel".
- [ ] **Step 4:** `npm test && npm run typecheck && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git commit -m "Grow small buttons to 44 px on touch screens, put inner corners below card corners, drop motion classes nothing defines, add a neutral toast tone"`

### Task A2: Agent names and calendar name (ruling 1)

**Files:**
- Modify: `lib/nav.ts:42,45,46,48`
- Modify: `components/workspace/workspace.tsx` (`PLANNED` :95-100; Today scout task :937; Coming-soon grid :1137-1145; feed PLANNED rows :1640-1650; feed built row :1629-1630; agent tile `title` :1124; Today `<li>` :1064-1076; competitors note :771; `DocPane … autoReview` :1268)
- Modify: `components/shell/sidebar.tsx` (comment :50 about Echo, `cursor-grab` on `li` :175, aside label :228)
- Modify: `app/(shell)/agents/[agent]/page.tsx`
- Test: `tests/nav.test.ts`, `tests/uiux-shell.test.ts`

**Interfaces:**
- Produces: `PLANNED: { key: string; name: string /* role */; persona: string /* sidebar label */; icon: LucideIcon }[]`.

- [ ] **Step 1: Failing tests.** `nav.test.ts`: `NAV.find(e => e.id === "calendar")!.label === "Content calendar"`; `NAV.find(e => e.id === "echo")!.href === "/agents/echo"`; wave/drift/surge `role` are `"Content calendar"`, `"Competitors"`, `"Performance"`. `uiux-shell.test.ts`: `workspace.tsx` has no `"Scout reads"`; has `"Opportunities reads your documents and the season"`; Today `<li` line contains `flex-wrap`; Today label `<p` uses `line-clamp-2` and not `truncate`; `sidebar.tsx` has `aria-label="Sidebar"` and no `"cursor-grab active:cursor-grabbing"` on the `li` (keep `active:cursor-grabbing`); `workspace.tsx` has no `autoReview`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.**
  - nav: echo `href: "/agents/echo"` (drop its comment and the sidebar :50 Echo remark); wave `role: "Content calendar"`, drift `role: "Competitors"`, surge `role: "Performance"`; calendar `label: "Content calendar"`.
  - `PLANNED` maps `name: e.role ?? e.label, persona: e.label`. Coming-soon tile: `name={p.name} status={p.persona}`; feed soon row: `{p.name} agent` then subtitle `{p.persona}`.
  - Today scout detail: `"Opportunities reads your documents and the season"`. Button label stays `"Get ideas"` (A7 aligns the Ideas panel to it).
  - Today row: `<li className="flex flex-wrap items-center gap-3 …">`, `<p className="min-w-[12rem] flex-1 line-clamp-2 text-sm">`, render `{t.action}` before the "Not now" ghost button.
  - Feed built row: name `text-sm font-semibold`, detail `text-xs`; detail gets `text-destructive` when `a.lastRun?.status === "FAILED"`; row button gets `rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`. Feed "Soon" pill `text-[11px]` → `text-xs`.
  - Agent tile: `title={score ? … : agentStatus(a)}`; tile status `text-[11px]` → `text-xs`; count pills :735, :766 → `text-xs`.
  - Competitors note: "Audit them in the" + `<button>` "Competitors panel" calling a new `onOpenCompetitors` prop, wired to `revealPanel("competitors")` where the Context section is rendered.
  - DocPane call: drop `autoReview`.
  - sidebar: aside `aria-label="Sidebar"`; `li` class `cn("active:cursor-grabbing", …)`.
  - Agent coming-soon page: `title={entry.role ?? entry.label}`, description `${entry.label} is not on the web yet, and arrives in a later release.` (keep `blurb` override).
- [ ] **Step 4:** `npm test && npm run typecheck && npm run lint` → PASS.
- [ ] **Step 5: Commit** `"Use one name per agent and per page: role names in the Overview, persona under them, Content calendar everywhere, and let Today rows wrap instead of cutting the label"`

### Task A3: Disabled reasons, approval note, New post form

**Files:** Modify `components/workspace/release-panel.tsx` (:287-289, :306-311, :511-516), `components/workspace/new-post-dialog.tsx` (:84-108). Test: `tests/uiux-shell.test.ts`.

- [ ] **Step 1: Failing tests.** release-panel: contains `id="approve-why"` and `aria-describedby={blocked || refused ? "approve-why"`; no `title="Fix the quality blockers first"`; label no longer contains `"(needed to"`; "When" group uses `SegmentedRadios`. new-post-dialog: contains `"Choose a photo to draft the post."`, `aria-required`, and `${direction.length}/${DIRECTION_MAX}`; the `Cost:` line sits after the error line, inside `DialogFooter`'s preceding row.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** Approve: drop `title`, add `<p id="approve-why" className="text-xs text-muted-foreground">` with "Fix the quality blockers first." / "An issue stops this post." when `blocked || refused`. Override button keeps its title text as a visible helper only if already shown elsewhere; else move it to the same `<p>` pattern (`id="override-why"`). Note label: "Note"; helper `<p id="approval-note-help" className="text-xs text-muted-foreground">` with the existing two sentences, joined into `aria-describedby`. "When": `<SegmentedRadios label="When" name="publish-when" value={later ? "later" : "now"} …>` replacing the hand-made radiogroup (drop the `<legend>`). New post: under the photo row while `!photo` show `<p id="photo-required" className="text-xs text-muted-foreground">Choose a photo to draft the post.</p>`; label "Product photo" + `aria-required` on the Choose button; counter `<span className="text-xs text-muted-foreground">{direction.length}/{DIRECTION_MAX}</span>`; move "Cost: included in your plan" to just above the footer buttons (last line of the body).
- [ ] **Step 4:** checks → PASS.
- [ ] **Step 5: Commit** `"Say why Approve and Draft post are unavailable in visible text, since a disabled button never shows its tooltip"`

### Task A4: Loading, failures and headings in the shell

**Files:** Modify `app/(shell)/loading.tsx`, `app/(shell)/page.tsx:18`, `components/shell/workspace-switcher.tsx`, `components/shell/brand-switcher.tsx:96-101`, `components/workspace/workspace.tsx` (`LearningNotes` :1658-1666, GEO legend :1517-1528, accounts pills :797, Context text buttons :695/:710/:721, Analytics tabs :1472-1485, h1 :1040), `components/workspace/peek.tsx:92,104`, `components/workspace/release-panel.tsx:452`. Test: `tests/uiux-shell.test.ts`.

- [ ] **Step 1: Failing tests.** loading.tsx contains `usePathname` and both `grid-cols-3` and `PageSkeleton`; page.tsx copy is `"Pick a business from the menu."`; workspace-switcher and brand-switcher contain `"Couldn't switch workspace"` / `"Couldn't switch business"`; `LearningNotes` contains `LoadFailed` and `what="learning notes"`; workspace.tsx contains `"mentioned"` legend text `"Green: mentioned · Amber: not mentioned · Grey: names the brand"` and `" · reconnect"`; Analytics tab buttons contain `focus-visible:ring-2`; Context Edit has `aria-label="Edit business details"`; peek title element is `<p id={titleId}` (not `h2`) and close button has `pointer-coarse:size-11`; release-panel has no `"Loading boards…"`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.**
  - loading.tsx: `"use client"`; on `"/"` render `<div role="status" className="grid h-full grid-cols-1 gap-3 p-3 lg:grid-cols-3">` with three `rounded-2xl bg-border motion-safe:animate-pulse` blocks and sr-only "Loading…"; else the existing `max-w-5xl` + `PageSkeleton`.
  - Switchers: workspace `.then(ok, () => toast({ title: "Couldn't switch workspace", detail: "Try again.", tone: "warning" }))`; brand: wrap the transition body in `try/catch` with `toast({ title: "Couldn't switch business", detail: "Try again.", tone: "warning" })`.
  - LearningNotes: `failed` state; reject → `setFailed(true)`; render `<LoadFailed what="learning notes" onRetry={load} />`; loading → `<ListSkeleton label="Loading notes" rows={2} />`. release-panel :452 → `<ListSkeleton label="Loading boards" rows={2} />`.
  - GEO: one `<p className="text-xs text-muted-foreground">` legend under the list with the three dot colours inline. Accounts: non-ACTIVE pill becomes `<Link href="/settings?tab=connections">{c.displayName} · reconnect</Link>`.
  - Context text buttons: add `min-h-11 pointer-coarse:py-2.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`; Edit `aria-label="Edit business details"`.
  - Analytics: replace the fake tablist with `SegmentedRadios` (label "Report").
  - Peek: title `h2` → `p` (it still labels the dialog via `aria-labelledby`); content keeps its `h1`. Overview: when the Home panel is not on the board, render `<h1 className="sr-only">Overview</h1>` in `Workspace`.
- [ ] **Step 4:** checks → PASS.
- [ ] **Step 5: Commit** `"Show switch and load failures instead of silence or a crashed page, match the Overview skeleton to the board, and fix heading and status-by-colour gaps"`

### Task A5: Assistant drawer width and New conversation Undo

**Files:** Modify `components/shell/assistant-panel.tsx:179,189,261`, `components/workspace/chat-pane.tsx:115-121,361,366`. Test: `tests/uiux-shell.test.ts`.

- [ ] **Step 1: Failing tests.** assistant-panel contains `"w-full sm:w-80"` and Expand class has `hidden sm:grid` (not `md:grid`); chat-pane `onNew` contains `label: "Undo"`; send/stop buttons contain `pointer-coarse:size-11`; assistant close contains `pointer-coarse:size-11`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** Width `expanded ? "w-[min(56rem,100vw)]" : "w-full sm:w-80"`; Expand `hidden sm:grid`. `onNew`: keep `prev = loaded`; set the new thread; `toast({ title: "New conversation", tone: "info", ms: 8000, action: { label: "Undo", onAction: () => setLoaded(prev) } })`. Failure mode noted in a comment: if a message was already sent in the new thread, Undo shows the old thread but the server's latest is the new one (reload shows the new one).
- [ ] **Step 4:** checks → PASS.
- [ ] **Step 5: Commit** `"Let the chat use the whole phone width and offer Undo after starting a new conversation"`

### Task A6: Toasts above the phone tab bar

**Files:** Modify `components/ui/toast.tsx:68`. Test: `tests/uiux-shell.test.ts`.

- [ ] **Step 1:** Test: toast container class contains `max-lg:pb-[max(4.5rem,env(safe-area-inset-bottom))]`. → FAIL.
- [ ] **Step 2:** Add that class (the Overview's phone tab bar is ~56 px; other pages just gain space). Checks → PASS.
- [ ] **Step 3: Commit** `"Keep toasts clear of the Overview's phone tab bar"`

### Task A7: content-panels and panel-layout fixes (starts after the calendar work lands)

**Files:** Modify `components/workspace/content-panels.tsx` (ideas loading :243, calendar loading :435, frames :997, post :1119/:1124, ideas filter tablist :272-278, "Find ideas" :302, per-row Plan button :346-352, dismissed `opacity-60` :309, `text-[11px]` :310/:532/:537/:538/:561/:666/:820/:826/:828, out-of-month `opacity-60` :820, PostChip `title` :572, legend under the month grid, campaigns/owners `() => {}` :401/:1093, story zoom :1041, month prev/next `w-8`, filter selects `h-8`), `components/workspace/panel-layout.tsx` (mobile tabs :410-425, header buttons :509-534, close toast tone :209, header `draggable` :471, panel title :498-508). Test: `tests/uiux-shell.test.ts`.

- [ ] **Step 1: Failing tests.** content-panels: no `"Loading ideas…"`, `"Loading calendar…"`, `"Loading frames…"`, `>Loading…<`; no `text-[11px]`; no `opacity-60`; contains `withPrice("Get ideas"`; contains `"Couldn't load campaigns"` and `"Couldn't load owners"`; story zoom uses `DialogContent`; contains a legend string `"Awaiting approval"` outside `sr-only`; PostChip button `title={`${item.title} · ${statusText(item)}`}`; `"Plan all"` occurs at most once. panel-layout: no `aria-current={activeMobile`; contains `aria-pressed={activeMobile === id}`, `border-t-2 border-primary`, `focus-visible:ring-inset`; header group `gap-1.5`; close toast `tone: "info"`; panel title wrapped in `<h2`; `draggable` sits on a grip element, not on the element containing the ⋯ and ✕ buttons.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** Text loaders → `<ListSkeleton label="Loading ideas|calendar|frames|post" rows={3} />`. Ideas filter → `SegmentedRadios label="Filter ideas"`. "Find ideas" → "Get ideas". Remove the per-row Plan button (the bar at :255 is the one CTA; keep "Remove from shortlist"). Dismissed idea: drop `opacity-60`, keep text tokens. All `text-[11px]` → `text-xs`; out-of-month day: drop `opacity-60` (stays `text-muted-foreground`). Month legend: one `text-xs` line of the tone chips with their labels under the grid. Campaigns/owners: reject sets a flag rendering `<p className="text-xs text-muted-foreground">Couldn't load campaigns.</p>` (owners: same) next to the select. Story zoom → `Dialog`/`DialogContent` (trap and focus return come from Radix). Prev/next and filter selects get `pointer-coarse:size-11` / `pointer-coarse:h-11`. Panel-layout: mobile tab classes `border-t-2` + active `border-primary font-medium text-primary-strong` / inactive `border-transparent text-muted-foreground`, `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`, `aria-pressed`; header button group `gap-1.5`, ⋯/✕ drop `size-7` (Button `icon` now grows on touch) for `size-8`; close toast `tone: "info"`; title button wrapped in `<h2 className="min-w-0">`; move `draggable`/drag handlers to the title/grip area only.
- [ ] **Step 4:** checks → PASS.
- [ ] **Step 5: Commit** `"Make Overview panels load, fail and show status the same way, mark the active phone tab by shape, and stop drags starting on panel buttons"`

---

## Track B: settings, welcome, context, products, auth (5 tasks)

### Task B1: Brand context truth and no review-on-open (ruling 2)

**Files:** Modify `components/context/doc-pane.tsx` (:32, :73, :170-177, :254, :306 `h4`→`h3`), `components/context/context-board.tsx` (:334 `autoReview`), `app/(shell)/context/page.tsx` (:17-22, :39), `components/welcome/welcome-flow.tsx:258`. Test: `tests/uiux-settings.test.ts` (create; Track B's own scan file, so tracks never share a test file).

- [ ] **Step 1: Failing tests** in `tests/uiux-settings.test.ts`: doc-pane has no `void onConfirm()` inside an effect and no `"does not change what agents use until you confirm it"`; contains `"Saving creates a new version. Agents use it from their next run."`; context page has no `"works from what you confirmed"` and contains `"agents work from the latest version"`; welcome has no `"Drafts until your team confirms them."` and contains `"Agents use them straight away. Review them when you can."`; context page EmptyStates pass `headingLevel="h1"`; context-board has no `autoReview`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** Delete the auto-review effect and `reviewed` ref; remove `autoReview` from the destructure and leave `autoReview?: boolean` in Props with the comment `/** Ignored: opening a document never marks it reviewed. Delete once the Overview stops passing it (Task A2). */`. Context page description: "Give us a name and a website. The Research agent drafts five strategy documents; you review them, and agents work from the latest version." `headingLevel="h1"` on both EmptyStates; same on `app/(shell)/settings/page.tsx:19`.
- [ ] **Step 4:** checks → PASS.
- [ ] **Step 5: Commit** `"Say that agents read the latest brand document, and stop marking a document reviewed just because someone opened it"`

### Task B2: Welcome live region and log scroll

**Files:** Modify `components/welcome/welcome-flow.tsx` (:179 placeholder, :184 comment, :350-352, :416-420). Test: `tests/uiux-settings.test.ts`.

- [ ] **Step 1: Failing tests.** No `scrollIntoView`; contains `scrollTop = ` on the log list ref; the `clock(elapsed)` span is outside the `aria-live` paragraph (assert the `aria-live` `<p` block, sliced to its `</p>`, has no `clock(`); placeholder is `placeholder:text-muted-foreground` (no `/50`); no `"brass"`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** Log: `listRef` on the `<ol>`, follow-bottom logic as `components/agents/agent-log.tsx:78-86` (stick when within 24 px of bottom). Clock span moves to a sibling `aria-hidden` span. Comment "brass" → "accent".
- [ ] **Step 4:** checks → PASS.
- [ ] **Step 5: Commit** `"Stop the welcome log pulling the page up and the reading status re-announcing its clock every two seconds"`

### Task B3: Settings tabs, connections, members, AI models, permission copy

**Files:** Modify `components/settings/settings-board.tsx:101-104`, `components/settings/connections-tab.tsx` (:83, :111, :169-195), `components/settings/members-tab.tsx` (:63/:122, :78-90, :135), `components/settings/ai-models-tab.tsx` (:101, :131-141, :244), `components/settings/role-dialog.tsx:165`, `app/(shell)/settings/page.tsx:19`. Create `lib/connect-return.ts`. Test: `tests/uiux-settings.test.ts`, `tests/connect-return.test.ts`.

**Interfaces:**
- Produces: `connectReturnPath(stored: string | null): "/connections" | null` (returns `"/connections"` only for that exact value) and `CONNECT_RETURN_KEY = "connect-return"`.

- [ ] **Step 1: Failing tests.** `connect-return.test.ts`: `connectReturnPath("/connections") === "/connections"`; `connectReturnPath(null) === null`; `connectReturnPath("//evil") === null`. Scan: settings tablist has `overflow-x-auto` and `max-w-full`, tabs `shrink-0`; connections banner JSX appears before `<PageSection`; no `"members.read"` / `"Your role doesn't include"` in members-tab (copy: "Your role can't see the member list."); ai-models-tab has no `npm run`; member role change contains `label: "Undo"`; members result line appears before the table; role-dialog shows the description as the main label and `p.key` is gone from visible text (kept only as `title`).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** Tabs: add `max-w-full overflow-x-auto` to the tablist, `shrink-0` per tab. Connections: before `startConnect` redirect, `sessionStorage.setItem(CONNECT_RETURN_KEY, pathname)` (try/catch); on mount at `/settings` with connect params, read and remove it, and if `connectReturnPath(v)` then `router.replace("/connections?" + same params)`. No server change. Banner moves above `PageSection`. "Not set up" → add `<span className="text-xs text-muted-foreground">Needs app keys on the server. Ask your platform admin.</span>`. Members role change: apply, then `toast({ title: "Role changed", detail: `${name} is now ${role}`, tone: "info", action: { label: "Undo", onAction: () => change(id, oldRole) } })`; result line above the table. AI models: drop CLI strings from copy (keep the code comment); tier Save shows `toast({ title: "Tier saved", detail: "All workspaces use it within a minute.", tone: "success" })`.
- [ ] **Step 4:** checks → PASS.
- [ ] **Step 5: Commit** `"Keep the settings tabs on screen, show connect results where you are and send you back there, offer Undo on role changes, and drop permission keys and CLI commands from copy"`

### Task B4: Products and campaigns rows and dialogs

**Files:** Modify `components/products/products-board.tsx` (:179-186, :308-314, :498), `components/products/campaigns.tsx` (:90-91, :242). Test: `tests/uiux-settings.test.ts`.

- [ ] **Step 1: Failing tests.** products-board contains ``aria-label={`Edit ${p.title}`}`` and ``aria-label={`Delete ${p.title}`}``, `loadingId`, `Loader2`; campaigns contains ``aria-label={`Edit ${`` and ``aria-label={`Withdraw ${``; both dialogs use `useUnsavedGuard` / `okToDiscard` before closing.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** `const [loadingId, setLoadingId] = useState<string | null>(null)`; Edit shows `Loader2` and `disabled` while `loadingId === p.id`; a failed load sets a row-level error under that row (`text-xs text-destructive`). Dialog `onOpenChange(false)` → only if `!dirty || okToDiscard()` from `components/context/unsaved.ts`.
- [ ] **Step 4:** checks → PASS.
- [ ] **Step 5: Commit** `"Show progress on a product's Edit, name the product in row buttons, and ask before a dialog drops typed changes"`

### Task B5: Auth contrast and field size

**Files:** Modify `components/auth/login-form.tsx:88`, `components/auth/auth-card.tsx:18` (+ its inputs). Test: `tests/uiux-settings.test.ts`.

- [ ] **Step 1:** Test: login-form notice has `text-success-ink` not `text-success"`; auth-card has `rounded-2xl` and inputs `h-11`. → FAIL.
- [ ] **Step 2:** Implement; checks → PASS.
- [ ] **Step 3: Commit** `"Use the success ink on the sign-in notice and give the other auth forms sign-in's card and field size"`

---

## Track C: library, reels, photoshoot, agents, performance, admin, error pages (5 tasks)

### Task C1: Shell-level error page

**Files:** Create `components/net/page-error.tsx`, `app/(shell)/error.tsx`. Modify `app/error.tsx`, `components/net/error-screen.tsx`, `app/global-error.tsx:18-23`. Test: `tests/uiux-pages.test.ts` (create).

**Interfaces:**
- Produces: `ErrorScreen` gains `inline?: boolean` (wrapper `div` with `flex items-center justify-center py-16` instead of `<main min-h-dvh>`); `PageError({ error, reset, inline }: { error: Error & { digest?: string }; reset: () => void; inline?: boolean })`.

- [ ] **Step 1: Failing tests.** `app/(shell)/error.tsx` exists and renders `PageError` with `inline`; `app/error.tsx` renders `PageError` without it; global-error "Reload" calls `location.reload()` and uses `buttonVariants`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** by moving `app/error.tsx`'s body into `PageError`.
- [ ] **Step 4:** checks → PASS.
- [ ] **Step 5: Commit** `"Show a failed shell page inside the shell so the sidebar and top bar stay"`

### Task C2: Library delete confirm and photo grid

**Files:** Modify `components/library/library-board.tsx:81-97`, `components/library/photo-grid.tsx` (:210, :229-233, :244). Test: `tests/uiux-pages.test.ts`.

- [ ] **Step 1:** Test: library-board imports `ConfirmDialog` from `@/components/settings/shared`; photo-grid title spans carry `title={`. → FAIL.
- [ ] **Step 2:** Implement: `onRemove` sets `confirming` photo; `ConfirmDialog` "Delete this photo from the library?" confirms the existing delete. Truncated titles get `title`. Remove button gets `pointer-coarse:size-11`. Checks → PASS.
- [ ] **Step 3: Commit** `"Ask before deleting a library photo and show full photo names on hover"`

### Task C3: Reels: separate Approve and Download (ruling 3), template card, card alt

**Files:** Modify `components/reels/review-step.tsx` (:24-27, :79-88, :278-322), `components/reels/api.ts:45-47`, `components/reels/home.tsx` (:216-241), `components/reels/reel-card.tsx:36`. Create `components/reels/reel-actions.ts`. Test: `tests/reels.test.ts`, `tests/uiux-pages.test.ts`.

No server change: `sendReel` (`server:server/reels/service.ts:308-317`) approves only when `AWAITING_APPROVAL`; for APPROVED/SCHEDULED/PUBLISHED it just returns the signed links. The mobile app keeps using `send` unchanged.

**Interfaces:**
- Produces: `reelActions(status: string, canApprove: boolean): { approve: boolean; download: boolean; downloadWhy: string | null }`; `reelsApi.approve` (= today's `send` call) and `reelsApi.download` (same request, called only when the reel is already approved).

- [ ] **Step 1: Failing tests.** `reels.test.ts`: `reelActions("AWAITING_APPROVAL", true)` → `{ approve: true, download: false, downloadWhy: "Approve it first to download." }`; `reelActions("APPROVED", true)` → `{ approve: false, download: true, downloadWhy: null }`; `reelActions("PUBLISHED", false)` → `{ approve: false, download: true, … }`; `reelActions("AWAITING_APPROVAL", false)` → `{ approve: false, download: false, downloadWhy: "Someone who can approve reels approves it first." }`. Scan: review-step has no `"Downloading approves this version."`; contains `>Approve<` and `Download video`; home.tsx has `"Play sample"` and `"Make a preview with my photos"` and the paid button has `whitespace-normal h-auto`; reel-card `alt=""`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** Approve button (primary) calls `reelsApi.approve`, then `fetchShared(url, true)`; never navigates. Download button calls `reelsApi.download` and `window.location.assign`, enabled only when `reelActions(...).download`; `downloadWhy` shown as visible `text-sm text-muted-foreground`. Does `send` need `content.approve` for a download of an approved reel? Yes (route PERMISSION) — so for roles without it, Download stays hidden as today and `downloadWhy` reads "Your role can't download reels." (open question, see owner list). Update the file's header comments.
- [ ] **Step 4:** checks → PASS.
- [ ] **Step 5: Commit** `"Make Approve and Download separate buttons on a reel so downloading never approves it, and keep the paid template preview inside its card"`

### Task C4: Agents, photoshoot, studio copy and states

**Files:** Modify `components/agents/agents-board.tsx:73`, `components/photoshoot/shoot-detail.tsx:229`, `app/(shell)/studio/page.tsx`, `app/(shell)/agents/page.tsx:15`, `app/(shell)/performance/page.tsx:14`. Test: `tests/uiux-pages.test.ts`.

- [ ] **Step 1:** Test: agents-board skeleton uses `bg-border` (no `bg-card` in the skeleton line); shoot-detail has `"Shoot details"` not `"Staging summary"`; studio page passes `backHref="/"`; agents and performance EmptyStates pass `headingLevel="h1"`. → FAIL.
- [ ] **Step 2:** Implement; checks → PASS.
- [ ] **Step 3: Commit** `"Grey agent skeletons, plain shoot heading, a way back from Studio, and page headings on empty states"`

### Task C5: Performance and admin readability

**Files:** Modify `components/performance/audit-board.tsx` (:51, :143, severity label), `components/admin/ui.tsx:35`, `components/admin/spend-chart.tsx:48,64,72`, `app/(shell)/admin/page.tsx` (:55, :58, :91), `app/(shell)/admin/workspaces/[workspaceId]/roles/page.tsx:31`. Test: `tests/uiux-pages.test.ts`.

- [ ] **Step 1:** Test: audit-board summary contains a `ChevronRight` with `group-open:rotate-90`; no `"analytics.read"` (copy: "Your role can't see performance."); severity rendered through a `SEVERITY_LABEL` map (`critical: "Critical"`, `high: "High"`, `medium: "Medium"`, `low: "Low"`); admin ui dash `text-muted-foreground` (no `/60`); spend-chart has no `text-[10px]`; admin page has no `"Hover a day"` (copy: "The table below has each day's split.") and no `npm run`; roles page chips `text-xs`. → FAIL.
- [ ] **Step 2:** Implement (chevron as in `workspace.tsx` Coming-soon `<summary>`). Checks → PASS.
- [ ] **Step 3: Commit** `"Show that audit findings expand, use readable severity and permission copy, and lift admin text to 12 px and AA contrast"`

---

## Dropped (not confirmed in code, or not a defect) — 7

- Shell #1a "The Opportunities agent" in Ideas: not a defect under ruling 1; the scout agent's name is "Opportunities" (`server:server/agents/definitions/scout.ts:37`). The stray "Scout" is fixed instead (A2).
- Calendar view tablist "no focus-visible": it already has `focus-visible:ring-2` (`content-panels.tsx:427`).
- Languages tab 403 "Try again that can never work": `languages-tab.tsx:23` doesn't match; the only "Try again" is a save error (:39).
- Campaign times as free-text `HH:MM` with `pattern`: no `pattern=` or time input found in `campaigns.tsx`.
- Products page `w-full` with no `max-w-*` (:341): not confirmed at the cited spot.
- Pages audit "no inbox/automations routes" and "welcome progress bar is fine": observations, not findings.
- Context `context-board.tsx:241` "agents use your edit on their next run": true per the server, no change.

Not verified before the wrap-up deadline (left out, re-check before scheduling): auth field `aria-invalid`/password toggle; context Re-run research confirm, error alignment; synced-product dialog with all fields disabled; reels starter chip starts at once; hashtag-limit warning; agent tile failure `line-clamp-2`; agent log raw levels and duplicate "unavailable" alerts; performance truncated URLs; admin `Ago` hover-only times; credits popover anchoring.

## Needs owner / visual check

- Button shape: pill (`rounded-full`) vs 16 px (`rounded-2xl`, DESIGN_SYSTEM §4 says controls are `rounded-2xl`); A1 only fixes the `xl` < `2xl` inversion.
- Built agents' persona subtitle: no code maps Research/SEO/Opportunities… to Wave/Surge/Drift; owner to supply the mapping if built agents should carry one.
- Open question (ruling 2): agents read drafts, not only confirmed docs; copy now says so. Should the server gate on confirmed?
- Reels: roles without `content.approve` cannot download an approved reel (route permission); confirm that is intended.
- One word for business / brand / project, and one retry verb ("Try again" vs "Retry now", "Read again"…): cross-track copy sweep after this plan.
- Phone top bar crowding at 360 px (five tool buttons) and moving a tool into the menu.
- Credits popover pinned at `right-4 top-[76px]` rather than anchored to the chip.
- Sidebar row right edges (`mr-7 ml-5` vs `mx-5`).
- Phone panel tabs: show only the layout's panels plus "More" (audit follow-up).
- Calendar filter row wrapping in a ~350 px panel; month chips below 520 px.
- Reels template grid `grid-cols-1 @md:grid-cols-2` vs wrap-only (C3 does wrap only).
- Photoshoot Quality `columns={4}` in the half-width column; brand logo on `bg-foreground`; login entrance stagger length.
- The 9 px "!" agent-tile badge (12 px may not fit the badge).
- Dialog/menu enter motion: A1 removes dead classes (current snap kept); add real motion only if wanted.
- Column resize handle discoverability; peek width 1024–1280 px; admin table switch points.
