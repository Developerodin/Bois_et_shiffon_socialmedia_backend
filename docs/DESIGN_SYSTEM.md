# Design System — Multi-Brand AI CMO Platform

Neutral platform chrome; **per-brand** accent may come from brand photography and optional `BrandProfile` theme tokens later. **shadcn/ui** + Tailwind CSS. Do not copy Okara or Scalio branding. B&C seed uses warm editorial tokens below as **one brand’s** preview—not global product skin.

---

## 1. Principles

- **Editorial hierarchy:** Content and imagery lead; chrome stays quiet
- **Restraint:** Neutral surfaces, one accent, generous whitespace
- **Status clarity:** Workflow states (draft, in review, approved, published, failed) always visible
- **Accessibility:** WCAG 2.2 AA contrast for text; focus rings; keyboard paths for dialogs and tables

---

## 2. Color tokens (CSS variables)

Source of truth: `apps/web/app/globals.css` (hex, light mode only). The values below are as built.

| Token | Value | Usage |
|-------|-------|--------|
| `--background` | `#f6f5f9` | Page background behind panels (cool off-white) |
| `--foreground` | `#191620` | Primary text |
| `--card` | `#ffffff` | Cards, panels, sidebar, top bar |
| `--muted` | `#f2f0f7` | Secondary surfaces, loading placeholders, disabled buttons |
| `--muted-foreground` | `#5e596b` | Meta text |
| `--border` | `#ded9e6` | Card outlines, dividers |
| `--primary` / `--primary-strong` | `#5b50d6` / `#4c40bb` | Actions, active nav |
| `--accent` / `--accent-foreground` | `#eeeafc` / `#4c40bb` | Icon tiles, selected rows |
| `--destructive` | `#b42318` | Errors, reject |
| `--success` | `#1a7f4b` | Approved, healthy |
| `--warning` | `#9a5b00` | Warnings |
| `--success-ink` | `#146b3e` | Status text on tints (success badges); passes 4.5:1 on the tint |
| `--warning-ink` | `#8a5100` | Status text on tints (warning badges); passes 4.5:1 on the tint |

**Brand note:** In brand-scoped views, product/hero imagery carries color; platform chrome stays neutral so any onboarded brand’s assets dominate.

---

## 3. Typography

| Role | Font stack | Size / line |
|------|------------|-------------|
| Display (`.font-display`) | `Inter` | `text-2xl` page greetings, `text-lg` panel titles |
| Page title (`PageHeader`) | `Inter` | `text-3xl font-medium` |
| UI / body | `Inter`, system-ui | `text-sm` base, `leading-relaxed` |
| Mono / data | `JetBrains Mono` | SKUs, ids, metrics |

Loaded via `next/font` in `app/layout.tsx`.

---

## 4. Spacing & layout

- Base unit: 4px (`space-1`); radius token `--radius: 1rem` (`rounded-2xl` for cards and controls)
- Shell: sidebar `232px`, top bar `72px` (`h-18`), assistant panel on the right from `xl`
- **Languages** (`components/languages/languages.tsx`): `LanguageSelects` (team working language + post language, used by Settings → Languages and the run dialog), `LanguageDialog` (asked once before a first run; mounted in the shell next to the paywall dialog), `TranslateToggle` (ghost "Translate" button; while shown, "Machine translation" + "Show original").
- **Assistant panel** (`components/shell/assistant-panel.tsx`): a card (`rounded-2xl border bg-card shadow-sm`) set `12px` off the edges; docked it sits under the top bar, which spans the page and the panel, so its controls reach the right edge. Expanded: `w-[min(56rem,100vw)]` over the scrim, conversation in a `max-w-3xl` column; a `w-80` spacer keeps the docked column's place.
- Non-Overview pages: `p-4 sm:p-6` inside the main area (top bar `sm:px-6` to match), `gap-5` between page blocks, document cards `p-5 sm:p-6`
- **`PageSection`** (`components/ui/page-section.tsx`) is the section card on those pages: `rounded-2xl border border-border bg-card shadow-sm`, `px-5` inset, `text-lg` title, optional description and actions; lists inside run edge to edge. A header-only section (no children) sits above an `EmptyState` or error shown outside the card, never a card in a card. The admin console alone uses its own flat (no card) `Section` (`components/admin/ui.tsx`).
- **Overview panels** (`components/workspace/panel-layout.tsx`): each panel is a card (`rounded-2xl border bg-card shadow-sm`) on `--background`, `12px` (`gap-3` / `p-3`) between cards. The gap between columns is the resize handle; its line shows only on hover or focus. A column whose panels are all collapsed shrinks to `15rem`.
- **Inside a panel:** one inset for everything, `px-5`. Sections are separated by spacing (`py-4`), not divider lines; list rows that need edge-to-edge hover use `-mx-2 px-2`.
- Icon tiles: agent and task icons sit on `bg-accent` tiles (`size-8 rounded-lg` in rows, `size-12 rounded-xl` in the agent grid).
- Max content width for reading: `max-w-3xl` (brief editor); dashboards `max-w-7xl`

---

## 5. Elevation & borders

- Cards: `border border-border shadow-sm` (no heavy shadows)
- Modals: `shadow-lg`
- Focus: `ring-2 ring-primary ring-offset-2`

---

## 6. shadcn/ui components (install order)

1. `button`, `input`, `label`, `textarea`
2. `dialog`, `dropdown-menu`, `select`
3. `table`, `badge`, `tabs`
4. `calendar` (date picker for Screen 7)
5. `toast` / sonner for feedback
6. `sheet` for mobile nav

Customize via CSS variables above in `components.json`.

### Toast (built: `web/components/ui/toast.tsx`, not shadcn/sonner)

A small own component for "something finished while you were elsewhere", mounted once in the shell. Used today only by the agent watcher.

- **Placement:** stacked bottom-right, `max-w-sm`, full width on a phone, above the home bar (`env(safe-area-inset-bottom)`), `z-[70]`. The newest three stay.
- **Timing:** dismissed after 10 s; the timer pauses while the pointer is over it or focus is inside; the close button (`Dismiss`, 36 px target) always works.
- **Motion:** the same short `rise-in` as other page parts (280 ms); off under `prefers-reduced-motion`.
- **Tone:** `success` (border `success/50`) for a finished run, `warning` (border `warning/60`) for one that needs a look. Card surface, `rounded-2xl`, a bold title and one muted detail line. Plain text only.
- **Link:** an optional `href`, accepted only for in-app paths: "/" then a letter, digit, "?" or "#"; "//host", "/\host" and any control character (a tab or newline browsers drop from a URL) are rejected; the whole body is then a button that dismisses and navigates.
- **Brand switch:** toasts clear (they belong to the brand the watcher was watching).
- **Announcing:** the stack is `role="status"` with `aria-live="polite"`.
- **Copy:** "<Agent> finished" or "<Agent> needs a look", the failure reason in the detail line. Runs with nothing to do stay silent.

---

## 7. Application components (feature-level)

| Component | Responsibility |
|-----------|----------------|
| `AppShell` | Sidebar + header + workspace selector + **brand switcher** |
| `BrandSwitcher` | Lists accessible brands; shows `displayName` + status; blocks navigation actions when none selected (REQ-PLAT-002) |
| `BrandLabel` | Chip in header: active brand name; portfolio mode shows “Portfolio” badge |
| `PageHeader` | Title (`h1`, `text-3xl`), description, primary action (`components/ui/page-header.tsx`) |
| `PageSection` | Titled section card with `px-5` inset (`components/ui/page-section.tsx`) |
| `StatusBadge` | Maps workflow enums to a tone and label (`components/ui/status-badge.tsx`; the one status-to-tone map is `lib/status.ts`, text on tints uses the `-ink` tokens) |
| `JobProgress` | Step list and progress bar for a long job, with slow and failed notices (`components/ui/job-progress.tsx`; used by the photoshoot, which keeps it mounted after the job ends so the end is announced; the reel's Video step unmounts it at the end instead, and the page's live region announces the end) |
| `CreditsChip` | Top-bar balance chip with a popover (`components/shell/credits-chip.tsx`); paid buttons show their price from the server, unlimited workspaces show none |
| `PaywallDialog` | Opens on a recognisable 402 (`components/shell/paywall-dialog.tsx`, state in `lib/paywall.ts`) |
| `LibraryPicker` | Photo chooser for features that start from the library: `onUse(photo: LibraryPhoto)`, `children` for feature-specific text (`components/library/library-picker.tsx`; used by the photoshoot's source and garment rows) |
| `PhotoGrid` / `SourceSwitch` | Library photo grid with keyboard selection, and the switch between uploads and generated photos (`components/library/photo-grid.tsx`, `library-board.tsx`); `SourceSwitch` is a thin wrapper over `SegmentedRadios`. In pick mode the chosen tile has a primary border and a check badge; keyboard focus is a separate `ring-2 ring-ring` |
| `SegmentedRadios` | Pill radio group in a fieldset with a screen-reader legend: `label`, `name`, `value`, `onChange`, `options` (`value`, `label`, optional `count`). Native radios, so arrows and space work; the chosen pill is filled and keyboard focus draws an offset ring (`components/ui/segmented-radios.tsx`). The admin `Segmented` (`components/admin/ui.tsx`) is the link version for page-level tabs and is separate |
| `ChoiceCards` | Radio group shown as cards: visible `legend`, `columns` 2, 3 or 4, options with `title`, `description`, `meta`. The chosen card has a primary border, a tint and a check icon; keyboard focus is a separate `ring-2 ring-ring` so the two never share a colour (`components/ui/choice-cards.tsx`). `PhotoGrid`'s pick tiles mark the chosen photo the same way (a primary border and a check badge, focus as a separate ring) but share no code with the cards: the tiles show photos, without the tint; a change to one should be checked against the other |
| `StepsRail` | The steps of a flow as links: `label`, `steps` (`id`, `label`, `state`, `href`), `current`. The current step has `aria-current="step"` and each state is shown as text. Below `md` it is a "Step N of M: label" button that opens the same list in a sheet, mounted only when opened (`components/ui/steps-rail.tsx`; used by the one-reel page) |
| `ChecksList` | A quality check's results: `results` (`check`, `status` `pass` / `warn` / `blocker`, `note`). Each status is an icon with an `aria-label`; used by the Overview's Quality check section and the reel Review step (`components/ui/checks-list.tsx`) |
| `PreviewFrame` | 9:16 frame for a reel: `photoUrl`, `videoUrl`, `alt`, `onScreenText` (real text over the photo), `children`, `captionsUrl` (a WebVTT link: adds a captions track, on by default), `captionsLang`, `noDownload` (hides the player's own download item; cosmetic). Below `md` at most 60vh tall, with the width narrowed to keep 9:16; a `<video>` only when `videoUrl` is set, with native controls and no autoplay (`components/ui/preview-frame.tsx`) |
| `AudioRecorder` | One microphone take: `maxSeconds`, `minSeconds`, `disabled`, `notice`, `onTake(blob, seconds)`, `onStart`, `onBusyChange`, `label`. Start recording / Stop recording, a device select, a timer, and an announced "Recording started". Stops by itself at `maxSeconds`. The mic is on only while recording and is released on stop, on a device change, on a failed start and on unmount; a closed recorder sends nothing (`components/ui/audio-recorder.tsx`; used by the scene record dialog and the clone dialog) |
| `VoiceRow` | One voice: `name`, `prefix`, `detail`, `sampleUrl`, `playing`, `onToggle`, `action` slot. Shows a "Play sample, name" / "Stop sample" toggle (`aria-pressed`) only when there is a sample (`components/reels/voice-row.tsx`; used by the Voices sheet and the Script step) |
| `EmptyState` | Illustration-free; clear CTA |
| `DataTable` | Sortable columns, filter row |
| `OpportunityCard` | Score, rationale, product chip |
| `ContentPreview` | IG caption truncation preview (125 chars) — mirrors `caption.py` UX |
| `ApprovalBanner` | Version id, approver, blocking checks |
| `IntegrationHealthPill` | Connected / degraded / error |
| `LoadingSkeleton` | List and card placeholders |

---

### Photoshoot data rules (web)

- `useJob` (`components/workspace/use-job.ts`) takes an optional `stopOn` list of HTTP statuses (the photoshoot passes
  403 and 404 so a missing shoot is not polled) and returns `status`, the last error's HTTP status or `null`.
- Signed image links expire after an hour. `SIGNED_LINK_STALE_MS` (50 minutes) and `stale(fetchedAt)` in `lib/signed-links.ts`
  (a plain module, so pure helpers and server pages can import it without the client-only `use-job.ts`) are the one rule: nothing renders an image from an answer older than that, and the list and shoot page re-read before then.
- A paid button shows its price from the server: `shootPrice(sub, tier)` in `lib/plan-credits.ts` (no price for
  unlimited workspaces), and `shootPriceBlocker` holds the press until the plan has been read.

---

## 8. Imagery

- Product thumbnails: fixed aspect `aspect-[4/5]` in grids
- Hero previews: `aspect-video` for Reel
- Use `next/image` with explicit sizes; lazy load below fold
- Placeholder when asset rights `PENDING` — never show unlicensed competitor media

---

## 9. Motion

- Subtle: `transition-colors duration-150`
- Avoid gratuitous animation; respect `prefers-reduced-motion`

---

## 10. Responsive breakpoints

| Breakpoint | Behavior |
|------------|----------|
| `< md` (below 768 px) | No sidebar; it opens in a sheet from the Menu button; stack filters |
| `md+` | Sidebar visible |
| `lg+` | Two-column studio (editor + preview) |

---

## 11. Content-specific patterns

### Opportunity feed

- Left: source + timestamp + provenance link
- Center: title + AI summary (labeled)
- Right: score + actions (shortlist / reject)

### Studio

- Split pane: editor | live preview (platform toggle)
- Version timeline vertical rail

### Calendar

- Month grid + list toggle; overdue in `--warning`
- Filter row above the list (Phase 0): Channel, Status, Campaign (only when posts belong to campaigns), Owner (Anyone,
  Mine, Unassigned), Needs action. Filters run in the browser over the loaded window.
- No-matches state: "No posts match these filters" with a Clear filters button; the filter row stays visible.
- Owner label on each card: small muted text, the owner's name, "A team member" when the server sent none, or "Unassigned". Setting it is a select in the post's
  detail view (people from `GET content/owners`).
- New post dialog: opens from a product; one column (`grid-cols-[minmax(0,1fr)]`) so long names never scroll it sideways.

---

## 12. Accessibility checklist (per screen)

- [ ] All icons with `aria-hidden` + text label or `aria-label`
- [ ] Form errors linked with `aria-describedby`
- [ ] Table headers `scope="col"`
- [ ] Dialog focus trap and Esc close
- [ ] Color not sole indicator of status (icon + text)

---

## 13. Authorization & data honesty (Phase 0.5)

### Permission-denied states

- Destructive or privileged actions hidden **and** server-enforced; when user lacks capability, show inline **“You don’t have permission”** with request-access hint — never a no-op button.
- OWNER separation override (`content.approve.self`): confirm dialog + audit notice in `ApprovalBanner`.

### Stale commercial data

- Product stock past freshness TTL: `--warning` badge **“Stock unverified”** with last-checked timestamp; publish CTA disabled at UI level (server still authoritative).
- Expired offer linked to draft: banner **“Offer ended”** with link to commercial settings.

### Unavailable metrics (REQ-BRIEF-019)

- Use em dash or **“Unavailable”** label — never `0` for missing platform metrics.
- `delayed` metrics: subtle **“Updating…”** with `observedAt` when known.
- Comparison charts: footnote when metrics are not cross-platform comparable (GA4 vs Meta).

### Integration health

- `IntegrationHealthPill`: `healthy` | `degraded` | `error` | `disconnected` with reconnect CTA on `error`.

---

## 14. Files to create (Screen 1)

- `app/globals.css` — tokens
- `tailwind.config.ts` — extend fontFamily, colors
- `components/ui/*` — shadcn
- `components/layout/app-shell.tsx`
- `components/layout/brand-switcher.tsx`

### Brand switcher UX (REQ-PLAT-002)

- Placement: header, adjacent to workspace selector
- No primary CTA (create brief, approve, publish, connect integration) without `activeBrandId` — show inline prompt “Select a brand”
- Archived brands: visible to admins in switcher with “Archived” badge; read-only history routes only
- Portfolio view: separate nav entry; distinct from brand context (DEC-022)
- `lib/design-tokens.ts` — export status color map for badges
