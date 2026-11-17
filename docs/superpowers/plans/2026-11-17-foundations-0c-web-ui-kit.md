# Foundations 0c · Web UI kit and accessibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the website the shared page parts (page header and section, status badge, job progress, credits chip, paywall dialog, grouped navigation) the eight mobile features will be built from, and fix the shell's critical accessibility faults (C1–C3) plus page titles, a skip link and a visible loading placeholder.

**Architecture:** Additive on 0b and on what exists. The admin console's `PageHeader` moves to `components/ui` and gains actions; one `PageSection` card follows DESIGN_SYSTEM §4. One status→tone map (`lib/status.ts`) feeds one `StatusBadge` that replaces the five pill implementations, with two darker ink tokens so every tone passes 4.5:1. The credits chip and `PaywallDialog` read 0b's plan/credits and paywall stores; prices come from the server's `/subscription` answer (one additive server field). `JobProgress` renders a `useJob` result. Navigation gains feature-flagged Create and Customers groups read from 0b's `featureOn`. The sidebar becomes a `Sheet` below `md`.

**Tech Stack:** Next.js 15.5 / React 19.1, Tailwind 4, Radix (dialog, dropdown-menu), vitest 5 in node (no jsdom, no testing library), Playwright for `scripts/audit-ui.ts`. Server: Next.js 15 route handlers, vitest.

**Spec:** server repo `docs/superpowers/specs/2026-11-17-foundations-design.md` §5 "0c · Web UI kit and accessibility", §6, §8. Findings: `docs/handover/2026-11-17-mobile-web-parity-review/accessibility.md` (C1, C2, C3, I1, I3, I7, I9, M1, M2; "Requirements for each coming feature" for progress, credits and live regions). Design rules: `docs/DESIGN_SYSTEM.md` §2–§4, §7, §12.

## Decisions (ambiguities and spec/code conflicts, settled here)

1. **`PageHeader` is the admin one, moved.** `components/admin/ui.tsx:182` already has a `PageHeader` (eyebrow, crumbs, title, children as description) used by 10 admin pages. It moves to `components/ui/page-header.tsx` with `Crumbs`, gains `actions`, and `admin/ui.tsx` re-exports it, so admin callers don't change. Its `children` stay the description slot.
2. **One title size: `font-display text-3xl font-medium tracking-tight`** (the existing shared header and four of the six pages). Products and Connections grow from `text-2xl`; Settings, Performance, Context and Agents lose `sm:text-4xl`. DESIGN_SYSTEM §3 gets a "page title" row (it lists only the Overview greeting today).
3. **Where `PageSection` goes in 0c:** Settings (each tab's section), Products (Campaigns and the catalogue), Connections (through its Settings tab), Performance (its two `Panel`s). Context and Agents get `PageHeader` only: Context is a list + editor layout and Agents a tile grid, like the Overview (§8 allows choosing per page). Inside a `PageSection` a list or table drops its own `rounded-2xl border border-border bg-card` wrapper (the section is the card) and goes edge to edge with `-mx-5`; table rows keep `divide-y`. Admin keeps its own `Section` (not a card; a console of tables).
4. **The five pill implementations** are `StatusPill` (`components/settings/shared.tsx:20-38`), admin `Pill` (`components/admin/ui.tsx:88-91`), `DocStateBadge` (`components/context/doc-state.tsx`), the tone maps in `components/workspace/content-panels.tsx:136-152` and `ATTEMPT` in `components/workspace/release-panel.tsx:550-558`. Also moved: the agent tile's status pill (`components/agents/agent-tile.tsx:76-86`), the Overview's "New" chip (`workspace.tsx:475`) and the shadcn `Badge` (only use: "Archived" in `brand-switcher.tsx:97`; `components/ui/badge.tsx` is then deleted). Not moved: count chips (`workspace.tsx:619,648`), the sidebar "Soon" tag, `release-panel.tsx:615` "no longer valid" — labels, not statuses.
5. **Tone names stay the ones 33 callers already pass:** `good | warn | bad | muted`, plus `info` for in-progress/awaiting. `StatusBadge` takes `status` (looked up in the one map) or an explicit `tone` for derived states that aren't a workflow enum (a connection's "Needs reconnect", audit severities, admin role chips). Where enums collide, one meaning wins: `RUNNING` is `info` (admin showed `warn`), `QUEUED` is `warn`.
6. **Contrast fix = two ink tokens** `--success-ink: #146b3e`, `--warning-ink: #8a5100`; text on tints uses them, `--primary-strong` and `--destructive`. Tints are the base colour at 10 %. Worked out: every tone is ≥ 4.76:1 over card, canvas, accent and muted. A unit test recomputes this from `globals.css` and the badge's own classes.
7. **Prices come from `/subscription`.** No web-visible price exists for agent runs today (server `CREDIT_COSTS` in `server/services/credits.ts:10`); competitor audits already send `auditCost`. The server's `GET /workspaces/:w/subscription` adds `prices: CREDIT_COSTS` and `freeAgents: [...FREE_MANUAL_AGENTS]` (additive; old phone builds ignore it). The web reads them from 0b's plan/credits store, so no new request and no polling. An **unlimited** workspace shows no price (its charges are zero-delta bookkeeping); an unloaded subscription or an old server shows no price rather than a guess.
8. **Priced buttons in 0c:** every button that starts an agent run or research: agent tile "Run now", Overview agent list and agent view run buttons (`workspace.tsx` around :1117 and :1354, and the `autoRun` path's trigger), Ideas "Plan posts" (planner) and "Run Scout" (`content-panels.tsx` :219, :256), the post's Next step run (`content-panels.tsx` around :449), the chat's start button (`chat-pane.tsx:125-140`), Context "Run research again" (`context-board.tsx:232`) and the welcome retry (`welcome-flow.tsx:290-300`). Visible text first, then price: "Run now · 5 credits"; the accessible name keeps the visible words first (I6). After a successful start each forces `loadPlanCredits(workspaceId, true)` so the chip moves.
9. **The credits chip's "small popover" is the native HTML `popover`** (React 19 types it; light dismiss and Escape for free, no new Radix package). Feature 6 swaps it for a link to Settings → Plan & credits.
10. **`PaywallDialog` replaces `paywall-stub.tsx` in place** (`git mv` to `paywall-dialog.tsx`): same store wiring, copy in a pure `paywallCopy`, a "shared by every business" line and a Close button. No purchase path: plans aren't on sale (feature 8).
11. **`JobProgress` ships without a production consumer in 0c.** No current web job has steps (story render and publishing are single-state). Its pure parts are unit-tested; feature 2 (photoshoot) is the first caller. It takes `useJob`'s `{ slow, failed, reload }` (useJob returns no `finished`; the caller's `done` decides that).
12. **Routes and groups for the coming features** (names only; each feature builds its page): Create = Photo library `/library` (`library`), Photoshoot `/photoshoot` (`photoshoot`), Reels `/reels` (`reels`), Studio `/studio` (`stories` — the existing Studio page, "where briefs become finished posts", is feature 4's home); Customers = Inbox `/inbox` (`inbox`); Automations `/automations` (`automations`) joins the main group. Onboarding and Plans get no entry. Unflagged entries are hidden, but `navFor` still names them, so breadcrumbs and titles are right the day a flag turns on.
13. **Page titles via Next metadata, text from `navFor`:** root `title: { default: "Espanda", template: "%s · Espanda" }`; each shell page `export const metadata = { title: navFor("<path>").title }`; `/agents/[agent]` uses `generateMetadata`. Admin titles become "People · Platform admin · Espanda" (I1's format). A file-scan test fails when a shell page has neither.
14. **C1:** the sidebar body is shared by the desktop `aside` (`hidden md:flex`) and a left `Sheet` opened by a Menu button the layout passes into the top bar (no new context). `overflow-x: clip` is removed from `html, body`; the top bar and main padding shrink below `sm` so 320 px fits. The audit gets a "content past the right edge" count because `scrollWidth` alone missed C1.
15. **C2:** "Create a business" becomes a `DropdownMenuItem` whose `onSelect` opens `NewBrandDialog` rendered outside the menu; `NewBrandDialog` gains optional controlled `open`/`onOpenChange` and `trigger={null}` (additive; its two other callers unchanged).
16. **C3:** a pure `layoutMessage` builds "Context moved to column 2 of 3" / "Context hidden" from the new layout; one polite live region; focus goes to the panel's header button (or the Layout button) in an effect after the layout commits, with the panel menu's `onCloseAutoFocus` prevented so Radix doesn't race it.
17. **Loading placeholder:** `PageSkeleton` and `ListSkeleton` blocks use `bg-border` (1.38:1 on a card, up from 1.02–1.13:1, M1) and `PageSkeleton` gets an `sr-only` "Loading…" inside its status region (I9).

## Global Constraints

- Run npm inside each repo with `--prefix .`: `npm test --prefix . -- tests/x.test.ts`. Windows; Git Bash for the commands below; PowerShell 5.1 has no `&&`. Paths are relative to the repo the task names (web = `../web` from the server repo).
- Every web task leaves `npm run typecheck --prefix .` (runs `check-shared` first), `npm run lint --prefix .` and `npm test --prefix .` green. The server task leaves the server's `npm run typecheck --prefix .`, `npm run lint --prefix .`, `npm test --prefix .` green.
- Web tests run in node without jsdom; no test library may be added. Unit-test pure logic only (status→tone, contrast, labels, nav/title derivation, announcements); component glue is checked by the build, `scripts/audit-ui.ts` and the owner's manual check. Each task says which.
- Commit messages: describe the change and why. No co-author lines, no tool/session lines, no mention of tests. Commit only in the repo the task names.
- Credits are per workspace, shared by all its brands. Paid buttons show their price from the server.
- No new dependencies. Laziest correct solution. Follow `DESIGN_SYSTEM.md`; no new visual language (cards `rounded-2xl border border-border bg-card shadow-sm`, `px-5` inset, `text-lg` section titles, `focus-visible:ring-2 ring-ring`).
- Reuse, don't duplicate: `Dialog*`, `Sheet*`, `DropdownMenu*`, `Button`, `EmptyState` (`components/ui`), `useJob` (`components/workspace/use-job.ts`), `usePlan`/`useCredits`/`loadPlanCredits` (0b), the paywall store (`lib/paywall.ts`), `featureOn` (`lib/features.ts`), `navFor`/`NAV` (`lib/nav.ts`). Never edit `web/shared` by hand.
- The dev DB has only admin users and empty workspaces; the owner tests by hand. No e2e runs that need seeded data.
- Keep the e2e selectors that exist: h1 "Products" and "Connections", the "Select business" button name.

## Review Focus

1. **A badge on a tinted surface** (a selected `bg-accent` row, a `bg-muted` strip): text must still pass 4.5:1, not only on white. Test in Task 2 (four surfaces).
2. **No price is better than a wrong one:** subscription not loaded yet, an old server without `prices`, an unlimited workspace, a free agent (`quality`) → the plain label, never "undefined credits" or "· 0 credits". Test in Task 4.
3. **Polling re-renders with the same steps** must not re-announce; a job already halfway when the card mounts announces nothing until a step changes; a failure is announced once. Test in Task 6.
4. **Moving the last panel out of its column** (the column disappears, or "Move right" opens a new one): the message counts the columns of the new layout ("column 3 of 3"), never the old. Test in Task 9.
5. **A mistyped or unknown flag** (`WEB_FEATURES=reel`) shows nothing and doesn't throw; a group with every entry off is not rendered as an empty heading. Test in Task 7.

Also watch, no test: at 320 px the top bar must hold the Menu button, credits chip, Logs and Espanda without overflow (Task 10's audit line). The mobile nav sheet closes when a link inside it navigates. Opening "Create a business" from the keyboard and pressing Escape returns focus to "Select business", not `<body>`.

---

### Task 1: Prices on the subscription answer (server)

**Files:**
- Modify: `app/api/v1/workspaces/[workspaceId]/subscription/route.ts:4, 17-21` (import `CREDIT_COSTS`, `FREE_MANUAL_AGENTS`; add two fields; update the doc comment "No prices yet" → "Plan prices: none yet. `prices` are credit costs per action.")
- Test: `tests/subscription-route.test.ts` (new)

**Interfaces:**
- Produces: the JSON body gains `prices: { siteAudit: number; manualRun: number; reelPerSecond: number; presenterPerSecond: number; storyWrite: number }` (= `CREDIT_COSTS`) and `freeAgents: string[]` (= `[...FREE_MANUAL_AGENTS]`). Existing fields unchanged.

- [ ] **Step 1: Write the failing test** (mock pattern as `tests/credit-refusals.test.ts`: `vi.mock("@/server/auth/request-user", …)` → `"u1"`, `vi.mock("@/server/auth/access", …)` → `requireWorkspaceMember` resolves, `vi.mock("@/server/services/subscriptions", async (o) => ({ ...(await o<object>()), activePlan: vi.fn(async () => null) }))`): `GET(new Request("http://x"), { params: Promise.resolve({ workspaceId: "w1" }) })` → 200, body `prices` equals `CREDIT_COSTS` (import it), `freeAgents` equals `["quality"]`, `plan` null, `plans` an array.
- [ ] **Step 2: Run** `npm test --prefix . -- tests/subscription-route.test.ts` → FAIL (`prices` undefined).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; typecheck, lint, full test → green.
- [ ] **Step 5: Commit** (server) "Send each action's credit cost with the workspace's subscription, so the website can show prices on paid buttons".

### Task 2: One status map and `StatusBadge`, with tone inks that pass contrast (web)

**Files:**
- Create: `lib/status.ts`, `components/ui/status-badge.tsx`
- Modify: `app/globals.css` (`:root` add `--success-ink: #146b3e; --warning-ink: #8a5100;`; `@theme inline` add `--color-success-ink`, `--color-warning-ink`; header comment: "status text on tints uses the -ink tokens")
- Modify (replace pills): `components/settings/shared.tsx:20-38` (delete `TONES`, `StatusPill`), and every `StatusPill` import/use in `components/settings/*-tab.tsx`, `components/performance/audit-board.tsx`; `components/admin/ui.tsx:88-91` (delete `Pill`) and every `<Pill` in `components/admin/log-table.tsx`, `app/(shell)/admin/**` (`log-table.tsx:5-7` tone helpers deleted; runs and calls pass `status=`, levels pass `status=` too); `components/context/doc-state.tsx:14-33`; `components/workspace/content-panels.tsx:136-152, 266, 359-361, 613`; `components/workspace/release-panel.tsx:550-558, 622`; `components/agents/agent-tile.tsx:18-23, 76-86`; `components/workspace/workspace.tsx:475`; `components/shell/brand-switcher.tsx:8, 97`
- Delete: `components/ui/badge.tsx`
- Test: `tests/status.test.ts`

**Interfaces:**
- Produces (`lib/status.ts`, no React):
  - `type Tone = "good" | "warn" | "bad" | "muted" | "info"`
  - `STATUS_TONE: Readonly<Record<string, Tone>>` — info: `AWAITING_APPROVAL, SCHEDULED, PUBLISHING, RUNNING`; good: `APPROVED, PUBLISHED, SUCCEEDED, SUCCESS, ACTIVE, ACCEPTED, RECOMMEND, CONFIRMED`; warn: `CHECK, HOLD, PENDING_VERIFY, PARTIAL, QUEUED, INVITED, PENDING, WARN`; bad: `BLOCKED, REJECTED, FAILED, EXPIRED, ERROR`. Everything else is muted.
  - `toneOf(status: string | null | undefined): Tone` — map lookup, else `"muted"`.
  - `TONE_CLASS: Record<Tone, string>` — good `border-success/40 bg-success/10 text-success-ink`; warn `border-warning/40 bg-warning/10 text-warning-ink`; bad `border-destructive/40 bg-destructive/10 text-destructive`; info `border-primary/40 bg-primary/10 text-primary-strong`; muted `border-border bg-muted text-muted-foreground`.
- Produces (`components/ui/status-badge.tsx`, no `"use client"` needed): `StatusBadge({ status?: string | null; tone?: Tone; className?: string; children: ReactNode })` — `tone ?? toneOf(status)`; `inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium` + `TONE_CLASS[t]`. Labels stay with callers.
- Callers keep their label maps but drop their tone strings: e.g. `ATTEMPT: Record<Attempt["status"], string>` (labels) + `<StatusBadge status={a.status}>`; content `PUBLISH_ISSUE` keeps labels and `content-panels.tsx:613`'s banner uses `TONE_CLASS[toneOf(item.publishIssue)]`. Agent tile: `<StatusBadge status={agent.enabled ? status : null}>` with today's text (`STATUS_DOT` deleted).

- [ ] **Step 1: Write failing tests** in `tests/status.test.ts`:
  - `toneOf("PUBLISHED") === "good"`, `toneOf("PENDING_VERIFY") === "warn"`, `toneOf("FAILED") === "bad"`, `toneOf("RUNNING") === "info"`, `toneOf("REVIEWED") === "muted"`, `toneOf(null) === "muted"`, `toneOf("nonsense") === "muted"`.
  - Contrast (Review Focus 1): read `app/globals.css`, collect `--name: #hex` from `:root`; for each tone parse `TONE_CLASS[tone]` with `/\bbg-([a-z-]+)(?:\/(\d+))?/` and `/\btext-([a-z-]+)/`, resolve both to hex, composite the tint at its alpha over each of `--card`, `--background`, `--accent`, `--muted`, and assert the WCAG ratio of text on the result is `>= 4.5` (helpers `luminance`/`ratio`/`over` written in the test file; ~12 lines).
  - A scan: no file under `components/` or `app/` contains `StatusPill`, `<Pill` or `@/components/ui/badge` (same walk as `tests/no-hsl-var.test.ts`).
- [ ] **Step 2: Run** `npm test --prefix . -- tests/status.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `lib/status.ts`, the tokens, `StatusBadge`; then replace each caller listed under Files (mechanical: `StatusPill`/`Pill` → `StatusBadge`, same `tone` prop; enum-driven ones → `status=`). Delete `badge.tsx` and the dead tone maps.
- [ ] **Step 4: Run** → PASS; typecheck, lint, full test → green. Manual (dev app): `/settings?tab=members` (an admin row shows "Active" green), `/admin/people`, `/admin/logs` (run statuses), the Overview Ideas/Posts panels if any rows exist — badges read as before, darker green/amber text.
- [ ] **Step 5: Commit** (web) "Show every status through one badge and one status-to-tone map, with darker text on tints so each tone passes contrast".

### Task 3: `PageHeader` and `PageSection`, applied outside Settings (web)

**Files:**
- Create: `components/ui/page-header.tsx` (moved from `components/admin/ui.tsx:93-111` `Crumbs` and `:182-192` `PageHeader`), `components/ui/page-section.tsx`
- Modify: `components/admin/ui.tsx` (delete both; `export { PageHeader } from "@/components/ui/page-header";`)
- Modify: `components/products/products-board.tsx:196-215` (header → `PageHeader` with `actions` = Sync now / Add product, description = the source/sync line), `:108-135` (search + table inside `<PageSection id="catalogue" title="Catalogue">`, table wrapper loses its card classes, `-mx-5`), `components/products/campaigns.tsx:54-60` (→ `PageSection id="campaigns" title="Campaigns and offers"`, list wrapper loses card classes)
- Modify: `app/(shell)/connections/page.tsx:55-61` (→ `PageHeader`)
- Modify: `components/performance/audit-board.tsx:75-98` (`Panel` → `PageSection` with `description` "Last run …" and `actions` = the `Score`), `:183-187` (→ `PageHeader`)
- Modify: `components/context/context-board.tsx:167-185` (→ `PageHeader eyebrow="Strategy documents" title="Brand context"`)
- Modify: `components/agents/agents-board.tsx:56-67` (→ `PageHeader title="Your agents"`; it becomes the page's h1, fixing M2's "no h1 on /agents")
- Verify: build, typecheck, lint; manual (no unit: markup only)

**Interfaces:**
- Produces:
  - `PageHeader({ title: string; eyebrow?: string; crumbs?: { href?: string; label: string }[]; actions?: ReactNode; children?: ReactNode })` — `<header className="flex flex-wrap items-end justify-between gap-4">`; left: crumbs or eyebrow (`text-xs text-primary`), `<h1 className="font-display text-3xl font-medium tracking-tight text-balance">`, `children` in `max-w-prose text-sm text-muted-foreground`; right: `actions` in `flex flex-wrap gap-2`.
  - `PageSection({ id: string; title: string; description?: ReactNode; actions?: ReactNode; className?: string; children: ReactNode })` — `<section aria-labelledby={`${id}-h`} className="rounded-2xl border border-border bg-card shadow-sm">`; head `flex flex-wrap items-start justify-between gap-4 px-5 pt-4` with `<h2 id={`${id}-h`} className="font-display text-lg font-medium">` and description `mt-1 text-sm text-muted-foreground`; body `px-5 py-4`.

- [ ] **Step 1: Implement** the two components and the moves. Keep every existing heading text (e2e reads h1 "Products" and "Connections").
- [ ] **Step 2: Run** typecheck, lint, full test → green; `npm run build --prefix .` → compiles.
- [ ] **Step 3: Manual** (dev app, 1440 px): `/products`, `/connections`, `/performance`, `/context`, `/agents`, `/admin/people` — one title size, actions on the right of the title, sections are white cards with a `px-5` inset on the grey page, no card inside a card.
- [ ] **Step 4: Commit** (web) "Give the pages one header and one section card, moving the console's header into the shared kit".

### Task 4: Settings on `PageHeader` and `PageSection` (web)

**Files:**
- Modify: `components/settings/settings-board.tsx:155-166` (→ `PageHeader title="Settings"`)
- Modify: `components/settings/members-tab.tsx:128-178, 182-188`, `invitations-tab.tsx:82, 110-116`, `roles-tab.tsx:71, 140-146`, `project-access-tab.tsx:71, 123-131`, `connections-tab.tsx:98, 165-170`, `ai-models-tab.tsx:43, 59, 92-98` — each tab's outer `<section aria-labelledby …><SectionHeader …/>` becomes `<PageSection id title description actions>`; inner lists/tables drop `rounded-2xl border border-border bg-card` (and `overflow-hidden`), go `-mx-5`, keep `divide-y`; members' mobile cards and roles' per-role cards become `py-4` rows in a `divide-y` list.
- Modify: `components/settings/shared.tsx:49-71` (delete `SectionHeader`)
- Verify: build, typecheck, lint; manual

- [ ] **Step 1: Implement.** Keep heading ids where other code targets them (grep each `*-heading` id first).
- [ ] **Step 2: Run** typecheck, lint, full test → green; `npm run build --prefix .`.
- [ ] **Step 3: Manual:** each Settings tab at 1440 px and 375 px — one card per section, tables edge to edge inside it, the tablist still above.
- [ ] **Step 4: Commit** (web) "Lay out the settings tabs as section cards under the shared page header".

### Task 5: Credits chip, `PaywallDialog`, priced buttons (web)

**Files:**
- Create: `components/shell/credits-chip.tsx` (`"use client"`)
- Move: `components/shell/paywall-stub.tsx` → `components/shell/paywall-dialog.tsx` (`git mv`), export `PaywallDialog`
- Modify: `lib/plan-credits.ts:3-7` (`Subscription` gains optional fields), add pure helpers; `components/shell/use-plan-credits.ts` (add `useRunPrice`)
- Modify: `app/(shell)/layout.tsx:5, 41` (mount `PaywallDialog`), `components/shell/top-bar.tsx:61-64` (`<CreditsChip workspaceId={workspaceId} />` first in the right-hand group, when `workspaceId`)
- Modify (prices, Decision 8): `components/agents/agent-tile.tsx:93-101`, `components/workspace/workspace.tsx` (agent view run button near :1117, list run buttons near :1354), `components/workspace/content-panels.tsx` (:219-221 Plan posts, :256 Run Scout, NextStep run near :449), `components/workspace/chat-pane.tsx:125-150`, `components/context/context-board.tsx:116-130, 232`, `components/welcome/welcome-flow.tsx:290-300`
- Test: `tests/credits.test.ts`

**Interfaces:**
- Consumes: `planCredits`, `loadPlanCredits`, `Subscription` (0b); `useEntry` inside `use-plan-credits.ts`; `currentPaywall`, `onPaywallChange`, `closePaywall` (0b); `PaywallRefusal` from `@/shared`; `GET /subscription` `prices`/`freeAgents` (Task 1).
- Produces:
  - `Subscription` += `prices?: { manualRun: number; siteAudit: number; storyWrite: number; reelPerSecond: number; presenterPerSecond: number }; freeAgents?: string[]`
  - `agentRunPrice(sub: Subscription | null, agentKey: string): number | null` — null when `sub` is null, `sub.unlimited`, or `prices` missing; 0 when `freeAgents` has the key; else `prices.manualRun`.
  - `withPrice(label: string, credits: number | null): string` — null or 0 → `label`; 1 → `` `${label} · 1 credit` ``; n → `` `${label} · ${n} credits` ``.
  - `creditsLabel(credits: number | null, unlimited: boolean): string` — unlimited → "Unlimited credits"; null → "Credits"; 1 → "1 credit"; n → "n credits".
  - `workspaceIdOf(base: string): string | null` — the decoded segment after `/workspaces/` in a `/api/v1/workspaces/<w>/brands/<b>` base, else null (for `content-panels.tsx`, which only has `base`).
  - `useRunPrice(workspaceId: string | null, agentKey: string): number | null` = `agentRunPrice(entry.subscription, agentKey)`.
  - `paywallCopy(r: PaywallRefusal): { title: string; body: string }` (exported from `paywall-dialog.tsx`) — credits: title "Not enough credits", body `` `This needs ${needed} credit(s). The workspace has ${balance}. Credits are shared by every business in this workspace.` `` (singular for 1); plan: title `r.title`, body "Plans aren't on sale yet. Ask us to turn one on for this workspace."
  - `PaywallDialog({ workspaceId })`: as the stub (forced reload once per opening) + `DialogFooter` with `<DialogClose asChild><Button variant="outline">Close</Button></DialogClose>`.
  - `CreditsChip({ workspaceId }: { workspaceId: string })`: `useCredits` + `usePlan`; a `tool`-styled button (`top-bar.tsx:17`) with `Coins` icon, `popoverTarget="credits-popover"`, text `creditsLabel(...)` (below `sm` the word "credits" is `sr-only`); `<div id="credits-popover" popover="auto" className="fixed inset-auto right-4 top-[76px] m-0 w-72 rounded-2xl border border-border bg-popover p-4 text-sm shadow-lg">` holding the balance, "Shared by every business in this workspace.", the plan line (plan id and renewal date / "Unlimited (test workspace)" / "No plan yet. Plans aren't on sale yet."), and on `failed` "Couldn't read the balance." with a Try again button calling `reload`.
  - Each priced button: label via `withPrice(<today's label>, useRunPrice(workspaceId, key))`; where an `aria-label` exists it starts with the visible text (`` `${withPrice("Run now", price)}, ${agent.name}` ``); after a successful start `void loadPlanCredits(workspaceId, true)`.

- [ ] **Step 1: Write failing tests** in `tests/credits.test.ts` (Review Focus 2):
  - `agentRunPrice(null, "scout") === null`; with `{ plan: null, unlimited: false, plans: [] }` (no `prices`) → null; with `unlimited: true` and prices → null; `prices.manualRun = 5`, `freeAgents: ["quality"]` → `"scout"` 5, `"quality"` 0.
  - `withPrice("Run now", 5) === "Run now · 5 credits"`, `(…, 1)` → "Run now · 1 credit", `(…, 0)` and `(…, null)` → "Run now".
  - `creditsLabel(null, false) === "Credits"`, `(120, false)` → "120 credits", `(1, false)` → "1 credit", `(0, false)` → "0 credits", `(5, true)` → "Unlimited credits".
  - `workspaceIdOf("/api/v1/workspaces/w%201/brands/b1") === "w 1"`; `workspaceIdOf("/x") === null`.
  - `paywallCopy({ insufficientCredits: true, balance: 3, needed: 10 })` → title "Not enough credits", body contains "needs 10 credits" and "has 3"; `needed: 1` → "needs 1 credit."; `paywallCopy({ planRequired: true, title: "Reels need a plan" }).title === "Reels need a plan"`.
- [ ] **Step 2: Run** `npm test --prefix . -- tests/credits.test.ts` → FAIL.
- [ ] **Step 3: Implement** the helpers, `PaywallDialog`, `CreditsChip`, then each priced button.
- [ ] **Step 4: Run** → PASS; typecheck, lint, full test → green. Manual (server on this branch): the chip shows the workspace balance; clicking opens the popover, Escape and an outside click close it; `/agents` "Run now · 5 credits" (an unlimited workspace shows "Run now"); a 402 (a workspace at 0 credits pressing Run) opens the dialog with the server's numbers and a Close button. If no 402 is reachable with the dev data, record that in HANDOVER.
- [ ] **Step 5: Commit** (web) "Show the workspace's credits in the top bar, explain both paywall refusals, and put the server's price on every paid run button".

### Task 6: `JobProgress` (web)

**Files:**
- Create: `components/ui/job-progress.tsx` (`"use client"`)
- Test: `tests/job-progress.test.ts`

**Interfaces:**
- Consumes: the `{ slow, failed, reload }` part of `useJob`'s result (0b).
- Produces:
  - `type JobStep = { label: string; state: "done" | "active" | "waiting" | "failed" }`
  - `progressText(steps: readonly JobStep[], value: number | null): string` — a failed step → `` `Failed: ${label}` ``; all done → "Done"; else `` `Step ${i} of ${n}, ${activeLabel}` `` plus `` `, ${Math.round(value)} %` `` when value is a number (the progress bar's `aria-valuetext`).
  - `stepAnnouncement(prev: readonly JobStep[] | null, next: readonly JobStep[]): string | null` — null when `prev` is null (mount) or when the index of the active step, the failed step and "all done" are unchanged; otherwise `progressText(next, null)`.
  - `JobProgress({ title, steps, value = null, job, onRetry }: { title: string; steps: JobStep[]; value?: number | null; job: { slow: boolean; failed: boolean; reload: () => Promise<void> }; onRetry?: () => void })` — a card (`rounded-2xl border border-border bg-card shadow-sm px-5 py-4`, `section aria-label={title}`); a `role="progressbar"` bar (`aria-valuemin 0`, `aria-valuemax 100`, `aria-valuenow` only when `value` is a number, `aria-valuetext={progressText(...)}`; track `bg-border`, fill `bg-primary`, `motion-reduce:transition-none`); an `<ol>` of steps, each with an `aria-hidden` icon and visible state text ("Done", "In progress", "Waiting", "Failed"); one always-mounted `<p aria-live="polite" className="sr-only">` set from `stepAnnouncement` (previous steps kept in a ref); when `job.slow` and not dismissed, a `role="status"` line "This is taking longer than usual." with "Keep waiting" (dismisses until `slow` turns false again) and "Retry" (`onRetry`, or "Check now" → `job.reload` when no `onRetry`); when `job.failed`, "Couldn't check progress." and "Try again" → `job.reload`.

- [ ] **Step 1: Write failing tests** (Review Focus 3): steps `a: done, b: active, c: waiting` → `progressText(s, 40) === "Step 2 of 3, b, 40 %"`, `progressText(s, null) === "Step 2 of 3, b"`; all done → "Done"; b failed → "Failed: b". `stepAnnouncement(null, s) === null`; same steps in new objects → null; active moves to c → "Step 3 of 3, c"; then all done → "Done"; then all done again → null; a step fails → "Failed: b", and again with the same failure → null.
- [ ] **Step 2: Run** `npm test --prefix . -- tests/job-progress.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; typecheck, lint, full test → green. Glue is checked when feature 2 first renders it (Decision 11).
- [ ] **Step 5: Commit** (web) "Add a job progress card: steps with their state, a progress value, a polite announcement per step, and keep waiting or retry when slow".

### Task 7: Grouped, feature-flagged navigation (web)

**Files:**
- Modify: `lib/features.ts:4-12` (list → type), add `featuresOn`
- Modify: `lib/nav.ts:6-14` (`NavEntry` gains `feature?`; group union adds `"create" | "customers"`), `:20-28` (entries, Decision 12), add `sidebarGroups`
- Modify: `app/(shell)/layout.tsx` (pass `features={featuresOn(workspaceId)}` to the sidebar)
- Modify: `components/shell/sidebar.tsx:15, 76-94` (render `sidebarGroups(features)`: unlabelled main list, then each labelled group with the "Your agents" label style; icons `Images`, `Camera`, `Clapperboard`, `PenSquare`, `Inbox`, `Workflow` added to the icon map)
- Test: extend `tests/features.test.ts`, `tests/nav.test.ts`

**Interfaces:**
- Produces:
  - `WEB_FEATURE_LIST = ["library", "photoshoot", "reels", "stories", "inbox", "automations", "onboarding", "plans"] as const`; `type WebFeature = (typeof WEB_FEATURE_LIST)[number]` (same union as today).
  - `featuresOn(workspaceId: string | null): WebFeature[]` = `WEB_FEATURE_LIST.filter((f) => featureOn(f, workspaceId))`.
  - `NavEntry.feature?: WebFeature` (`import type` from `@/lib/features`; type-only, so the client bundle never loads the server-only module).
  - New entries: `{ id: "automations", label: "Automations", href: "/automations", group: "main", feature: "automations" }` after Connections; `library` "Photo library" `/library`, `photoshoot` "Photoshoot" `/photoshoot`, `reels` "Reels" `/reels`, `studio` "Studio" `/studio` (feature `stories`) in `create`; `inbox` "Inbox" `/inbox` in `customers`.
  - `sidebarGroups(enabled: readonly WebFeature[]): { id: "main" | "create" | "customers"; label: string | null; entries: NavEntry[] }[]` — main first (label null, entries without a feature or with an enabled one), then `create` ("Create") and `customers` ("Customers") only when they have an enabled entry.

- [ ] **Step 1: Write failing tests** (Review Focus 5):
  - features: `WEB_FEATURES="reels, inbox"` → `featuresOn("w1")` equals `["reels", "inbox"]`; `WEB_FEATURES="reel"` → `[]`; `WEB_FEATURE_WORKSPACES="library:w1"` → `["library"]` for w1, `[]` for w2 and null.
  - nav: `sidebarGroups([])` → one group, `main`, ids `["overview", "context", "products", "connections"]`; `sidebarGroups(["reels"])` → main + create with `["reels"]`, no customers; `sidebarGroups(["inbox", "automations"])` → main ends with `automations`, customers `["inbox"]`, no create; every `create`/`customers` entry in `NAV` has a `feature`; `navFor("/studio").title === "Studio"`, `navFor("/reels/abc")` → `{ activeId: "reels", title: "Reels" }`, `navFor("/inbox").title === "Inbox"`, `navFor("/library").title === "Photo library"`. Existing nav tests stay green.
- [ ] **Step 2: Run** `npm test --prefix . -- tests/features.test.ts tests/nav.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; typecheck, lint, full test → green. Manual: no flags → sidebar as today; `WEB_FEATURES=reels,inbox` (restart the web dev server) → "Create: Reels" and "Customers: Inbox" appear; `/studio` breadcrumb reads "Studio".
- [ ] **Step 5: Commit** (web) "Group the coming features under Create and Customers in the sidebar, each shown only when its flag is on, and name their routes".

### Task 8: Page titles, skip link, visible loading placeholder (web)

**Files:**
- Modify: `app/layout.tsx:18-21` (`title: { default: "Espanda", template: "%s · Espanda" }`)
- Modify: `app/(shell)/page.tsx`, `context/page.tsx`, `products/page.tsx`, `connections/page.tsx`, `agents/page.tsx`, `performance/page.tsx`, `settings/page.tsx`, `studio/page.tsx` (each `export const metadata = { title: navFor("/<path>").title }`); `agents/[agent]/page.tsx` (`generateMetadata` → the entry's label, or "Page not found")
- Modify: `app/(shell)/layout.tsx` (first child: `<a href="#content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-2xl focus:bg-card focus:px-4 focus:py-3 focus:shadow-lg focus:ring-2 focus:ring-ring">Skip to content</a>`)
- Modify: `components/workspace/main-area.tsx:12` (`id="content" tabIndex={-1}`, `focus:outline-none`)
- Modify: `components/ui/page-skeleton.tsx:6-7` (blocks `bg-border`, add `<span className="sr-only">Loading…</span>` inside the status div), `components/settings/shared.tsx` `ListSkeleton` (`bg-muted` → `bg-border`)
- Test: `tests/page-titles.test.ts`

**Interfaces:**
- Consumes: `navFor` (Task 7 entries).

- [ ] **Step 1: Write the failing test:** walk `app/(shell)` for `page.tsx` files; every one except the redirect-only `calendar/page.tsx` and `chat/page.tsx` (an explicit allowlist in the test) must contain `export const metadata` or `export async function generateMetadata`. Also `navFor("/settings").title === "Settings"` and `navFor("/").title === "Overview"`.
- [ ] **Step 2: Run** `npm test --prefix . -- tests/page-titles.test.ts` → FAIL (shell pages have no metadata).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; typecheck, lint, full test → green. Manual: tab title "Products · Espanda", "People · Platform admin · Espanda"; first Tab on `/products` shows "Skip to content", Enter moves focus to main and the next Tab reaches "Add product"; the loading skeleton is visibly grey on the canvas.
- [ ] **Step 5: Commit** (web) "Title every page after its place in the navigation, add a skip link to the content, and make the loading placeholder visible and spoken".

### Task 9: Focus and announcement after moving or hiding a panel (C3, web)

**Files:**
- Modify: `components/workspace/panel-layout.tsx` — export `layoutMessage`; the Layout trigger (`:208-211`) gets `id="layout-menu"`; each panel's collapse button (`:316-324`) gets `id={`panel-head-${id}`}`; the panel menu's `DropdownMenuContent` (`:350`) gets `onCloseAutoFocus={(e) => e.preventDefault()}`; `shift`, `move(…, "new-column")` from the menu, and `hide` (menu and Layout checkbox) set a pending `{ id, title }` in a ref; an effect on `layout` focuses `panel-head-<id>` when the panel is in a column, else `layout-menu`, and writes `layoutMessage(...)` into one `<p aria-live="polite" className="sr-only">` in the component; the drag hint (`:244`) reads "Drag a panel by its header, or use its ⋯ menu, to move it. Drag the dividers or use the arrow keys to resize."
- Test: extend `tests/panel-layout.test.ts`

**Interfaces:**
- Produces: `layoutMessage<Id extends string>(title: string, layout: Layout<Id>, id: Id): string` — `` `${title} moved to column ${i + 1} of ${layout.columns.length}` `` when a column holds `id`, else `` `${title} hidden` ``.

- [ ] **Step 1: Write failing tests** (Review Focus 4): layout `[[a],[b,c]]` → `layoutMessage("Context", l, "c") === "Context moved to column 2 of 2"`; after moving `a` right out of a one-panel column, the new layout `[[b,c,a]]` → "… column 1 of 1"; a new third column `[[a],[b],[c]]` for `c` → "column 3 of 3"; `id` in no column → "Context hidden".
- [ ] **Step 2: Run** `npm test --prefix . -- tests/panel-layout.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; typecheck, lint, full test → green. Manual (keyboard only, Overview at 1440 px with a brand): open "Context panel options", Move right → focus on the Context header button, the moved panel; Hide panel → focus on Layout; in DevTools' Accessibility pane the live region reads the message. (`document.activeElement` must not be `body`.)
- [ ] **Step 5: Commit** (web) "Keep keyboard focus on a panel after moving it, or on Layout after hiding it, and announce where it went".

### Task 10: Sidebar as a sheet below 768 px, reflow at 320 px (C1, web)

**Files:**
- Modify: `components/shell/sidebar.tsx` — the current body (`:44-137`, logo to account menu) becomes `SidebarBody(props: Props & { features: WebFeature[] })`; `Sidebar` = `<aside aria-label="Workspace" className="hidden h-full w-[232px] shrink-0 flex-col bg-card md:flex"><SidebarBody/></aside>`; new `MobileNav(props)` = `Sheet` (own `open` state, closed by an effect on `usePathname()` change) with a `SheetTrigger` button (`tool` style from `top-bar.tsx`, `md:hidden`, `Menu` icon, text "Menu" `sr-only` below `sm`) and `SheetContent side="left" className="flex w-[264px] max-w-[85vw] flex-col bg-card p-0"` holding `<SheetTitle className="sr-only">Menu</SheetTitle>` and `SidebarBody`
- Modify: `app/(shell)/layout.tsx:21` (fallback `hidden … md:block`), `:22-30` (build the props once; `Sidebar` as today; pass `nav={<MobileNav … />}` to `TopBar`)
- Modify: `components/shell/top-bar.tsx` (`nav?: ReactNode` prop rendered before the breadcrumb; header `px-4 sm:px-8`; "Logs" and "Espanda" button texts `sr-only` below `sm`)
- Modify: `components/workspace/main-area.tsx:12` (`p-8` → `p-4 sm:p-8`)
- Modify: `app/globals.css:86-89` (delete the `html, body { overflow-x: clip }` rule)
- Verify: build, audit (Task 11), manual

- [ ] **Step 1: Implement.** If removing the clip shows a horizontal scrollbar on a wide screen, find the overflowing element (DevTools) and fix that element; don't put the clip back.
- [ ] **Step 2: Run** typecheck, lint, full test → green; `npm run build --prefix .`.
- [ ] **Step 3: Manual** at 320×640 and 767 px (DevTools device mode): no sidebar; Menu opens the sheet from the left with focus inside; Escape closes it and focus returns to Menu; choosing a link navigates and closes it; the business and account menus work inside it; `/products` heading and "Add product" are whole; no horizontal scroll. At 768 px the sidebar is back and Menu is gone.
- [ ] **Step 4: Commit** (web) "Collapse the sidebar into a menu sheet below tablet width and let the shell reflow down to 320 px instead of clipping it".

### Task 11: "Create a business" reachable by keyboard (C2, web)

**Files:**
- Modify: `components/shell/new-brand-dialog.tsx:20-28, 104-111` (props `trigger?: ReactNode | null; open?: boolean; onOpenChange?: (open: boolean) => void`; controlled when `open` is given; no `DialogTrigger` when `trigger === null`; the reset-on-close logic runs either way)
- Modify: `components/shell/brand-switcher.tsx:101-113` (a `DropdownMenuItem` with the Plus icon and "Create a business", `onSelect={() => setCreating(true)}`; `<NewBrandDialog workspaceId open={creating} onOpenChange={setCreating} trigger={null} />` rendered after `</DropdownMenu>`; a ref on the "Select business" trigger, passed so the dialog's `onCloseAutoFocus` focuses it)
- Verify: typecheck, lint; manual keyboard run

**Interfaces:**
- Produces: `NewBrandDialog({ workspaceId, trigger, open, onOpenChange, returnFocus }: { workspaceId: string; trigger?: ReactNode | null; open?: boolean; onOpenChange?: (open: boolean) => void; returnFocus?: RefObject<HTMLElement | null> })` — `returnFocus` used in `DialogContent onCloseAutoFocus` (`e.preventDefault(); returnFocus.current?.focus()`). Existing callers (`context/page.tsx`, the empty-brand switcher) unchanged.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Run** typecheck, lint, full test → green.
- [ ] **Step 3: Manual** (keyboard only, a workspace with a brand and `brand.create`): Tab to "Select business", Enter, ArrowDown reaches "Create a business", Enter opens the dialog with focus in the name field; Escape closes it and focus is back on "Select business"; mouse click on the item still works; the page stays clickable afterwards (no stuck `pointer-events: none` on `body`).
- [ ] **Step 4: Commit** (web) "Make Create a business a real menu item that opens its dialog outside the menu, so the keyboard can reach it".

### Task 12: UI audit at 320 px and on every shell route (web)

**Files:**
- Modify: `scripts/audit-ui.ts:13` (`PRIVATE` adds `/products`, `/connections`, `/agents`, `/studio`, `/settings?tab=members`, `/admin`, `/admin/people`), `:62` (viewports add `["narrow", { width: 320, height: 640 }]`), `:35-45` (metrics add `offscreen`: visible elements inside `main` or `header` whose `getBoundingClientRect().right > innerWidth + 1`, count plus up to 5 names, printed on the `extras` line), `:1-4` (header comment: the 320 pass and why — C1 was hidden by `overflow-x: clip`; run with `npm run audit:ui --prefix .`)
- Verify: run it

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Run** typecheck, lint, full test → green.
- [ ] **Step 3: Run the audit:** server dev on :3101 from the server repo; in web `npm run build --prefix .` then `npm run start --prefix .`; then `SEED_ADMIN_EMAIL=… SEED_ADMIN_PASSWORD=… npm run audit:ui --prefix .`. Expected: every `narrow` line `overflow:none` and `offscreen: 0`; no `color-contrast` rule on the pages with badges; `page-has-heading-one` gone from `/agents`. Paste the summary into HANDOVER (Task 13). The dev admin may land on `/welcome` or `/admin` for brand pages; say which routes really rendered.
- [ ] **Step 4: Commit** (web) "Audit every shell route at 320 px too, and count content pushed past the right edge, which clipping used to hide".

### Task 13: Documentation and whole-slice check

**Files:**
- Modify (server): `docs/DESIGN_SYSTEM.md` §2 (rows for `--success-ink`, `--warning-ink`: "status text on tints"), §3 (row "Page title (`PageHeader`): `text-3xl font-medium`"), §4 (non-Overview pages: `p-4 sm:p-8`; `PageSection` = the section card, `px-5`, `text-lg` title, lists edge to edge inside), §7 (`PageHeader`, `StatusBadge` rows point at `components/ui/page-header.tsx`, `status-badge.tsx` + `lib/status.ts`; add `PageSection`, `JobProgress`, `CreditsChip`, `PaywallDialog`), §10 (`< md`: sidebar in a sheet from the Menu button)
- Modify (server): `docs/HANDOVER.md` — a "Foundations 0c" entry above 0b: what changed, the Decisions that change what people see (title size, badge colours, prices hidden for unlimited workspaces, no sidebar below 768 px), the audit summary, "not checked live" items (402 dialog, priced buttons against a real balance, JobProgress until feature 2)

- [ ] **Step 1: Edit** both; commit in server: "Record the website's UI kit, its tokens and the accessibility fixes in the design system and the handover".
- [ ] **Step 2: Web:** `npm run typecheck --prefix .`, `npm run lint --prefix .`, `npm test --prefix .`, `npm run build --prefix .`, `npm run check:bundle --prefix .` → all green. **Server:** typecheck, lint, test → green.
- [ ] **Step 3:** request a whole-branch review (superpowers:requesting-code-review) across server and web before calling 0c done.
