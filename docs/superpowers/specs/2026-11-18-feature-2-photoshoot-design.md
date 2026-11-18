# Feature 2 · Photoshoot on the website — design

Date: 2026-11-18. Status: draft for the owner (approach A and the Creator upload rule decided by the owner).
Repos (side by side): `apps/server`, `apps/web`, `apps/mobile`. Parent spec:
`docs/superpowers/specs/2026-11-17-foundations-design.md` (Step 0, merged). Feature 1 (brand look + photo library) is
merged and hands this feature its `LibraryPicker`.

## 1. Intent

Everything a person can do in the phone's Photoshoot (Figma "04 Photoshoot", F01–F07) becomes possible on the website,
with **the same steps, the same choices and the same server calls**, laid out for a desktop screen (owner, 2026-11-17).
Anyone in the workspace who can create content may run a shoot and spend the workspace's credits, Creators included,
with no cap and no role lock (owner, A7, 2026-11-18). The server already enforces plan, credits, refunds and one charge
per submit (Step 0a), so this is UI work on that base.

## 2. Goals, non-goals, anti-goals

Goals
- A product shoot and a fashion shoot can be set up, paid for, watched and reviewed on the website.
- Every choice the phone offers is offered, with the same values sent to the same endpoints.
- The price is on the button that spends it; "no plan" and "not enough credits" open the existing paywall dialog.
- A double click, a retry after a timeout, or a refresh never charges twice.
- Keyboard and screen-reader use works (radio groups, polite step announcements, named result images).

Non-goals (later, or covered elsewhere)
- **Use in story** (feature 4 brings stories to the web). **Share** (no share sheet on desktop; Download covers it).
- A Jobs entry in the top bar, a toast or a Today task on completion (review MC2); the studio's inline card is enough
  for one feature. Add when reels (feature 3) also runs long jobs.
- A quality check of each shot against the original (left out on the phone too).
- Translations; the website is English only (open owner decision, parent spec §9).
- New server behaviour, beyond moving existing types/constants into the shared contract and the one permission change
  in §5.0.

Anti-goals (a failure even if it works)
- Charging twice for one press, or starting a shoot the person didn't press for.
- Showing a provider's error text (the server already hides it; the web must not invent its own detail).
- Changing what phone builds get.
- A second photo picker or a second copy of the tier prices.

## 3. Constraints (from the code today)

- Endpoints (brand-scoped, `…/workspaces/{ws}/brands/{brand}/photoshoots`):
  - `GET` → `{ shoots: Shoot[] }`, newest first; `brand.read`.
  - `GET /{id}` → `{ shoot: Shoot }`.
  - `POST` body = `ShootRequest` + optional `requestId` (UUID) → 202 new, 200 repeat of the same `requestId`;
    402 `{ insufficientCredits, balance, needed }` or `{ planRequired, title }`; `content.create`; 503 when
    `PAID_STARTS_OFF_FOR=web`.
  - `ShootRequest` (zod in `server/photoshoot/shoot.ts`): product `{ tier, sourceKey, ratio 1:1|4:5|9:16,
    scene studio|interior|custom, brief }` (brief required for custom); fashion `{ tier, sourceKey, ratio 4:5|9:16,
    model? natural|editorial|casual, pose fullBody|threeQuarter|closeUp, background studioMinimal|urbanStreet|naturalInterior }`.
  - `Shoot`: `id, kind, tier, status RUNNING|DONE|FAILED, input, credits, failed, createdAt, sourceUrl, shots[{key,url}]`;
    links are signed for an hour.
- Tiers: base 4, moderate 6, higher 12, ultra 24 credits for four photos (`server/photoshoot/tiers.ts`); base preselected.
  The phone keeps a hand copy (`SHOOT_TIERS` in `mobile/src/api/endpoints.ts`).
- A shoot takes about a minute (Base) to a few minutes (Ultra); the server gives up after an hour.
- Web parts ready: `LibraryPicker` (`onUse(photo)` gives key, url, title; uploads included), `JobProgress` +
  `useJob` (polling intervals, slow/failed notices, live regions), `StatusBadge`, `PageHeader`/`PageSection`,
  `CreditsChip`, `PaywallDialog` + `lib/paywall.ts`, `requestId()` in `lib/net.ts`, `withPrice`/`creditsText` in
  `lib/plan-credits.ts`, `requireFeature("photoshoot")` and the sidebar entry `/photoshoot` (flag `WEB_FEATURES`).
- Not in the web kit yet, asked for by the review before this feature (design-ux I2): a radio card (`ChoiceCard`) and a
  `Segmented` control.
- The phone's copy (`mobile/src/i18n/locales/en/photoshoot.json`) is the wording source.

## 4. Approaches considered

- **A. One studio page (picked by the owner, 2026-11-18).** `/photoshoot`: Product/Fashion switch, setup on the left,
  the running shoot and its four photos on the right, past shoots below; each past shoot opens `/photoshoot/{id}`.
  Fewest clicks, suits a wide screen, and replaces the phone's blocking "generating" screen with an inline card
  (review MC2).
- **B. Mirror the phone's pages** (start → setup → generating → results → detail). Easy to check step by step against
  the phone, but more clicks and a waiting page that blocks the person. Not picked.
- Same build cost either way.

## 5. The design

### 5.0 Creators may upload photos (owner, 2026-11-18)
`POST …/media` (library upload) checks `content.create` instead of `publish.execute`, so a Creator can upload the
product or garment photo they want to shoot. Nobody loses access: every role with `publish.execute` (Manager, admins)
also has `content.create`. The phone shows its upload buttons to everyone already, so Creators there stop getting a
403; no phone code changes. On the web, `/library` and the studio pass `canUpload={perms.has("content.create")}`.
Removing photos, colours and tones stay on `context.edit`. Update the server route test and the handover's feature 1
note ("add photo = publish.execute").

### 5.1 Shared contract (server repo, synced)
`shared/photoshoot.ts`: tier ids with credits (from `tiers.ts`), the option lists (ratios per kind, scenes, poses,
backgrounds, models with display names Léa / Inès / Hugo, fashion output formats), the `ShootRequest` and `Shoot` types.
`server/photoshoot/tiers.ts` and the route read credits from it; `scripts/sync-shared.mjs` copies it to web and mobile.
Mobile's `SHOOT_TIERS`/types re-export from the synced copy with no behaviour change. *(My call: removes the second
price copy the handover warns about; same pattern as `shared/brand-look.ts`.)*

### 5.2 `/photoshoot` — the studio
Behind `WEB_FEATURES=photoshoot`; same no-business state as `/library`. Without `brand.read`: the lock state. With
`brand.read` but no `content.create` (Viewer, Approver…): a read-only studio, with past shoots and the shoot page, no
setup, no Generate, no Variation, and the line "Your role can view photoshoots but not start them." *(My call: matches
the server, which answers 403 to them.)*

**What a card's buttons spend** *(my call)*: a button on a shoot (Try again on a failed one, Variation on the shoot
page) always re-sends **that shoot's own `input`**, priced from its tier. It never sends the setup on the left. The left
setup is only ever spent by Generate. So the price on every button matches what it starts.

```
Photoshoot                                      [credits chip in top bar]
Create product photos and style apparel on models.
( Product | Fashion )                                       <- Segmented

┌ Setup ────────────────────────┐  ┌ This shoot ───────────────────────┐
│ Source photo  [thumb] Change  │  │ (nothing yet) / JobProgress card  │
│ Aspect ratio  (1:1)(4:5)(9:16)│  │  1 Processing catalog asset  Done │
│ Scene style   [Studio][Interior][Custom]  2 Composing scene  In progress│
│ Creative brief  [textarea]    │  │  3 Finishing & colour       Queued│
│ Quality  [Base 4][Mod 6][Higher 12][Ultra 24]                        │
│ [ Generate photoshoot · 4 credits ]   then the 4 photos, Open shoot →│
└───────────────────────────────┘  └───────────────────────────────────┘
Past photoshoots   (All 12)(Product 9)(Fashion 3)
[card][card][card][card]   status badge: Processing · 4 credits / Ready / Didn't work · 4 credits refunded
```

- **Product setup**: source photo (opens `LibraryPicker`), aspect ratio, scene style (radio cards), creative brief
  ("Optional", "Required" when Custom; Generate disabled with the reason as text until filled), quality tier.
- **Fashion setup**: garment photo (same picker; the phone's hint and upload requirements shown as text), model &
  styling (radio cards incl. "Choose a model" = none, the shoot picks), pose, output format (Feed portrait 4:5,
  Story/Reel 9:16), background, quality tier.
- Each kind keeps its own choices when switching Product/Fashion during the visit. No source photo → Generate is
  disabled with "Choose a photo" / "Upload a garment photo to enable generation" as visible text.
- **Generate** is the page's only primary button, labelled with the price (`withPrice`). Press flow as the phone's
  `startShoot`: one `requestId` per press; if the press got no answer (timeout, network), pressing again with the same
  choices reuses that id, so a press that did reach the server is returned, not charged again. Button disabled while
  the request is in flight. 402 → paywall dialog; 503 paused → the server's sentence inline; other errors inline.
- **This shoot** (right column): after Generate, a `JobProgress` card polling `GET /{id}`, with the phone's three
  steps and states (step 1 done once the shoot exists; step 2 active while RUNNING) and the phone's wait line ("Four
  photos, usually ready in about a minute" / the Ultra variant). Step changes and completion are announced politely,
  once each. DONE → the four photos in place with "Open shoot". FAILED → "This photoshoot didn't work. Your N credits
  are back." with "Try again · N credits" (re-sends the failed shoot's input, a new charge). Leaving the page doesn't stop the
  shoot; it shows in Past photoshoots.
- **Past photoshoots**: `GET` list, filter All/Product/Fashion with counts (Segmented), cards with the first photo
  (or source photo while running), "Product · Studio"-style title, date and a `StatusBadge`. The list re-reads while
  any shoot is RUNNING (same intervals as `useJob`). Empty: "No photoshoots yet."
- Narrow screens (< `lg`): columns stack, setup first. No horizontal scroll at 375 px.

### 5.3 `/photoshoot/{id}` — one shoot
- Header: title ("Product · Studio"), date, status badge, back to Photoshoot.
- The four photos in a grid, each named "Photo 2 of 4, Product · Studio"; selecting one shows it large.
- **Compare original**: a toggle button that shows the source photo beside the selected photo (no drag slider).
- **Download photo**: downloads the selected JPG. *(My call: the server signs the link with
  `Content-Disposition: attachment` if the bucket supports it; otherwise the builder opens the image in a new tab
  labelled "Open full size". Builder checks which.)*
- **Variation · N credits**: runs the same input again (new `requestId`, same press rules), with the text "Runs the
  same setup again and is charged again" next to the button, then returns to `/photoshoot` showing the new shoot in
  "This shoot".
- Staging summary: format, scene/pose/background/model, brief (or "No art direction: staged as the scene style
  describes"), creation cost.
- RUNNING → the same `JobProgress` card; FAILED → the refunded line.
- Signed links expire after an hour: re-read the shoot when a link is older than ~50 minutes (as the library does).

### 5.4 Kit additions (web `components/ui`)
- `Segmented` (radio group look-alike for 2–4 options: Product/Fashion, filters, aspect ratio).
- `ChoiceCard` group (radio cards with title, optional description and price: scenes, tiers, models, poses,
  backgrounds). Native radio inputs underneath, arrow keys move, one tab stop per group.
- One control radius per the review (`rounded-xl` inputs, pill buttons).

## 6. Left to the builder
- File and component split, polling details within `useJob`, and test layout (pure helpers get unit tests: request
  building from choices, step states, press/requestId reuse, label text).
- Whether the "This shoot" card remembers the running shoot across a reload (e.g. `?shoot=id` in the URL) — nice,
  not required.
- Exact wording where the phone has none (desktop-only labels), following the phone's tone.
- Adding `/photoshoot` and `/photoshoot/{id}` to `scripts/audit-ui.ts`.

## 7. Checks
- Unit tests as above; web build + bundle check; server tests for the contract move; mobile typecheck.
- Live: the Higgsfield/OpenAI account has no credits; an unlimited test workspace can still run a Base product shoot
  (OpenAI) end to end. Owner's manual checks go in the handover (flag off = 404, double click = one shoot, 402 opens the
  paywall, keyboard through every group, 375 px).
