# Feature 3c · Reels on the web: render, review and publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the website a person can make the video (Make video, with its price), follow it, see why it failed and try again, review it (player with captions, transcript, checks, caption and hashtags, download), and publish or schedule it, with the same calls as the phone. A finished version is never charged again, and a studio reel is never asked for a video link.

**Architecture:** Server first: S2 (the re-render guard, plus a refunded attempt is never reused; its own task so it can merge alone), then S3 + S4 + S7 (release flag, hook/script follow the plan and the caption save respects the plan's limits, download link), then S8 (caption cues, with the shared `CaptionCue`), then the shared sync. Web: pure helpers first (`reel.ts`, `labels.ts`, `components/workspace/release.ts`), then the calls and the reel read, then one task per step (Video with Make video, Review, Publish), then the two places outside the reel page (the home's "Posted it? Add link", the Overview's studio reels). Each step joins `BUILT_STEPS` in the task that renders it.

**Tech Stack:** Next.js 15.5 / React 19.1, Tailwind 4, vitest (node, no jsdom). Server: Next.js route handlers, zod, Prisma, vitest. Browser `<video>` + `<track>` (WebVTT from a `blob:` URL), no new dependency.

**Spec:** server repo `docs/superpowers/specs/2026-11-18-feature-3-reels-design.md` (approved 2026-11-18; owner answers in §9: Q1–Q5 as recommended, so Q2(a) yes → S8 is in, Q2(b) burned subtitles not in feature 3, Q3 no off-page notice, Q4 any date and time). This plan is slice **3c** (§7): server S2, S3, S4, S7, S8; web Make video, Video and X01, Review, Publish and Scheduled, Posted it? Add link, the release panel's studio fix, and "Open in Reels" in the Overview (I-6). Model plans: `2026-11-18-feature-3b-reels-steps-voice.md`, `2026-11-18-feature-3a-reels-plan-storyboard.md` (both merged).
**Phone source of truth (mobile repo):** `src/app/reels/{storyboard,generating,review,publish,scheduled,results}.tsx`, `src/app/recovery/video-failed.tsx`, `src/api/endpoints.ts:312-345`, copy `src/i18n/locales/en/reels.json` (`storyboard`, `generating`, `review`, `publish`, `scheduled`, `results`, `failure`) and `recovery.json` (`videoFailed`).

**Owner decision (2026-11-19):** the failed reel card keeps "Didn't work" and leaves out spec §5.2's "· N credits back" (`ReelSummary` carries no credits; the Video step says them).

**Found while planning (not in the spec):**
- The quality checks list the spec calls "the release panel's issue list" (§5.3 Review, §5.11 `ChecksList`) is in `components/workspace/content-panels.tsx:705-725` (the Overview's "Quality check" section). The release panel lists product issues. `ChecksList` is taken from there.
- S10 is already in `main` (`render.ts renderView` reads `creditEntry` with `workspaceId`, done in 3a).
- `releaseState` lists only ACTIVE accounts, so "Expired: reconnect" needs `GET …/connections` (`brand.read`).
- The content list already sends `studio` (`content/route.ts` spreads the item), so the Overview needs no server change.
- The web's post scheduling shows no time zone today, although spec Q4 says it does.
- The content edit route takes 30 hashtags and a 5000-character caption, but a reel's plan takes at most 5 and 2200 (`server/reels/plan.ts:41-42`). The phone never edits hashtags; the web would be the first to break a reel's plan this way (Task 2).

**Plan lenses (2026-11-19):** correctness, security, performance and maintainability ran on the first draft; every Critical and Important finding is folded in below, with its id in brackets ([C-C1] correctness Critical 1, [S-I1] security, [P-I1] performance, [M-I1] maintainability). Minors are folded or listed under "Lens minors not taken". Reports: server `.superpowers/sdd/2026-11-19-feature-3c-reels-render-review-publish/lens-*.md`.

## Reuse map (don't rebuild)

| Need | Already there |
|---|---|
| Calls, 402 → paywall, error text | `request()`, `ApiError`, `errorMessage` (`components/settings/api.ts`) |
| Paid press | `usePaidPress`, `pressLabel` (`components/reels/paid-press.ts`); `refused`, `isRepeatClick`, `pressErrorText` (`lib/presser.ts`) |
| A refused attempt id | `chargeRefunded(workspaceId, refId)` (`server/services/credits.ts:81`), as photoshoots and clones use it |
| The reel, its cache, polling | `useReel` (`use-reels.ts`), `fetchShared`, `putShared`, `sharedAt`, `useJob` (`stopOn`, `capMs`, `slow`), `JOB_INTERVALS.reelRender` / `publishing` (`components/workspace/use-job.ts`) |
| Save-race helpers | `saveErrorText`, `REEL_CHANGED` (`use-reel-save.ts`), `adoptRefusedVersion` (`reel.ts`), `CHANGED_ELSEWHERE` (`plan-stream.ts`) |
| Edit lock, rendering | `editLock`, `rendering`, `defaultStep` (`reel.ts`) |
| Render progress | `JobProgress` + `JobStep` (`components/ui/job-progress.tsx`): step list, progress bar, one announcement per step, the slow notice and "Couldn't check progress" |
| Approve, publish, schedule, cancel, posted / not posted, publishing poll | `ReleasePanel` with `PublishForm` and `History` (`components/workspace/release-panel.tsx`); `JOB_INTERVALS.publishing`, 10-minute cap already inside |
| Connections read and type | `settingsApi.connections`, `Connection` (`components/settings/api.ts:218,261`) |
| Sending rules | `REEL_SENDABLE`, `REEL_SCHEDULABLE`, `reelStage`, `zoneCity`, `safeHttpUrl` (`@/shared`) |
| Signed download name | `signedMediaUrl(key, 3600, downloadAs)` (`server/storage/media.ts`), as `server/photoshoot/shoot.ts:273` |
| Scene lengths | `clipSeconds`, `PRESENTER_MIN_SECONDS`, `sceneSeconds` (`server/reels/plan.ts:51-58`); the join's own expression at `server/reels/render.ts:382-386` (Task 3 lifts it next to them) |
| Page parts | `PreviewFrame`, `StepsRail`, `StatusBadge`, `Dialog`, `Button`, `Input`, `Textarea`, `PageSection` (`components/ui/*`); `LoadError`, `ListSkeleton` (`components/settings/shared`) |
| Credits text | `creditsText`, `withPrice` (`lib/plan-credits.ts`); `usePlan(w).unlimited` |
| Lazy client part | `dynamic(() => import(…), { ssr: false })`, mounted on first open (`home.tsx`) |

## Global Constraints

- Repos side by side: `C:\Users\INTEL\Desktop\Social Media Agent\apps\{server,web,mobile}`. Branch `feature-3c-reels` from `main` in all three. Commit only in the repo the task names.
- Run npm inside the repo with `--prefix .`. Windows, Git Bash.
- Every task leaves its repo green: server `npm run typecheck|lint|test --prefix .`; web `npm run typecheck|lint|test --prefix .` (typecheck runs `check-shared`); mobile `npm run typecheck --prefix .`. Tasks 2, 3 and 4 run back to back: Tasks 2 and 3 edit `shared/`, and web and mobile `check-shared` read the server's `shared/.hash`.
- Shared code: edit `shared/` in the server only, then `npm run sync:shared --prefix .` (server) and commit the copies (with their `.hash`) in web and mobile. Never hand-edit `web/shared` or `mobile/src/shared`.
- Old phone builds see no change. S3, S7 and S8 add fields; `draft.changed` adds a code to a 409 whose message is unchanged; S4 ignores a studio reel's sent hook and script, which the phone already sends with the plan's values, and its new caption/hashtag limits refuse only what the phone never sends (it sends the stored hashtags back); S2 refuses only a render of a version that already has a video, which the phone never asks for. The phone's own screens are not moved onto the shared helpers.
- No new dependencies. Web tests unit-test pure logic only; components are checked by build, `scripts/audit-ui.ts` and the owner.
- Copy is the phone's English (`reels.json`, `recovery.json`), copied by hand; desktop-only lines follow its tone. Never show provider error text; failures are worded from `failure.kind`, and refusals show the server's sentence. **One exception, as for posts today:** a publish attempt's error in the reused `History` is the platform's own message (`publishers.ts:50`); wording it is out of 3c and named in the handover [S-M3].
- `docs/DESIGN_SYSTEM.md` (server repo): one primary button per view, cards `rounded-2xl border border-border bg-card shadow-sm`, inputs `rounded-xl`, buttons pill, `focus-visible:ring-2 ring-ring`, icons `aria-hidden` beside text. Dialogs use `components/ui/dialog.tsx` as it is.
- Read-only role (no `content.create`): Storyboard, Video and Review show their content with no Make video, Try again, caption edit or Check again. Download needs `content.approve` ("Your role can't approve reels, so Download (which approves) isn't here."). Publish needs `publish.execute`, plus `content.approve` when the version isn't approved yet; without them the form is hidden and the missing role is named.
- Commit messages: the change and why. No co-author lines, no tool or session URLs, no mention of tests.
- Don't call paid providers; don't touch port 3100's running process. Renders, presenters and previews stay unchecked live.
- Slice scope: 3c finishes feature 3. Not built: the ready banner or any off-page notice (Q3), Use in story (feature 4), credit history labels (feature 6), burned-in subtitles (Q2b), `again: true` (no "Make it again"), the failed card's credits (owner).
- Streaming re-renders the reel page once a frame: `chat` goes only to the Plan and Presenter steps. `VideoStep` and `ReviewStep` are `memo`ed and get stable props only: primitives (`slow`, `failed`, `chatBusy`, `ended`), stable callbacks (`go`, `reload`), `detail` and a memoised `perms` [P-M4, M-M3]. `PublishStep` is loaded lazily [P-I3]. Each step keeps its edit state inside itself.

## Paid press rules (Task 7; spec §5.4, Make video and Try again)

Both buttons go through **one hook**, `useRenderPress` (Task 7), built on `usePaidPress`:
- Price from the server (`detail.price`) through `pressLabel`; no price when `usePlan(w).unlimited`. Before the plan is read: disabled, "Reading prices…". `detail.price === null` (plan incomplete): disabled.
- No plan (`loaded && !planned`): the press opens the paywall with `PLAN_REFUSAL` and sends nothing.
- Disabled while its request is in flight; `isRepeatClick(e)` presses are ignored; off for `PRESS_COOLDOWN_MS` after a success, held until the reel read after it lands (so the button can't come back before `rendering(detail)` is true).
- After any answer: `loadPlanCredits(w, true)` (inside `usePaidPress`). A 402, either shape, opens the paywall through `request()`.
- **No `requestId`.** The server charges per `versionId:attempt`, returns a running render instead of charging, skips an attempt whose charge was refunded (Task 1), and (S2) refuses a version that already has a video. The body is `{ action: "render", version: detail.version }`, never `again`.
- Unknown outcome (status 0, 5xx, 503 paused: `!refused(e)`): read the reel again and keep the button off until it lands, then show the sentence. Never re-press for the person.
- Refusals (`renderRefusal`, Task 5): 409 `render.alreadyDone` → read the reel again and open Review; any other 409 ("A newer plan exists…", "already scheduled or posted") → read again and show the server's sentence; 400 (stand-ins, word counts, library voice, presenter removed) → the server's sentence inline.
- Disabled while the plan chat streams (`chatBusy`) or a save runs (`save.saving`): either would move the version under the press.

## Review Focus

1. **A finished version is never charged again**: render *v* → its join writes *v+1* with `videoKey` → a render of *v+1* is refused 409 `render.alreadyDone` with no charge. The web never sends `again`, and a version with a video shows **Watch the video**, not Make video. → Tasks 1, 7, 8.
2. **A double click, a retry after no answer or a 5xx, or a second tab** on Make video or Try again makes one render and one charge; a start whose charge was refunded (no render row) is never reused for a free render; an unknown outcome is read, never re-pressed. → Tasks 1 [S-I1], 5 (`renderRefusal`), 7.
3. **A studio reel is never asked for a video link**, on the reel page or in the Overview; **an approval is asked only when the status is AWAITING_APPROVAL** (the server's and the phone's rule), so a failed publish followed by a re-read only publishes next time; and **no studio approval auto-books a post**, from the reel page or the Overview. → Tasks 2, 5 (`publishCalls`), 9 [C-I3, M-I2, S-M2].
4. **A studio reel's plan can't be broken or drifted through the content edit route** from any client: hook and script follow the plan, more than 5 hashtags or a caption over 2200 characters is refused, and the web says so before sending. → Tasks 2, 5, 8 [C-C1].
5. **Download** names the file `reel-<8>.mp4`, approves only a version awaiting approval, is refused while the checks run or a check blocks, navigates only to an http(s) link, and shows no provider text. → Tasks 2, 8.
6. **Caption cues follow the timings the join used** (voice length, presenter minimum, trimmed to the clip), a scene with no voice text has no cue, the WebVTT text is escaped (no forged `-->`), and the same cues keep the same `blob:` URL across polls. → Tasks 3, 5, 8 [P-I2, S-M5].
7. **A caption save that loses a race** (`draft.changed`) keeps the typed text, tells the person, and saves on the newer version only on their next press; any other 409 shows the server's sentence and moves nothing. → Tasks 2, 8 [M-I1].
8. **Polling ends**: render DONE or FAILED, 403/404, and the Review's checks wait stops after 10 minutes with a way to look again; the automatic recheck runs at most once per visit; a reel sent back or rejected says so instead of "Checking…". → Tasks 5, 8 [C-I1, C-I2, P-I1].
9. **Roles**: a viewer sees no Make video, Try again, caption edit or Check again; Download is for approvers; Publish names the missing role. → Tasks 7–9.
10. **A render that ends** moves focus to "Review your reel" only on the Video step; elsewhere the rail changes and a polite line says so. → Tasks 6, 7.

---

### Task 1: Server: S2, a finished version isn't rendered again; a refunded attempt isn't reused

**Repo:** server. Mergeable alone.

**Files:**
- Modify: `server/reels/render.ts:126-139` (`startRender`)
- Test: `tests/reel-render.test.ts` (`describe("startRender")`; the `@/server/services/credits` mock at :32 also mocks `chargeRefunded`)

**Interfaces:** none new.
- `startRender` refuses with `PublishingError("This version already has a video. Make it again?", 409, "render.alreadyDone")` when `!input.again` and **either** the latest version's body has a `videoKey` **or** a DONE render belongs to it (the old check stays).
- After the first transaction, before charging: `let attempt = loaded.attempt; while (await chargeRefunded(input.workspaceId, \`${loaded.versionId}:${attempt}\`)) attempt++;` and that `attempt` is used for the `refId` and for `reelRender.create` [S-I1]. Comment: "a start that charged, failed to write its row and was refunded leaves its refId behind; spendCredits would return it without charging, so step past it (as photoshoots and clones do)".

- [ ] **Step 1: Write the failing tests** (in `describe("startRender")`, reuse `ready()`):
  - `the real sequence: the join's new version is refused, with no charge` — latest version `{ id: "v3", version: 3, body: { ...plan, videoKey: "w1/b1/r.mp4" } }` (what the join writes after rendering v2), `reelRender.findFirst` → null for `{ contentVersionId: "v3", step: "DONE" }`; `startRender({ …, version: 3 })` rejects `{ status: 409, code: "render.alreadyDone" }`; `m.spend` not called; `reelRender.create` not called.
  - `asked again, that version is charged once` — same version, `again: true` → `m.spend` called with `refId: "v3:1"`, `amount: 22`.
  - `a retry after a refunded start uses the next attempt` — `chargeRefunded` true for `"v1:1"`, false after; no render rows (`aggregate` max null) → `m.spend` called with `refId: "v1:2"` and `reelRender.create` with `attempt: 2`.
  - Keep `asks before paying again for a version that already has a video` and `charges the plan's price once per attempt` as they are (`chargeRefunded` mocked false by default).
- [ ] **Step 2: Run** `npm run test --prefix . -- reel-render` → FAIL.
- [ ] **Step 3: Implement** the `videoKey` condition after the version check (comment: "the join writes v+1 with the video and no render rows, so the body's videoKey is the check that fires; the phone checks the same (`storyboard.tsx`, `!!detail.videoUrl`)"), then the attempt skip.
- [ ] **Step 4: Run** server typecheck, lint, test → PASS.
- [ ] **Step 5: Commit** (two commits): "Refuse to render a reel version that already has a video unless asked again"; "Never reuse a refunded render attempt's charge id".

---

### Task 2: Server: S3 studio flag, S4 the caption save follows the plan, S7 download link

**Repo:** server. Three red/green cycles, one commit each [M-M8].

**Files:**
- Modify: `server/services/publishing.ts` (`releaseState` return; `saveDraft` inside its transaction; the version-race 409 at :221 gains a code)
- Modify: `shared/contract/errors.ts:29` (`ErrorCode` gains `"draft.changed"`)
- Modify: `server/reels/service.ts:308-316` (`sendReel`)
- Test: `tests/publishing-products.test.ts` (where `releaseState` and `saveDraft` already run against the mocked database), `tests/reel-shared.test.ts`, `tests/reel-service.test.ts`

**Interfaces:**
- **S3:** `releaseState(…).requirements` gains `studio: boolean` (`item.studio`). **Call:** set in `releaseState` (`{ ...publishRequirements(item.channel), studio: item.studio }`), not as a `publishRequirements` parameter: that function has no item, an exact-shape test (`stories-requirements.test.ts:21`) and two other callers (`automations.ts:84`, `publishing.ts:360`). `needsVideo` is unchanged.
- **S4:** in `saveDraft`, when `item.studio` and the latest body has `scenes`:
  - `hook = scenes[0].onScreenText ?? ""` and `script = scenes.map((s) => s.voiceText)` replace the sent values, before the "Nothing changed" check;
  - more than 5 hashtags → `PublishingError("A reel takes at most 5 hashtags.", 400)`; a caption over 2200 characters → `PublishingError("The caption is over 2200 characters.", 400)`, both before anything is written (the plan schema's limits, `plan.ts:41-42`; without them the new version stops parsing as a plan and the reel page loses it) [C-C1].
  - The version race ("Someone saved a newer draft…") gets code `draft.changed` [M-I1]; the scheduled and published 409s keep no code.
- **S7:** `sendReel(scope, itemId, version): Promise<{ videoUrl: string; downloadUrl: string }>` — `downloadUrl = signedMediaUrl(body.videoKey, 3600, \`reel-${itemId.slice(0, 8)}.mp4\`)`.

- [ ] **Step 1 (S3): Write the failing test** in `publishing-products.test.ts`: `releaseState` of a studio reel → `requirements` `toMatchObject({ needsVideo: true, studio: true })`; of a post → `studio: false`. **Run** → FAIL. **Implement.** **Run** server typecheck, lint, test → PASS. **Commit:** "Tell the release state when a reel was made in the studio".
- [ ] **Step 2 (S4): Write the failing tests** in `reel-shared.test.ts` (`describe("studio reels in the publishing flow")`):
  - latest body `{ caption: "a", hashtags: [], hook: "Hi", script: ["x", "y"], scenes: [{ onScreenText: "Hi", voiceText: "x" }, { onScreenText: "", voiceText: "y" }] }`, sent `{ hook: "evil", script: ["z"], caption: "b", … }` → created body has `hook: "Hi"`, `script: ["x", "y"]`, `caption: "b"`. Same sent values on `studio: false`, `channel: "INSTAGRAM_POST"` → `hook: "evil"`, `script: ["z"]`.
  - `a studio reel takes at most 5 hashtags` — six hashtags → rejects `{ status: 400 }` with that sentence, `contentVersion.create` not called; the same six on `INSTAGRAM_POST` → saved.
  - a 2201-character caption on a studio reel → 400 "The caption is over 2200 characters."; 2200 → saved.
  - a stale `version` → rejects `{ status: 409, code: "draft.changed" }`.
  **Run** → FAIL. **Implement.** **Run** server typecheck, lint, test → PASS. **Commit:** "Keep a studio reel's caption edit inside its plan: hook and script from the scenes, plan limits, a code for the version race".
- [ ] **Step 3 (S7): Write the failing test** in `reel-service.test.ts`: make the `signedMediaUrl` mock `(k, _e, name) => \`https://s3/${k}${name ? \`#${name}\` : ""}\``; `sendReel` resolves `{ videoUrl: "https://s3/w1/b1/r.mp4", downloadUrl: "https://s3/w1/b1/r.mp4#reel-i1.mp4" }`; a cuid `ckv9x1y2z3a4` → `#reel-ckv9x1y2.mp4`. **Run** → FAIL. **Implement.** **Run** → PASS. **Commit:** "Give a downloaded reel a file name".

---

### Task 3: Server: S8 caption cues (and the shared cue type)

**Repo:** server (the shared copies are committed in Task 4, run straight after).

**Files:**
- Modify: `shared/reels.ts` (`CaptionCue`; `ReelDetail.captions`)
- Modify: `server/reels/plan.ts` (`presenterFloor`, `joinSeconds` beside `clipSeconds` and `sceneSeconds`) [M-M1]
- Create: `server/reels/captions.ts` (pure: `captionCues` only)
- Modify: `server/reels/render.ts:382-386` (`joinClips` uses `joinSeconds`)
- Modify: `server/reels/service.ts:373-404` (`reelDetail`; its return gains `satisfies ReelDetail`) [M-I4]
- Test: `tests/reel-captions.test.ts` (new), `tests/reel-service.test.ts`

**Interfaces:**
- `@/shared`: `export type CaptionCue = { start: number; end: number; text: string };` (seconds from the video's start); `ReelDetail.captions: CaptionCue[] | null`.
- `plan.ts`:
  - `presenterFloor(seconds: number, presenter: boolean): number` — `presenter ? Math.max(PRESENTER_MIN_SECONDS, seconds) : seconds`; `sceneSeconds` uses it.
  - `joinSeconds(out: { voiceSeconds: number[]; models: string[]; clipSeconds: number[] }): number[]` — per scene `Math.min(presenterFloor(clipSeconds(v), out.models[i] === PRESENTER_MODEL), out.clipSeconds[i])`: exactly what the join trims each clip to.
- `captions.ts`: `captionCues(scenes: readonly Pick<ReelScene, "voiceText">[], seconds: readonly number[]): CaptionCue[]` — one cue per scene over that scene's span (start = the sum of the earlier spans); a scene whose trimmed voice text is empty has no cue but still takes its time.
- `reelDetail`: with a `videoKey` on the latest body, reads `prisma.reelRender.findFirst({ where: { contentItemId, videoKey, step: "DONE" }, select: { outputs: true } })` **inside the existing `Promise.all`** at `service.ts:382` [P-M1], and returns `captionCues(plan.scenes, joinSeconds(outputs))`; else `null` (no video, no matching render, or outputs missing a field). **Call:** one cue per scene, wrapped by the browser. Ceiling (comment): a 30-word scene is one 15 s cue; split by sentence if people ask.

- [ ] **Step 1: Write the failing tests:**
  - `reel-captions.test.ts`: `joinSeconds({ voiceSeconds: [3.2, 1.0, 20], models: ["kling-3-std", PRESENTER_MODEL, "kling-3-std"], clipSeconds: [5, 5, 10] })` → `[4, 4, 10]`; `captionCues([{ voiceText: "Hello there" }, { voiceText: "  " }, { voiceText: "Bye" }], [4, 3, 5])` → `[{ start: 0, end: 4, text: "Hello there" }, { start: 7, end: 12, text: "Bye" }]`; `captionCues([], [])` → `[]`.
  - `reel-service.test.ts` (it mocks prisma and `signedMediaUrl`; add `reelRender.findFirst`, and `creditBalance` if needed) [M-I4]:
    - `captions come from the DONE render with the body's videoKey` — the `findFirst` is called with `{ contentItemId: "i1", videoKey: "w1/b1/r.mp4", step: "DONE" }` and the answer has cues from its outputs.
    - `a caption edit's version keeps its cues` — latest is a later version whose body carries the same `videoKey` → same cues.
    - `no video, or outputs without voiceSeconds, gives null`.
- [ ] **Step 2: Run** `npm run test --prefix . -- reel-captions reel-service` → FAIL.
- [ ] **Step 3: Implement**; `joinClips` calls `joinSeconds(out)` in place of its two lines (behaviour unchanged; `reel-render.test.ts` stays green).
- [ ] **Step 4: Run** server typecheck, lint, test → PASS.
- [ ] **Step 5: Commit**: "Give the reel's detail caption cues timed as the join cut each scene".

---

### Task 4: Shared sync to web and mobile

**Repo:** server (sync), then web and mobile.

**Files:** `web/shared/**`, `mobile/src/shared/**` (synced); `web/tests/reels.test.ts:21`, `web/tests/reel-plan-stream.test.ts:16` (the `ReelDetail` fixtures gain `captions: null`).

- [ ] **Step 1: Run** `npm run sync:shared --prefix .` in server.
- [ ] **Step 2: Fix** the two web fixtures. Run web typecheck, lint, test and mobile typecheck → PASS (mobile needs no other change: it re-exports the type and shows a 409's message).
- [ ] **Step 3: Commit** in web and in mobile: "Sync the shared contract: caption cues on the reel detail and the draft.changed code".

---

### Task 5: Web pure helpers (no React)

**Repo:** web.

**Files:**
- Modify: `components/reels/reel.ts`, `components/reels/labels.ts`, `components/reels/use-reel-save.ts` (`saveErrorText`), `components/reels/use-step-edit.ts:34` (new `adoptRefusedVersion` call)
- Create: `components/workspace/release.ts` (`publishCalls` only)
- Test: `tests/reels.test.ts`, `tests/release.test.ts` (new)

**Interfaces (Produces):**
- `reel.ts`:
  - `reelHref(id: string, brandId: string, step?: ReelStep): string` — `/reels/{id}?b={brandId}` plus `&step=` when given; used by `ReelCard`, the page's `stepHref` and the rail, and Task 10's Open in Reels [M-M5].
  - `stepState` gains `video`: rendering "Making…", `videoUrl` "Done", `renders[0].step === "FAILED"` "Didn't work", else "None" (the video first, as `reelStage`) [C-M4]; `review`: no `videoUrl` "None", status APPROVED / SCHEDULED / PUBLISHED "Done", else "Ready"; `publish`: PUBLISHED "Posted", SCHEDULED "Scheduled", `videoUrl` "Ready", else "None".
  - `awaitingChecks(d: ReelDetail): boolean` — `!!d.videoUrl && !d.checks && d.item.status === "DRAFT_REVIEW"`.
  - `renderSteps(d: ReelDetail): JobStep[]` — running only [M-M2]: VOICE → active, waiting, waiting; CLIPS → done, active, waiting; JOIN → done, done, active; labels from `RENDER_STAGES` (labels.ts) with N scenes.
  - `renderRefusal(e: unknown): { reread: boolean; review: boolean }` — 409 `render.alreadyDone` → both true; other 409 → `{ reread: true, review: false }`; else both false.
  - `renderNews(prev: ReelDetail | null, next: ReelDetail): string | null` — `prev` rendering and `next.renders[0]` DONE → "Your reel is ready."; FAILED → "The video couldn't be made. Your credits are back."; else null.
  - `retryPriceNote(d: ReelDetail, unlimited: boolean): string | null` — null when `unlimited`; else, when `renders[0].credits` and `d.price` are both numbers and differ: `"Making it again costs ${creditsText(price)} now; the last try cost ${creditsText(credits)}."` [C-M3].
  - `sendBlock(d: ReelDetail): string | null` — the reason Download and Publish are off, else null [C-I1]:
    - BLOCKER → "A check found a problem (see Checks). Fix it in the caption, or ask for changes.";
    - `awaitingChecks(d)` → "Checking the reel… Download and Publish open when the checks are done.";
    - checks present, status DRAFT_REVIEW → "Changes were asked for (see the history under Publish). Change the caption or the plan and it's checked again.";
    - REJECTED → "This reel was rejected. Change the caption or the plan to send it through review again.";
    - otherwise outside `REEL_SENDABLE` → the checking sentence.
  - `reviewChecks(d: ReelDetail): CheckResult[]` — `checks.results` then, for each `softened` join `n` of the DONE render whose `videoKey === d.videoKey` [C-M11], `{ check: "Scene n → n+1", status: "warn", note: "The two shots didn't quite match, so they blend with a dissolve" }`.
  - `parseHashtags(text: string): string[]` — split on whitespace and commas, strip leading `#`, drop empties, dedupe, prefix `#`. `REEL_HASHTAGS_MAX = 5`, `REEL_CAPTION_MAX = 2200` beside it.
  - `postTextLength(caption: string, aiLine: string | null, tags: readonly string[]): number` — the length of `[caption.trim(), aiLine, tags.join(" ")]` joined by `"\n\n"` over the non-empty parts, as the server's `postText` [C-M7].
  - `toWebVtt(cues: readonly CaptionCue[]): string` — `"WEBVTT\n\n"` then per cue `"<n>\n<hh:mm:ss.mmm> --> <hh:mm:ss.mmm>\n<text>\n\n"`; text with whitespace runs collapsed to one space, `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`.
  - `postLinkWanted(r: ReelSummary): boolean` — `r.status === "APPROVED" && !r.postUrl` (the phone's `results.tsx:118`).
  - `instagramState(cs: readonly Pick<Connection, "provider" | "status" | "displayName">[]): { state: "active"; name: string } | { state: "expired" } | { state: "none" }` — the first ACTIVE Instagram one; else "expired" when an Instagram one exists; else "none" (the phone's `publish.tsx:51-54`) [M-I3].
  - `adoptRefusedVersion<E extends { version: number }>(edit: E, refused: boolean, version: number): E` — the scene-count argument goes (`useStepEdit:25-28` already drops an edit whose count changed), so the caption edit reuses it [M-I1].
  - `keepReelLinks`: the detail's video link is kept while `videoKey` is unchanged and the old links are fresh, whatever the version (a caption save moves the version, not the file); photos keep the version check [C-M2, P-M2].
- `labels.ts`: `failureText(f: RenderFailure): string` (`reels.json failure.*`, `scene` fills N); `RENDER_STAGES` and `STOPPED_AT`, side by side, keyed by stage: running labels "Preparing N scenes" / "Rendering video frames" / "Adding audio" (`generating.*`), stopped-at names "Voiceover" / "Video scenes" / "Joining the scenes" (`videoFailed.details.stages`).
- `use-reel-save.ts`: `DRAFT_CHANGED = "draft.changed"`; `saveErrorText` gives `CHANGED_ELSEWHERE` for `REEL_CHANGED` or `DRAFT_CHANGED`, else `errorMessage(e)`.
- `release.ts`: `publishCalls(version: number, status: string, body: Record<string, unknown>): Record<string, unknown>[]` — `status === "AWAITING_APPROVAL"`: `[{ action: "decide", version, verdict: "APPROVED", noAutoPublish: true }, { action: "publish", version, ...body }]`; else the publish only (the server accepts an approval only then, `publishing.ts:271`; the phone's `publish.tsx:69`) [C-I3].

- [ ] **Step 1: Write the failing tests** (values pinned):
  - `reelHref("r1", "b1")` → `"/reels/r1?b=b1"`; with `"review"` → `"/reels/r1?b=b1&step=review"`.
  - `stepState` for video / review / publish, each branch above; video with `videoUrl` and a FAILED `renders[0]` → "Done".
  - `awaitingChecks`: video, no checks, DRAFT_REVIEW → true; checks present → false; AWAITING_APPROVAL → false.
  - `renderSteps` for `"CLIPS"` with 1 scene → `[{ label: "Preparing 1 scene", state: "done" }, { label: "Rendering video frames", state: "active" }, { label: "Adding audio", state: "waiting" }]`.
  - `renderRefusal(new ApiError(409, "x", "render.alreadyDone"))` → `{ reread: true, review: true }`; `(409)` → `{ reread: true, review: false }`; `(400)`, `(0)`, a plain `Error` → both false.
  - `renderNews`: CLIPS → DONE → "Your reel is ready."; JOIN → FAILED → the failed line; DONE → DONE → null; null prev → null.
  - `retryPriceNote`: price 24, credits 20 → "Making it again costs 24 credits now; the last try cost 20 credits."; equal → null; credits null → null; `unlimited` → null.
  - `sendBlock`: BLOCKER → the check sentence; DRAFT_REVIEW without checks → the checking sentence; DRAFT_REVIEW with PASS checks → the changes-asked sentence; REJECTED → the rejected sentence; AWAITING_APPROVAL with PASS → null.
  - `reviewChecks` with one result and `softened: [2]` on the DONE render with the detail's `videoKey` → two rows, the second `"Scene 2 → 3"`; `softened` on a DONE render with another `videoKey` → one row.
  - `parseHashtags("#oak, wood  #oak ##table")` → `["#oak", "#wood", "#table"]`; `""` → `[]`; `"a b c d e f"` → six tags (the caller's limit counts the parsed tags).
  - `postTextLength("Hi", "Made with AI.", ["#a", "#b"])` → `24`; `("Hi", null, [])` → `2`.
  - `toWebVtt([{ start: 0, end: 4, text: "Hi & <b>\nthere" }, { start: 61.5, end: 3725, text: "x" }])` → `"WEBVTT\n\n1\n00:00:00.000 --> 00:00:04.000\nHi &amp; &lt;b&gt; there\n\n2\n00:01:01.500 --> 01:02:05.000\nx\n\n"`; `toWebVtt([{ start: 0, end: 1, text: "a --> 00:00:00.000 --> 99:00:00.000" }])` has exactly one `-->` (the timing line) [S-M5].
  - `postLinkWanted` true for APPROVED without `postUrl`, false with one, false for PUBLISHED.
  - `failureText({ kind: "scene", scene: 3, stoppedAt: "CLIPS" })` → "Scene 3 couldn't be animated. Your credits are back. Try again, or pick another photo for it."
  - `publishCalls(4, "AWAITING_APPROVAL", { connectionId: "c1" })` → the two calls; `(4, "APPROVED", …)` → `[{ action: "publish", version: 4, connectionId: "c1" }]`.
  - `instagramState`: ACTIVE Instagram "Shop" → `{ state: "active", name: "Shop" }`; only ERROR Instagram → expired; only an ACTIVE Facebook → none.
  - `adoptRefusedVersion({ version: 3, caption: "x" }, true, 5)` → `{ version: 5, caption: "x" }`; refused false → same object; same version → same object (the old scene-count case at `reels.test.ts:130` goes).
  - `saveErrorText(new ApiError(409, "…", "draft.changed"))` → `CHANGED_ELSEWHERE`; a 409 "This post is scheduled…" with no code → that sentence.
  - `keepReelLinks`: a version bump with the same `videoKey` and fresh links keeps `videoUrl`; a new `videoKey` takes the new link.
- [ ] **Step 2: Run** `npm run test --prefix .` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** web typecheck, lint, test → PASS.
- [ ] **Step 5: Commit.**

---

### Task 6: Web calls, the reel read, and the page wiring

**Repo:** web.

**Files:**
- Modify: `components/reels/api.ts`, `components/settings/api.ts` (`connectionsUrl` exported; `settingsApi.connections` uses it) [M-I3], `components/reels/use-reels.ts`, `components/reels/reel-page.tsx`, `components/reels/reel-card.tsx` (`reelHref`), `app/(shell)/reels/[id]/page.tsx`

**Interfaces:**
- `api.ts` (all through `request()`):
  - `brandUrl(w, b)` exported (was the private `brand`).
  - `reelsApi.render(w, b, id, version: number): Promise<{ render: { id: string; step: RenderStep; attempt: number } }>` — POST `{ action: "render", version }`.
  - `reelsApi.download(w, b, id, version: number): Promise<{ videoUrl: string; downloadUrl: string }>` — POST `{ action: "send", version, how: "download" }` (named as the phone names it) [M-M7].
  - `reelsApi.recheck(w, b, id): Promise<{ status: "started" | "checking" | "none" }>` — POST `{ action: "recheck" }`.
  - `reelsApi.registerLink(w, b, id, url: string)` — POST `{ action: "register-link", url }` [C-M9].
  - `reelsApi.editCaption(w, b, id, version: number, caption: string, hashtags: string[])` — POST `${brandUrl}/content/${id}` `{ action: "edit", version, body: { caption, hashtags } }`. Comment: the route defaults hook and script, and S4 takes them from the plan, so the web sends neither; the phone still sends them and needs no change.
- `useReel(w, b, id)`: `done` stays `!rendering(d) && !stale(…)` (the Review step drives its own checks wait, Task 8) [C-I2, P-I1]; `capMs: RENDER_SLOW_MS` (`15 * 60_000`, exported); returns `slow` too.
- `ReelPage` takes `perms: readonly string[]` (the page passes `[...perms]`; the `canCreate` prop goes, and `canCreate`, `canApprove`, `canPublish` are derived inside, memoised) [M-M4], and holds:
  - `stepHref = (step) => reelHref(reelId, brandId, step)`; the rail's `href` uses it (3b Task 6 minor: the two built the same string). `go(step: ReelStep)` = `router.replace(stepHref(step))`, a `useCallback` on `[router, reelId, brandId]` only [P-M4].
  - `ended: string | null` — `renderNews(prev, detail)` (prev in a ref), shown in a polite live region so a render that ends is announced once wherever the person is, and passed to `VideoStep` [M-M3].

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Run** web typecheck, lint, test, build → PASS.
- [ ] **Step 3: Commit.**

---

### Task 7: Make video (Storyboard) and the Video step (R05, X01)

**Repo:** web.

**Files:**
- Create: `components/reels/use-render-press.ts`, `components/reels/video-step.tsx`
- Modify: `components/reels/storyboard-step.tsx` (Make video in place of "Make the video in the Espanda app for now.")
- Modify: `components/reels/paid-press.ts:24` (its comment lists Make video and Try again too) [M-M10]
- Modify: `components/reels/reel.ts` (`BUILT_STEPS` gains `"video"`), `components/reels/reel-page.tsx`, `tests/reels.test.ts` (the `BUILT_STEPS` assertion)

**Interfaces:**
- Consumes: `usePaidPress`, `pressLabel` (3b); `renderRefusal`, `renderSteps`, `retryPriceNote`, `failureText`, `STOPPED_AT` (Task 5); `reelsApi.render`, `useReel().slow`, `go`, `ended` (Task 6); `JobProgress`.
- Produces:
  - `useRenderPress(w, b, detail: ReelDetail, go: (s: ReelStep) => void): { label: (text: string) => string; pressing: boolean; error: string | null; press: (e: { detail: number }) => void }` — every **Paid press rule**; `reread = () => fetchShared(reelUrl(w, b, id), true)`; success → `go("video")`; a refusal goes through `renderRefusal` (reread, then `go("review")` when `review`).
  - `VideoStep({ workspaceId, brandId, detail, slow, failed, reload, ended, canCreate, chatBusy, saving, go })`, `memo`; `renderSteps(detail)` memoised on `detail`, and the `job` object for `JobProgress` memoised on `[slow, failed, reload]` [P-M4, M-M3].

Storyboard (spec §5.3 Storyboard, phone `storyboard.tsx`):
- **Make video · N credits** (the page's only primary), shown with `canCreate` when there is no video and no running render. Disabled with its reason as text: stand-ins ("Pick photos" link, as now), `editLock(detail)`, `chatBusy` or `saving` ("Wait for the plan to finish saving."). Under it the phone's `storyboard.balance` line: "Current balance: N credits · N credits will be reserved" (left out when unlimited).
- A running render: **See progress** (`go("video")`) in its place. A video: **Watch the video** stays (Task 8 points it at Review).

Video step (spec §5.3 Video, phone `generating.tsx`, `video-failed.tsx`), in this order:
- A video (`videoUrl`, whatever `renders[0]` says) [C-M4]: "Your reel is ready." and **Review your reel** (`go("review")`). When `ended` turns non-null while this step is shown, focus moves to that button.
- Running: `JobProgress` titled "Creating your reel", `steps = renderSteps(detail)`; its own lines cover "Couldn't check progress" and, when `slow` **or** `Date.now() - renders[0].createdAt > RENDER_SLOW_MS` (checked on each detail), "This is taking longer than usual." [C-M5]; "Composing visuals, voiceover and motion pacing for <title>." (`generating.bodyAny`); "N credits reserved" (`renders[0].credits ?? detail.price`; left out when unlimited or null) [C-M3]; "It's safe to leave this page."
- FAILED (X01): title "Your reel isn't ready" (`videoFailed.title`), `failureText(failure)` in `role=alert`, "Failed at: <STOPPED_AT>", "N reserved credits released" (`renders[0].credits`; left out when unlimited or null), `retryPriceNote(detail, unlimited)`, **Try again · N credits** (primary, `useRenderPress`, `canCreate` only), **Edit storyboard** (`go("storyboard")`), and for `voiceDeleted` **Change voice** (`go("script")`; **Call:** the step, not the sheet itself: the sheet lives in the Script step).
- No render: "No video yet." and a link to Storyboard.

- [ ] **Step 1: Update the `BUILT_STEPS` test, then implement.**
- [ ] **Step 2: Run** web typecheck, lint, test, build → PASS.
- [ ] **Step 3: Commit.**

---

### Task 8: Review step (R07), the captions track and `ChecksList`

**Repo:** web.

**Files:**
- Create: `components/ui/checks-list.tsx` (from `content-panels.tsx:711-724`), `components/reels/review-step.tsx`
- Modify: `components/workspace/content-panels.tsx` (its Quality check section renders `ChecksList`; output unchanged; the local `type Check` at :34 goes, `ContentItem.latest.check` uses the shared `CheckResult`) [M-M6]
- Modify: `components/ui/preview-frame.tsx` (optional `captionsUrl`, `captionsLang`, `noDownload`)
- Modify: `components/reels/reel-page.tsx` (preview: the video, with captions, on the Review step; the `watching` state and "Show the scenes" go), `components/reels/storyboard-step.tsx` (**Watch the video** → `go("review")`; `onWatch` goes)
- Modify: `components/reels/reel.ts` (`BUILT_STEPS` gains `"review"`), `tests/reels.test.ts`

**Interfaces:**
- Consumes: `awaitingChecks`, `sendBlock`, `reviewChecks`, `parseHashtags`, `REEL_HASHTAGS_MAX`, `REEL_CAPTION_MAX`, `postTextLength`, `toWebVtt`, `adoptRefusedVersion`, `saveErrorText`, `DRAFT_CHANGED` (Task 5); `reelsApi.editCaption|download|recheck`, `reload` (Task 6). `ChecksList` is imported from `components/ui/checks-list.tsx`, never from `content-panels.tsx` [P-I3].
- Produces:
  - `ChecksList({ results }: { results: readonly CheckResult[] })` — the `<ul>` with pass / warn / blocker icons as `aria-label`s, as today.
  - `PreviewFrame` gains `captionsUrl?: string; captionsLang?: string` → `<track kind="captions" label="Captions" srcLang={captionsLang} src={captionsUrl} default />` inside the `<video>`, and `noDownload?: boolean` → `controlsList="nodownload"` (cosmetic: the link is in the page) [S-M1].
  - In `reel-page.tsx`, a local `useCaptionsUrl(cues: CaptionCue[] | null | undefined): string | undefined` — `const vtt = useMemo(() => (cues?.length ? toWebVtt(cues) : null), [cues])`, then an effect **keyed on the `vtt` string** creates the `blob:` URL (`type: "text/vtt"`) into state and revokes it on change and unmount, so the same cues keep the same URL across polls and the track isn't reloaded [P-I2, C-M1]. Comment: "same cues, same URL".
  - `ReviewStep({ workspaceId, brandId, detail, reload, canCreate, canApprove, go })`, `memo` (no `saving`: the caption save doesn't use the plan lock) [M-M9].

Behaviour (spec §5.3 Review, §5.8, §5.9; phone `review.tsx`):
- The preview column shows `detail.videoUrl` on this step (no autoplay, native controls, `noDownload`), with captions when `detail.captions` has cues, `captionsLang = plan.language ?? "en"`. A caption save keeps the same video link (Task 5 `keepReelLinks`).
- **Transcript**: each scene's voice text in an `<ol>`, as text.
- **Checks** [C-I2, P-I1]: `ChecksList results={reviewChecks(detail)}`. While `awaitingChecks(detail)` the step waits itself (`useReel` doesn't): it calls `reload()` every 5 s for 2 minutes, then every 10 s (spec §5.8), and **stops after 10 minutes** with "The checks are taking long." plus **Check again** (creators) or **Read again** (`reload()` once, others). It shows "Checking… usually under a minute"; with `canCreate`, one silent `reelsApi.recheck` at 90 s (`CHECK_AUTO_MS`), and after 150 s (`CHECK_SLOW_MS`) `review.checkSlow` with **Check again** (`review.checkingAgain` while it runs; `checking` → `review.alreadyChecking`; a 429 shows the server's sentence). Timers reset when the checks land or the version moves; a failed automatic try stays quiet (the phone's rule). `sendBlock`'s other sentences (sent back, rejected) show with no timer.
- **Caption and hashtags** (`canCreate`; else read-only text): a `Textarea` and an `Input` "Hashtags (separated by spaces)" with "N of 5" under it [C-C1]. Under the caption, the post's length `postTextLength(caption, detail.aiDisclosure, parseHashtags(tags))` "of 2200" [C-M7]. Edits are `{ version, caption, tags }` with `version` set from `detail.version` at the first change. **Save caption** (outline) is off, with its reason as text, when nothing changed, over 5 hashtags ("A reel takes at most 5 hashtags."), over 2200, `editLock`, or a Download is in flight [C-M6] → `editCaption(…, edit.version, caption, parseHashtags(tags))` → `fetchShared(reelUrl, true)` → edit cleared. On `draft.changed`: read the reel again, keep the text, show `saveErrorText(e)` (`CHANGED_ELSEWHERE`), and `adoptRefusedVersion(edit, true, detail.version)` once the re-read lands, so the next press saves (the person was told) [M-I1]. Any other error (scheduled, published, the 400 limits): the server's sentence, the edit's version unchanged. A line under it: "Saving the caption runs the checks again." `aiDisclosure` → `review.aiDisclosure`.
- **Specs**: "N s · 9:16 vertical · <voice>" (`plan.voiceName`, else "Voiceover").
- **Download video** (outline, `canApprove`): disabled while `sendBlock(detail)` (its sentence shown), while it or a caption save is in flight [C-M6]; `isRepeatClick` ignored. Press → `download(…, detail.version)` → `const u = safeHttpUrl(downloadUrl)`; no `u` → "Couldn't start the download. Try again."; else `window.location.assign(u.href)` [S-M4] (the attachment header saves the file without leaving) → `fetchShared(reelUrl, true)`. A 409 → read again and show the server's sentence. The line "Downloading approves this version." beside it. Without `canApprove`: "Your role can't approve reels, so Download (which approves) isn't here." [S-M1].
- **Continue to Publish** (primary, `go("publish")`), enabled when `!sendBlock(detail)`. **Not right? Ask for changes** (`go("plan")`).

- [ ] **Step 1: Update the `BUILT_STEPS` test, then implement** (Storyboard and the preview first, then the step).
- [ ] **Step 2: Run** web typecheck, lint, test, build → PASS. Check the Overview's Quality check section looks the same, and that `/reels` (home) first-load size didn't grow.
- [ ] **Step 3: Commit** (two commits: `ChecksList` + captions in `PreviewFrame`; the Review step).

---

### Task 9: Publish step (R08, R09) and the release panel's studio fix

**Repo:** web.

**Files:**
- Modify: `components/workspace/release-panel.tsx`
- Create: `components/reels/publish-step.tsx`
- Modify: `components/reels/reel.ts` (`BUILT_STEPS = REEL_STEPS`; the "3c adds" comment goes), `components/reels/reel-page.tsx` (`PublishStep` via `dynamic(() => import("./publish-step").then((m) => m.PublishStep), { ssr: false, loading: () => <ListSkeleton label="Loading publishing" /> })`) [P-I3], `tests/reels.test.ts`

**Interfaces:**
- `release-panel.tsx`:
  - `ReleasePanel`'s `perms` widens to `readonly string[] | null` [C-M8, M-I2]. `Release.requirements.studio?: boolean` (optional: an older server sends none).
  - `ApproveForm`'s approval sends `noAutoPublish: true` when `data.requirements.studio`, so approving a studio reel in the Overview never books it on the first account at an old `scheduledFor` [S-M2].
  - `PublishForm`: with `req.studio`, no Video link field, no link check in `missing`, no `videoUrl` in the body (S3; this also fixes the Overview, C-6). Next to the schedule input, "Time zone: <zoneCity(browser zone)>" (Q4; posts get the line too). New prop `approving: boolean`, which swaps its ":367" line for "Publishing approves draft vN first." and its ":308" no-account line for "Connect an account for Instagram to publish it." [M-I2].
  - `ReleasePanel` gains `approveFirst?: boolean`, with a one-line comment above the chain: the reel page passes it, the Overview doesn't. The branch goes **first** in the chain [M-I2]: `approveFirst && !refused && (status === "AWAITING_APPROVAL" || (status === "APPROVED" && data.approvalValid))` — one branch for both, so the form keeps its state and error across the approval. **Call** (correctness and maintainability differed on APPROVED): APPROVED with an approval that no longer holds keeps the existing "needs a fresh approval" line [C-I3]. Inside the branch:
    - `qualityBlocked` → `sendBlock`'s sentence and no form; `ApproveForm` is never shown on this path.
    - with `content.approve` (or already APPROVED) and `publish.execute`: `PublishForm approving={status === "AWAITING_APPROVAL"}`, whose submit sends `publishCalls(version, status, body)` in order with `request()` directly, then one `reload()` and one `onChanged()` after the last call or after an error (rethrown), with `seen.current` set to the expected `status:version` first so the effect doesn't read again [P-M3].
    - without them: "Your role can't publish reels. Someone who can publish will post it." / "Your role can't approve reels, so it can't publish this one."
  - When the panel's `data` goes from going out (`!notGoingOut`) to not, it calls `onChanged()` once, so the reel page's status and rail follow a post that went out [C-M10, P-M3].
- `PublishStep({ workspaceId, brandId, detail, perms, onChanged })`, `memo`.

Behaviour (spec §5.3 Publish, §5.7, §5.8):
- No video: "Make the video first." with a Storyboard link. `sendBlock(detail)` → its sentence; the panel still shows the history.
- **Instagram** [M-I3, P-M5]: `useJob(connectionsUrl(w, b))` read once, plus `fetchShared(connectionsUrl, true)` on mount and when the tab becomes visible again (one listener, no polling) → `instagramState`. Only the cases the release state can't tell apart get a line: "Instagram needs reconnecting." with **Reconnect**, "Instagram isn't connected." with **Connect** (both `/settings?tab=connections`; `publish.expired|notConnected|reconnect|connect`). With an active account, the panel's own "Posting as…" line is the only one. `lastError` is never shown.
- `ReleasePanel base={brandUrl(w, b)} id={reel id} status={detail.item.status} version={detail.version} qualityBlocked={checks?.overall === "BLOCKER"} perms={perms} onChanged={reload} approveFirst`. Scheduled, Cancel schedule, Posted / Not posted, the publishing poll (5 s, 10-minute cap, "Check the account") are the panel's own.

- [ ] **Step 1: Update the `BUILT_STEPS` test, then implement.**
- [ ] **Step 2: Run** web typecheck, lint, test, build → PASS. Check a post's publish form in the Overview still shows its Video link for a non-studio reel, and that `/reels/[id]`'s first load doesn't include the release panel.
- [ ] **Step 3: Commit** (two commits: the release panel; the Publish step).

---

### Task 10: Outside the reel page: "Posted it? Add link" and studio reels in the Overview (I-6)

**Repo:** web.

**Files:**
- Create: `components/reels/post-link-dialog.tsx` (lazy, mounted on first open)
- Modify: `components/reels/your-reels.tsx`, `components/reels/home.tsx`, `app/(shell)/reels/page.tsx` (`canPublish`)
- Modify: `components/workspace/content-panels.tsx` (`ContentItem.studio?: boolean`; `ContentView` gains `reelsOn`), `components/workspace/workspace.tsx`, `app/(shell)/page.tsx` (`reelsOn = featureOn("reels", workspaceId)`)

**Interfaces:**
- `PostLinkDialog({ workspaceId, brandId, reel: ReelSummary | null, onClose, onSaved })` — title "Add the post link" (`results.linkTitle`), body `results.linkBody`, a URL `Input` (label "Post link"), **Save link** (`results.saveLink`, "Saving…") → `reelsApi.registerLink` → `onSaved()` (the list's `reload`). Errors: the server's sentence ("…Instagram post", "Download the reel first").
- `YourReels` gains `canPublish`; under a card with `postLinkWanted(r)`, a small button "Posted it? Add link" (`aria-label` "Posted <title>? Add the link"), outside the card's link.
- Overview, a studio item: no Edit button, no `DraftEditor`, no `NextStep` (the Creator can't rewrite a studio reel: `rewrite` filters `studio: false`). In their place: "Made in Reels. Change its plan, video and caption there." and, with `reelsOn`, **Open in Reels** (`reelHref(id, brandId)`). The release panel stays (S3 drops its link field; Task 9 adds `noAutoPublish` to its approval).

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Run** web typecheck, lint, test, build → PASS.
- [ ] **Step 3: Commit** (two commits).

---

### Task 11: Handover, design system

**Repo:** server only (`docs/HANDOVER.md`, `docs/DESIGN_SYSTEM.md`).

**Files:**
- Modify: `docs/HANDOVER.md` (a "Feature 3c" section above 3b's, shaped like it: what was built, server changes, calls made, copy written without a source, owner checks, not checked live, limits). In the 3b section, correct "all additive, old phone builds unaffected": an old phone's fast clone retry now gets 409 `clone.stillMaking` (3b final review m6).
- Modify: `docs/DESIGN_SYSTEM.md` §7: a `ChecksList` row; the `PreviewFrame` row gains `captionsUrl` / `captionsLang` / `noDownload`; the `JobProgress` row adds that the reel's Video step unmounts it at the end and the page's live region announces the end [M-M10].

Owner checks (spec §11, the ones 3c owns): double-click Make video: one render, one charge; a finished reel's storyboard shows "Watch the video", and a forced render call (`{ action: "render", version }` on that version) gets 409; a 402 on Make video and Try again opens the paywall; the player and every Review control by keyboard, captions on by default and in step with the voice; a sixth hashtag is refused before sending; Download saves `reel-<8>.mp4` and the reel shows as approved; Publish now on an unapproved reel approves and posts in one press, and after a failed publish the next press doesn't approve again; approving a studio reel in the Overview doesn't book it by itself; Schedule shows the time zone; Cancel schedule; 375 px: no horizontal scroll on Video, Review and Publish; a studio reel in the Overview's release panel asks for no video link, shows "Open in Reels" and no draft editor; "Posted it? Add link" on a downloaded reel.
Limits: renders were never run live (no provider credits), so the Video step, X01 and the captions' timing against a real video are unseen; one caption cue per scene; captions are on our preview only, not burned in (Q2b); nobody is told a render ended once they leave the page (Q3); the failed reel card says "Didn't work" without its credits (left out by the owner's choice; spec §5.2 asked for it); the Review's checks wait stops after 10 minutes; viewers can still save the video from the player (the approval gate covers the approval act, not the file) [S-M1]; a failed publish attempt in History shows the platform's own message, as for posts [S-M3]; a scheduled reel coming due while the page is open isn't noticed until the page is read again; "Open in Reels" shows only with the reels flag on; `/reels/{id}` still has no `scripts/audit-ui.ts` entry (no fixture reel).

- [ ] **Step 1: Write** both docs.
- [ ] **Step 2: Commit** in server.

---

## Deferred minors folded in

- 3b ledger Task 6 (progress.md line 42): `stepHref` and the rail's `href` built the same string in `reel-page.tsx` → Task 6 (with `reelHref`).
- 3b final review m6 (progress.md lines 13, 72): the 3b handover's "old phone builds unaffected" wording → Task 11.
- The others in `final-review.md` stay as triaged: none is in a file 3c changes in a way that reaches them (`script-step.tsx`, `voices-sheet.tsx`, `use-voice-library.ts`, `audio-recorder.tsx`, `presenter-step.tsx`, the recordings route are untouched; `paid-press.ts` gets only a comment).

## Open questions for the owner

None. (The failed card's credits were decided by the owner on 2026-11-19: left out.)

## Self-review notes

- Spec §7 3c coverage: S2 → Task 1; S3, S4, S7 → Task 2; S8 → Tasks 3, 4; Make video → Task 7; Video and X01 → Task 7; Review (checks, recheck, caption, download, captions, transcript) → Task 8; Publish and Scheduled (release panel reuse) → Task 9; the release panel's studio fix → Task 9; Posted it? Add link → Task 10; "Open in Reels" with the draft editor hidden (I-6) → Task 10; paid press rules for Make video and Try again → Paid press rules + Task 7; handover and design system → Task 11.
- Not in 3c (or feature 3): the ready banner and push (Q3), Use in story (feature 4), credit history labels (feature 6), burned-in subtitles (Q2b), "Make it again" (`again: true`), the failed card's credits (owner), an audit-ui fixture reel.
- Deviations, one line each:
  - The failed reel card leaves out "· N credits back" (§5.2), by the owner's choice.
  - S3's flag is set in `releaseState`, not as a `publishRequirements` parameter (no item there; an exact-shape test and two callers).
  - S4 also refuses more than 5 hashtags or a caption over 2200 for a studio reel, and the version race gets code `draft.changed` (both additive).
  - S2 also skips a refunded attempt id (the spec's guard assumed every charge has a render row).
  - `ChecksList` comes from the Overview's Quality check section (`content-panels.tsx`), not the release panel, which has no checks list.
  - The Review's checks wait stops after 10 minutes (§5.8 names no end).
  - "Change voice" on a `voiceDeleted` failure opens the Script & voice step, not the Voices sheet itself.
  - The Overview hides `NextStep` for studio reels too, not only the draft editor (the Creator can't rewrite them).
  - The time zone line on the schedule input also shows for posts (Q4 assumed it was already there).
  - The Review's primary button is **Continue to Publish**; Download and Save caption are outline (the spec names no primary).
  - The Instagram status reads `GET …/connections`, since the release state lists only active accounts; it shows only when no account is active.

## Lens minors not taken

- [C-M4, the `defaultStep` half] `defaultStep` keeps FAILED before the video: the lens itself says leave it, and only the phone's `again` can produce that state.
- [C-M12] "`releaseState` is already mocked" wording: fixed in Task 2's Files line; no other change.
- [P-M1, the reuse-`renderView` half] Cues aren't taken from `renderView`'s rows: that would change its public shape and miss a video older than the 20 newest renders; the extra read runs inside the existing `Promise.all` instead.
- [P-M3, the due-time timer] No timer for a scheduled attempt coming due while the page is open: the Overview behaves the same today, and the next read shows it; named as a limit in Task 11.
- [Performance, out-of-lens note] "`editCaption` sends only caption and hashtags": checked, the edit route's schema defaults `hook`, `slides`, `script`, `pinTitle` and `altText` (`content/[contentId]/route.ts:21-27`), and S4 fills hook and script; nothing to change.
