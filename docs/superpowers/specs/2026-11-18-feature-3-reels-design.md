# Feature 3 · Reels studio on the website — design

Date: 2026-11-18. Status: approved by the owner on 2026-11-18. The owner's answers to §9 are recorded there: the
recommended answer for Q1–Q5, and for Q6 an audio upload for scene takes is in feature 3 (slice 3b, §5.6).
Repos (side by side): `apps/server`, `apps/web`, `apps/mobile`. Parent spec:
`docs/superpowers/specs/2026-11-17-foundations-design.md` (Step 0, merged). Model: feature 2
(`2026-11-18-feature-2-photoshoot-design.md`, merged). Finding ids (C-4, I-2, MC1, Mi2…) refer to
`docs/handover/2026-11-17-mobile-web-parity-review/`.

## 1. Intent

Everything a person can do in the phone's Reels studio (Figma R01–R13 and X01, `mobile/src/app/reels/*`) becomes
possible on the website, with **the same steps, the same choices and the same server calls**, laid out for a desktop
screen (owner, 2026-11-17). The phone's chain of thirteen full screens becomes one reel page with a steps rail. Long
waits become inline cards. The paid buttons follow the money rules feature 2 set: the price is on the button, nothing
is charged twice, and a 402 opens the paywall.

Most of the safety work was done in 0a, but checking the code turned up two gaps that still need server work before
the web gets a render button or a second chat client (§3.1).

## 2. Goals, non-goals, anti-goals

Goals
- A reel can be planned (chat, an idea or a template), given a presenter, photos, a script, a voice, recorded takes
  or a cloned voice, rendered, reviewed, downloaded, published or scheduled from the website.
- Every choice the phone offers is offered, with the same values sent to the same endpoints.
- Each paid button (render, presenter, template preview, clone) shows its price. A double click, a retry after a
  timeout, a refresh or a second tab never charges twice. "No plan" and "not enough credits" open the existing paywall.
- A dropped or slow plan stream never makes a second reel or loses the reply.
- The site works with a keyboard and a screen reader, including recording, render progress and the video itself (§5.9).

Non-goals (later, or covered elsewhere)
- **The ready banner and push** (R11 "ready banner", `ui/reels/render-watch.ts`). The website has no push channel,
  and polling stays per page (operations review). See also Q3.
- **Use in story** (review and storyboard). Feature 4 brings stories to the web.
- **Credit history labels** for presenter, preview and clone charges (I-8). Feature 6 adds the credit history to the
  web, and the fix lands with it. Today only the phone shows these labels, and they are wrong there.
- Translations. The website is English only (parent spec §9).
- Moving the phone's own screens onto the shared helpers. The phone gets the new shared types by re-export, with no
  change in behaviour (§5.1).

Anti-goals (a failure even if it works)
- Charging twice for one press, or rendering a version that already has a video without being asked.
- Making a second reel because a stream dropped and the person pressed again.
- Showing a provider's error text (the server words failures as `failure.kind`, and the web words those kinds the way
  the phone does).
- Changing what old phone builds get, except the one race named in §5.0 S5.
- A second photo picker, a second NDJSON reader, a second poller or a second copy of the reel prices.
- Accepting an uploaded file as a voice-clone reading (security A1: clones are recorded live, with the challenge).

## 3. Constraints (from the code today)

Endpoints (brand-scoped, `…/workspaces/{ws}/brands/{brand}`):

| Call | Body / answer | Permission | Notes |
|---|---|---|---|
| `GET /reels` | `{ reels: ReelSummary[] }`, newest 50 | `brand.read` | signs thumb + video per reel |
| `POST /reels` | `{ opportunityId? , prompt? (≤2000), templateId?, language?, requestId? }` → 201 `{ id, version, plan, price, reply }`; NDJSON with `Accept: application/x-ndjson` | `content.create` | plan gate + 20/h/brand; `requestId` repeat → same reel; 409 `reel.stillPlanning` while the first runs |
| `POST /reels/{id}/plan` | `{ version, message?, templateId?, presenterId?, language? }` → `{ version, plan, price, reply, droppedRecordings }`; NDJSON | `content.create` | plan gate + 20/h/brand; **no `requestId`, no lock before the AI runs** |
| `GET /reels/{id}` | `ReelDetail` (plan, price, seconds, sceneSeconds, caption, videoUrl, checks, renders, chat, credits, photoUrls, aiDisclosure) | `brand.read` | re-queues a render that has been quiet for over 60 s |
| `PATCH /reels/{id}` | `{ version, plan }` → `PlanResult` | `content.create` | plan check, not counted in the 20/h; may run the director (AI) |
| `POST /reels/{id}` `render` | `{ version, again? }` → 202 `{ render }`; 402 either shape | `content.create` | charge refId `versionId:attempt`; a running render is returned, not charged |
| `POST /reels/{id}` `send` | `{ version, how:"download" }` → `{ videoUrl }` | `content.approve` | approves AWAITING_APPROVAL |
| `POST /reels/{id}` `recheck` | → 202 `{ status: started\|checking\|none }` | `content.create` | 1 per 15 s per reel, 10/h/brand |
| `POST /reels/{id}` `register-link` | `{ url }` | `publish.execute` | |
| `POST /reels/{id}/recordings` | multipart `file`, `text`, `language` → 201 `{ id, seconds, transcript, matches }` | `content.create` | M4A or WebM, ≤1 MB, ≤15 s; 30/h/user, 60/h/reel |
| `GET /reels/options` | `{ templates, previewCredits, canPreview, presenters, traits, presenterCredits }` | `brand.read` | |
| `POST /reels/presenters` | `{ name ≤40, traits }` → 202; 402 | `content.create` | 2 credits; one RUNNING per brand (409 busy, refunded) |
| `DELETE /reels/presenters/{id}` | 204 | `content.create` | not while RUNNING |
| `POST /reels/previews` | `{ templateId }` → 202; 402 | `content.create` | 10 credits; one RUNNING per brand and template |
| `GET /voices` | `{ voices, cloning: { allowed, credits, max, seconds, consent } }` | `brand.read` | |
| `GET /voices/library` | `?language&gender&age&accent&useCase&search&page` → `{ voices, more, usable }` | `brand.read` | ElevenLabs public library, 30 a page |
| `GET /voices/clones/challenge?lang=` | `{ challengeId, lang, sentences }` | `voices.manage` | 10-minute TTL, single use, 20/h/user |
| `POST /voices/clones` | multipart `file, name, consent=1, challengeId, requestId, appVersion` → 201/200; 402; 409 `clone.updateApp` / max 2; 410; 422 | `voices.manage` | 10 credits; 60–90 s; ≤4 MB; 5/h/user |
| `PATCH`/`DELETE /voices/clones/{id}[?withdraw=1]` | rename / delete | `brand.read` + owner or admin | |
| `POST /content/{id}` `edit` / `decide` / `publish` / `cancel` / `posted` / `not-posted` | as posts | as posts | caption edit; approve + publish (R08/R09) |

- Every paid start goes through `paidStart`: it answers 503 "Making this from the website is paused" when
  `PAID_STARTS_OFF_FOR=web`.
- A streamed plan ends with `{type:"done",result}` or `{type:"error",status,detail,code,planRequired}`. Progress lines
  are `stage` (reading / writing / directing) and `draft` (reply, title, scenes so far). The web's `request()`
  (`components/settings/api.ts`) already reads them: progress goes to `onLine`, a streamed 402 opens the paywall, and
  a body that breaks off becomes `ApiError` status 0.
- Plan rules (`server/reels/plan.ts`): 2–6 scenes; voice text ≤400 characters and ≤30 words a scene (about 15 s);
  scene length follows the voice (a recording's measured length, else about 2 words a second, 3–15 s; presenter
  scenes at least 4 s); price = Σ scene seconds × 2 credits (4 for presenter scenes). The server returns `price` and
  `seconds`, and the clients never compute them.
- A finished render **writes a new plan version** (latest + 1, with `videoKey`, `createdBy:"agent"`). Any client
  still holding the old version then gets 409 on its next save, caption edit, download or approval (I-3).
- Route budgets: create and chat `maxDuration = 120`, PATCH 300, recordings and clones 60. The phone waits 120 s for
  AI calls, 60 s for a recording and 90 s for a clone. *(The parent spec said 330 s for plan and chat; the routes
  allow 120, so 120 is what the web uses.)*
- Web parts ready: `request()` with `onLine` and `timeoutMs`, `SLOW_MS` (120 s), `requestId()`, `useJob` with
  `JOB_INTERVALS.reelRender` / `preview` / `publishing`, `stopOn`, `capMs`; `JobProgress`, `StatusBadge`,
  `PageHeader`/`PageSection`, `SegmentedRadios`, `ChoiceCards`, `PaywallDialog` + `lib/paywall.ts`, `withPrice`,
  `isRepeatClick` and `PRESS_COOLDOWN_MS` (`components/photoshoot/press.ts`), `LibraryPicker` (single photo, uploads
  included), `SIGNED_LINK_STALE_MS`, the release panel (approve, publish and schedule, cancel, posted / not posted),
  `requireFeature("reels")` and the sidebar entry `/reels` (already in `lib/nav.ts`, flag `reels`).
- The phone's copy (`mobile/src/i18n/locales/en/reels.json`, `recovery.json`) is the wording source.

### 3.1 The review findings, checked against the code (not the docs)

| Finding | State | Evidence |
|---|---|---|
| **C-4** re-render charges again | **Open in practice.** 0a added `render.alreadyDone`, but it never fires after a real render | `render.ts:127` looks for a DONE render on the **latest** version. A finished render belongs to version *v*, and its join writes *v+1* (`render.ts:412`) with no render rows. So pressing render on *v+1* passes the check and charges. The unit test mocks a DONE render on the latest version, which never happens. Fix: S2 |
| **C-5** paid features gated on the client only | Closed for reels | `planGate` in `createReel`/`chatPlan` (`service.ts:121-124`), `requirePlan` in `editPlan`, `startRender`, `createAsset`, `createClone` |
| **C-6** web can't publish a studio reel | **Open** | `publishRequirements` gives every reel `needsVideo:true` (`publishing.ts:67`); the release panel then asks for a link (`release-panel.tsx:320,399`) that the server refuses for studio reels (`publishing.ts:390`). Fix: S3 |
| **C-8** browser audio refused | Closed for WebM and MP4 | `isWebm` + explicit `-f matroska` (`recordings.ts:29-36,73`). **Ogg is still refused**, so Firefox must be asked for WebM (§5.6) |
| **I-2** two clients chat on one version | **Open** | Nothing is locked before the scriptwriter runs; the version is checked only at save (`service.ts:162-170`). Chat takes no `requestId`. Fix: S5 |
| I-15 streamed errors lose `code` | Closed | `streamPlan` sends `code` and `planRequired` (`service.ts:40`) |
| Ops I7 ledger scan on every reel poll | **Open** | `renderView` reads `creditEntry` by `refId` with no `workspaceId` (`render.ts:495`). Fix: S10 |
| I-6 web draft editor edits a studio reel's hook and script | **Open** | `saveDraft` merges what is sent (`publishing.ts:205-240`). Fix: S4 |

## 4. Approaches considered

- **A. A reels home and one reel page with a steps rail.** `/reels` holds the start, ideas, templates, presenters and
  your reels. `/reels/{id}` holds the rail (Plan → Presenter → Photos → Script & voice → Storyboard → Video → Review
  → Publish), the editor for the chosen step, and a 9:16 preview. Every step can be seen and reached, including
  Script & voice, which the phone hides behind the presenter screen (MC1). Waits are inline (MC2). *(My call,
  following the owner's choice of the same shape for feature 2 (approach A), and design-ux §5 feature 3.)*
- **B. Mirror the phone's thirteen screens.** Easier to check one screen at a time, but it copies MC1 (an unreachable
  step) and the blocking generating screen. Not picked.
- The build cost is about the same either way. A needs one rail component and a URL `?step=`.

## 5. The design

### 5.0 Server changes (server repo; each additive for old phone builds unless stated)

- **S1 · Shared contract `shared/reels.ts`** (§5.1).
- **S2 · Re-render guard that works (C-4).** In `startRender`, "already has a video" means **the latest version's
  body has a `videoKey`**. That is exactly the phone's check (`storyboard.tsx:33`, `!!detail.videoUrl`), and edits
  and chat revisions drop `videoKey` (`toVersionBody`). Without `again: true` the answer is 409 `render.alreadyDone`.
  The old check (a DONE render on the latest version) stays as well. The test models the real sequence: render *v* →
  DONE writes *v+1* → render *v+1* is refused with no charge. Phone: no change, because it never presses render on
  a finished version.
- **S3 · Studio reels in the release state (C-6).** `publishRequirements` gains `studio: boolean` (from
  `item.studio`). For a studio reel the web release panel shows no Video link field and no link check. `needsVideo`
  stays as it is, so old readers are unchanged.
- **S4 · A studio reel's hook and script follow its plan (I-6).** For a studio item, `saveDraft` takes `hook` and
  `script` from the latest plan (`scenes[0].onScreenText`, `scenes[].voiceText`) and ignores any sent values. The
  phone already sends those same values (`endpoints.ts:377-381`), so it sees no change.
- **S5 · One plan turn at a time per reel, and a chat `requestId` (I-2, dropped streams).**
  - `chatPlan` claims an in-flight marker `reel-chat:<itemId>` (the `claimTransient` 0a built for create, with the
    same 6-minute expiry) **before** the rate-limit hit and the scriptwriter. While it is held, another message gets
    409 `reel.stillPlanning` ("This reel is still being planned. Wait for the reply.") and nothing is spent or counted.
  - `POST /reels/{id}/plan` takes an optional `requestId` (UUID). It is stored on that user turn
    (`chat[].requestId`). A repeat whose id is already in the chat returns the saved result (`version, plan, price,
    reply`) with 200, and a repeat while it runs gets the 409 above.
  - The same order fix applies to create: claim the marker before `planGate`'s rate-limit hit, so a retry that gets
    409 doesn't use up one of the 20 runs an hour.
  - *Changes what phones get in one case only:* a phone that sends a message while another device's message on the
    same reel is still being written now gets an immediate 409 with that sentence. Today it pays for the AI and then
    gets 409 "This plan changed in the meantime". *(My call: same outcome, sooner, at no cost.)*
- **S6 · A dropped reader doesn't stop the plan.** In `streamPlan`, `send` ignores `enqueue` errors once the reader
  has gone, so the plan is still written and saved. Recovery on both clients assumes "the server carries on", and an
  `enqueue` on a cancelled stream throws inside `onDraft`. Test: cancel the reader mid-plan, and the reel or turn is
  still saved. (If the test shows that Next never cancels the stream, the change is a no-op guard.)
- **S7 · A real download for the reel.** The `send` answer also carries `downloadUrl`, signed with
  `Content-Disposition: attachment` as `reel-<first 8 characters of the id>.mp4`, the same way feature 2's shots are.
  `videoUrl` is unchanged.
- **S8 · Caption cues (only if Q2(a) is yes).** `ReelDetail` gains `captions: { start, end, text }[] | null`, built
  from the DONE render the latest version came from: each scene's voice text over the scene lengths the join actually
  used (`outputs.voiceSeconds` → `clipSeconds`, presenter minimum). It is null with no finished video. The web turns
  the cues into a WebVTT track.
- **S9 · The consent version on screen.** `GET /voices` `cloning` gains `consentVersion` (`CONSENT_VERSION`), so the
  checkbox label can show the version the consent record names (a11y).
- **S10 · Index-friendly render view (ops I7).** `renderView` adds `workspaceId` to its `creditEntry` query. The web
  polls the reel every 5–30 s while it renders. No behaviour change.
- New error codes go into `shared/contract/errors.ts`: none apart from those above (`reel.stillPlanning` already
  exists).

### 5.1 Shared contract (server repo, synced)

`shared/reels.ts` (plain TS, no zod):
- Types: `ReelPlan`, `ReelScene`, `ReelSummary`, `ReelDetail`, `PlanResult`, `PlanEvent`/`PlanStage`/`DraftSoFar`,
  `RenderStep`, `RenderFailure`, `ChatTurn` (with the optional `requestId`), `CheckResult`, `ReelOptions`,
  `Presenter`, `PresenterTrait`, `ReelTemplateOption`, `ReelVoiceOption`, `LibraryVoice`, `CloningInfo`.
- Limits the forms check before sending: `REEL_SCENES {min 2, max 6}`, `MAX_SCENE_WORDS` 30, `VOICE_TEXT_MAX` 400,
  `CHAT_MESSAGE_MAX` 2000, `NAME_MAX` 40 (presenter and clone), `MAX_RECORDING_SECONDS` 15, `MAX_RECORDING_BYTES`
  1 MB, `MAX_CLONE_BYTES` 4 MB, `REEL_DURATION_CHIPS` [20, 30], and the library filter values (gender, age, use case).
- Rules both apps need: `reelStage(summary)` (draft / processing / ready / failed, the phone's `statusOf`),
  `REEL_SENDABLE` and `REEL_SCHEDULABLE` (the phone's review sets), `isReelIdea(opportunity)` (channel
  `INSTAGRAM_REEL`, not REJECT).
- The server's zod `ReelPlan` stays in `server/reels/plan.ts`, with a type-level check that its inferred type equals
  the shared one. Server constants that duplicate these (`MAX_SCENE_WORDS`, the recording and clone caps) import them.
  `scripts/sync-shared.mjs` copies the file to web and mobile. The phone's types in `endpoints.ts` re-export from the
  synced copy with no behaviour change. *(My call: the reel types are the largest hand copy left, and the web would
  make it a third.)*

### 5.2 `/reels` — the reels home (R01, R02, R06, R10 and R12 entry points)

Behind `WEB_FEATURES=reels`; the same no-business state as `/photoshoot`. Without `brand.read`: the lock state. With
`brand.read` but no `content.create`: read only, meaning the list and the reel page with no Plan, Make, Record or
Generate controls, and the line "Your role can view reels but not make them."

```
Reels                                                  [credits chip in top bar]
Plan, make and post short videos for your business.
┌ Plan a reel together ───────────────────────────┐ ┌ Presenters ──────────┐
│ What should your next reel be about?             │ │ [Léa ✓][Tom …][+ Make]│
│ [ describe it…                         ] [Plan]  │ ├ Templates ───────────┤
│ ● 6 reel ideas ready   [View ideas]              │ │ [▶ Unboxing][▶ Detail]│
└──────────────────────────────────────────────────┘ └──────────────────────┘
Your reels   ( All 12 | Ready 4 | Processing 1 )
[9:16 card][9:16 card][9:16 card]   badge: Draft / Processing / Ready / Failed / Scheduled / Posted · 24 s
```

- **Plan a reel**: a prompt (≤2000) and **Plan**, which starts a new reel in a streamed create (§5.5) and opens
  `/reels/{id}?step=plan` once the reply lands. While it streams, the card shows the stages and the draft as they
  arrive. Leaving the page doesn't stop the plan, and the reel appears in the list when it is saved.
- **View ideas** (R02): a dialog listing the brand's reel ideas (`GET /opportunities` filtered by `isReelIdea`), each
  with **Use this idea**, which does a streamed `POST /reels {opportunityId}`. *(My call: the phone sends the same call
  without streaming; streaming the same call costs nothing and shows progress.)* Empty: the phone's `ideas.empty`
  wording.
- **Presenters** (R10 without a reel): the brand's presenters with their state, **Make a presenter** (dialog, §5.3
  Presenter) and Remove. Polls options while one is being made.
- **Templates** (R12 without a reel): each template's preview (the generic one, or the brand's own once made), with
  **Use** (a streamed create `{templateId}`; the server writes the English title as the person's turn when no message
  is sent) and **Preview with my photos · 10 credits** (§5.4). `canPreview: false` → the button is replaced by "Add a
  photo to your library to preview with it."
- **Your reels** (R06): `GET /reels`, filter All / Ready / Processing with counts (`SegmentedRadios`, the phone's
  three), cards with the first scene's photo, title, seconds and a `StatusBadge` from `reelStage` plus the item status
  (Scheduled / Posted). A failed card says "Didn't work · N credits back" and opens the reel at Video. A downloaded,
  unposted reel (APPROVED with no post link) shows **Posted it? Add link** (`register-link`, `publish.execute`). The
  list re-reads while any reel is processing (§5.8). Empty: "No reels yet."
- No plan (and not unlimited): a banner, "Reels need a plan. You can look around; planning and making videos are
  locked." Plan, Use and Preview open the paywall dialog with the plan refusal without sending anything. The server
  stays the authority (it answers 402 `planRequired` anyway).

### 5.3 `/reels/{id}` — one reel

`/reels/{id}?step=<step>&b=<business>`: the step is in the URL, so a reload keeps it. The default step is the first
one that needs something (no plan → Plan; stand-ins → Photos; rendering or failed → Video; a video → Review), else
Storyboard.

```
┌ Steps ─────────┬ Script & voice ─────────────────────────────┬ Preview ─────┐
│ ✓ Plan         │ Voice: Léa (French) ▶ Play sample  [Change]  │ ┌──────────┐ │
│ – Presenter    │ Scene 1 · 6 s  [textarea]  14 words · ~7 s    │ │   9:16   │ │
│ ⚠ Photos (1)   │   ● Recorded 5.8 s  [Play] [Record again] [Remove]│ scene 1 │ │
│ ● Script &     │ Scene 2 · 5 s  [textarea]  [Record]          │ └──────────┘ │
│   voice        │ …                                            │ ◀ 1 of 4 ▶   │
│ ○ Storyboard   │                    [ Save script ]           │ Transcript…  │
│ ○ Video        │                                              │              │
│ ○ Review       │                                              │              │
│ ○ Publish      │                                              │              │
└────────────────┴──────────────────────────────────────────────┴──────────────┘
```

- **Rail**: a `nav` list with each step's state as text (Done / None / Needs a photo / Making… / Didn't work / Ready
  / Scheduled). One click opens a step. The rail and the preview stay usable during a render.
- **Editing locks** (the server refuses them): while a render runs, every step's edit controls are disabled, with "A
  video is being made from this plan. Wait for it to finish." After the reel is scheduled or posted: "This reel is
  already scheduled or posted." After any 409 "changed in the meantime" or "newer version": reload the reel, keep
  what was typed in the box, and say "This reel changed elsewhere. Your text is still here; save again."
- **When a render finishes, the reel is read again** (its version moved, I-3) before any other write.

Per step (same choices as the phone):

| Step (phone) | Desktop |
|---|---|
| **Plan** (R04, R12 Use) | The chat thread (`role=log`) with the plan card (title, N scenes, seconds, opening line), the phone's starters on an empty chat (three ideas, then "A reel about <product>"), and the duration chips "Current: N s", "20 s", "30 s" (a chip within 5 s of the current length is hidden; a chip sends the English sentence "Make it N seconds"). A composer (≤2000) and Send. "Start from a template": the templates as `ChoiceCards` with Use, which sends `{templateId}` with no message. A failed send shows "Try again" with the last message. See Q1 for where this chat lives. |
| **Presenter** (R10) | `ChoiceCards`: "No presenter", then each DONE presenter. A RUNNING one shows "Being made…" and can't be picked; a FAILED one shows "Didn't work · 2 credits back" with Remove. **Make a presenter · 2 credits** opens a dialog with a name (≤40) and one radio group per trait (the server's `traits`, with the English labels it sends). **Use this presenter** sends chat `{presenterId}` (a streamed scriptwriter turn, priced in the reply as the plan's new price). **No presenter** sends `PATCH` with `presenter:"none"`. Remove sends `DELETE` (not while RUNNING). |
| **Photos** (R13) | One slot per scene, in scene order, each with the scene's photo (alt = the scene's `shot`), "Stand-in: this photo doesn't show what the scene talks about" where flagged, **Change photo** (opens `LibraryPicker`; uploads allowed with `content.create`), and **Move earlier / Move later** (swap photos between scenes; focus follows and is announced). **Save photos** sends one `PATCH` with `scenes[i].photoKey`, as the phone's Apply does. *(My call: per-scene picking uses the existing single picker, with the same choices and the same single call as the phone's ordered multi-select; no multi-select picker.)* |
| **Script & voice** (R11, voices, record, clone) | One textarea per scene (≤400 characters) with "N words · ~N s" and the 30-word limit as text (Save is blocked with the reason). This replaces the phone's blank-line split; same `PATCH`. A recorded scene shows its take (length, Play, Record again, Remove) and "Editing this text drops its recording". After Save, `droppedRecordings` → "Scene 2's recording was dropped because its text changed." Voice row: name, language, **Play sample**, **Change voice** → the Voices sheet (below). **Record** opens the recorder dialog (§5.6). |
| **Storyboard** (R03) | Facts: N s · vertical · presenter or "No presenter" · N scenes. Each scene: photo, shot, direction, on-screen text, voice text, the video model's name (the phone's `MODEL_NAMES`), presenter tag, and the transition to the next as text ("Cross-fade into scene 3"). **Make video · N credits** is the page's only primary button (§5.4). Stand-ins block it, with "Pick photos" leading to Photos. A version that already has a video shows **Watch the video** (to Review) in its place. |
| **Video** (R05, X01) | `JobProgress` with the phone's three steps (voice → clips → join, from `renders[0].step`), the wait line and the notes the phone has: offline, "Can't reach the server" after 30 s with no render read, and "Taking longer than usual" after 15 minutes (`capMs`). "It's safe to leave this page." DONE → Review. **FAILED** (X01): the kind in the phone's words (unavailable / slow / scene N / voice deleted / other), where it stopped, "Your N credits are back" (`renders[0].credits`), **Try again · N credits** (today's price, which may differ from the refunded one, and is said so when it does), **Edit storyboard**, and **Change voice** for `voiceDeleted`. |
| **Review** (R07) | The player in the preview column (§5.9 captions), the transcript as text, the checks list (reusing the release panel's issue list), "Checking… usually under a minute" with an automatic recheck at 90 s and "Check again" after 150 s, the caption and hashtags (editable, `content.create`, saved with `POST /content/{id} edit`), the read-only `aiDisclosure` line ("Added when it's posted"), and the specs (seconds, 9:16, voice). **Download** (`content.approve`; `send` then saves `downloadUrl`), with "Downloading approves this version." A blocker disables Download and Publish, with the reason. **Ask for changes** opens Plan. |
| **Publish** (R08, R09) | The release panel's publish form and history, reused (with S3 it no longer asks a studio reel for a link). Instagram account status, and Connect when none is active ("Expired: reconnect" when one exists but isn't active). Publish now / Schedule with date and time (Q4). One press approves the version first when it isn't approved (`decide` APPROVED, `noAutoPublish:true`), then publishes, as the phone does. After an error the reel and its release state are read again before a retry, so the approval isn't asked twice. Scheduled: the slot, Cancel schedule, and Posted / Not posted for by-hand attempts (existing History). Publishing polls with `JOB_INTERVALS.publishing` and a 10-minute cap. |

**Voices sheet** (side `Sheet`, filters stay open, design-ux): three tabs.
- **Our voices**: stock voices and the workspace's clones, as a radio group with Play / Stop samples. Your own clones
  show Rename and Delete; a clone's owner also gets "Withdraw consent and delete" (`?withdraw=1`).
- **Library**: filters (language, gender, age, use case, search), 30 a page with "More". When `usable` is false,
  the line "Library voices can be picked now and used once our voice plan is upgraded; a video with one can't be
  made yet."
- **Clone a voice**: only when `cloning.allowed`, showing "N of 2 used".

Picking a voice saves `PATCH {plan.voice, voiceName}`.

**Leaving and switching business** follow feature 2: a 403 or 404 stops polling and shows "Couldn't load this reel"
with a link to Reels, never a loop.

### 5.4 Money and safety rules on every paid button

| Button | Price from | Double press / retry | 402 | Other refusals |
|---|---|---|---|---|
| **Make video**, **Try again** | `detail.price` (server) | No `requestId`. The server charges per `versionId:attempt` and returns a running render instead of charging, and S2 refuses a finished version. Unknown outcome (status 0): read the reel again; never re-press for the person. | paywall (either shape) | 409 `render.alreadyDone` → read again and open Review; 409 newer plan → read again; 400 (stand-ins, word counts, library voice, presenter removed) → the server's sentence inline; 503 paused → inline |
| **Make a presenter** | `presenterCredits` (options) | One RUNNING per brand (unique index; a second start is refunded and gets 409 "already being made"). Disabled while one runs. Unknown outcome: read the options again before enabling. | paywall | 409 busy → its sentence |
| **Preview with my photos** | `previewCredits` (options) | One RUNNING per brand and template, as above | paywall | 409 busy |
| **Clone voice** | `cloning.credits` (voices) | One `requestId` per take: kept when there was no answer (status 0) or a 5xx, so a retry returns the first voice; any 4xx means a new challenge and a new take (the phone's rule). A 409 `request.idTaken` (the kept try was refunded) means a new take. | paywall | 409 `clone.updateApp` can't happen (web sends `challengeId`); 410/422 → message + new challenge; 409 max clones; 503 not available |

- Every paid button: disabled while its request is in flight; the second click of a double click is ignored
  (`isRepeatClick`); off for `PRESS_COOLDOWN_MS` after a success. These are feature 2's rules and helpers, reused.
- The price is on the button (`withPrice`), read from the server. The button stays disabled, with "Reading prices…",
  until it is read. Unlimited (test) workspaces show no price, as elsewhere.
- No plan: the press opens the paywall with the plan refusal and sends nothing (§5.2). Otherwise every 402, streamed
  or not, opens the paywall through `request()`, and the balance is read again after every paid answer
  (`loadPlanCredits(ws, true)`).
- Recordings, plan turns and saves cost no credits; they are plan-gated and rate-limited, and their refusals show
  inline.

*Why no `requestId` on render, presenter and preview (my call): each already has a server-side guard that makes a
repeat free (charge refId per attempt; one RUNNING per kind). A key would add a column and a code path for no new
protection.*

### 5.5 Streaming plan chat (create and revise)

- Calls: `request()` with `onLine` and `timeoutMs: SLOW_MS` (120 s, the routes' budget). `language: "en"` (the web's
  language; the scriptwriter replies in the language of the person's message anyway, `agents.ts:38`). The reel's own
  language stays the brand's, as on the phone.
- Progress: the sent message shows at once. Under it, the stage ("Reading your business" / "Writing the script" /
  "Choosing a video model per scene", the phone's words) and the draft growing scene by scene. One send at a time
  per tab; Send stays disabled while one is in flight.
- **Create**: one `requestId` per press of Plan, Use this idea or Use template. The reel is created under that id.
- **Revise**: one `requestId` per message (S5).
- **Dropped stream or timeout** (`ApiError` status 0):
  - Create: poll `GET /reels/{requestId}` every 3 s for up to 3 minutes. A 404 means not yet, the 200 is the reel.
    No guessing from the list (this replaces the phone's `adoptCreated` heuristic on the web).
  - Revise: poll `GET /reels/{id}` every 3 s for up to 3 minutes until the chat holds a turn with that `requestId`
    followed by the assistant's reply. This replaces counting turns, which fails past 40 turns (minor 1).
  - After 3 minutes: "The reply is taking too long. Check back in a moment." with Reload. The person's message stays
    in the composer for a resend; a resend reuses the same `requestId`, so it can't plan twice.
- **409 `reel.stillPlanning`** (another tab or device is writing): "This reel is still being planned. Wait for the
  reply." The page then polls the reel as above (until the version moves) and shows the reply when it lands.
- **429** (20 plans an hour per brand, shared with the phone): the server's sentence. **402** `planRequired` in the
  stream: the paywall opens.
- Recovery state lives in the page, not the module, so leaving the page drops the wait. The plan still lands, and the
  reel shows it next time. *(My call: the phone's module-level "in flight" state exists because its screens share no
  URL; the web keeps the reel in the URL.)*

### 5.6 Recording and cloning in the browser

Both use one `AudioRecorder` part (design-ux 6.11).
- **Format**: the first that `MediaRecorder.isTypeSupported` accepts, from `audio/webm;codecs=opus`, `audio/webm` and
  `audio/mp4` (Safari). Never Ogg: the server refuses it, and Firefox gives WebM when asked. If none is supported:
  "This browser can't record audio here. Use a recent Chrome, Edge, Firefox or Safari." Mono, `audioBitsPerSecond`
  64 000: 15 s ≈ 120 KB and 90 s ≈ 720 KB, well inside 1 MB and 4 MB. The byte caps are checked before upload.
- **Microphone permission**: before the first `getUserMedia`, a line says why ("Your browser will ask to use the
  microphone. The recording is sent to us only to check it and make your voiceover."). The outcomes:
  - Denied (`NotAllowedError`): a `role=alert` with the steps to allow it in the address bar.
  - No microphone (`NotFoundError`).
  - Microphone busy (`NotReadableError`).
  - Not a secure page (no `mediaDevices`; e.g. plain http on a network address): "Recording needs a secure (https)
    page."
  Once allowed, a **Microphone** select lists the inputs (`enumerateDevices`). Tracks are stopped when the dialog
  closes.
- **Scene take** (R11 record): the scene's text, **Start recording / Stop recording** (one button, `aria-pressed`),
  "Recording, 0:07 of 0:15", stopping by itself at 15 s.
  - Upload `file` + `text` + `language` (the plan's), with a 120 s timeout. Then "Checking what we heard…", then
    "Matches the script" or "Differs from the script", with the transcript and **Play take**.
  - **Use this take** saves `recordingId`. **Use what I said** also replaces the text with the transcript. **Record
    again** starts over.
  - After saving, if the scene's take was dropped (`droppedRecordings` or no `recordingId`): "The plan changed while
    you recorded. Record scene N again."
  - Errors: 413/400 shown as the server words them ("Keep it under 15 seconds.", "That recording is empty."); 429
    "Too many recordings for now."
  - **Upload a file instead** (Q6, owner 2026-11-18): a native file input in the same dialog,
    `accept=".m4a,.mp4,.webm,audio/mp4,audio/x-m4a,audio/webm"`. Files over `MAX_RECORDING_BYTES` are refused before
    upload ("Keep the file under 1 MB."). The file goes through the same call, timeout, check and result as a take
    (`POST /recordings` sniffs the bytes, measures the length and transcribes), so the 15 s cap, the transcript match
    and the rate limits are the server's, not the browser's. A wrong format comes back as the server's 400. No
    server change. It needs no microphone, so it shows even when the microphone is refused or missing. *(Ceiling:
    an upload can carry anyone's voice, as a take played from a speaker could; the transcript must still match the
    script. Clones still never take files.)*
- **Clone a voice** (dialog, `voices.manage` only):
  - The reading language (Q5), then `GET /voices/clones/challenge?lang=`, and the sentences shown as one passage.
  - A name (≤40).
  - The consent block: the server's `consent` text shown in full, and a real checkbox labelled "I agree" with
    `aria-describedby` on the text and "Consent version <consentVersion>" (S9). The text is never reworded or
    shortened.
  - Record for 60–90 s: Stop is disabled with "Keep reading: at least 60 seconds" until 60 s, and recording stops
    itself at 90 s. Play the reading back. A new take asks first ("Replace your reading?").
  - **Clone voice · 10 credits** (§5.4 rules), sending `appVersion` = the web's client tag, with a 120 s timeout.
  - The challenge lasts 10 minutes. If it expires the server says so (410) and the dialog fetches a new one; the
    reading must be redone.
  - **No file upload** for clones (security A1). *(Settled by the security review.)*

### 5.7 Permissions per step

| Action | Permission (server) | Web without it |
|---|---|---|
| See `/reels`, a reel, options, voices, library | `brand.read` | lock state |
| Plan (create, chat, ideas, templates Use), edit any step, record, recheck | `content.create` | read-only, with the line in §5.2 |
| Make a presenter, Preview, Make video, Try again | `content.create` (+ a plan, + credits) | hidden in read-only |
| Remove a presenter | `content.create` | hidden |
| Upload a photo in the picker | `content.create` (feature 2) | `canUpload=false` |
| Clone a voice (challenge, create) | `voices.manage` (`cloning.allowed`) | tab hidden |
| Rename, delete or withdraw a clone | its owner, or a workspace admin (server) | shown on your own clones; for admins on all |
| Edit caption | `content.create` | read-only caption |
| Download (approves) | `content.approve` | hidden, with "Your role can't approve reels" |
| Publish / schedule | `content.approve` (unless already APPROVED) + `publish.execute` | form hidden, with the missing role named |
| Cancel schedule, posted / not posted, add post link | `publish.execute` | hidden |

Creators (`content.create`) may spend the workspace's credits on renders, presenters and previews, as on the phone
and as the owner settled for the photoshoot (A7). Cloning stays admin-only (`voices.manage`), as on the phone.

### 5.8 Polling (all through `useJob`: one request in flight per URL, backoff on errors to 60 s, 429 waits, paused in a hidden tab)

| What | URL | Intervals | Stops |
|---|---|---|---|
| Render (Video step, and Storyboard while one runs) | `GET /reels/{id}` | `reelRender`: 5 s for 2 min, 10 s to 10 min, then 30 s; "slow" at 15 min | DONE / FAILED; 403/404 |
| Review waiting for checks | `GET /reels/{id}` | 5 s for 2 min, then 10 s | checks present; 403/404 |
| Reels list | `GET /reels` | 10 s, only while any card is processing; once more when a watched render ends | none processing |
| Presenter or preview being made | `GET /reels/options` | `preview`: 10 s | none RUNNING |
| Publishing now | `GET /content/{id}` | `publishing`: 5 s, 10-minute cap, then "Check the account" | PUBLISHED / FAILED / PENDING_VERIFY |
| Dropped-stream recovery | `GET /reels/{requestId}` or `/reels/{id}` | 3 s, cap 3 min (§5.5) | found / cap |
| Credits and plan | — | on focus and after a paid answer, no timer | — |

- Signed links (video, photos, presenter sheets, previews) last an hour. A page holding links older than
  `SIGNED_LINK_STALE_MS` (50 min) reads them again before using them, as feature 2 does.
- Each reel read during a render may re-queue a stalled render server-side (one upsert per 20 s slot); that is
  expected (ops M2).

### 5.9 Accessibility

- Page titles: "<Step> · <Reel title> · Reels · Espanda" and "Reels · Espanda". "Skip to preview" link on the reel
  page.
- The rail is a `nav` with `aria-current="step"`, and each step's state is text, not colour alone.
- Chat: `role=log`. Each stage is announced politely once; "Plan ready" is announced once when the reply lands (not
  every streamed word). Typing dots respect reduced motion.
- Render: `JobProgress` (progressbar with `aria-valuetext`, step changes announced once each). When it finishes,
  focus moves to "Review your reel" only if the person is on the Video step; otherwise the rail's state changes and
  the announcement is polite.
- Radio groups (`ChoiceCards` with native radios, arrow keys, one tab stop) for presenters, traits, templates and
  voices. The selected state uses a check and text. **Play sample, <name>** / **Stop sample** buttons use
  `aria-pressed`.
- Photo moves: Move earlier / Move later buttons; after a move, focus stays on the moved photo and "Photo moved to
  scene 2 of 4" is announced. Scene thumbnails use the scene's shot as alt text. Transitions are text.
- Recorder: the rules in §5.6. The file input is the route for people who can't use a microphone; it has a visible
  label ("Or upload an audio file, up to 15 seconds"). "Recording started", "10 seconds left" and "Stopped" are announced once each. "Checking
  what we heard…" and the result go in a live region. The transcript is text.
- Video: native `<video controls>`, no autoplay, and the transcript beside it (1.2.1 / 1.2.3). **Captions: see Q2.**
  With Q2(a) yes, the preview carries `<track kind="captions" default>` from S8's cues whenever the reel has a
  voiceover. Template previews have no speech and play muted with controls.
- Consent: a real checkbox with the server's text (§5.6).
- Credits: visible text in the chip and on the buttons.

### 5.10 Narrow screens

- `lg` and up: rail | editor | preview. `md` to `lg`: rail | editor, with the preview under the editor.
- Below `md`: the rail becomes a "Step 3 of 8: Script & voice" menu button at the top (a `Sheet` list). The preview
  follows the editor, at a 9:16 height of at most 60vh.
- Dialogs (presenter, recorder, clone, picker) are full-width sheets below `md`. The Voices sheet becomes full screen.
- No horizontal scroll at 375 px (and 320 px in the audit).
- Recording works in phone browsers (Safari gives MP4), but the phone app remains the main route there; no
  phone-browser-only work.

### 5.11 Kit additions (web)

- `StepsRail` (nav list with states; the narrow menu form).
- `AudioRecorder` (§5.6) and `VoiceRow` (name + Play sample).
- `PreviewFrame` 9:16 (video or scene photo with the on-screen text as real text, not an image).
- `ChecksList`, taken out of the release panel's approve form and shared with Review (design-ux 6.9).
- `useReelStream` (the create/revise call plus §5.5 recovery), on `request()`. No second NDJSON reader.

## 6. Failure modes and ceilings

- **Two people, or a phone and a tab, chat on one reel**: S5 refuses the second with "still being planned", with
  nothing spent. Two people **editing** steps at once: the version check gives the slower one 409, the web reloads
  and keeps their typed text, and nothing is lost silently.
- **A render finishes while someone edits**: the version moves (I-3), their save gets 409 "changed in the meantime",
  and they reload and save again. The render's video belongs to the plan it was made from.
- **Stale tab presses Make video after the phone made the video**: the version moved, so the press is refused ("A
  newer plan exists"). The same version that was already made is refused by S2. **Stale tab presses Try again while
  the phone's retry runs**: the running render is returned, not charged.
- **Stream dropped, tab closed or 120 s passed**: the server carries on (S6), the marker holds 6 minutes, and the web
  recovers by id (§5.5). Ceiling: a plan that takes over 6 minutes could be started again by a resend after the
  marker expires (the same ceiling as create today).
- **Render stuck**: reel reads re-queue it, and the server gives up after 24 hours with a refund (`kind: "slow"`).
  Presenter or preview stuck: given up after an hour, refunded.
- **Library voice not usable yet**: the render is refused with its sentence before any charge.
- **Paid starts paused for the web** (`PAID_STARTS_OFF_FOR=web`): 503 with its sentence inline. Planning and
  recording still work.
- **Limits people can meet**:
  - 20 plans an hour per brand (shared with the phone).
  - 30 takes an hour per person and 60 per reel.
  - 5 clone tries an hour; 20 challenges an hour; 2 clones per workspace.
  - One presenter being made per brand.
  - Rechecks: one per 15 s per reel, 10 an hour per brand.
  Each refusal shows the server's sentence.
- **CSP**: library voice previews are ElevenLabs-hosted links. The report-only CSP (`media-src 'self' blob:
  <storage>`) will report them, and an enforcing CSP would block them. Before enforcing, add that origin to
  `media-src` or serve the previews through the server. Recorder blobs are covered (`blob:`). No
  `Permissions-Policy` header exists today. If one is added, it must allow `microphone=(self)`.
- **Ceilings (named, not built for)**:
  - The reels list shows the newest 50, with no paging.
  - The chat keeps its last 40 turns.
  - Each watching tab polls about 12 requests a minute during a render, and each reel read signs every scene photo
    plus the video.
  - Audio conversion (ffmpeg) runs on the API instance: seconds of CPU per take, so many concurrent takes on one box
    would queue.
  - The voice library cache is per process (10 minutes).
  - A page left open over an hour re-signs its links at 50 minutes.

## 7. Slices (each mergeable alone behind `WEB_FEATURES=reels`)

- **3a · Plan and storyboard.**
  - Server: S1 contract, S5 chat lock + `requestId` + claim-before-count, S6 dropped reader, S10 index.
  - Web: `/reels` (plan prompt, ideas, templates Use, presenters list read-only, your reels with filters and
    badges), `/reels/{id}` with the rail, Plan (streamed chat, starters, duration chips, recovery) and Storyboard
    read-only (Make video not shown yet). Phone: types re-exported.
  - Alone, a person can plan and revise reels on the web and make them on the phone.
- **3b · Presenter, photos, script, voice, record, clone.**
  - Server: S9.
  - Web: Presenter step and Make a presenter, template Preview, Photos (picker per scene, moves), Script & voice
    (per-scene text, Voices sheet with library), `AudioRecorder`, scene takes (recorded or uploaded, Q6), Clone a voice. Three paid buttons with
    §5.4 rules.
  - Alone: everything before rendering is possible on the web.
- **3c · Render, review and publish.**
  - Server: S2 re-render guard (may ship earlier on its own: it is a money fix with no web dependency), S3 studio
    flag, S4 hook/script, S7 download link, S8 caption cues (if Q2(a)).
  - Web: Make video, Video step and X01, Review (checks, recheck, caption, download, captions, transcript), Publish
    and Scheduled (release panel reuse), Posted it? Add link, the release panel's studio fix, and an "Open in Reels"
    link with the draft editor hidden for studio reels in the Overview's content view (I-6).
  - Alone: the full flow.

## 8. Calls made in the spec (cost if wrong is one condition or one string each, unless said)

- Approach A (home + one reel page with a rail), following the owner's choice for feature 2.
- Photos are changed per scene with the existing single picker plus Move earlier / later: the same choices and the
  same single `PATCH` as the phone's ordered multi-select; no multi-select picker.
- No `requestId` on render, presenter or preview: the server's per-attempt charge and one-RUNNING index already make
  a repeat free.
- S5's lock gives a phone an immediate "still being planned" instead of a later "changed in the meantime" in the
  two-device race. That is the only change old phone builds see.
- Streamed requests wait 120 s (the routes' budget), not the parent spec's 330 s.
- The web sends `language: "en"` to the scriptwriter; replies still follow the language the person writes in.
- Ideas → reel is streamed on the web (the same call; the phone doesn't ask for the stream).
- A finished version offers **Watch the video**, never "Make it again" (`again: true`): the phone never offers a paid
  re-render of the same plan.
- Try again shows today's price, says so when it differs from the refunded one, and charges today's price (as the
  phone does).
- "Downloading approves this version." is shown next to Download; the phone does the same approval without saying so.
- Publishing approves first in the same press when needed (the phone's flow), reusing the release panel's form; the
  time is the browser's, as the web's post scheduling is (see Q4 for the choice of times).
- No plan: paid and planning buttons open the paywall without a request; the server still enforces.
- `appVersion` on a web clone is the web's client tag.
- Dropped-stream recovery waits in the page, not across pages.
- Creators may spend credits on reels, as the owner settled for the photoshoot (A7); cloning stays admin-only.

## 9. Open questions for the owner (recommended answer first)

Answered by the owner on 2026-11-18: Q1–Q5 as recommended (Q2: (a) yes, (b) not in feature 3). **Q6: add the
upload now** (§5.6, slice 3b).

1. **Where does the planning chat live?** *Recommended:* inside the reel page's Plan step (centre column); on
   `/reels/*` the global assistant panel starts collapsed. *Alternative (design-ux I3):* the global assistant panel
   switches to a "Planning: <reel>" mode. *Cost if wrong:* moving the chat later means rehousing one component and
   changing the shell's assistant panel, about half a slice. Picking the panel now adds shell work to 3a.
2. **Captions on reels (a11y, held from the parent spec §9).**
   - (a) *Recommended yes:* our web preview gets a captions track built from the scenes' voice text and the render's
     real timings (S8), plus the transcript as text. *Cost if no:* our own page fails WCAG 1.2.2 for every
     voiceover reel.
   - (b) *Recommended not in feature 3:* burning subtitles into the posted video. That is a render change for both
     apps and changes what goes to Instagram, which adds its own automatic captions. *Cost if wrong:* posted reels
     stay without burned captions until a later render change; nothing to undo.
3. **Telling people a render finished when they've left the page** (Jobs count in the top bar, a toast, a Today
   task; feature 2 deferred these "until reels"). *Recommended:* not in feature 3. The list badge, the rail state
   and the Video card cover a person who comes back; build the Jobs entry with feature 4, when stories also run long
   jobs. *Cost if wrong:* a person who starts a 5–15 minute render and leaves won't know it is ready until they look.
4. **Schedule times.** *Recommended:* any date and time (date and time inputs in the browser's time zone, shown
   next to them, as the web's post scheduling already works), not the phone's next 7 days × 9:00 / 12:00 /
   18:00 / 20:00. The phone's limit comes from a missing date-picker package, not a product rule (design-ux MI4).
   *Cost if wrong:* swapping the input back to the phone's slot list; the server call is the same either way.
5. **The language of the clone reading on the web.** The phone uses the app's language; the web is English only.
   *Recommended:* a "Reading language" select over the 24 passages, defaulting to the browser's language when one
   exists, else English. *Cost if wrong:* if English only, a French speaker reads English for their clone. It still
   works (the voice is theirs), but feels odd; the select is one control.
6. **An alternative to the microphone for a scene voiceover** (the a11y review asks for "upload an audio file").
   *Recommended:* not in feature 3. The generated voice already reads the typed text, which is the route for people
   who can't or don't want to record, and the phone has no upload. Clones never take uploads (security). *Cost if
   wrong:* adding a file input to the scene recorder later (the server already accepts M4A and WebM files).

## 10. Left to the builder

- File and component split; which of §5.11 go into `components/ui` and which stay in `components/reels`.
- Storage for S5's `requestId` on the chat turn (the turn JSON, as specified) versus a column, as long as a repeat
  finds it.
- Exact wording where the phone has none (desktop-only labels), in the phone's tone; failure kinds and stage names
  copied from `reels.json` / `recovery.json` by hand, as feature 2 did.
- Whether the default step logic lives in the shared contract.
- Adding `/reels` and a fixture reel page to `scripts/audit-ui.ts` (320 px and 1280 px).
- Test layout. Pure helpers get unit tests: default step, step states, `reelStage`, the clone press rule, the
  recorder's format choice, WebVTT from cues, and the recovery match by `requestId`. Server tests for S2 (the real
  version sequence), S3, S4, S5 (lock, repeat, claim before count), S6 (cancelled reader still saves), S7, S8, S10.

## 11. Checks

- Unit tests as above; web build and bundle check; server tests; mobile typecheck after the contract sync.
- Live: the provider accounts have no credits. An unlimited test workspace can plan (OpenAI), record and transcribe
  (OpenAI) end to end. Renders, presenters, previews and clones call Higgsfield or ElevenLabs and stay unchecked
  live, as for the phone.
- Owner's manual checks go in the handover:
  - Flag off: `/reels` is 404 with no nav entry.
  - Double-click Make video: one render, one charge.
  - A finished reel's storyboard shows "Watch the video", and a forced render call gets 409.
  - Close the tab mid-plan, reopen: the reel is there, with one reel only.
  - A phone and a tab send a message at once: one is told to wait.
  - Record a take in Chrome, Firefox and Safari: accepted.
  - Upload an M4A and a WebM take: accepted; an Ogg or MP3 file: the server's 400; a 20 s file: "Keep it under 15
    seconds."
  - Clone: consent text matches the server's; no upload button.
  - A 402 opens the paywall.
  - Keyboard through the rail, every radio group, the recorder and the player.
  - 375 px: no horizontal scroll.
  - A studio reel in the Overview's release panel asks for no video link.
