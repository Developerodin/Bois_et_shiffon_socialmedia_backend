# Mobile → web parity: design and UI/UX review (before)

Date: 2026-11-17 · Lens: design and UX · Read-only review of `apps/web` (as on `desktop-shell` today, including the Overview redesign) and `apps/mobile/src` (Figma "Espanda App 00–07").

Owner's rule this review works to: **the web gets the same steps, choices and server calls as the phone, laid out for desktop inside the web workspace**, not phone screens stretched wide.

Evidence key: `web/…` and `mobile/…` are paths under `apps/`. Screenshots: `shots/<name>.png` = `…\scratchpad\shots\`, `p3-default.png` = the redesigned Overview.

---

## 0. Verdict in five lines

1. The redesigned Overview (`p3-default.png`) is the strongest screen in the product and should be the model. The other pages are not built to the same rules yet, and that will spread to every new feature.
2. Before any of the 8 features ships, the web needs four shared pieces: **somewhere in the navigation for Create and Customers**, **one page frame (PageHeader + section card)**, **one StatusBadge**, and a **credits/cost pattern**. Without these the eight features will look like eight products.
3. The mobile flows are sound, but they are laid out as a chain of screens. On desktop most of them become **one editor with a steps rail**. The steps and choices stay the same; the screens merge.
4. Phone-specific patterns (bottom sheets, full-screen waits, screens that pick something and send it back, share sheet, 7-day slot picker) each have a straightforward desktop version. Section 3 lists them all.
5. One product decision is needed early: whether the reel's **"Plan in chat"** uses the global assistant panel or a chat inside the editor. Both at once would put two chats on one screen.

---

## 1. Findings: current web UI against its own design system

### Critical

**C1. Created things have nowhere to go in the navigation.** 
- `web/lib/nav.ts:15-35`: the main group is Overview / Business context / Products / Connections. There is no Create, Studio, Library, Inbox or Billing entry.
- `/studio` is not in `NAV`, so `navFor` falls back to "Overview" (`nav.ts`, `if (!best) return { … title: "Overview" …}`). Its breadcrumb says **Overview** on the Studio page (`shots/owner_studio.png`).
- Echo ("Communication") points at `/settings?tab=connections` (`nav.ts:25`) as a stand-in.
- Mobile has a clear model: four module tabs (Reels / Posts / Photoshoot / Marketing, `mobile/src/ui/photoshoot/chrome.tsx:7-11`) plus a drawer with Create / Grow / Manage sections (`mobile/src/ui/business/drawer.tsx:36-60`). The web has nothing equivalent.
- If we add 8 features without first settling where they live, each will invent its own entry point. Section 4.1 proposes the sidebar.

**C2. Pages outside the Overview use two different layouts, and new features will copy whichever one they start from.**
- **Headings are four different sizes and two weights:**
  - `text-2xl font-semibold`: Connections (`web/app/(shell)/connections/page.tsx:57`) and Products (`web/components/products/products-board.tsx:198`)
  - `text-3xl sm:text-4xl font-medium`: Settings (`settings-board.tsx:158`), Context (`context-board.tsx:174-176`), Performance (`audit-board.tsx:185`)
  - `text-4xl`/`5xl`: ComingSoon (`components/ui/empty-state.tsx:187`)
  - Compare `shots/owner_settings.png` (large light "Settings") with `shots/owner_products.png` (small bold "Products").
- **Surfaces are inconsistent.** The Overview puts every block on a white card on the grey page (DESIGN_SYSTEM.md §4). Products and Studio put content straight on the grey canvas with dashed boxes. Settings and Connections use white cards. Agents uses cards with a hairline footer.
- `DESIGN_SYSTEM.md` §7 lists a `PageHeader` component, but it was never built.
- **Fix:** before feature work, add `PageHeader` (title `text-2xl font-semibold`, matching mobile `type.pageTitle` 24/30 semibold in `mobile/src/theme/tokens.ts:44`; one-line description; one primary action on the right) and `PageSection` (a white card with `px-5 py-4` inside, the same inner spacing as Overview panels). Then convert the five existing pages to them.

**C3. Status pills are implemented five different ways, and the new features add about 15 statuses.**
- The `components/ui/badge.tsx` primitive is only used by `brand-switcher.tsx`.
- The working implementations are separate:
  - `StatusPill` (`settings/shared.tsx:27`)
  - `Pill` (`admin/ui.tsx:88`)
  - `DocStateBadge` (`context/doc-state.tsx:20`)
  - `docBadge()` (`workspace/workspace.tsx:473`)
  - the inline "Soon" pill in the sidebar (`shell/sidebar.tsx:112`)
- They look different on screen: "In use" is a blue-dot outline, "Succeeded" a green dot, "New" a green fill, "Soon" is lavender in the sidebar and an outlined lock elsewhere (`p3-default.png`, `shots/owner_agents.png`, `shots/owner_context.png`).
- New statuses coming with the features:
  - Reels: draft / processing / checking / ready / scheduled / published / failed
  - Photoshoot: running / done / failed
  - Stories: due / posted by hand / partly posted
  - Inbox: unread / needs reconnect
  - Connections: healthy / degraded / error / disconnected (`IntegrationHealthPill`, DS §13)
- **Fix:** one `StatusBadge` that maps each status to tone + icon + label (DS §7 and §12 ask for "colour not sole indicator"), built on the existing `TONES` map in `settings/shared.tsx:20-25`. Fold the other four into it.

**C4. The web has no way to show credits or price, and features 2, 3 and 6 all charge.**
- Mobile shows:
  - the balance in every studio header (`mobile/src/ui/photoshoot/chrome.tsx:48`)
  - the price on the button that spends it ("Make video · N credits", `mobile/src/app/reels/storyboard.tsx:97-105`)
  - a balance line under it
  - a Low-credits sheet on any 402 (`mobile/src/app/recovery/low-credits.tsx`)
  - a Plan gate (`mobile/src/app/plans/gate.tsx`)
- `web/components/shell/top-bar.tsx` has no credits chip, and nothing in the web shell reads the balance (it only appears on the admin workspace pages).
- **Fix:** build a `CreditsChip` (top bar, links to Billing), a `CostButton` (label + price, with a disabled reason) and a `LowCreditsDialog` / `PlanGateDialog` **before** Photoshoot. Otherwise the first paid action on the web will charge without warning.

### Important

**I1. Too many primary buttons, so nothing is the obvious next step.**
- `/agents`: 9 filled "Run now" buttons on one screen (`web/components/agents/agent-tile.tsx:95-102`, `shots/owner_agents.png`).
- `/connections`: 7 filled "Connect" buttons (`settings/connections-tab.tsx:148`, `shots/owner_connections.png`).
- `/products`: two filled primaries stacked ("Add product" and "New campaign", `shots/owner_products.png`).
- The Overview already uses the right pattern: secondary pills on rows, at most one primary per panel.
- **Rule for the new features:** one primary per view (reel editor: Make video / Schedule; photoshoot: Generate; inbox: Send). Repeated row actions use `variant="secondary"` or `outline`.

**I2. Form controls don't match each other.**
- Shapes in use:
  - `Button` is `rounded-full` (`ui/button.tsx:7`)
  - `Input` is `rounded-md` h-9 (`ui/input.tsx:10`)
  - `selectClass` is `rounded-md` native `<select>` (`settings/shared.tsx:17`), used in 9 places (members, invitations, ai-models, products, campaigns, context)
  - `DESIGN_SYSTEM.md` §4 says `rounded-2xl` for cards **and controls**
- In `shots/owner_settings_tab_members.png` the native select's browser chevron sits next to the pill buttons.
- `rounded-md` is used 22 times in components, against 40 uses of `rounded-2xl`.
- The new features are mostly choices (photoshoot ratio / scene / pose / model / background; voices filters; brief format / goal; automations switches).
- **Fix:** settle one control radius (`rounded-xl` for inputs and selects, keeping pill buttons). Add `ChoiceCard` (radio card), `Segmented`, `Switch` and a styled `Select` (built on `dropdown-menu.tsx`) before feature 2.

**I3. Two chats on one screen when building the reels studio.**
- The assistant panel is always on at `xl` (`shell/assistant-panel.tsx:78`). At 1440 px the main area is about 1440 − 232 − ~320 = **~890 px**.
- Mobile reels have their own planning chat (R04 `mobile/src/app/reels/chat.tsx`).
- A three-column reel editor (rail + editor + 9:16 preview) inside 890 px is tight. Adding a second chat beside the assistant breaks the "Your team, one conversation" promise.
- **Recommendation:** in Studio routes the assistant panel switches to a **reel-scoped mode**: same panel, its header says "Planning: <reel title>", and its starters are the R04 ones. It can also be collapsed to a 48 px rail. Owner to confirm (see §6, Q1).

**I4. Three styles of empty state.**
- `EmptyState` is a dashed box on grey (`ui/empty-state.tsx:163`; Products, `shots/owner_products.png`).
- Overview panels use plain text plus a small secondary button ("Nothing planned yet. … Plan posts", `shots/owner_calendar.png`).
- `ComingSoon` is a hero with a 5xl heading (`shots/owner_studio.png`).
- **Rule:** inside cards use the panel style (text + one action). Use `EmptyState` only when the empty thing is the whole page, and keep its heading at `text-xl`. Retire the hero size except for the Plans placeholder.

**I5. The overlay uses pure black, against its own token.**
- `globals.css:39` says the scrim is the ink colour, "never pure black".
- `shell/assistant-panel.tsx:66` uses `bg-black/50`, and so does the story frame zoom (`workspace/content-panels.tsx:618`).
- The new dialogs and sheets (media picker, low credits, schedule) should all use `bg-overlay`.

**I6. Connections are in two places, and Echo points at one of them.**
- `/connections` and `Settings → Connections` show the same list (`shots/owner_connections.png`, `shots/owner_settings.png` tab row).
- Inbox and Google (feature 5) need "Reconnect" states that link to one place.
- **Fix:** keep `/connections`, and make the settings tab a link to it.

**I7. Agents page labels.**
- Breadcrumb says "Agent log" but the heading says "Your agents" (`shots/owner_agents.png`; `nav.ts:32`).
- `/agents/<key>` is a 404 (`shots/owner_agents_scout.png`).
- So "agent tile → feature" must go to a panel or a feature route, never `/agents/<key>`.

**I8. Products page order.**
- "Campaigns and offers" (an h2 with its own primary) sits **above** the product list's empty state (`shots/owner_products.png`). The page reads as being about campaigns.
- Put the product list first, campaigns second, each in a `PageSection`.

### Minor

- **M1.** Sidebar main rows use `mr-7 ml-5` but agent rows use `mx-5` (`shell/sidebar.tsx:77,97`), so the active "Overview" pill is 8 px narrower than the agent rows below it (`p3-default.png`).
- **M2.** Six of the eight agents in the sidebar are "Soon" (`nav.ts:20-27`). Once features 5–6 land, Echo stops being "Soon" (it becomes the inbox). Consider folding the remaining "Soon" agents into one "5 more coming" row so the sidebar shows things you can actually use.
- **M3.** "Last run 28 Oct, 16:30" is in JetBrains Mono (`agents/agent-tile.tsx:92`) and wraps awkwardly in the card footer. DS §3 reserves mono for SKUs, ids and metrics; dates should use `text-xs text-muted-foreground`.
- **M4.** Settings is `font-medium` and Connections is `font-semibold` at h1. Fixed by C2.
- **M5.** The assistant's disabled "Send message" is a full-width lavender block (every screenshot). On a page full of primary buttons it reads as an enabled primary. Use the `--disabled` treatment, or a ghost button until there is text.
- **M6.** `DESIGN_SYSTEM.md` §6 and §14 are stale: they describe installs and a `components/layout/app-shell.tsx` that don't exist. §11 "Studio: split pane editor | live preview, version rail" is the right brief for features 3–4; keep it and expand it with §4 of this review.
- **M7.** Mobile and web tokens have drifted slightly:

  | Token | Mobile (`theme/tokens.ts`) | Web (`globals.css`) |
  |-------|----------------------------|---------------------|
  | divider / border | `#E8E7ED` | `#DED9E6` |
  | success | `#1B7A46` | `#1a7f4b` |
  | card radius | 24 | 16 |

  Mobile screens also hard-code colours outside the tokens: `#64646F`, `#F0EEF6`, `#F2F1F6`, `"#000"`, `rgba(244,242,253,0.7)` (`mobile/src/app/reels/index.tsx:40,58,96,122,153,165`). When porting, **map to web tokens; don't copy the hex values**.

---

## 2. Findings: the mobile flows as the source

What each flow does well (keep): honest cost shown before a paid action; render failure that says why and returns credits (X01); a draft-reply-then-human-sends pattern in inbox and reviews; approval tied to the exact version; resumable jobs ("Return to workspace" keeps the shoot running).

### Critical

**MC1. Reels is a graph of 13 screens, and one step is hard to find.**
- Script & voice (R11) is only reached from the presenter screen: `router.push("/reels/script")` at `mobile/src/app/reels/actor.tsx:100`. Storyboard (R03) has no link to it.
- Someone who plans in chat and goes straight to the storyboard never sees "Change voice" or "Record your own".
- The real order the server needs is: plan → presenter → photos → script & voice → storyboard → render → review → publish.
- **On desktop:** show that order as a **steps rail**. Every step is visible and reachable. The rail marks steps that are done, skipped (no presenter) or invalidated ("an edited scene loses its take", `script.tsx` comment).

**MC2. Full-screen waits block the person.**
- R05 and F05 (`mobile/src/app/reels/generating.tsx`, `mobile/src/app/photoshoot/generating.tsx`) poll on a dedicated screen. Mobile already offers "Return to workspace", which shows the wait was never needed.
- **On desktop:** the job becomes an inline progress card in the editor or results, plus a **Jobs entry in the top bar** (a count while anything is running). Completion appears as a Today task ("Your reel is ready to review") and a toast. Keep the same three-step progress (voice / clips / join), the 30 s "can't reach the server" note and the 15 min "taking long" note.

### Important

**MI1. Pickers that send the choice back** (F04 `photoshoot/source.tsx:39-40` `dismissTo` with params; R13 `reels/assets.tsx`). These are phone navigation workarounds. On desktop use one `MediaPicker` dialog over the editor: the library grid, Website / Uploads tabs, drag-and-drop upload, and multi-select whose order is the scene order for reels (R13's rule).

**MI2. Mixed save models on one screen.** Brand settings saves the palette **immediately** and the tones **on Save** (`mobile/src/app/business/brand.tsx` header comment). On a desktop form this is confusing. Use the same server calls with one model per card: each card shows "Saved" after its own change (autosave), with no page-level Save. Alternatively keep both, but say on each card which one applies.

**MI3. Onboarding step numbers repeat.**
- Step 2 is shown on four screens: source, website, maps, manual.
- Step 3 is shown on both learning (a wait) and review (`grep StepHeader step=` in `mobile/src/app/onboarding/*`).
- **On desktop:** a 5-step stepper (Goal · Business · Review · Brand · Connect). Website / Maps / Describe are three **tabs of one step**, and Learning is the loading state of Review, not a step of its own.

**MI4. A limited slot picker.** Reels publish offers only "the next seven days and a few set times" because no date-picker package is installed (`mobile/src/app/reels/publish.tsx` comment). The posts schedule uses half-hour slots 07:00–22:30 (`posts/schedule.tsx`). **On desktop:** a real date + time field (native `<input type="date">` / `type="time"` styled, or the shadcn calendar from DS §6). It sends the same request and shows the timezone. This is a deliberate difference: the phone limit is a missing package, not a product rule.

**MI5. Bottom sheets** (`mobile/src/ui/recovery/sheet.tsx`: X02 low credits, X03, L02 plan gate, A13 "connect later?"). On desktop these become centred `Dialog`s (`web/components/ui/dialog.tsx`), using `bg-overlay`. The L02 "blurred studio behind the sheet" becomes an inline banner in the editor above a disabled `CostButton`, with the dialog opening on click.

### Minor

- **Mi1.** The phone share sheet (photoshoot F07 Download / Share; reel download) becomes **Download** and **Copy link** on desktop.
- **Mi2.** Recording (R11 record, voice clone `reels/clone.tsx`) works in the browser through `MediaRecorder`, but desktop needs states the phone handles at OS level:
  - microphone permission denied
  - no microphone
  - choose input device
  
  Keep the consent checkbox and the server's consent text exactly as they are.
- **Mi3.** Stories "Post by hand" (`mobile/src/ui/stories/by-hand.tsx`) is phone-native: you save frames to the camera roll and post from Instagram on the phone. On desktop, offer "Download frames" + "Copy link", and say plainly that stories are posted from the phone. The web already has this (`release-panel.tsx:481 StoryByHand`), so reuse it.
- **Mi4.** The "Inbox replies" automation switch has no backend (`mobile/src/app/business/automations.tsx:17`, `key: null`). Show it disabled with a "Soon" `StatusBadge` on both platforms; don't hide it on one and show it on the other.
- **Mi5.** Mobile touch targets are 44–48 px (`tokens.ts layout`). On desktop, controls can be h-9 / h-10 at the web's density, except the primary action in each editor, which should be h-10 or larger.

---

## 3. Phone pattern → desktop pattern (reference table)

| Phone pattern (where) | Desktop pattern | Why |
|---|---|---|
| Chain of full screens with Back (reels R01–R13, photoshoot F01–F07) | One editor page with a **steps rail** | You can see the whole job and jump between steps; same order, same server calls |
| Full-screen "Generating" polling (R05, F05) | Inline `JobProgress` card + top-bar Jobs count + Today task + toast | A desktop user keeps working while it runs |
| Picker screen that sends its choice back (F04, R13) | `MediaPicker` dialog with drag-and-drop upload | The editor stays in view |
| Bottom sheet (X02, L02, A13) | Centred `Dialog` | Desktop convention; focus trap + Esc (DS §12) |
| Bottom tabs (Reels/Posts/Photoshoot/Marketing) | Sidebar groups (§4.1) | The shell already has a sidebar |
| Drawer M13 (Create / Grow / Manage) | The same three groups in the sidebar | Same mental model on both platforms |
| Credits chip in the module header | `CreditsChip` in the top bar, on every page | One place, always visible |
| Share sheet | Download + Copy link | No share sheet on desktop |
| 7-day / fixed-time slot picker | Date + time inputs with timezone | The phone limit is a missing package |
| Swipe through story frames | Vertical frame strip + large canvas + inspector | Room for all three on desktop |
| SegmentedTabs (photos Website/Uploads) | Reuse `admin/segmented-links.tsx` / `tab-links.tsx`, promoted to `ui/` | Already built and animated (`use-indicator.ts`) |

---

## 4. Desktop information architecture

### 4.1 Where things go (decision rule)

- **Overview panel**: something you glance at and act on next to other work, small enough to run in a 240 px+ column. Examples: Inbox (unread), Jobs / generations, Google profile checklist. These are added to `PANEL_IDS` in `workspace.tsx` and to a preset.
- **Full page under `app/(shell)/`**: creation editors that need width, and libraries. Pages use `PageHeader` + `PageSection`, max width `max-w-7xl`. Editors are full-bleed like `/`, using the `MainArea` full mode (`workspace/main-area.tsx:12`, which is currently keyed to `/` only and needs a list).
- **Dialog**: one decision or a short form (brief, low credits, plan gate, schedule, consent, media picker).
- **Side sheet** (`ui/sheet.tsx`): a detail view that keeps the list underneath (a review's reply, a person's conversations from People, a photo's details).

### 4.2 Sidebar proposal (replaces the main group in `nav.ts`)

```
┌ Espanda ─────────────┐
│ [Atelier Sorrel   v] │
│ ▣ Overview           │
│                      │
│ CREATE               │
│ ▶ Reels              │  /studio/reels
│ ◉ Photoshoot         │  /studio/photoshoot
│ ▤ Library            │  /library   (brand photos)
│                      │
│ CUSTOMERS            │
│ ✉ Inbox        3     │  /inbox     (Echo)
│ ⌖ Google             │  /google
│                      │
│ BUSINESS             │
│ ☰ Business context   │
│ ◐ Brand              │  /brand     (look & feel)
│ ▢ Products           │
│ ⏚ Connections        │
│                      │
│ YOUR AGENTS          │
│ Wave · Surge · Drift │  (live agents)
│ + 5 coming           │
│──────────────────────│
│ (N) Emulator · Owner │  Settings, Billing & credits, Plans in account menu
└──────────────────────┘
```

- Posts and stories have no sidebar item: they live in the Overview **Content calendar** panel, which is Wave's page (`nav.ts:23`), and open in the existing `ContentView` or the new story editor.
- Agents map onto features: Wave → content calendar + Studio; Echo → Inbox; Drift → competitors; Surge → performance.
- Settings gains the tabs **Automations**, **Billing & credits** and **Plan**.

### 4.3 Top bar

`Breadcrumb · · · [Jobs 1 ●] [◈ 1,240 credits] [Layout] [Logs]`. The credits chip and the Jobs indicator are new (C4, MC2).

---

## 5. Per-feature IA, layout, entry points and states

Every feature uses the shell (sidebar + top bar + assistant). Each wireframe shows only the main area.

### Feature 1: Brand look & feel + photo library

Source: M07 `business/brand.tsx` (palette ≤ N colours, logo, watermark, creative tones), M08 `business/photos.tsx` (Website / Uploads tabs, add, remove, Refresh).

**Where:**
- `/brand`: a page of three `PageSection` cards.
- `/library`: a page. The same grid is also the `MediaPicker` dialog used by features 2, 3 and 4.

```
/brand
┌ Brand look & feel ───────────────────────── [Save tones] ┐
│ How your posts, reels and photos look.                   │
├──────────────────────────────────────────────────────────┤
│ Palette                               saved ✓            │
│ [■ #2B2A28] [■ #C9A27E] [■ #F4EFE8] [+ Add colour]       │
│   click a swatch → popover: hex field + picker + Remove  │
├──────────────────────────────────────────────────────────┤
│ Logo & watermark          [logo 32px]  Watermark  [◯━]   │
├──────────────────────────────────────────────────────────┤
│ Creative tones (pick 1–3)                                │
│ [✓ Warm] [  Minimal] [✓ Crafted] [  Playful] …           │
│ Pick at least one tone.                (inline error)    │
└──────────────────────────────────────────────────────────┘

/library
┌ Photo library ─────────────── [↻ Refresh] [⬆ Upload] ────┐
│ [ Website 24 | Uploads 6 ]           search ▢            │
│ ┌────┐┌────┐┌────┐┌────┐┌────┐┌────┐   4:5 thumbs        │
│ │    ││    ││    ││    ││    ││    │   hover: ⋯ remove   │
│ └────┘└────┘└────┘└────┘└────┘└────┘   (uploads only)    │
│ ░░░░ drop photos anywhere to upload ░░░░                 │
└──────────────────────────────────────────────────────────┘
```

- **Desktop differs:**
  - drag-and-drop upload and multi-file upload (the phone uses ImagePicker one at a time)
  - the colour editor is a popover instead of the phone's `color-sheet`
  - each card states how it saves (MI2)
- **Entry points:**
  - sidebar Brand / Library
  - Business context "Brand voice" row
  - a Today task "Add your own photos" when Uploads = 0
  - every "Change photo" in features 2–4
- **States:**
  - loading: `PageSkeleton` grid
  - empty Website: "Research hasn't found product photos yet" + Refresh
  - empty Uploads: drop zone as the empty state
  - upload error per tile
  - refresh in progress: the button shows a spinner and the grid stays visible
  - viewer role: read-only, controls hidden, plus the DS §13 permission line

### Feature 2: Photoshoot

Source: F01 Create (Product | Fashion), F02 product setup (asset, ratio 1:1/4:5/9:16, scene studio/interior/custom), F03 fashion (garment, pose, format, background, model Léa/Inès/Hugo/auto, garment checklist), F04 picker, F05 generating, F06 results, F07 detail (4 photos, compare original, variation, use in story). Options are in `mobile/src/ui/photoshoot/options.ts`.

**Where:** `/studio/photoshoot`, a two-pane page: **setup | results**. The detail view opens in the right pane, so there is no separate page.

```
/studio/photoshoot
┌ Setup (380px) ─────────────────┬ Results ──────────────────────────────┐
│ [ Product | Fashion ]          │ [ All | Running | Done ]              │
│                                │ ┌──────────────────────────────────┐ │
│ Photo                          │ │ ● Generating… dining table 4:5   │ │
│ ┌──────┐ Oak serving board     │ │ ▓▓▓▓▓░░░  ~40 s · keep working   │ │
│ │ img  │ [Change photo]        │ └──────────────────────────────────┘ │
│ └──────┘   → MediaPicker       │ ┌────┐┌────┐┌────┐┌────┐ 14 Nov     │
│ Format   [1:1] [4:5] [9:16]    │ │    ││    ││    ││    │ Studio 4:5 │
│ Scene    (◉ Studio)(○ Interior)│ └────┘└────┘└────┘└────┘ [Open]    │
│          (○ Custom: ______)    │ … older shoots                       │
│                                │                                      │
│ ─────────────────────────────  │ Detail (replaces list when open):    │
│ [ Generate 4 photos · 8 ◈ ]    │ ‹ Back  [big photo] [thumb×4]        │
│ Balance 1,240 ◈                │ [Compare original ◐] [Download]      │
└────────────────────────────────┴ [Variation · 8 ◈] [Use in story →]   ┘
```

- **Desktop differs:**
  - setup and results are visible together (the phone uses separate Create and Results tabs)
  - generating is an inline card in the result list (MC2)
  - "Compare original" is a press-and-hold or slider overlay instead of a toggle screen
- **Entry points:**
  - sidebar Photoshoot
  - Library photo ⋯ → "Photoshoot this"
  - story editor "Generate photo" (opens with `ratio=9:16`, as on the phone `posts/edit-story.tsx:267`)
  - Today task when there are products with no lifestyle photos
- **States:**
  - no photos in library: setup shows "Add a photo first" → Library
  - running (top-bar Jobs count)
  - done
  - failed: card says why + "credits returned" + Try again
  - 402 → `LowCreditsDialog`
  - no plan → inline banner + `PlanGateDialog`
  - fashion garment checklist unmet: a warning, not a block (keep the phone's behaviour)

### Feature 3: Reels studio

Source: R01 Create, R02 Ideas, R04 Plan in chat, R10 Presenter (+ make presenter from traits), R12 Templates, R13 Select assets, R11 Script & voice (+ Voices library with filters, Record per scene, Clone voice), R03 Storyboard (Make video · price), R05 Generating, R07 Review (checks, caption, specs, download, schedule, use in story), R08 Publish/Schedule, R09 Scheduled, R06 Results, X01 Video failed.

**Where:**
- `/studio/reels`: start page + library of reels.
- `/studio/reels/[id]`: full-bleed editor with **steps rail | step editor | live 9:16 preview**.
- Planning chat: the assistant panel in reel mode (I3, Q1).

```
/studio/reels  (start)
┌ Reels ─────────────────────────────────────────── [＋ New reel] ┐
│ ┌ Plan a reel together ──────────────────────┐ ┌ Presenter ───┐ │
│ │ ✦ What should your next reel be about?     │ │ AI presenter │ │
│ │ [ describe it…                    ] [Start]│ ├──────────────┤ │
│ │ ● 6 ideas ready  [View ideas]              │ │ Templates    │ │
│ └────────────────────────────────────────────┘ └──────────────┘ │
│ Your reels   [All|Drafts|Processing|Ready|Scheduled]  see all → │
│ ┌──9:16──┐┌──9:16──┐┌──9:16──┐┌──9:16──┐                        │
│ │[Draft] ││[Ready] ││[Sched.]││[Failed]│  title · 24 s          │
│ └────────┘└────────┘└────────┘└────────┘                        │
└─────────────────────────────────────────────────────────────────┘

/studio/reels/[id]  (editor)
┌ Steps ───────┬ Storyboard ──────────────────────────┬ Preview ──────┐
│ ✓ Plan       │ 24 s · vertical · AI presenter        │ ┌───────────┐ │
│ ✓ Presenter  │ ┌ Scene 1 · 6 s ─── [Kling] ───────┐  │ │           │ │
│ ✓ Photos (4) │ │ [img] Direction: slow push-in…   │  │ │   9:16    │ │
│ ● Script &   │ │       On screen: "Made by hand"  │  │ │  scene 1  │ │
│   voice      │ │       VO (FR): "Chaque cuillère…"│  │ │           │ │
│ ○ Storyboard │ └──────────────────────────────────┘  │ └───────────┘ │
│ ○ Video      │   ⤳ cross-fade                        │ ◀ 1/4 ▶       │
│ ○ Review     │ ┌ Scene 2 · 5 s … stand-in ⚠ ─────┐  │ Voice: Léa FR │
│ ○ Publish    │ │ "Pick a real photo" [Change]     │  │ ▶ sample      │
│              │ └──────────────────────────────────┘  │               │
│ Balance      │                                       │               │
│ 1,240 ◈      │ [✦ Edit in chat]   [ Make video · 48 ◈ ]             │
└──────────────┴───────────────────────────────────────┴───────────────┘
```

**Per step (same choices as mobile):**

| Step | Desktop layout |
|---|---|
| Plan | Chat in the assistant panel. The center shows the plan card when the plan arrives (R04's "plan card fades in"). |
| Presenter | Grid of presenter cards + "No presenter" + "Make a presenter" (trait chips in a dialog, priced). Polls every 10 s while one is being made, as on mobile. |
| Photos | Ordered tray of the chosen photos (the order is the scene order) + "Add" → `MediaPicker` multi-select. |
| Script & voice | Per-scene script blocks (one textarea per scene, which replaces the phone's blank-line convention) with word count / seconds. Voice row with ▶ sample and "Change voice" → **Voices side sheet** (filters inline, not one sheet per filter as on the phone). Per-scene Record / Remove. "Clone a voice" opens a dialog (admins only). |
| Storyboard | As drawn above. Make video is the **only** primary. Stand-in scenes block it, with "Pick photos" as on mobile. |
| Video | The step turns into `JobProgress` (voice / clips / join). Rail and preview stay usable; the person can leave. |
| Review | Player in the preview column; center shows checks (`ChecksList`), caption (editable), specs, "Ask for changes" → chat. Download / Schedule / Use in story. |
| Publish | Inline form: channel status (+ Reconnect), Publish now ◉ / Schedule ◯ with date + time + timezone (MI4), "Save as draft". Confirming approves this version. Scheduled state: slot, Cancel schedule. |

- **Desktop differs:**
  - all steps are visible and reachable (MC1)
  - generating does not block (MC2)
  - the slot picker is a real date and time (MI4)
  - per-scene text boxes replace the single blank-line-split textarea
  - the voice filters stay open in a side sheet
  - recording needs mic permission states (Mi2)
- **Entry points:**
  - sidebar Reels
  - Ideas panel ("6 reel angles" → R02 list in a dialog → opens the editor at Storyboard)
  - Today task "Your reel is ready to review"
  - Content calendar reel items
  - story editor "Generate clip"
- **States:**
  - no plan: rendering locked (L01). The editor stays usable and "Make video" shows the plan gate.
  - draft
  - processing
  - checking: "Checking… usually under a minute", then Check again
  - ready
  - scheduled
  - published
  - failed: X01 inline. Says why, credits returned, Try again (same price) / Edit storyboard / Change voice.
  - 402: low credits
  - not connected: Publish shows Connect

### Feature 4: Stories editing + post from brief

Source: P01 Today, P02 Calendar, P06 Create brief (format single/carousel, goal, product, direction, "included" cost), P04 Edit post, P07 Stories (New story, scheduled tab), story detail (frames, checks, Fix it, Approve / Approve anyway / Request changes, Schedule / Post by hand, partly posted), `edit-story.tsx` (frame strip ≤ 5, crop, trim clip, text box, picker, generate photo/clip).

**Where:**
- **Post from brief:** a `Dialog` launched from the Content calendar panel header ("New post") and from Today. On submit it opens the draft in the existing `ContentView` (`content-panels.tsx:632`) in the home panel.
- **Story editor:** `/studio/stories/[id]`, full-bleed with **frame strip | 9:16 canvas | inspector**.
- **Story detail / approve / schedule:** the existing `ContentView` + `ReleasePanel` (`release-panel.tsx:59`), which already has ApproveForm, PublishForm, StoryByHand and History.

```
New post (dialog, 560px)
┌ New post from a brief ─────────────────────── ✕ ┐
│ Format   (◉ Single photo)  (○ Carousel)         │
│ Goal     [Sell] [Awareness] [Engage] [Announce] │
│ Product  [img] Oak serving board  [Change ▾]    │
│ Direction (optional) [______________________]   │
│ Cost: included in your plan                     │
│                       [Cancel] [✦ Draft post]   │
└─────────────────────────────────────────────────┘

/studio/stories/[id]
┌ Frames ─┬ Canvas ─────────────────────────┬ Frame 2 ────────────────┐
│ ┌─────┐ │        ┌─────────────┐          │ Source  [img] [Change]  │
│ │  1  │ │        │             │          │   [✦ Generate photo]    │
│ └─────┘ │        │    9:16     │          │ Crop    [drag on canvas]│
│ ┌─────┐ │        │  live text  │          │ Clip    ▕▔▔▔[■■■]▔▔▕ 5 s │
│ │ ▶2  │ │        │   overlay   │          │ Text    [_____________] │
│ └─────┘ │        │             │          │ Sound   [◯━]            │
│ ┌─────┐ │        └─────────────┘          │ ⋯ Move up / down /Delete│
│ │  3  │ │  "Preview: the server redraws    │                         │
│ └─────┘ │   the frame on save"             │                         │
│ [＋ 3/5]│                                  │ [Discard]  [Save frames]│
└─────────┴──────────────────────────────────┴─────────────────────────┘
```

- **Desktop differs:**
  - the frame strip is vertical with drag-to-reorder (the phone's "…" menu stays as the keyboard path)
  - crop is done directly on the canvas
  - the inspector stays visible instead of opening sheets
  - Post by hand downloads frames (Mi3)
  - the brief is a dialog, not a page, because it is four choices
- **Entry points:**
  - Content calendar panel "New post" / "New story"
  - Today ("Stories due to post": `DueStories`, `workspace.tsx:944`, already on web)
  - `ContentView` → "Edit story"
  - Reel/Photoshoot "Use in story"
- **States:**
  - draft
  - rendering (save in progress)
  - checks failed → Fix it
  - approved
  - scheduled
  - due by hand
  - partly posted ("Did frame N appear?")
  - posted
  - unsaved-changes guard: reuse `context/unsaved.ts`

### Feature 5: Customer inbox + Google reviews / posts

Source: M02 Inbox (IG Direct + Messenger, Reconnect for old accounts, WhatsApp soon), M03 Reply assistant (Draft reply → edit → Send), M17 People, M16 Reviews (Draft reply → Post reply), M04 Google setup, M14 Google workspace (Posts, New Google post from a brand photo, Profile checklist).

**Where:**
- `/inbox`: three panes, **conversations | thread | customer + assistant draft**. Tabs: Messages · Reviews · People.
- `/google`: Posts + Profile checklist.
- An **Inbox** Overview panel (unread list, compact) so the Overview can show customers next to Today.

```
/inbox
┌ [Messages 3|Reviews 2|People] ┬ Marie D. · Instagram ────────────┬ Marie D. ───────┐
│ ▢ search                      │                                   │ IG @marie.d     │
│ ● Marie D.   IG   2m          │  ◀ "Is the oak board food safe?"  │ 2 conversations │
│   Is the oak board food…      │                                   │ First seen 3 Nov│
│   Paul R.    FB   1h          │  ▶ "Yes — finished with…"  (you)  │                 │
│   …                           │                                   │                 │
│ ─ Needs reconnect ─           │ ┌ Reply ─────────────────────────┐│                 │
│ ⚠ Facebook Page  [Reconnect]  │ │ [✦ Draft reply]                ││                 │
│ WhatsApp  [Soon]              │ │ ____________________________   ││                 │
│                               │ │ AI draft, edit before sending  ││                 │
│                               │ │                        [Send]  ││                 │
└───────────────────────────────┴─┴────────────────────────────────┴┴─────────────────┘

Reviews tab: list | review + [✦ Draft reply] → edit → [Post reply on Google]

/google
┌ Google Business Profile ─────────── Connected ✓ ─┐
│ Posts                          [＋ New Google post]│
│  ┌card┐┌card┐┌card┐  live / draft                │
│ Profile checklist   ✓ Hours ✓ Photos ○ Description│
│ Reviews: 4.7 ★ (38)  [Open reviews →  /inbox?tab=reviews]
└──────────────────────────────────────────────────┘
```

- **Desktop differs:**
  - list and thread are side by side, so there is no push into the reply screen
  - the customer column shows People context, so People becomes a tab plus a side column, not a separate screen
  - Send is always the person's own click; this is kept exactly
- **Entry points:**
  - sidebar Inbox (with unread count) and Google
  - Echo in "Your agents" points at `/inbox`
  - Today task "3 messages waiting" / "2 new reviews"
  - Inbox Overview panel
- **States:**
  - no channel connected: page empty state + Connect → `/connections`
  - connected before inbox existed: Reconnect row
  - loading thread
  - draft generating (the textarea shows a typing cursor; `.typing-cursor` already exists in `globals.css:129`)
  - send failed: retry in place, as in `reels/chat.tsx` conventions
  - Google not connected: M04 setup card with Connect

### Feature 6: Automations + credits

Source: M10 (monthly plan on the 1st costs 5 credits; auto-publish of approved dated posts; "Review before publishing" always on; inbox replies have no backend), M11 (balance, ledger, plan card → Plans).

**Where:** `/settings?tab=automations` and `/settings?tab=billing`, plus the top-bar `CreditsChip` (C4).

```
Settings › Automations
┌ Monthly content plan ───────────────────── [◯━━] ┐
│ On the 1st, the Planner fills next month. 5 ◈/run │
├ Auto-publish approved posts ─────────────── [━━◯] ┤
│ Approved posts with a date go out on their own.   │
│ Needs a connected account → Connections           │
├ Review before publishing ───────── Always on 🔒 ──┤
├ Reply to customers automatically ───────── Soon ──┤
└───────────────────────────────────────────────────┘

Settings › Billing & credits
┌ Balance  1,240 ◈ ┐ ┌ Plan  No plan yet  [See plans] ┐
└──────────────────┘ └────────────────────────────────┘
┌ Credit history ───────────────────────────────────┐
│ Date        What                        Credits   │
│ 14 Nov      Reel "Hand-carved…"           −48     │
│ 12 Nov      Refund: render failed         +48     │
└───────────────────────────────────────────────────┘   (reuse admin/table.tsx)
```

- **Desktop differs:** the ledger is a full table (date / what / amount, `numeric` column right-aligned, `font-mono` for amounts per DS §3); the phone shows a short recent list.
- **States:**
  - toggle saving / failed (revert + inline error)
  - auto-publish without a connection: the switch is disabled with the reason
  - empty ledger
  - viewer: read-only
- **Entry points:**
  - CreditsChip
  - LowCreditsDialog ("See history")
  - Today "Plan next month" when monthly is off

### Feature 7: Fuller onboarding

Source: A04 Goal, A05 Source (Website / Google Maps / Describe), A06 Website, Maps search, A07 Manual, A08 Learning, A09 Review, A10 Brand preferences (palette + tones), A11 Preparing (first Scout run), A12 Connect (+A13 later?). Web today: `/welcome` (`components/welcome/welcome-flow.tsx`, address → research).

**Where:** `/welcome`, outside the shell (as now). One centred card (`max-w-2xl`) with a 5-step stepper at the top. Phone sign-in / verify / email / password stay on the existing `/login` and are not ported.

```
/welcome
        Espanda
   ① Goal ── ② Business ── ③ Review ── ④ Brand ── ⑤ Connect
  ┌──────────────────────────────────────────────────────┐
  │ Where can we learn about your business?              │
  │ [ Website | Google Maps | Describe it ]              │
  │  https:// [ateliersorrel.fr________]  [Continue →]   │
  │  No website? → Describe it                           │
  └──────────────────────────────────────────────────────┘
  ③ while Research runs: the existing reading screen (live log,
     checks) becomes Review's loading state, then the review form.
  ⑤ Connect: IG / FB cards + "Connect later" (dialog, A13)
  After ⑤: "Preparing your first ideas" runs in the background and
  lands as the Overview's Today ideas task, not a blocking screen.
```

- **Desktop differs:**
  - Website / Maps / Describe are tabs of one step (MI3)
  - Preparing (A11) does not block: the workspace opens and the ideas arrive in Today. Same server call, which is free once.
- **States:**
  - website unreachable (`recovery/import-failed.tsx` options become inline options)
  - Maps no results → Describe
  - research failed → retry / continue
  - connect cancelled / failed (`connect.tsx` params)
  - resume onboarding on reload (step in the URL)

### Feature 8: Plans (placeholder)

Source: L01 Reels home without plan, L02 gate, L03 Plans, L04 Activated, L05 Posts offer, L06 Marketing tools; no payments backend.

**Where:**
- `/settings?tab=plan`: plan cards, read-only, with "Payments aren't available yet; contact us to add credits", which is the honest copy from `recovery/low-credits.tsx`.
- `PlanGateDialog` is used by features 2, 3 and 5.
- L01 is not a separate page on web: Reels start shows its normal page with a banner.

```
┌ Plans ─────────────────────────────────────────────────┐
│ ┌ Posts ─────┐ ┌ Reels ─────┐ ┌ Marketing ─┐            │
│ │ … included │ │ … ◈/month  │ │ inbox, Google│          │
│ │ [Current]  │ │ [Soon]     │ │ [Soon]       │          │
│ └────────────┘ └────────────┘ └──────────────┘          │
└────────────────────────────────────────────────────────┘
```

- **States:** no plan; activated (L04 becomes a toast + banner "Reels unlocked", with "Continue your reel" back to the editor).

---

## 6. Components

### Reuse as-is (do not rebuild)

| Existing | Use in |
|---|---|
| `ui/button.tsx`, `ui/card.tsx`, `ui/dialog.tsx`, `ui/sheet.tsx`, `ui/dropdown-menu.tsx`, `ui/textarea.tsx`, `ui/avatar.tsx` | everywhere |
| `ui/page-skeleton.tsx` | page loading |
| `workspace/content-panels.tsx` `useBrandData`, `usePerms`, `LoadGate`, `LoadFailed` (63–131) | all brand data fetching, load/error states |
| `workspace/release-panel.tsx` (Approve, Publish, StoryByHand, History) | F4 story/post approval and scheduling; F3 Review/Publish should follow its layout |
| `workspace/content-panels.tsx` `ContentView`, `StoryFrames` | F4 detail |
| `workspace/draft-editor.tsx` | F4 post caption edit |
| `workspace/chat-pane.tsx` / `shell/assistant-panel.tsx` | F3 planning chat (reel mode), F5 thread layout patterns |
| `workspace/panel-layout.tsx` (`PanelDef`, presets) | Inbox panel, Jobs panel |
| `workspace/score-ring.tsx` | Google profile completeness |
| `admin/table.tsx` | Billing ledger, People |
| `admin/segmented-links.tsx`, `admin/tab-links.tsx`, `admin/use-indicator.ts` | promote to `ui/` → Library tabs, Inbox tabs, Results filters |
| `context/unsaved.ts` | story editor, brand page guards |
| `net/connection-banner.tsx`, `net/error-screen.tsx` | offline / failed pages |
| `.typing-cursor`, `.status-pulse`, `.grow-x` (`globals.css`) | draft generating, running job dot, progress |

### Build once, shared by all eight (in this order)

1. **`PageHeader`, `PageSection`** (C2): title, description, one primary; white card with `px-5 py-4`.
2. **`StatusBadge`** (C3): one status → tone + icon + label map, in `lib/design-tokens.ts` (DS §14 already names this file).
3. **Form kit** (I2): `Select` (styled), `ChoiceCard` (radio card with title + detail, used for format, scene, presenter, model), `Segmented`, `Switch`, `ChipToggle` (tones, goals, filters). One control radius.
4. **`CreditsChip`, `CostButton`, `LowCreditsDialog`, `PlanGateDialog`** (C4).
5. **`MediaGrid` + `MediaPicker` dialog + `Dropzone`** (F1, F2, F3, F4).
6. **`JobProgress`** (step list + elapsed time + "can't reach server" + "taking long") and a top-bar **`JobsIndicator`** (MC2).
7. **`StepsRail`** (done / current / skipped / invalidated; keyboard navigable) (F3, F7).
8. **`PreviewFrame`** (9:16 / 4:5 / 1:1 with a device-neutral frame and live text overlay) (F2, F3, F4).
9. **`ChecksList`**: extract from `release-panel.tsx` ApproveForm issues, and share with reel Review.
10. **`SlotPicker`** (date + time + timezone) (F3 publish, F4 schedule).
11. **`AudioRecorder`** (permission states, level meter, 15 s / 90 s caps) and **`VoiceRow`** (▶ sample) (F3).
12. **`ConversationList`, `MessageThread`, `ReplyComposer`** (draft → edit → send) (F5, reused for review replies).
13. **`ColorSwatch`** with a popover editor (F1).

### Rules so the eight look like one product

- One primary action per view; repeated row actions are secondary or outline (I1).
- Editors are full-bleed with three columns at `lg+` (DS §10 already says "two-column studio" at `lg`; extend it to rail + editor + preview at `xl`). Below `lg`, the rail becomes a step dropdown and the preview becomes a toggle.
- Every paid button shows its price; every running job is in the Jobs indicator; every failure says why and whether credits came back.
- AI writes, the person sends: draft buttons use the ✦ icon + `secondary`, and send/publish buttons are the primary.
- Copy: reuse the mobile i18n strings (`mobile/src/i18n`) as the source of wording, so both platforms say the same thing.

---

## 7. Open questions for the owner

1. **Reel planning chat:** use the global assistant panel in reel mode (recommended), or a chat column inside the editor with the assistant collapsed?
2. **Sidebar:** accept the Create / Customers / Business groups and fold "Soon" agents into one row?
3. **Library vs Brand:** two pages (recommended, because every studio uses the library), or one Brand page with a Photos tab as on mobile M07/M08?
4. **Onboarding A11 "Preparing":** OK to make it non-blocking on web (ideas arrive in Today)?
5. **Brand save model:** autosave per card, or one Save for the page? (The phone mixes both today.)
