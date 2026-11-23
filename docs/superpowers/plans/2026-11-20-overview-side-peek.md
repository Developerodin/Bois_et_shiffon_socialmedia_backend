# Overview Side Peek + Recent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opening anything on the web Overview (a post, document, agent, competitor) shows it in one side peek with ×/Esc instead of replacing the Today panel; buttons that point at a panel bring it into view instead of adding it; a Recent menu and Reopen bring back what you had open. The saved board never grows by itself.

**Architecture:** The View model and URL stay as they are (`lib/workspace-view.ts`, one item per URL, pushState history). `workspace.tsx` renders the four existing drill-in views inside a new non-modal `Peek` region, a sibling of `PanelLayout` inside the Overview wrapper (not the Radix `Sheet`, which is modal and viewport-fixed). The unsaved-changes guard becomes per-editor. `PanelLayout` gains a reveal that never writes the layout. Recent is a small per-user store of links in `localStorage`.

**Tech Stack:** Next.js + React (web), vitest (pure modules), no new dependency.

**Spec:** the four-lens report https://claude.ai/artifact/SAf3r3LgpGv7fe6jTpb15Y and the approved mockups https://claude.ai/artifact/PeW8kLZqUYFV76GqNj4YwG (Main, PeekRecent). Owner approved A + A2 on 2026-11-20; A3 (two side by side) is out of scope. The plan's own four-lens review (2026-11-20) is folded in.

## Global Constraints

- Web repo (`apps/web`), branch `overview-peek` from `main`; the server repo gets only the docs commit and `shared/` (synced) on its own `overview-peek` branch.
- One item per URL, as today (`?post=`, `?doc=`, `?agent=` + `runId`, `?competitor=`); opening pushes history; Back/Forward, reload and the agent toast link land in the peek. `run` (auto-run) never comes from the URL, Recent or Reopen.
- Opening anything never changes the saved layout (`ws.layout.v1`). The sidebar's `?panel=` (Calendar, Performance links) stays an explicit insert — the person asked for that panel.
- Unsaved work is never lost silently.
- Agent, AI and user text renders as plain React text (breadcrumbs, Recent, toasts).
- No new 6 s pollers; a closed peek is unmounted after its slide; nothing new subscribes to a poll for a closed menu.
- Motion: slide with `transform` only, ≤ 220 ms; the reveal flash is a 1.2 s outline/ring (paint); `prefers-reduced-motion` skips both and unmounts immediately.
- Never run `next build` while `next dev` runs. Checks: web `npm test`, `npm run typecheck`, `npm run lint`; server `npm run sync:shared` when `shared/` changes, then web typecheck.
- Commit messages: the change and why. No co-author lines, no tool or session URLs, no mention of tests.

## Review Focus

1. A post's caption edited in the peek while its release form is clean, then another board item clicked: asked first; Cancel keeps the peek and the edit. Same for a sidebar link and closing the tab. (Task 1.)
2. A menu inside the peek open and Esc pressed: only the menu closes; a second Esc closes the peek and focus returns to the item that opened it (or its panel header if that item is gone). The assistant panel's Esc doesn't fire while focus is in the peek. (Task 2.)
3. `?doc=not-a-doc` → the Overview, no peek; `?post=<id from another brand>` → the peek says "This post no longer exists". Switching business with a peek open closes it. (Task 2.)
4. "Open competitors" from an agent in the peek: the peek closes (asking first if needed), the Competitors panel scrolls into view and flashes; if it's collapsed the toast offers "Expand", if it isn't on the board "Add to board" (saved). The layout is unchanged until one of those is pressed. (Task 3.)
5. An agent opened with auto-run, closed, then reopened from Recent or Reopen: it opens, it does not run again. Signing out clears Recent on this browser. (Task 4.)

---

### Task 1: Per-editor unsaved guard

**Files:** `web/components/context/unsaved.ts`, `web/components/context/doc-pane.tsx` (~98-124), `web/components/workspace/draft-editor.tsx` (`TextDraftEditor` ~37-52), `web/components/workspace/release-panel.tsx` (approval note, schedule time, upload in progress ~235-350); test `web/tests/unsaved.test.ts`.

**Interfaces:** `setUnsaved(owner: symbol, dirty: boolean)` backed by a `Set<symbol>`; `okToDiscard()` asks when the set is non-empty (generic wording: "You have unsaved changes. Leave without saving?"); `useUnsavedGuard(dirty: boolean)` hook = the `beforeunload` + capture-phase in-app link guard moved out of DocPane, registering its own symbol and clearing it on unmount. DocPane, DraftEditor and the release forms use it.

- [ ] Step 1: Failing tests: two owners dirty, one clears → still asks; both clear → doesn't ask; unmount clears only its own owner.
- [ ] Step 2: FAIL. Step 3: Implement. Step 4: PASS + checks.
- [ ] Step 5: Commit (web) "Track unsaved changes per editor, so a post's caption and its release form can't clear each other's warning".

### Task 2: The side peek

**Files:** create `web/components/workspace/peek.tsx`, `web/components/workspace/use-peek.ts`; modify `web/components/workspace/workspace.tsx` (render site ~337-371; the wrapper ~439 gets `relative`), `web/lib/workspace-view.ts`, `server/shared/` (new `context-docs.ts` exporting `DOC_KINDS`, moved from `web/components/context/api.ts:17`, which re-exports it), `web/components/workspace/content-panels.tsx` (story zoom Esc ~606-611 handles Esc first in capture phase and calls `preventDefault`; ContentView's sticky back bar ~730-735 removed), `web/components/workspace/competitors-panel.tsx` (CompetitorView's sticky bar ~214 removed); tests `web/tests/workspace-view.test.ts` (extend).

**Interfaces / rules:**
- `lib/workspace-view.ts`: `doc` must be in `DOC_KINDS`; `post`/`competitor` ids match `/^[A-Za-z0-9_-]{1,64}$/`; `agent` matches `/^[a-z][a-z0-9-]{0,39}$/` (no static agent list exists; the existing after-load check at workspace.tsx ~181-186 still drops unknown agents); invalid → home. Exported pure `parseViewParts(kind, id)` for Task 4 to reuse. `peekCrumb(view)` ("Calendar › Post", "Context › Document", "Agents", "Competitors") and `peekTitle(view, known)` (falls back to "Post", "Document", the agent key, "Competitor") live here too.
- `Peek({ open, title, crumb, onClose, fullPageHref?, children })` in `peek.tsx` — `<aside role="region" aria-labelledby>` `absolute inset-y-0 right-0`, `width: min(560px, 100%)`, own `overflow-y-auto`, inside the Overview wrapper (MainArea is already separate from the assistant column); a light scrim with `pointer-events-none`, no blur; below 1024 px it fills the wrapper. Esc is handled in the aside's React `onKeyDown` (only when focus is inside the peek and `!e.defaultPrevented`; it then calls `preventDefault` so the assistant's document Esc listener doesn't also act). `ponytail:` comment: not Sheet because Sheet is modal and viewport-fixed. Reuse Sheet's close icon, `SHELL_STROKE` and focus-ring classes. `React.memo` with stable inputs.
- `use-peek.ts`: keeps the last non-home view, title and crumb as a snapshot so the peek renders it while sliding out, clears it on `transitionend` (300 ms fallback; immediate under reduced motion); content keyed by `kind+id` so a replaced item remounts fresh; the snapshot always passes `autoRun=false`; remembers the opener element on open and on close focuses it if `isConnected`, else `#panel-head-<panel>`, else the Layout button; closes on brand change (Workspace is keyed by brand; also clear `?post|doc|agent|competitor` on switch).
- `workspace.tsx`: `<Peek>` is a sibling of `<PanelLayout>`; the home panel always renders Today; remove `setFocus home` from `open()` (~301) AND from the URL effect (~159); close = `open({ kind: "home" })` (goes through `okToDiscard`). Delete `BackBar` (~1162) and the `onBack` props of DocView, AgentView, CompetitorView and ContentView, and any now-unused imports. `fullPageHref` only for studio reels (`reelHref`).
- Each view in the peek keeps its own refresh, so a permission narrowed while open shows its existing "not found"/"no access" state rather than stale data.

- [ ] Step 1: Failing tests: bad doc/id/agent → home; `run` never from the URL; crumbs and title fallbacks.
- [ ] Step 2: FAIL. Step 3: Implement. Step 4: PASS + checks (sync shared, web typecheck).
- [ ] Step 5: Commit (web; server shared) "Open posts, documents, agents and competitors in a side peek instead of replacing the Today panel".

### Task 3: Bring a panel into view instead of adding it

**Files:** `web/components/workspace/panel-layout.tsx` (focus effect ~214-223), `web/components/workspace/workspace.tsx` (new `revealPanel`; decide each `showPanel` call site — ~304, 368, 386, 414, the AGENT_NEXT buttons ~1304 and any others: buttons inside the peek or the board that point at a panel use `revealPanel`; `?panel=` from the sidebar keeps the insert), `web/components/ui/toast.tsx` (`action?: { label; onAction }` that dismisses the toast; optional `ms`), tests `web/tests/panel-layout.test.ts`, `web/tests/toast.test.ts` (extend).

**Rules:** `revealPanel(id)`: if a peek is open, close it first through `okToDiscard` (a revealed panel can sit under the peek); if the panel is in a column and not collapsed, scroll `#panel-head-<id>` into view and flash it with a class toggled via ref + timeout (cleared on unmount) — no `setLayout`, no layout write, decided from a ref to the current layout; if collapsed, toast "{Panel} is collapsed" with "Expand" (commits); if not in any column, toast "{Panel} isn't on your board" with "Add to board" (commits, so it's saved); on mobile (`setMobilePanel`) switch to it. Toasts with actions are dismissed when Workspace unmounts.

- [ ] Step 1: Failing tests: shown → reveal, layout object unchanged; collapsed → expand offer; absent → add offer; "Add to board" commits; toast action dismisses; `ms` honoured.
- [ ] Step 2: FAIL. Step 3: Implement. Step 4: PASS + checks.
- [ ] Step 5: Commit (web) "Bring a panel into view instead of adding it to the board, and offer to expand or add it when it isn't showing".

### Task 4: Recent and Reopen

**Files:** create `web/lib/recent.ts`, `web/components/workspace/recent-menu.tsx` (built on `components/ui/dropdown-menu.tsx`; rendered by `workspace.tsx` and portaled into `TOPBAR_SLOT_ID` the way Layout is), test `web/tests/recent.test.ts`; modify `web/components/workspace/sign-out-item.tsx` (`signOutNow` removes every `recent:` key before `signOut`, in try/catch), `web/components/workspace/workspace.tsx` / `use-peek.ts` (record opens, Reopen, R).

**Interfaces / rules:**
- `type RecentEntry = { kind: "post" | "doc" | "agent" | "competitor"; id: string; at: number }`; `RECENT_MAX = 8`; `recentKey(workspaceId, brandId, userId)` (skip Recent entirely when `user.id` is missing); `pushRecent(list, entry)` (dedupe by kind+id, newest first, cap); `readRecent(key)` strict: an array, each entry rebuilt as `{ kind, id, at }` only (never spread), kind and id checked with `parseViewParts`, `at` finite and within 30 days, at most 8; `writeRecent` skips when the top entry is already the same item; reads only on menu open and on push, never in render; all storage in try/catch; `clearAllRecent()` removes every `recent:` key (`ponytail:` scans localStorage keys; fine at this size).
- Recording: an effect keyed on the view's kind+id, not on render.
- Titles resolved only when the menu opens: docs and agents from workspace state; posts from the shared content cache (`sharedResponse`) else "Post"; competitors via one `fetchShared(\`${base}/competitors\`)` on open else "Competitor"; "…" while loading. An entry is marked "No longer available" only when its list loaded, the role can read it, and it's missing — and never deleted on a failed fetch.
- Opening from Recent or Reopen builds the View from `{ kind, id }` only.
- Reopen: closing the peek shows a toast "Closed {title}" with `ms: 6000` and `href` built from `viewToSearch({kind,id})`; R reopens the last closed entry when no peek is open and the event isn't `defaultPrevented`, `repeat`, `isComposing`, has no Ctrl/Meta/Alt, and its target isn't inside `input, textarea, select, [contenteditable], [role=textbox], [role=menu], [role=dialog]`. The last-closed entry is cleared on brand switch.

- [ ] Step 1: Failing tests: push/dedupe/cap; read drops extra fields (`{kind:"agent",id:"x",run:true}` → no run), bad kinds/ids, entries older than 30 days; clearAllRecent removes only `recent:` keys; the R filter as a pure function.
- [ ] Step 2: FAIL. Step 3: Implement. Step 4: PASS + checks.
- [ ] Step 5: Commit (web) "Reopen what you had open: a Recent menu on the Overview and Reopen after closing".

### Task 5: Docs

**Files:** `server/docs/DESIGN_SYSTEM.md` (Peek placement, width, focus, Esc, mobile; the reveal flash; Recent menu; toast `action` and `ms`; the unsaved guard), `server/docs/HANDOVER.md` ("Overview side peek" section: what changed, the URL validation rules, `?panel=` still inserts by choice, A3 deferred and why, not checked in a browser).

- [ ] Step 1: Write against the code. Step 2: Commit (server) "Document the Overview side peek and Recent".

---

## Self-review notes

- Plan-lens findings folded in: per-editor guard + tab/link guard (correctness C1/C2) → Task 1 first; exit snapshot (perf C1, correctness I4); agent/doc validation sources (maintainability C1/C2, correctness minor); placement, Esc via onKeyDown + zoom fix, all four headers removed, URL-effect focus removed (correctness I3/I5/I6/I7); reveal: close peek first, no setLayout, expand vs add, commit, call sites decided, ?panel= stays (correctness I8–I11, perf I3, maintainability I4); toast action/ms/dismiss (maintainability I5, correctness I16); Recent: dropdown-menu, portal, titles on open, no purge on failed fetch, strict read, TTL, sign-out clears all, R filter, no run replay (security I1–I4/M6, correctness I12–I15, perf I4/M5, maintainability I6/I7); brand switch closes peek and clears last-closed (security M7); hooks/pure helpers out of workspace.tsx (maintainability I9).
- Not built: two side by side; full pages for posts, documents, competitors; hover prefetch (data is already cached or in state).
