# Accessibility review (WCAG 2.2 AA): mobile flows coming to web

Date: 2026-11-17. Lens: accessibility only. "Before" review: the current web app as it stands, the mobile screens the port
copies, and what each coming feature has to meet on web.

## How this was checked

- The web (:3100) and server (:3101) dev apps were not running when the review started, so they were started with
  `npm run dev:web` / `npm run dev:server` from the repo root. Nothing else changed. Code is untouched.
- axe-core (tags wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa, best-practice) at 1440x900, light theme, signed in
  with `e2e/.auth/owner.json` on `/`, `/context`, `/products`, `/connections`, `/agents`, `/agents/scout`,
  `/performance`, `/studio`, `/settings`, `/settings?tab=connections`, `/settings?tab=members`, `/agents/spark`; and
  with `admin.json` on `/admin`, `/admin/activity`, `/admin/people`, `/admin/workspaces`, `/admin/spend`,
  `/admin/logs`, `/admin/models`.
- Playwright keyboard runs on the Overview: tab order, the top-bar Layout menu, the panel options menu (Move right,
  Hide panel), the collapse toggle, the column separator, Account menu, Logs drawer, the assistant drawer at 1100 px,
  the business menu and the "Add a brand" dialog (opened, then closed with Escape). Panel moves only touch
  localStorage in a throwaway browser context. No agent runs, no saves.
- Reflow at 320 CSS px wide (the 400 % zoom case), reduced motion (`reducedMotion: "reduce"`), and contrast worked out
  from the tokens in `apps/web/app/globals.css`.
- Mobile: a source read of `apps/mobile/src/app/**` and `apps/mobile/src/ui/**`.
- The scripts are in the session scratchpad (`a11y/axe-sweep.mjs`, `kbd.mjs`, `kbd2.mjs`, `kbd3.mjs`), not the repo.

Not covered: screen-reader runs with real assistive tech (NVDA/VoiceOver), Windows high-contrast mode, and dark theme
(the app ships light only).

## Summary

axe finds only a few rule types, and they repeat on every page. The serious problems are ones axe can't catch:
**the shell doesn't reflow at 320 px**, **"Create a business" can't be reached by keyboard**, and **moving or hiding an
Overview panel drops focus to `<body>`**. Every coming feature is built inside this shell, so these three come
first. The mobile app has good accessibility habits that the port should keep, mainly labelled controls, progress
bars with values, polite live regions, and button alternatives to dragging. It also has gaps the web port shouldn't
copy: no captions on reels, recorder results that aren't announced, and no contrast check on brand colours.

---

## Findings on the current web app

### Critical

**C1. The shell does not reflow: at 320 CSS px the sidebar keeps 232 px and the page gets 88 px, with content cut
off.** WCAG 1.4.10 Reflow (AA).
- Evidence: at 320x640 on `/`, `/products` and `/settings`, `aside` is 232 px wide and `main` is 88 px. Headings and
  buttons are cut off ("Produ…", "Add p…"). Horizontal overflow is 0 only because `html, body { overflow-x: clip }`
  (`app/globals.css` base layer) hides it, so the clipped content can't be reached at all.
- Source: `components/shell/sidebar.tsx:44` (`w-[232px] shrink-0`, never collapses), `app/(shell)/layout.tsx:20`.
- Why it matters for the port: every coming screen (reels, stories, inbox) sits in this frame. Someone using 200–400 %
  zoom on a laptop hits this today. Below about 768 px the sidebar has to collapse into a menu button with a drawer.
  The assistant drawer already does this below 1280 px. Then remove `overflow-x: clip` or limit it to the body, so
  overflow can be seen and fixed rather than hidden.

**C2. "Create a business" can't be reached from the keyboard.** WCAG 2.1.1 Keyboard (A), 4.1.2 Name, Role, Value (A).
- Evidence: in the business menu (sidebar, `Select business`), ArrowDown moves only between `role=menuitem` rows.
  "Create a business" is a plain `<button>` inside `role=menu`, so the arrows skip it. Tab is swallowed by the Radix
  menu (focus stayed on the last brand, menu still open). Mouse users can reach it; keyboard users can't.
- Source: `components/shell/brand-switcher.tsx:101-110` (the `NewBrandDialog` trigger is a `<button>`, not a
  `DropdownMenuItem`).
- Fix: make it a `DropdownMenuItem` whose `onSelect` opens a dialog held outside the menu, so the dialog doesn't
  unmount when the menu closes. Fuller onboarding and multi-brand flows are coming, so this entry point matters more
  soon. Once open, the dialog itself is fine: focus goes to the name field, Tab cycles inside, Escape closes it and
  focus returns to its trigger, and axe finds nothing in it.

**C3. Moving or hiding an Overview panel from its options menu loses focus.** WCAG 2.4.3 Focus Order (A), 4.1.3
Status Messages (AA).
- Evidence: after `Context panel options` → "Move right", `document.activeElement` is `<body>`. The same happens
  after "Hide panel". The panel moved (order became Today & agents, Context, Agents feed), but nothing announced it
  and keyboard users have to start again from the top of the page.
- Source: `components/workspace/panel-layout.tsx:332-338` (menu items) together with the `<section key={id}>` at :268
  being re-parented into another column, which React remounts, so Radix's focus-return target is gone.
- Fix: after `move`/`shift`/`hide`, focus the moved panel's header button (or the Layout button when the panel was
  hidden) in an effect, and write "Context moved to column 2 of 3" or "Context hidden" to one polite live region. The
  column-resize keyboard path and the collapse toggle are fine (focus stays, `aria-expanded` updates).

### Important

**I1. Every workspace page has the same title, "Espanda".** WCAG 2.4.2 Page Titled (A).
- Evidence: `document.title` is "Espanda" on `/`, `/context`, `/products`, `/connections`, `/agents`, `/performance`,
  `/studio` and `/settings` (all tabs). Admin pages do this right ("People · Platform admin").
- Source: `app/layout.tsx:19` metadata only; no `metadata`/`generateMetadata` in the `(shell)` pages outside `admin/`.
- Port rule: every new route (Reels, Stories, Inbox, Automations, Plans, each onboarding step) sets
  "<Step or screen> · <Area> · Espanda", and the step number for wizards ("Record voiceover, scene 2 of 5 · Reels").

**I2. Column resizing has no single-pointer alternative to dragging.** WCAG 2.5.7 Dragging Movements (AA, new in 2.2).
- Evidence: `components/workspace/panel-layout.tsx:357-372`. The separator works with a pointer drag or the arrow
  keys, but 2.5.7 asks for a non-drag pointer method, and the keyboard doesn't count as one. Moving panels is fine:
  the options menu has click alternatives.
- Fix: add "Wider / Narrower" items to each panel's options menu, or an "Equal widths" item. Presets in the Layout
  menu only partly cover this. Also give the separator Home/End keys and announce the value as a percentage
  (`aria-valuetext="Context 63 %"`). Home did nothing in testing (79 → 79).

**I3. Status pills fail text contrast (4.06–4.38:1 at 11–12 px).** WCAG 1.4.3 Contrast (Minimum) (AA).
- Evidence (axe): `text-success` on `bg-success/10` = 4.38:1 (`/settings?tab=members`, `/admin/people`,
  `/admin/models`). On `bg-success/15` = 4.11:1 ("New" chip on the Overview's document list). `text-primary` on
  `bg-primary/10` with a primary border = 4.13:1 (`/context`).
- Source: `components/settings/shared.tsx:20-25` (`TONES.good`), `components/workspace/workspace.tsx:475`,
  `components/workspace/content-panels.tsx:186-197`, `components/workspace/release-panel.tsx:558`.
- Fix: use `text-primary-strong` and a darker success-ink token (for example `#146b3e`) for text on tinted chips. The
  port will add many more chips (render state, reply state, plan tier, automation status), so fix the tone tokens
  once now.

**I4. Links inside running text show only by colour.** WCAG 1.4.1 Use of Color (A).
- Evidence (axe): `/performance` "SEO agent" and "GEO agent". `#5b50d6` against the surrounding muted text
  `#5e596b` is 1.14:1, with no underline until hover.
- Source: `components/performance/audit-board.tsx:93`.
- Fix: always underline links in text. This matters because inbox replies, reviews and onboarding copy will have a
  lot of inline links.

**I5. Scroll regions you can't reach by keyboard.** WCAG 2.1.1 Keyboard (A).
- Evidence (axe `scrollable-region-focusable`, on every page that shows the assistant): the chat message list
  `div.overflow-y-auto.p-6`, `components/workspace/chat-pane.tsx:215`. The Agent log already does this right
  (`components/agents/agent-log.tsx:120-127`: `role=log`, `tabIndex=0`, label, focus ring).
- Fix: `tabIndex={0}`, `role="log"`, `aria-label="Conversation"`. Every new scrolling pane (inbox thread, storyboard,
  frame list, photo library grid) needs the same.

**I6. Visible label not in the accessible name.** WCAG 2.5.3 Label in Name (A).
- Evidence (axe, 13 nodes on `/agents`, 2 on every other page): `Select business` (visible text: the business name),
  `Account menu` (visible: the user's name and role), and `Run Research now` and the other agent tiles (visible:
  "Run").
- Source: `components/shell/brand-switcher.tsx:66`, `components/workspace/account-menu.tsx:38`,
  `components/agents/agent-tile.tsx:99`.
- Fix: put the visible words first in the name, for example `aria-label={`${active.displayName}, switch business`}`
  and "Run Research". Speech-input users say what they see.

**I7. There is no skip link, and 14 sidebar stops come before the page.** WCAG 2.4.1 Bypass Blocks (A). The landmarks
technically pass it; this is a usability gap for sighted keyboard users.
- Evidence: from a fresh load of `/products`, Tab goes through the logo, Select business, 4 nav links, 8 agent links,
  Account menu and Logs before reaching "Add product" (stop 17). `main` has no `id`.
- Source: `app/(shell)/layout.tsx`, `components/workspace/main-area.tsx:12`.
- Fix: a "Skip to content" link as the first focusable element, targeting `<main id="content" tabIndex={-1}>`.
  Reels and stories editors will have long toolbars, so give them their own "Skip to preview" / "Skip to frames"
  links too.

**I8. The assistant drawer says it is a dialog but doesn't act like one.** WCAG 4.1.2 (A), 2.4.3 (A).
- Evidence: at 1100 px the drawer opens with `role=dialog`, focus moves to the `<aside>`, Escape returns focus to the
  toggle (good). But 12 Tabs lead out of the drawer to the sidebar's "Connections" link behind the scrim. There's no
  `aria-modal` and no focus trap. The comment at `components/shell/assistant-panel.tsx:27-29` says this is
  deliberate.
- Fix: choose one. Either keep it non-modal, drop `role=dialog` and the scrim, and use `role=complementary` with a
  label; or make it modal with `aria-modal="true"`, trap focus and make the page behind it inert. The scrim plus
  `role=dialog` tells screen-reader users something that isn't true.

**I9. The page loading skeleton announces nothing.** WCAG 4.1.3 (AA).
- Evidence: `components/ui/page-skeleton.tsx:7` is `role="status" aria-label="Loading"` with no text inside. Live
  regions read their text content, not `aria-label`, so nothing is spoken. `ListSkeleton`
  (`components/settings/shared.tsx:73-84`) does it right with an `sr-only` label.
- Fix: put `<span className="sr-only">Loading {page}…</span>` inside `PageSkeleton`.

### Minor

- **M1. The new grey placeholder is barely visible.** `ListSkeleton` `bg-muted` (#f2f0f7) on a card (#fff) is 1.13:1,
  and on the canvas 1.04:1. `PageSkeleton` `bg-muted/60` on the canvas is 1.02:1. A loading placeholder isn't strictly
  required to meet 1.4.11 because it now has text for screen readers, but low-vision users will see an empty panel,
  which is the problem commit 68640b3 meant to fix. Suggest `bg-border` (#ded9e6, 1.38:1 on a card) or a darker
  skeleton token. The pulse is correctly turned off under `motion-reduce`. Render and photoshoot "generating" screens
  will reuse this, so set it once.
- **M2. The Overview's heading order follows the panel order.** The DOM gives h2 "Atelier Sorrel", h2 "Documents" and
  others before h1 "Welcome, …" (`components/workspace/workspace.tsx:578`, :834). `/agents` has no h1 at all (axe
  `page-has-heading-one`). WCAG 1.3.1, best practice. Keep the h1 first in the DOM, for example a visually hidden
  "Overview" h1 in the top bar area.
- **M3. Tab order doesn't match visual order in the agent grid.** The tab order goes "Analyst, SEO, GEO" (y=782) and
  then "Competitors" (y=695), so focus jumps back up the screen. WCAG 2.4.3 / 1.3.2.
- **M4. Small targets.** The context panel's "Edit" button is 21x24 px, below the 24x24 minimum (WCAG 2.5.8 Target
  Size (Minimum), AA, unless the spacing exception applies). Check this while porting icon buttons: the mobile app
  uses 44 px everywhere (`ui/reels/kit.tsx` `square44`).
- **M5. Menu items show focus only with a background tint.** `components/ui/dropdown-menu.tsx:81,97,121` use
  `focus:bg-accent` (#eeeafc on #fff, about 1.1:1) with `outline-none`. Today the text-colour change to
  `accent-foreground` makes the focused item visible, but it's weak. Add an inset ring for keyboard focus
  (`data-[highlighted]:ring-2 ring-inset`). WCAG 2.4.7 (AA); 2.4.13 is AAA but worth aiming for.
- **M6. The drag-hint text in the top bar mentions only the mouse.** "Drag a panel by its header to move it. Drag the
  dividers to resize." (`panel-layout.tsx:206`). Add "or use the ⋯ menu / arrow keys on the divider".
- **M7. Under 1024 px, the panel tabs use `aria-current="page"` on `<button>`s** (`panel-layout.tsx:236-246`). Use
  `role=tablist`/`tab` with `aria-selected`, as Settings already does (`components/settings/settings-board.tsx:96-128`).
- **M8. Landmark labels are duplicated.** The sidebar is `aside[Workspace]` and contains `nav[Workspace]`. Admin
  adds an unlabelled `aside` and a second `header`. A missing route under `/agents/*` (for example `/agents/scout`,
  which isn't in `lib/nav.ts`) renders the 404 `ErrorScreen` with its own `<main>` inside the shell's `<main>` (axe
  `landmark-no-duplicate-main`, `landmark-main-is-top-level`). Rename the nav to "Main", label the admin aside, and
  give the in-shell 404 a `<div>` root.
- **M9. Story frame videos have no captions track.** `components/workspace/content-panels.tsx:590` uses
  `<video controls>` without `<track>` (WCAG 1.2.2). Currently user-supplied clips; see the Reels requirements.

### What already works (keep it)

- Focus ring on buttons, links and switchers (`focus-visible:ring-2 ring-ring`, `primary` on the canvas is 5.43:1).
  Every tab stop checked on the Overview had a visible indicator except the separator, which shows a 2 px primary
  line through `::after`. That is visible, if thin.
- Layout menu: opens on Enter, focus goes to the first item, panels are `menuitemcheckbox` with `aria-checked`, and
  Escape returns focus to "Layout". Account menu: the same, and focus returns on Escape.
- Logs drawer: `aria-expanded` and `aria-controls`, Escape closes it and returns focus, and the log is
  `role=log aria-live=polite`.
- Chat announces "Reply finished" once instead of every streamed token (`chat-pane.tsx:217-219`). Keep this pattern
  for streaming generation in Reels chat.
- Reduced motion: no running animations on the Overview under `prefers-reduced-motion: reduce`, and
  `globals.css:198-212` covers every custom animation.
- Muted text contrast is fine: `--muted-foreground` #5e596b is 6.21:1 on the canvas, 6.74:1 on cards and 5.71:1 on
  accent. The disabled colour #64646f is 5.84:1.
- Dialogs (Radix): labelled title and description, focus inside, Escape and focus return, `sr-only` "Close".

---

## Mobile source: patterns to carry over, and gaps not to copy

Carry over (with the web equivalent):

| Mobile pattern | Where | Web equivalent |
|---|---|---|
| Progress bars with values | `app/reels/results.tsx:108`, `ui/stories/picker.tsx:149`, `app/recovery/low-credits.tsx:56` | `<progress>` or `role=progressbar` with `aria-valuenow` and `aria-valuetext` ("Rendering, 40 %") |
| Per-step status read as one item | `app/photoshoot/generating.tsx:112-118` (`role=list`, `accessible`, label "step: status") | `<ol>` of steps, each `<li>` with text status (not just an icon); polite announcement when a step changes |
| Polite live regions for errors and async results | `app/onboarding/review.tsx:81,175`, `app/posts/edit-story.tsx:419,477`, `ui/stories/picker.tsx:140-171` | `aria-live="polite"` region already in the DOM before the text changes; `role=alert` only for blocking errors |
| Adjustable control with a button alternative to dragging | `ui/stories/trim.tsx:101-113` (`adjustable` + Earlier/Later buttons) | `role=slider` with arrow keys and `aria-valuetext="0:12 to 0:27 of 1:04"`, plus Earlier/Later buttons (meets 2.5.7) |
| Menu as the button alternative to dragging frames | `ui/stories/frame-strip.tsx:15,52-53` | Same: a per-frame menu with Move earlier/later/Delete, plus keyboard reorder |
| Tabs with selected state | `ui/reels/kit.tsx:145-154,190-192` | `role=tablist`/`tab`/`aria-selected` |
| Sample play/stop labelled per voice, voice choice as radio | `app/reels/voices.tsx:212-222` | `<button aria-pressed>` "Play sample, Léa"; voices as a radio group |
| Consent as a real checkbox | `app/reels/clone.tsx:164-167` | `<input type=checkbox>` with the server's consent text as its label |
| Reduced motion respected | `app/reels/chat.tsx:244-245`, `ui/page-loading.tsx:16` | `motion-safe:` / `prefers-reduced-motion` on every new animation (render ring, typing dots) |
| Credits in the header label | `ui/reels/kit.tsx:138` | Visible text "120 credits" in the control, not only in the label |

Gaps not to copy:

1. **Reels have no captions.** `app/reels/review.tsx:138` (`VideoView` with native controls, no text track). The
   server says so: `apps/server/server/reels/join.ts:53` ("no burned-in subtitles… Instagram's automatic captions
   cover it for now"). A voiceover reel previewed on web without captions fails 1.2.2 Captions (Prerecorded) (A) on
   our own page, whatever Instagram does later.
2. **The recorder result isn't announced.** `app/reels/record.tsx:137` ("checking…" is a plain Text), `:155-159` (the
   "heard matches/differs" panel appears silently), `:113` and `:133` (problem and no-mic errors without a live
   region). The same in `app/reels/clone.tsx:124,141`.
3. **Render step changes aren't announced.** `app/reels/generating.tsx:60-75`: Done/In progress/Queued per step is
   not in a live region. `:94`: `accessibilityLabel` on a `View` that isn't `accessible`, so it is ignored on iOS.
   Compare `photoshoot/generating.tsx`, which does this right.
4. **Reordering only moves items left, and the hint says "drag".** `app/reels/assets.tsx:139,147`: the text says
   "Drag to reorder", but tapping moves the scene one place earlier. Nothing moves it later, and there's no
   announcement.
5. **The crop's position can only be changed by gesture.** `app/posts/edit-story.tsx:59,313` with
   `ui/stories/crop.tsx:89-90`: drag and pinch, with only Fit/Fill as buttons. Nothing moves the crop window by steps
   (2.5.7 on web, 2.1.1 for keyboard).
6. **Brand colours aren't checked for contrast.** `ui/onboarding/color-sheet.tsx:121-123` checks the hex format and
   duplicates only. Brand colours end up as text and background on generated stories and posts.
7. **Reply boxes cut text silently.** `app/marketing/reply.tsx:89` (`maxLength=1000`) and
   `app/marketing/reviews.tsx:136` (`maxLength=4000`) show no counter and no message when the limit is reached.

---

## Requirements for each coming feature on web

These apply to every feature: a unique page title (I1), a skip link (I7), reflow at 320 px (C1), focus kept and
moved on purpose after any reorder, delete or close (C3), visible label in the name (I6), 24x24 minimum targets
(M4), status-chip contrast with the fixed tokens (I3), focusable scroll regions (I5), `prefers-reduced-motion` on
every animation, and no information carried by colour alone.

### Brand look & feel + photo library
- Colour palette editor: every swatch is a button named by its hex and role ("Primary, #5B50D6, edit"), and the hex
  field has a `<label>` with its error in `aria-describedby`. Show a **contrast check** for the pairs that will be
  used: brand colour as text on white and on the canvas, and white on the brand colour, with a pass/fail at 4.5:1 and
  3:1 in text, not just a coloured dot. Warn before saving a palette whose text pairs fail.
- The hue/shade picker is a radio group with arrow keys, plus a hex field. Never a drag-only colour wheel (2.5.7).
- Photo library: a grid of buttons or checkboxes named by alt text or file name, `aria-selected`/`checked` for
  multi-select, Delete with a confirm dialog, and focus moved to the next photo after a delete. Uploads have a
  file-input button as well as drag-and-drop, upload progress per file through `<progress>` and a polite summary
  ("3 of 5 uploaded"), and errors are named per file.
- Alt text: let people edit each photo's description and use it as alt text wherever the photo appears. Logos get alt
  "<Brand> logo".

### Photoshoot
- The source picker and the style choice are radio groups. The generating screen keeps mobile's `<ol>` of steps with
  text status (`photoshoot/generating.tsx:112-118`) and announces step changes and completion politely, once each,
  not on every poll.
- Results grid: each image is named ("Result 2 of 4, studio white background"), and selecting, downloading and
  regenerating are buttons with visible names. A "regenerate spends N credits" warning must be text near the button,
  not only a tooltip.
- Long waits: say that it's safe to leave (mobile has this), and when people come back, move focus to the results
  heading.

### Reels studio
- **Render progress:** `role=progressbar` with `aria-valuetext` ("Rendering frames, 40 %, about 2 minutes left"). A
  polite live region announces each step change and Done/Failed, throttled to step changes (no announcing every 5 %).
  When the render ends, move focus to "Review your reel" only if the person is still on that page, otherwise show a
  toast. Keep "Keep working" and "Back to workspace" reachable during the render.
- **Captions for generated reels:** the preview `<video>` must have a `<track kind="captions">` built from the scene
  `voiceText` and its timing (the server already has the per-scene text and durations). Captions on by default when
  the reel has a voiceover. Burned-in subtitles stay a product choice; the web preview needs the track either way
  (1.2.2).
- **Voiceover transcripts:** show the full script next to the player and in the review step as plain text (1.2.1 /
  1.2.3 for anything audio-only, such as voice samples). Voice samples in the voice picker get their sample sentence
  as visible text.
- **Video preview:** use the native `<video controls>` (keyboard-operable) or a custom player whose buttons are named
  and toggle `aria-pressed`. No autoplay with sound. If it autoplays muted, give it a visible Pause (2.2.2).
  Fullscreen and the caption toggle work by keyboard.
- **Audio recorder (scene voiceover, voice cloning):**
  - One button whose name changes between "Start recording" and "Stop recording" (or `aria-pressed`). Space and Enter
    work, and focus stays on the button.
  - Before recording, explain the microphone permission. If permission is denied, show a text explanation with the
    steps to fix it, in `role=alert`.
  - Recording state as text ("Recording, 0:07 of 0:15"), not only the red colour. Don't announce every second;
    announce "Recording started", "10 seconds left" once, and "Stopped".
  - After a take, announce "Checking what we heard…" and then the result ("Matches the script" or "Differs: …"), with
    the transcript as text and a Play take button before Use/Keep/Record again.
  - Recording must not be the only route. Offer **upload an audio file** and **type the text for the generated voice
    instead**, for people who can't speak or don't have a microphone.
  - Cloning consent: a real checkbox labelled with the server's consent text, with the version in the text.
- **Storyboard and scene reordering:** reordering by keyboard and by single pointer. Use Move earlier/later buttons
  or menu items on each scene (fixes the left-only gap in `reels/assets.tsx:147`), and optionally drag. After a move,
  focus follows the scene and a polite announcement says "Scene 3 moved to position 2 of 5". Thumbnails get the scene
  description as alt text (mobile uses `s.shot`, `storyboard.tsx:135`). The transition between scenes is text, not
  just an icon (`storyboard.tsx:153`).
- **Templates, presenter (actor) and voice pickers:** radio groups with a visible selected state that doesn't rely on
  colour (a check icon plus text). Sample previews have Play/Stop buttons.
- **Reels chat:** keep the web chat's "announce once when finished" pattern and `role=log` with a focusable transcript
  (I5).

### Stories editing (frame editor)
- The frame strip is a toolbar or listbox. Each frame is named "Frame 2 of 5, photo, headline '…'" with
  `aria-selected`. Arrow keys move between frames. A frame menu offers Move earlier/later, Duplicate and Delete
  (mobile `frame-strip.tsx` already offers a menu instead of dragging). After a delete, focus goes to the neighbouring
  frame.
- Crop: buttons and keys besides drag and pinch. Nudge up/down/left/right, zoom in/out, Fit/Fill, Reset, and an
  `aria-live` readout of the crop ("Zoom 1.4×, centred") (2.5.7, 2.1.1). Close mobile's gap 5.
- Clip trim: copy `ui/stories/trim.tsx`, with `role=slider` and arrow keys (±1 s, Page Up/Down ±5 s),
  `aria-valuetext`, and Earlier/Later buttons.
- Text tool: the headline and body fields have labels and a character count in `aria-describedby`. The text colour
  over the photo gets a **contrast warning** (text against the sampled image area, or force a scrim). Generated story
  text must also be readable for sighted followers.
- Sound picker: a radio group, each option with a Play sample button.
- The editor shouldn't trap focus. Escape leaves a tool panel and returns focus to the tool button (mobile "Done",
  `edit-story.tsx:411`).

### Post from a brief
- A multi-step form: each step has an h1/h2, a step indicator in text ("Step 2 of 4: Audience") with
  `aria-current="step"`, and on Next, focus goes to the new step's heading.
- Validation: errors are listed at the top and linked to fields, plus inline `aria-invalid` and `aria-describedby`
  (3.3.1, 3.3.3). Typed input is kept when going Back (3.3.7 Redundant Entry).
- Generated drafts appear in a polite region ("3 drafts ready"). Each draft is an `article` with a heading. Draft
  scoring (the score ring) needs a text equivalent ("Score 82 of 100").

### Customer inbox + Google reviews/posts
- Two-pane layout: a list (`role=list` or `listbox`) and a thread (`role=log`, focusable). On narrow and zoomed
  screens, collapse to one pane with a back link (C1). The unread state is text or `aria-label`, not only bold or a
  dot.
- Each conversation row is named "Name, channel, time, first line" (mobile `inbox.tsx:113` is close). The channel and
  connection state are text (mobile `inbox.tsx:82` does this).
- **Reply composer:** a labelled `<textarea>`, a visible character counter that announces when you are near or at the
  limit (unlike mobile's silent `maxLength`), and Ctrl/Cmd+Enter to send as a documented shortcut, not the only way.
  "Suggest reply" (AI) puts the suggestion in the box for editing and announces "Suggested reply inserted". Sending is
  announced ("Reply sent"), and a failure keeps the draft and focuses the error.
- Reviews: star ratings as text ("4 of 5 stars"; mobile `reviews.tsx:115` does this). Each review is an `article`
  with a heading. Google posts get alt text on their images, entered when the post is created.
- New messages arriving: a polite announcement of the count only ("2 new messages"), never the full message text
  automatically.

### Automations + credits
- Each automation's on/off is a `role=switch` with `aria-checked` and a visible state word. Schedules use
  native/labelled inputs, not a drag-only timeline.
- Rule builders (if → then) are fieldsets with legends. Adding or removing a rule moves focus to the new rule, or to
  the previous one after a removal.
- Credits: the balance is text, and a meter is `role=meter` or `progressbar` with values (mobile
  `low-credits.tsx:56`). Any action that spends credits says the cost in its accessible name or description ("Make
  video, uses 12 credits") and asks for confirmation in a dialog. Low-balance warnings are `role=status`, not colour
  only.

### Fuller onboarding
- Each step is its own route with a unique title, a step indicator in text, focus on the step heading after
  navigation, and Back that keeps what was entered (3.3.7).
- Sign-in, password and verify: `autocomplete` attributes (1.3.5); password rules shown before typing; no CAPTCHA
  that relies only on cognitive tests (3.3.8 Accessible Authentication); a verify code field with
  `autocomplete="one-time-code"` and pasting allowed.
- "Learning your business" and "preparing" steps: progress as text plus a polite live region (mobile
  `onboarding/learning.tsx:92` already uses one), and a way to continue or leave without waiting.
- Choice screens (goal, source): radio groups or labelled cards with visible selection that doesn't depend on colour
  alone.

### Plans
- Plan comparison as a real `<table>` with headers for features × plans, or one list per plan. Ticks and crosses
  have text ("Included" / "Not included").
- The current plan is shown in text ("Your plan"), not only by highlight. Prices give the period in text ("€29 per
  month").
- Upgrade/checkout: if it hands off to a payment provider, say so beforehand. The gate screens (`plans/gate.tsx`)
  explain why a feature is locked and offer a keyboard-reachable way out.

---

## Order of work (suggested)

1. C1 (shell reflow), C2 (Create a business by keyboard) and C3 (focus after panel moves). All are in shared shell
   code that every new screen inherits.
2. I1 titles, I3 chip tokens, I5 scroll regions, I6 label-in-name, I7 skip link and I9 skeleton text, as one small
   shared pass.
3. Then build each feature to the requirements above. Write the shared pieces once: progress plus live-region
   announcer, a reorderable list with keyboard and menu moves, a recorder button, and a video with a captions track.
   Reels, Stories, Photoshoot and Onboarding all need them.
4. Add the coming routes to `scripts/audit-ui.ts` (its `PRIVATE` list only has 7 routes and runs with the old login
   form instead of the `e2e/.auth` storage states). Add a 320 px viewport pass to it, since the current 375 px pass
   doesn't catch C1's clipped content: overflow is hidden, so it reports 0.
