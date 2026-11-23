# Feature 3b · Reels on the web: presenter, photos, script, voice, record, clone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the website a person can do everything before rendering: pick or make a presenter, preview a template with their photos, change each scene's photo and order, edit the script per scene, pick a voice (ours, a clone or the library), record or upload a take per scene, and clone a voice. Paid buttons follow the §5.4 money rules.

**Architecture:** Server: the clone consent version on `GET /voices` (S9), the recordings route accepts web-made (UUID) reel ids with a scope-keyed rate bucket, a version conflict carries a code, a clone retry can't report a voice that isn't made, and the word-count rule and library filter values move into `shared/reels.ts`. Web: pure helpers first (`reel.ts`, `lib/recorder.ts`, `voices.ts`), then one save hook held by the reel page, one paid-press hook, then one task per step or dialog. Each step joins `BUILT_STEPS` in the task that renders it. Dialogs, the picker and the Voices sheet load lazily.

**Tech Stack:** Next.js 15.5 / React 19.1, Tailwind 4, vitest (node, no jsdom). Browser `MediaRecorder` and `getUserMedia`, no new dependency. Server: Next.js route handlers, zod, Prisma, vitest.

**Spec:** server repo `docs/superpowers/specs/2026-11-18-feature-3-reels-design.md` (approved 2026-11-18). This plan is slice **3b** (§7): server S9; web Presenter, template Preview, Photos, Script & voice, Voices sheet, `AudioRecorder`, scene takes (recorded or uploaded, Q6), Clone a voice. Model plan: `2026-11-18-feature-3a-reels-plan-storyboard.md` (merged).
**Phone source of truth (mobile repo):** `src/app/reels/{actor,assets,script,voices,record,clone,templates}.tsx`, `src/api/endpoints.ts:247-306`, copy `src/i18n/locales/en/reels.json` (`actor`, `assets`, `script`, `record`, `clone`, `voices`, `templates.preview*`).

**Found while planning (not in the spec):** `POST /reels/{id}/recordings` refuses any id not matching `^[a-z0-9]{10,40}$` (route.ts:20), but `createReel` stores a web-made reel under its request UUID (`service.ts`, `id: input.requestId`). Without Task 1's fix every take on a web-made reel is a 404.

**Plan lenses (2026-11-18):** correctness, security, performance and maintainability ran on this plan; all Critical, Important and Minor findings are folded in below. Reports: server `.superpowers/sdd/2026-11-18-feature-3b-reels-steps-voice/lens-*.md`.

## Reuse map (don't rebuild)

| Need | Already there |
|---|---|
| Calls, 402 → paywall, error text | `request()`, `ApiError`, `errorMessage` (`components/settings/api.ts`); a `FormData` body gets its own multipart header |
| Paid press helpers | `isRepeatClick`, `pressErrorText`, `refused`, `idTaken` (export it) (`lib/presser.ts`); `PRESS_COOLDOWN_MS` (`components/photoshoot/press.ts`); the in-flight/alive/cooldown pattern in `components/photoshoot/studio.tsx:35-90` (read it; don't copy it, Task 4's hook replaces the pattern for reels) |
| Price on a button | `withPrice(label, price)` (`lib/plan-credits.ts`); `usePlan(w)` → `{ loaded, planned, unlimited }`; `loadPlanCredits(w, true)`; `openPaywall` (`lib/paywall.ts`) |
| Plan refusal without a request | `PLAN_REFUSAL` in `components/reels/home.tsx`: Task 2 moves it to `labels.ts` |
| Reel, options, cache | `useReel`, `useReelOptions`, `useReelIdeas` (read-once pattern) (`use-reels.ts`), `fetchShared`, `putShared`, `sharedAt`, `stale`, `useRereadWhenStale` (`components/workspace/use-job.ts`) |
| Streamed presenter turn | `usePlanChat(...).send(version, body)` (`plan-step.tsx`), already lifted to the reel page; `makeRevisePresser` key in `plan-stream.ts`; body built at `use-reel-stream.ts:25` |
| Edit lock | `editLock(detail)` in `plan-step.tsx`: Task 2 moves it to `reel.ts` |
| Presenter states / name | `PRESENTER_STATE` (`home.tsx:29`), the name lookup at `storyboard-step.tsx:19`: Task 2 replaces both with `presenterState` / `presenterName` |
| Photo picker | `LibraryPicker` (`components/library/library-picker.tsx`), single photo, uploads with `canUpload`; `onUse` gives a `LibraryPhoto` whose display link is `url`; load it lazily as `components/photoshoot/setup-parts.tsx:15` does |
| Confirm a delete | `ConfirmDialog` (`components/settings/shared.tsx:57`) |
| `<select>` style | `selectClass` (`components/settings/shared.tsx:16`) |
| `m:ss` clock | inline at `components/welcome/welcome-flow.tsx:314`: Task 2 makes it `clock` in `lib/time.ts` and uses it there too |
| Page parts | `ChoiceCards`, `SegmentedRadios`, `Dialog`, `Sheet`, `Button`, `Textarea`, `Input`, `PageSection`, `EmptyState` (`components/ui/*`); `LoadError`, `ListSkeleton` (`components/settings/shared`) |
| Client tag for `appVersion` | `CLIENT_TAG` (`lib/net.ts`) |
| Clone reading languages | `CLONE_PASSAGES` keys (`@/shared/contract/clone-passages`, 13.5 KB: imported only by the lazy clone dialog) |
| Lazy client part | `dynamic(() => import(…), { ssr: false })`, mounted on first open as `home.tsx:43-44,102` does (`ideasMounted`) |

## Global Constraints

- Repos side by side: `C:\Users\INTEL\Desktop\Social Media Agent\apps\{server,web,mobile}`. Branch `feature-3b-reels` from `main` in all three. Commit only in the repo the task names.
- Run npm inside the repo with `--prefix .`. Windows, Git Bash.
- Every task leaves its repo green: server `npm run typecheck|lint|test --prefix .`; web `npm run typecheck|lint|test --prefix .` (typecheck runs `check-shared`); mobile `npm run typecheck --prefix .`.
- Shared code: edit `shared/` in the server only, then `npm run sync:shared --prefix .` (server) and commit the copies (with their `.hash`) in web and mobile. Never hand-edit `web/shared` or `mobile/src/shared`.
- Old phone builds see no change. The phone's own screens are not moved onto the shared helpers.
- No new dependencies. Web tests unit-test pure logic only; components are checked by build, `scripts/audit-ui.ts` and the owner.
- Copy is the phone's English (`reels.json`), copied by hand; desktop-only lines follow its tone. Never show provider error text; show the server's sentence.
- `docs/DESIGN_SYSTEM.md` (server repo): one primary button per view, cards `rounded-2xl border border-border bg-card shadow-sm`, inputs `rounded-xl`, buttons pill, `focus-visible:ring-2 ring-ring`, icons `aria-hidden` beside text. Dialogs use `components/ui/dialog.tsx` as it is; the Voices sheet is full screen below `md`.
- Read-only role (no `content.create`): every step shows its content with no edit, record, make or pick controls. Cloning shows only when `cloning.allowed`.
- Commit messages: the change and why. No co-author lines, no tool or session URLs, no mention of tests.
- Don't call paid providers; don't touch port 3100's running process.
- Slice scope: no Make video, Video, Review or Publish steps (3c). The Storyboard stays read-only apart from its "Pick photos" link.
- Streaming re-renders the reel page once a frame: `chat` goes only to the Plan and Presenter steps; `PhotosStep` and `ScriptStep` are `memo`ed and get stable (`useCallback`) props; each step keeps its edit state inside itself.

## Paid press rules (Tasks 4, 9; spec §5.4)

Every paid button (Make a presenter, Preview with my photos, Clone voice) goes through **one hook**, `usePaidPress` (Task 4):
- Price from the server (`presenterCredits`, `previewCredits`, `cloning.credits`) through `withPrice`; no price when `usePlan(w).unlimited`. Before the price is read: disabled, label "Reading prices…".
- No plan (`loaded && !planned`): the press calls `openPaywall(PLAN_REFUSAL)` and sends nothing.
- Disabled while its request is in flight; `isRepeatClick(e)` presses are ignored; off for `PRESS_COOLDOWN_MS` after a success.
- After any answer: `loadPlanCredits(w, true)`. Error text: `pressErrorText(e)` (null = the paywall said it).
- Unknown outcome (`!refused(e)`): run the caller's `reread` (options for presenter and preview, voices for clone) and keep the button off until it lands.
- Presenter and preview send no `requestId` (the server allows one RUNNING per kind and refunds a second).
- Clone keeps one `requestId` per take and decides same-take/new-take with `cloneRetry` only. **Never `makePresser`** for the clone: it silently re-sends on `request.idTaken`, which would send the voice again against a used challenge.

## Review Focus

1. **A take on a web-made reel** (UUID id) uploads instead of 404ing; a path-like id is refused before any rate-limit row; another workspace can't fill this reel's bucket. → Task 1.
2. **A save that loses a race** (a render finished, another device saved) reloads the reel and keeps what the person typed. Only `reel.changed` gives the keep-your-text sentence. Two steps never save at once (one hook on the reel page). → Tasks 1, 3.
3. **A clone press whose answer was lost** retries with the same take and `requestId` (no second charge); the dialog closes only when the voice is listed; a voice still being made or archived is never reported as made. → Tasks 1, 2, 9.
4. **A press on Make a presenter or Preview while one is already being made, or right after an unknown outcome**, sends nothing until the options are read again. → Tasks 2, 4.
5. **A file over 1 MB, or a recording the browser can't make** (no supported type, mic denied, no mic, busy, not https), is stopped in the browser with a sentence and no upload. → Task 2.
6. **An edit made while the plan moved** (the Plan chat landed) gets a 409 and keeps the edit, never overwrites the newer plan; scene text is saved trimmed so its take survives. → Tasks 3, 6, 7.
6b. **The microphone is off** after the dialog closes, including when it closes during the permission prompt, mid-recording (no take is sent), or after a device switch. → Task 9.
7. **Picking a voice saves once** (Use this voice), never once per arrow key. → Task 8.
8. **"Use this presenter"** sends `presenterId` and leaves the Plan step's composer and pending bubble alone. → Task 3.
9. **Swapping two photos** keeps every other scene's photo and moves focus with the photo. → Tasks 2, 6.
10. **A library page answered after the filters changed** is dropped, and a voice is never listed twice. → Tasks 2, 8.

---

### Task 1: Server: consent version, UUID reel ids on recordings, change code, clone retry safety, shared word count and library filters

**Repo:** server, then sync to web and mobile (commit the copies there too).

**Files:**
- Modify: `shared/reels.ts` (add `wordCount`, `WORDS_PER_SECOND`, `LIBRARY_FILTERS`, `consentVersion` on `CloningInfo`)
- Modify: `server/reels/plan.ts:50,52` (import `wordCount`, `WORDS_PER_SECOND` from `@/shared`; delete the local copies; `speechSeconds` at :53 stays and stays exported)
- Modify: `server/reels/library.ts:17-26` (`z.enum(LIBRARY_FILTERS.gender)` etc.; import `LibraryVoice` from `@/shared`, delete the local type; keep `previewUrl` only when it parses as an `https:` URL, else null)
- Modify: `server/reels/service.ts:105,255` (version-conflict `PublishingError`s get code `reel.changed`)
- Modify: `server/reels/clones.ts` (`createClone` repeat branch, optional `consentVersion`)
- Modify: `app/api/v1/workspaces/[workspaceId]/brands/[brandId]/voices/route.ts:14` (add `consentVersion: CONSENT_VERSION`; the `cloning` object `satisfies CloningInfo`)
- Modify: `app/api/v1/workspaces/[workspaceId]/brands/[brandId]/voices/clones/route.ts` (read optional `consentVersion` form field, pass it on)
- Modify: `app/api/v1/workspaces/[workspaceId]/brands/[brandId]/reels/[contentId]/recordings/route.ts:20,29`
- Test: `tests/reel-shared.test.ts`, `tests/reel-recordings-route.test.ts` (new), `tests/reel-clones.test.ts`, the reel service/plan test that covers version conflicts, the library test if one exists

**Interfaces:**
- Produces (`@/shared`): `wordCount(text: string): number` (`text.trim().split(/\s+/).filter(Boolean).length`), `WORDS_PER_SECOND = 2`, `LIBRARY_FILTERS = { language: ["fr","en","de","es","it","pt","nl"], gender: ["female","male","neutral"], age: ["young","middle_aged","old"], useCase: ["social_media","advertisement","narrative_story","conversational","informative_educational","characters_animation"] } as const` (comment: "the phone's voices.tsx keeps its own copy (no characters_animation); keep in step"), `CloningInfo.consentVersion: string`.
- Error codes: `reel.changed` (409, version conflict on save/chat), `clone.stillMaking` (409, "This voice is still being made. Check back in a minute."), `clone.consentChanged` (409, "The consent text changed. Read it again, then tick the box.").

- [ ] **Step 1: Write the failing tests**
  - `reel-shared.test.ts`: `wordCount("  a  b\nc ")` is 3; `wordCount("")` is 0.
  - `reel-recordings-route.test.ts` (mock `authorizeBrandRoute` to return a scope, `hitRateLimit` to allow and record its keys, `uploadRecording` to resolve `{ id: "r1", seconds: 4, transcript: "x", matches: true }`):
    - `recordings route accepts a UUID reel id`: POST to contentId `0b9f2c4e-7d1a-4c3b-9e8f-1a2b3c4d5e6f` with a small `file` and `text` → 201, `uploadRecording` called with that id. Uppercase of the same UUID → also 201.
    - `refuses a path-like id with 404 and counts nothing`: contentId `../x` → 404 and `hitRateLimit` not called.
    - A cuid (`ckv9x1y2z3a4b5c6d7e8`) still → 201.
    - `the reel bucket is keyed by the caller's scope`: the reel key contains `scope.workspaceId` and `scope.brandId`.
  - New `tests/voices-route.test.ts` (mock `authorizeBrandRoute`, `voiceList`, `canManageVoices`): `GET /voices` answer has `cloning.consentVersion === CONSENT_VERSION`.
  - The recordings route test's `vi.mock("@/server/reels/recordings")` factory must also export the real `MAX_RECORDING_BYTES` (the route imports it; without it the size checks compare against `undefined` and pass silently).
  - `reel-clones.test.ts`: a repeat `requestId` whose row has `archivedAt` → 409 `request.idTaken`; whose row has `providerVoiceId: null` → 409 `clone.stillMaking`; a made row → `repeated: true` as today; `consentVersion` sent and different from `CONSENT_VERSION` → 409 `clone.consentChanged` before the challenge is taken; omitted → accepted (the phone).
  - Version conflict on save → `PublishingError` with code `reel.changed`.
  - Library: a non-https `previewUrl` from the provider comes back null.
- [ ] **Step 2: Run** `npm run test --prefix . -- reel-shared reel-recordings-route reel-clones` (plus the touched tests) → FAIL.
- [ ] **Step 3: Implement.**
  - Route id check: `const CUID = /^[a-z0-9]{10,40}$/;` then `if (!CUID.test(contentId) && !z.string().uuid().safeParse(contentId).success) return invalid("Reel not found", 404);` with the comment "a cuid (phone-made) or the request UUID a web-made reel is stored under". If an uppercase UUID doesn't find its reel in `uploadRecording`, lowercase the id before use.
  - Reel bucket: `` `rec:reel:${scope.workspaceId}:${scope.brandId}:${contentId}` ``.
  - `createClone` repeat branch, in order: other workspace → `request.idTaken` (as now); `found.archivedAt` → `request.idTaken`; `!found.providerVoiceId` → `clone.stillMaking`; else `repeated`. `consentVersion` check runs before `takeChallenge`.
  - Shared additions as in Interfaces; plan.ts and library.ts import them.
- [ ] **Step 4: Run** server typecheck, lint, test → PASS. `npm run sync:shared --prefix .`; web typecheck and mobile typecheck → PASS.
- [ ] **Step 5: Commit** in server (one or two commits: the route/clone safety, then the shared contract), then the synced copies in web and mobile (one commit each: "Sync the shared reels contract: word count, library filters and the clone consent version").

---

### Task 2: Web pure helpers (no React)

**Repo:** web.

**Files:**
- Modify: `components/reels/reel.ts` (`editLock` moved here, new helpers below; `BUILT_STEPS` unchanged here)
- Modify: `components/reels/plan-step.tsx` (import `editLock` from `./reel`; delete the local one)
- Modify: `components/reels/labels.ts` (`PLAN_REFUSAL` moved here from `home.tsx`; `presenterState`)
- Modify: `components/reels/home.tsx` (import `PLAN_REFUSAL`, use `presenterState`; delete `PRESENTER_STATE`)
- Modify: `components/reels/storyboard-step.tsx` (use `presenterName`)
- Modify: `lib/presser.ts` (export `idTaken`)
- Modify: `lib/time.ts` (`clock`), `components/welcome/welcome-flow.tsx:314` (use it)
- Create: `lib/recorder.ts`
- Create: `components/reels/voices.ts` (helpers plus `TRAIT_TITLES`, `LIBRARY_LABELS`, `GENDER_LABELS`: kept out of `labels.ts`, which every reel page loads)
- Test: `tests/reels.test.ts`, `tests/recorder.test.ts` (new), `tests/reel-voices.test.ts` (new)

**Interfaces (Produces):**
- `reel.ts`:
  - `editLock(d: ReelDetail): string | null` (moved as is).
  - `optionsMaking(o: ReelOptions): boolean` — any presenter RUNNING or any template `making`.
  - `presenterChoice(plan: ReelPlan, options: ReelOptions | null | undefined): string` — `plan.presenter` when it names a DONE presenter of `options` (or options aren't read yet), else `"none"`.
  - `presenterName(plan: ReelPlan, options: ReelOptions | null | undefined): string` — the presenter's name, "No presenter" for `"none"`, "…" while unread (the storyboard's current lookup, moved).
  - `optionBusy(options, kind: "presenter" | { templateId: string }): boolean` — true when options are unread, a presenter is RUNNING (presenter), or that template is `making` (preview).
  - `swapScenes(keys: readonly string[], i: number, j: number): string[]` — a copy with `keys[i]` and `keys[j]` swapped; out of range returns the copy unchanged.
  - `sceneProblems(texts: readonly string[], recorded: readonly boolean[]): (string | null)[]` — reads trimmed text; per scene: empty → "Scene N needs text."; over `VOICE_TEXT_MAX` characters → "Scene N is over 400 characters."; not recorded and `wordCount > MAX_SCENE_WORDS` → "Scene N is over 30 words (15 s). Shorten it."; else null.
  - `sceneCount(text: string): string` — `"N words · ~S s"` with `S = Math.round(wordCount / WORDS_PER_SECOND)` (singular "1 word").
- `labels.ts`: `presenterState(p: Presenter, credits: number): string` — RUNNING "Being made, about a minute"; DONE "Ready"; FAILED "Didn't work · N credits back".
- `lib/time.ts`: `clock(seconds: number): string` — `0:07`, `1:30`.
- `lib/recorder.ts`:
  - `RECORDER_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"] as const` (never Ogg: the server refuses it).
  - `pickFormat(isTypeSupported: (t: string) => boolean): string | null`.
  - `micProblem(e: unknown, secure: boolean): string` — not secure → "Recording needs a secure (https) page."; `NotAllowedError` → "Your browser blocked the microphone. Allow it from the icon in the address bar, then try again."; `NotFoundError` → "No microphone found. Plug one in, or upload a file instead."; `NotReadableError` → "Your microphone is busy in another app. Close it there, then try again."; else "Couldn't start recording. Try again."
  - `NO_FORMAT = "This browser can't record audio here. Use a recent Chrome, Edge, Firefox or Safari."`
  - `fileProblem(file: { size: number }, maxBytes: number): string | null` — over → "Keep the file under 1 MB."
- `components/reels/voices.ts`:
  - `libraryQuery(f: LibraryFilters): string` — `URLSearchParams` of set, non-empty fields (page included when > 0).
  - `mergeLibraryPage(prev: LibraryVoice[], next: LibraryVoice[]): LibraryVoice[]` — prev then next's unseen ids.
  - `cloneRetry(e: unknown): "same-take" | "new-take"` — `"same-take"` only when `e` is an `ApiError` with status 0 (no answer) or code `clone.stillMaking` (the repeat branch, which runs before the challenge); any other answer, 5xx included, → `"new-take"`: the server takes the challenge before its checks (`clones.ts:67`), and a 502 has already refunded the id. The phone's rule (`mobile clone.tsx:116`).
  - `readingLanguage(preferred: readonly string[], available: readonly string[]): string` — first exact match, then its base ("pt-BR" → "pt"), else `"en"`.
  - `languageName(code: string): string` — `new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code`; used for both library and clone languages.
  - `canManageClone(v: ReelVoiceOption, cloning: CloningInfo | null): boolean` — `v.clone && (v.mine || !!cloning?.allowed)`.
  - `TRAIT_TITLES` (the 7 `actor.trait.*` group titles only; option text is the server's label), `GENDER_LABELS` (`voices.gender.*`), `LIBRARY_LABELS` typed `{ [K in keyof typeof LIBRARY_FILTERS]?: Record<(typeof LIBRARY_FILTERS)[K][number], string> }` for gender, age, useCase (`voices.filter.*`, plus "Characters & animation") and `LIBRARY_TITLES` (`voices.filterTitle.*`).

- [ ] **Step 1: Write the failing tests** (values pinned):
  - `optionsMaking`, `presenterChoice` (FAILED → `"none"`; DONE → id; options null → plan's value), `presenterName`, `presenterState`.
  - `optionBusy`: options null → true; a RUNNING presenter → true for `"presenter"`, false for `{ templateId }`; template `making` → true for that template only.
  - `swapScenes(["a","b","c"], 0, 1)` → `["b","a","c"]`; `swapScenes(["a"], 0, 1)` → `["a"]`.
  - `sceneProblems(["", "x".repeat(401), thirtyOneWords, thirtyOneWords], [false, false, false, true])` → `["Scene 1 needs text.", "Scene 2 is over 400 characters.", "Scene 3 is over 30 words (15 s). Shorten it.", null]`.
  - `sceneCount("one two three")` → `"3 words · ~2 s"`; `sceneCount("one")` → `"1 word · ~1 s"`.
  - `pickFormat(t => t === "audio/mp4")` → `"audio/mp4"`; `pickFormat(() => false)` → null; `pickFormat(t => t.includes("ogg") || t === "audio/webm")` → `"audio/webm"`.
  - `micProblem` for each name and for `secure: false`.
  - `fileProblem({ size: MAX_RECORDING_BYTES + 1 }, MAX_RECORDING_BYTES)` → the sentence; equal size → null.
  - `clock(7)` → `"0:07"`, `clock(90)` → `"1:30"`.
  - `libraryQuery({ language: "fr", gender: "", search: undefined, page: 0 })` → `"language=fr"`; with `page: 2` → includes `page=2`.
  - `mergeLibraryPage([{id:"a"}], [{id:"a"},{id:"b"}])` ids → `["a","b"]`.
  - `cloneRetry(new ApiError(0,"x"))` and `(409, code "clone.stillMaking")` → same-take; `(502)`, `(503)`, `(400)`, `(410)`, `(402)`, `(409, code "request.idTaken")` and a plain `Error` → new-take.
  - `readingLanguage(["fr-CA"], ["en","fr"])` → `"fr"`; `(["xx"], ["en"])` → `"en"`.
- [ ] **Step 2: Run** `npm run test --prefix .` → FAIL.
- [ ] **Step 3: Implement** in the files above.
- [ ] **Step 4: Run** web typecheck, lint, test → PASS.
- [ ] **Step 5: Commit.**

---

### Task 3: Web API calls, the presenter chat send, and the shared save hook

**Repo:** web.

**Files:**
- Modify: `components/reels/api.ts`
- Modify: `components/reels/plan-stream.ts:15,83,100` (`ReviseBody.presenterId?`, the revise `keyOf`; `CHANGED_ELSEWHERE` beside `CHANGED_WHILE_WAITING`)
- Modify: `components/reels/use-reel-stream.ts:25,134` (send `presenterId` in the body; type gains it)
- Modify: `components/reels/plan-step.tsx:19,43,51,152` (`Body` becomes a tagged union; composer handling only for composer/chip sends)
- Modify: `components/reels/use-reels.ts` (`useReelOptions` polls while making; `useVoices`)
- Modify: `components/reels/reel-page.tsx` (hold one `useReelSave`)
- Create: `components/reels/use-reel-save.ts`
- Test: `tests/reels.test.ts`, `tests/reel-plan-stream.test.ts`

**Interfaces:**
- Produces in `api.ts` (all through `request()`; JSON unless said):
  - `voicesUrl(w, b)`, `voiceLibraryUrl(w, b, q: string)`, `presentersUrl(w, b)`, `previewsUrl(w, b)`.
  - `reelsApi.chat` body gains `presenterId?: string`.
  - `reelsApi.save(w, b, id, body: { version: number; plan: ReelPlan }): Promise<PlanResult>` — PATCH, `timeoutMs: SLOW_MS`.
  - `reelsApi.recording(w, b, id, file: Blob, fileName: string, text: string, language?: string): Promise<Take>` — POST multipart (`file`, `text`, `language`) to `${reelUrl}/recordings`, `timeoutMs: 120_000`. `export type Take = { id: string; seconds: number; transcript: string; matches: boolean }`.
  - `reelsApi.makePresenter(w, b, body: { name: string; traits: Record<string, string> })`, `reelsApi.removePresenter(w, b, id)` (DELETE), `reelsApi.preview(w, b, templateId)`.
  - `voicesApi.list(w, b)`, `voicesApi.library(w, b, f: LibraryFilters, signal: AbortSignal)`, `voicesApi.challenge(w, b, lang, signal?)`, `voicesApi.clone(w, b, body: { file: Blob; fileName: string; name: string; challengeId: string; consentVersion: string }, requestId: string): Promise<{ id: string; name: string }>` (form: `file`, `name`, `consent=1`, `consentVersion`, `challengeId`, `requestId`, `appVersion=CLIENT_TAG`; `timeoutMs: 120_000`), `voicesApi.rename(w, b, id, name)` (PATCH), `voicesApi.remove(w, b, id, withdraw: boolean)` (DELETE, `?withdraw=1`).
- `plan-stream.ts` revise key: `r.presenterId ? \`presenter:${r.presenterId}\` : r.message ?? \`template:${r.templateId}\``.
- `plan-step.tsx` `Body`: `{ kind: "message"; message: string } | { kind: "template"; templateId: string } | { kind: "presenter"; presenterId: string; message: string }` (or equivalent: check `presenterId` first). Clearing the composer, the pending "You:" bubble, putting text back on failure and **Try again** apply to `kind: "message"` (and chips) only. A presenter send's error shows in the Presenter step.
- `use-reel-save.ts`:
  - `saveErrorText(e: unknown): string` (pure, exported) — `ApiError` with code `reel.changed` → `CHANGED_ELSEWHERE` ("This reel changed elsewhere. Your text is still here; save again."); else `errorMessage(e)`.
  - `useReelSave(w, b, reelId): { saving: boolean; error: string | null; save: (version: number, plan: ReelPlan) => Promise<PlanResult | null>; clear: () => void }` — **called once in `reel-page.tsx`** and passed down, so every step and dialog shares one lock. One save at a time (a ref). On success `putShared` the merged `{ ...detail, version, plan }`, then `fetchShared(reelUrl, true)`; the lock is released only after that read resolves. On any 409, and on status 0 (a timed-out PATCH may still commit: `SLOW_MS` is 120 s, the route allows 300 s), also `fetchShared(reelUrl, true)`. Never resets the caller's edits.
  - Callers that edit in place (Photos, Script) keep the **version their edit started from** with the edit and pass that to `save`, never the current `detail.version`, so a plan that moved meanwhile (the Plan chat landed, another device saved) gets the server's 409 instead of being overwritten.
- `useReelOptions`: `done` false while `optionsMaking(data)`; intervals `[[120_000, 10_000], [600_000, 20_000], [Infinity, 60_000]]` (add as `JOB_INTERVALS.reelOptions`); `done` memoised on `[url]`.
- `useVoices(w, b)` in `use-reels.ts`: like `useReelOptions`' staleness: `done = () => !stale(sharedAt(url))` plus `useRereadWhenStale` (clone samples are signed links that expire in an hour); returns `{ data, reload }`.

- [ ] **Step 1: Write the failing tests:** `saveErrorText(new ApiError(409, "…", "reel.changed"))` → `CHANGED_ELSEWHERE`; a 409 "A newer version exists. Review it first." without the code → that sentence; a 400 → its message. In `reel-plan-stream.test.ts`: two presses with the same `presenterId` and different `message` share one request id; a presenter press and a message press with the presenter's name get different ids. If `plan-step`'s composer rule is in a pure function, test "a presenter send leaves the composer and the pending bubble alone"; otherwise extract it (`isComposerSend(body)`) and test that.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** web typecheck, lint, test → PASS.
- [ ] **Step 5: Commit.**

---

### Task 4: Paid presses: one hook, Make a presenter and Preview with my photos (home)

**Repo:** web.

**Files:**
- Create: `components/reels/paid-press.ts` (hook)
- Create: `components/reels/presenter-dialog.tsx` (lazy)
- Modify: `components/reels/home.tsx` (`SideColumn`: presenters gain Make a presenter and Remove; `TemplateCard` gains Preview with my photos; fix the "read only here" comment at :152)

**Interfaces:**
- Consumes: `optionBusy`, `presenterState`, `PLAN_REFUSAL`, `TRAIT_TITLES` (Task 2); `reelsApi.makePresenter|removePresenter|preview` (Task 3).
- Produces:
  - `usePaidPress(w: string, opts: { reread: () => Promise<unknown> }): { pressing: boolean; error: string | null; press: (e: { detail: number }, run: () => Promise<unknown>) => Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> }` — applies every **Paid press rule** (plan lock → paywall, `isRepeatClick`, in-flight guard, `alive` ref, cooldown, `loadPlanCredits`, unknown outcome → `reread()` and stays `pressing` until it lands; success also stays `pressing` until its reread settles, so the cooldown can't end before `optionBusy` sees the new RUNNING row). It returns the error so the clone can apply `cloneRetry`. Presenter and preview pass `reread: () => fetchShared(reelOptionsUrl, true)`; success also rereads options.
  - `PresenterDialog({ workspaceId, brandId, options, open, onOpenChange })` — name (`Input`, max `NAME_MAX`, required), one `ChoiceCards` radio group per `options.traits` (group title from `TRAIT_TITLES`, else the server's; option text the server's label; an "Any" first option with value `""` omitted from the body), and **Create presenter · N credits** (`withPrice`), disabled while `optionBusy(options, "presenter")` with "One presenter is made at a time." Copy: title "Create a presenter", body `actor.createBody`, notice `actor.notice`.
- Home presenters list rows: name, `presenterState(p, presenterCredits)`, **Remove** (`aria-label` "Remove <name>", hidden while RUNNING; DELETE then read options again). Shown only with `canCreate`.
- Template card: **Preview with my photos · N credits** (outline, small) for `canCreate`; `canPreview: false` → "Add product photos to preview templates with them."; `making` → "Making your preview. It takes a few minutes."; `failed` → "Your last preview didn't work. You weren't charged for it."; `own` → "Made with your photos".

- [ ] **Step 1: Implement** the hook, dialog (lazy, mounted on first open), and the home changes.
- [ ] **Step 2: Run** web typecheck, lint, test, `npm run build --prefix .` → PASS.
- [ ] **Step 3: Commit.**

---

### Task 5: Presenter step

**Repo:** web.

**Files:**
- Create: `components/reels/presenter-step.tsx`
- Modify: `components/reels/reel.ts` (`BUILT_STEPS` gains `"presenter"`; `stepState("presenter")`: no plan "None", `"none"` "No presenter", else "Done")
- Modify: `components/reels/reel-page.tsx` (render the step; pass `chat`, `options`, `canCreate`, `save`)
- Modify: `tests/reels.test.ts` (`BUILT_STEPS` assertion at :45; `stepState("presenter")` cases)

**Interfaces:**
- Consumes: `presenterChoice`, `presenterName`, `presenterState`, `editLock` (Task 2); the page's `save`, `saveErrorText` (Task 3); `PresenterDialog`, `usePaidPress` (Task 4); `chat.send(version, { kind: "presenter", presenterId, message: name })` (Task 3).
- Produces: `PresenterStep({ workspaceId, brandId, detail, options, canCreate, chat, save })`.

Behaviour (spec §5.3 Presenter, phone `actor.tsx`):
- `ChoiceCards` legend "Presenter": first "No presenter" (description `actor.noPresenterBody`, meta "Recommended"), then each DONE presenter. RUNNING and FAILED ones render as non-radio rows below the group with `presenterState`; FAILED has **Remove**.
- Value starts at `presenterChoice(plan, options)`; a plan naming a removed or failed presenter shows `role=status` "Presenter removed: pick another."
- **Use this presenter** (primary; shown when the choice differs from the plan; disabled while `chat.stream.sending`, when `send` would do nothing and mark the body failed): a presenter → `chat.send(...)` (streamed; stage line via `STAGE_LABELS`); "none" → `save(version, { ...plan, presenter: "none" })`.
- **Create a presenter** (outline) opens `PresenterDialog`. RUNNING ones poll through `useReelOptions`.
- Locked (`editLock`) or `!canCreate`: `presenterName(...)` as text and the lock sentence.
- Errors: the chat's error for a presenter send, or `saveErrorText`, in a `role=alert` line.

- [ ] **Step 1: Update the two tests, then implement.**
- [ ] **Step 2: Run** web typecheck, lint, test, build → PASS.
- [ ] **Step 3: Commit.**

---

### Task 6: Photos step (and the Storyboard's "Pick photos")

**Repo:** web.

**Files:**
- Create: `components/reels/photos-step.tsx`
- Modify: `components/reels/reel.ts` (`BUILT_STEPS` gains `"photos"`; `stepState("photos")`: no plan "None", any `standIn` "Needs a photo", else "Done")
- Modify: `components/reels/reel-page.tsx`
- Modify: `components/reels/storyboard-step.tsx` (stand-in copy: "Stand-in: this photo doesn't show what the scene talks about." plus a "Pick photos" link to `?step=photos`)
- Modify: `tests/reels.test.ts` (`stepFrom("photos")` at :54 now gives `"photos"`; `reachable("photos", d)`; `stepState("photos")` cases)

**Interfaces:**
- Consumes: `swapScenes`, `editLock` (Task 2); the page's `save` (Task 3); `LibraryPicker` loaded with `dynamic(() => import("@/components/library/library-picker").then((m) => m.LibraryPicker), { ssr: false })`, rendered only while open, for one scene at a time.
- Produces: `PhotosStep({ workspaceId, brandId, detail, canCreate, save, chatBusy })`, wrapped in `memo` (`chatBusy = chat.stream.sending`, a boolean, so streaming doesn't re-render it).

Behaviour (spec §5.3 Photos, §5.9; phone `assets.tsx` sends one PATCH with `scenes[i].photoKey`):
- State `edit: { version: number; keys: string[] } | null` (null = the plan's), its `version` set from `detail.version` on the first change and sent on save (`keys` below means `edit?.keys ?? the plan's`). If a re-read plan has a different scene count, drop `edit` and say "The plan changed: pick the photos again." Moves, Change photo and Save are disabled while `chatBusy`. One `<ol>` slot per scene: photo (alt = scene `shot`; a key picked in this session shows the picked `LibraryPhoto.url` until saved), "Scene N", the shot, the stand-in line on slot i when `keys[i]` is one of the plan's stand-in photos (`new Set(plan.scenes.filter(s => s.standIn).map(s => s.photoKey))`: the server's flag follows the photo, `carryStandIns` plan.ts:114; only a different photo clears it), **Change photo** (opens the picker with `selectedKey`, `canUpload = canCreate`, title "Photo for scene N"), **Move earlier** / **Move later** (disabled at the ends).
- After a move: focus goes to the moved slot's same button (or its other button when that one becomes disabled), and a polite live region says "Photo moved to scene 2 of 4." Keep a `Map<key, url>` of picked photos for display only.
- **Save photos** (primary, enabled only when `keys` differs from the plan): `save(edit.version, { ...plan, scenes: plan.scenes.map((s, i) => ({ ...s, photoKey: edit.keys[i] })) })`; success → `edit = null`; failure keeps it (after a 409 the person saves again, and the edit takes the re-read version).
- Locked or `!canCreate`: photos only, no buttons.

- [ ] **Step 1: Update the tests, then implement.**
- [ ] **Step 2: Run** web typecheck, lint, test, build → PASS (check the picker is not in the reel page's first-load chunk).
- [ ] **Step 3: Commit.**

---

### Task 7: Script & voice step

**Repo:** web.

**Files:**
- Create: `components/reels/script-step.tsx` (owns the Voices sheet, record dialog and clone dialog: lazy, mounted on first open; the reel page gains only the step line)
- Create: `components/reels/use-sample.ts`
- Create: `components/reels/voice-row.tsx`
- Modify: `components/reels/reel.ts` (`BUILT_STEPS = ["plan", "presenter", "photos", "script", "storyboard"]`; `stepState("script")`: no plan "None", else "Done"; update the stale comment at :8)
- Modify: `components/reels/reel-page.tsx`
- Modify: `tests/reels.test.ts` (`BUILT_STEPS`, `stepState("script")`)

**Interfaces:**
- Consumes: `sceneProblems`, `sceneCount`, `editLock`, `GENDER_LABELS` (Task 2); the page's `save`, `useVoices` (Task 3).
- Produces:
  - `useSample(): { playing: string | null; toggle: (id: string, url: string) => void; stop: () => void }` — backed by **one module-level `Audio`** with a small subscribe list, so the script row, the sheet and any later caller share it; a new id stops the old one; plays only `https:` or `blob:` links; ends or errors set `playing` null; `stop` also `removeAttribute("src")` and `load()`; the last unmount stops it.
  - `VoiceRow({ name, detail, sampleUrl, playing, onToggle, action })` — name, the detail line, **Play sample, <name>** / **Stop sample** (`aria-pressed`), and an `action` slot.
  - `ScriptStep({ workspaceId, brandId, detail, canCreate, save, chatBusy })`, wrapped in `memo`.

Behaviour (spec §5.3 Script & voice, phone `script.tsx`):
- **Voice row** (top): "Voice: <name>" (the list's name, else `plan.voiceName`, else "…"), detail = `GENDER_LABELS`, "From the ElevenLabs library" for `library:` ids, or in red "This reel's voice isn't available any more. Pick another." when not found; **Change voice** opens the Voices sheet (Task 8).
- One `Textarea` per scene (`maxLength` `VOICE_TEXT_MAX`, label "Scene N voiceover"), under it `sceneCount(text)` and the scene's problem (`aria-describedby`). A recorded scene shows "Recorded · 5.8 s" (no playback: the server keeps no playable link to a take), **Record again**, **Remove**, and "Editing this text drops its recording." Unrecorded: "Uses the voice above" and **Record** (opens the record dialog, Task 9).
- Edits are `{ version, texts }`, `version` set from `detail.version` on the first change (as Photos). `sceneProblems` gets `recorded[i] = !!scene.recordingId && text.trim() === scene.voiceText` (an edited recorded scene loses its take, so the 30-word rule applies). Editing, Save, Record and Remove are disabled while `chatBusy`.
- **Save script** (primary; enabled when edited and no problems; the first problem is the disabled reason, shown as text): `save(edit.version, { ...plan, scenes: … voiceText: text.trim() })` (the server stores a take's text trimmed and keeps the take only on an exact match, `recordings.ts:133`; the phone trims too); result `droppedRecordings` → one line per scene, the phone's `script.recordingDropped`. Record and Remove are disabled while the script has unsaved edits, with "Save your script changes before recording."
- **Remove** (a take): `save(version, scene with recordingId and recordingSeconds undefined)`.
- Locked or `!canCreate`: text only.

- [ ] **Step 1: Update the tests, then implement.**
- [ ] **Step 2: Run** web typecheck, lint, test, build → PASS.
- [ ] **Step 3: Commit.**

---

### Task 8: Voices sheet

**Repo:** web.

**Files:**
- Create: `components/reels/voices-sheet.tsx` (lazy from `ScriptStep`; mounted on first open and kept mounted)
- Modify: `components/reels/script-step.tsx`

**Interfaces:**
- Consumes: `useVoices`, the page's `save` (Task 3); `useSample`, `VoiceRow` (Task 7); `voicesApi.library|rename|remove` (Task 3); `libraryQuery`, `mergeLibraryPage`, `canManageClone`, `languageName`, `LIBRARY_LABELS`, `LIBRARY_TITLES` (Task 2); `LIBRARY_FILTERS` (Task 1); `ConfirmDialog`, `selectClass`.
- Produces: `VoicesSheet({ workspaceId, brandId, detail, save, open, onOpenChange, onClone: () => void })`.

Behaviour (spec §5.3 Voices sheet, phone `voices.tsx`):
- `Sheet` on the right (full screen below `md`), title "Voices", intro `voices.intro`. `SegmentedRadios`: "Our voices", "Voice library", and "Clone a voice" only when `cloning.allowed`. Starts on the library when the plan's voice starts with `library:`.
- **Choosing a voice**: a radio change only sets a local choice (native radios fire `change` per arrow key). **Use this voice** (primary, shown when the choice differs from the plan) saves once — `save(version, { ...plan, voice: id, voiceName: name.slice(0, 80) })` (`plan.ts:37` caps it; library names aren't checked) — then closes the sheet, as the phone does. Failure keeps the sheet open with the error.
- **Our voices**: a radio group (native radios, one tab stop) of the list, each with `VoiceRow` and its sample. Clones the person can manage (`canManageClone`) have **Rename** (a small dialog, `Input` max `NAME_MAX`) and **Delete**; their own clones also **Withdraw consent and delete**. Delete and withdraw confirm in `ConfirmDialog` (`voices.confirmDeleteTitle` / `confirmWithdrawTitle`, body `voices.confirmBody`), then `voicesApi.remove` and `reload`.
- **Voice library**: the first read starts only when the tab is shown. Search `Input` (submit on Enter), four `<select>`s (`selectClass`; language names from `languageName`; default = the plan's base language when it is in `LIBRARY_FILTERS.language`, else "Any"), **Clear** when narrowed. A select change waits 300 ms before requesting; each request starts page 0 and aborts the one in flight (`AbortController`); **More voices** loads the next page with `mergeLibraryPage`; an answer for older filters is dropped; an `AbortError` (rethrown as is by `send`/`request`) is swallowed, never shown. Results stay in the sheet's state across tab switches. `usable: false` → `voices.libraryNotYet`. Empty → `voices.libraryNone`. Rows are radios like Our voices.
- **Clone a voice** tab: "N of M used" (`clones / cloning.max`), `voices.cloneFull` at the cap, and **Clone a voice · N credits** → `onClone()`.
- Closing the sheet stops any sample.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Run** web typecheck, lint, test, build → PASS.
- [ ] **Step 3: Commit.**

---

### Task 9: AudioRecorder, scene takes (record or upload), and Clone a voice

**Repo:** web. Two commits (recorder + takes; clone).

**Files:**
- Create: `components/ui/audio-recorder.tsx`
- Create: `components/reels/record-dialog.tsx` (lazy; rendered only while a scene is chosen, so it unmounts on close)
- Create: `components/reels/clone-dialog.tsx` (lazy; the only importer of `CLONE_PASSAGES`)
- Modify: `components/reels/script-step.tsx` (open the record dialog per scene and the clone dialog from the sheet; hold the last challenge `{ lang, challenge, at }` so reopening the clone dialog reuses it)

**Interfaces:**
- Consumes: `pickFormat`, `RECORDER_TYPES`, `NO_FORMAT`, `micProblem`, `fileProblem` (Task 2), `clock` (`lib/time.ts`); `cloneRetry`, `readingLanguage`, `languageName` (Task 2); `reelsApi.recording`, `voicesApi.challenge|clone` (Task 3); the page's `save`; `usePaidPress` (Task 4) with `reread: reload` (voices).
- Produces:
  - `AudioRecorder({ maxSeconds: number; minSeconds?: number; disabled?: boolean; notice: ReactNode; onTake: (blob: Blob, seconds: number) => void; onStart?: () => void; label: string })`.
  - `RecordDialog({ workspaceId, brandId, detail, scene, save, onClose })`.
  - `CloneDialog({ workspaceId, brandId, cloning: CloningInfo, open, onOpenChange, onCloned: () => void, challengeCache })`.

**AudioRecorder** (spec §5.6, §5.9):
- Shows `notice` before the first `getUserMedia` (record dialog: "Your browser will ask to use the microphone. The recording is sent to us only to check it and make your voiceover."; clone dialog: its own line). No `navigator.mediaDevices` → `micProblem(…, false)`. `pickFormat(MediaRecorder.isTypeSupported)` null → `NO_FORMAT`.
- `getUserMedia({ audio: { deviceId, channelCount: 1 } })`; once allowed, a **Microphone** `<select>` (`selectClass`) from `enumerateDevices()` (audioinput). `new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 })`; `recorder.start()` with no timeslice; the take is built only in `onstop` (one place, so a manual stop and the auto-stop at `maxSeconds` can't send twice).
- **Microphone lifecycle** (must hold, Review Focus 6):
  - An `alive` ref and a request counter: a stream that resolves after unmount, or for a stale request, has its tracks stopped at once.
  - A device change stops the old stream before opening the new one.
  - `new MediaRecorder` throwing stops the stream's tracks.
  - On unmount: set `cancelled`, detach `ondataavailable` and `onstop` (or `onstop` checks `cancelled` and sends nothing), stop the recorder and every track, clear the clock interval and the auto-stop timeout.
  - Tracks stop when recording stops.
- One toggle button **Start recording** / **Stop recording** (`aria-pressed`); "Recording, 0:07 of 0:15" (`clock`; the 1 s clock state lives inside the recorder). With `minSeconds`, Stop is disabled before it with "Keep reading: at least 60 seconds". Announced once each in a polite live region: "Recording started", "10 seconds left", "Stopped". Errors in `role=alert` via `micProblem`. `disabled` turns off Start.

**RecordDialog** (scene take):
- Title "Record scene N", the scene's text under "Read this", the `AudioRecorder` (`maxSeconds` `MAX_RECORDING_SECONDS`), and below it a visible-label file input "Or upload an audio file, up to 15 seconds" (`accept=".m4a,.mp4,.webm,audio/mp4,audio/x-m4a,audio/webm"`); `fileProblem(file, MAX_RECORDING_BYTES)` refuses before upload. The file input shows even when the microphone failed.
- A take or a file → `reelsApi.recording(…, text, plan.language)` with `text` exactly the saved `plan.scenes[i].voiceText`; while it runs "Checking what we heard…" (live region) and Start recording and the file input are disabled; 413/400/429 show the server's sentence.
- Result: "We heard" / "We heard something different", the transcript (or `record.nothingHeard`), **Play take** (an object URL of the sent blob, revoked on new take and in an effect cleanup, which covers close, Esc and unmount). **Use this recording** (matches) → `save` with `recordingId`; **Keep it** (differs, transcript not empty) → also `voiceText: transcript`, with `record.keepNote`; **Record again** clears the take.
- After saving: `droppedRecordings` includes the scene or the saved plan has no `recordingId` there → "The plan changed while you recorded. Record scene N again." Else close.

**CloneDialog** (spec §5.6 Clone, phone `clone.tsx`; `voices.manage` only):
- **Reading language** `<select>` over `Object.keys(CLONE_PASSAGES)` named with `languageName`, default `readingLanguage(navigator.languages, keys)`. The challenge is read on open and after the language has stayed unchanged for 400 ms (older request aborted), and not re-read while the cached challenge for that language is unused and under 10 minutes old. The select is disabled while a take exists (changing it would pair the reading with a new challenge, a 422). Challenges live 10 minutes (`CHALLENGE_TTL_MS`): on **Start recording**, a challenge over 5 minutes old is read again first. The sentences show as one passage under "Read this".
- **Voice name** (`Input`, `NAME_MAX`, required).
- Consent: the server's `consent` text verbatim in a block with an id, then a native checkbox labelled "I agree" with `aria-describedby` = the text's id and a line "Consent version <consentVersion>". Never reworded. 409 `clone.consentChanged` → reload voices (new text), untick, show the server's sentence.
- `AudioRecorder` with `minSeconds` `cloning.seconds.min`, `maxSeconds` `cloning.seconds.max`. Each finished take gets a new `requestId()`; recording again over a finished take asks first ("Record again?" / "Your reading so far is replaced.", the phone's `clone.replace*`) in an inline confirm. **Play the reading back** (spec §5.6) uses an object URL revoked on new take, success, close and unmount.
- **Create the voice · N credits** (primary; `usePaidPress`; `withPrice`): enabled with a take, a name, the tick and a challenge. Size over `MAX_CLONE_BYTES` → "That recording is too large." without sending. Send `voicesApi.clone(…, take.requestId)` with `consentVersion`.
  - Success (200 or 201) → `reload()`; close and `onCloned()` only once the list has the returned id, else stay open with "Still being made…" and re-read (the press stays off).
  - Error: `cloneRetry(e) === "same-take"` keeps the take and id (the press can be repeated; `clone.stillMaking` shows its sentence); `"new-take"` drops the take and reads a new challenge. 410/422 show the server's sentence; 402 → the paywall (via `request()`), with `pressErrorText`.
- No file input in this dialog (security A1).

- [ ] **Step 1: Implement** `AudioRecorder` and `RecordDialog`; run web typecheck, lint, test, build → PASS; commit.
- [ ] **Step 2: Implement** `CloneDialog`; run the same (confirm `CLONE_PASSAGES` is only in the clone dialog's chunk) → PASS; commit.

---

### Task 10: Handover, design system, audit

**Repo:** server only (`docs/HANDOVER.md`, `docs/DESIGN_SYSTEM.md`).

**Files:**
- Modify: `docs/HANDOVER.md` (a "Feature 3b" section like 3a's: what was built, copy the builder wrote, owner checks, not checked live, limits)
- Modify: `docs/DESIGN_SYSTEM.md` §7 component table (rows for `AudioRecorder` and `VoiceRow`)

Owner checks to list (from spec §11, the ones 3b owns): record a take in Chrome, Firefox and Safari (accepted); upload an M4A and a WebM (accepted), an Ogg or MP3 (the server's 400), a 20 s file ("Keep it under 15 seconds."); clone consent text matches the server's and has no upload; a 402 opens the paywall (presenter, preview, clone); keyboard through every radio group, the recorder, the photo moves; arrowing through voices saves nothing until Use this voice; 375 px no horizontal scroll on each new step; mic denied, then "Upload a file instead" still works; close the record dialog during the permission prompt and mid-recording: the mic indicator goes off and no take is sent; a take on a web-made reel works (Task 1).
Limits to list: ElevenLabs sample and library preview links (`storage.googleapis.com`, ElevenLabs) are outside the report-only CSP `media-src`; enforcing it needs those origins added. No `Permissions-Policy` header today; if one is added it must allow `microphone=(self)`. A take's audio can't be played back after the dialog closes (the server keeps no playable link). Clone challenges are capped at 20 an hour per person. "More voices" can render up to 50 pages with no virtual list. The photoshoot studio still has its own press code; it could adopt `usePaidPress`. Presenter, preview and clone stay unchecked live (no provider credits).

- [ ] **Step 1: Write** both docs.
- [ ] **Step 2: Commit** in server.

---

## Self-review notes

- Spec §7 3b coverage: S9 → Task 1; Presenter step and Make a presenter → Tasks 4, 5; template Preview → Task 4; Photos → Task 6; Script & voice → Task 7; Voices sheet with library → Task 8; `AudioRecorder`, scene takes recorded or uploaded, Clone → Task 9; three paid buttons with §5.4 → Paid press rules + Tasks 4, 9.
- Not in 3b (3c): Make video, Video, Review, Publish, S2–S4, S7, S8.
- Deviations, one line each: the spec's "Play take" on a saved scene is not built (no playable link on the server; the dialog plays the take it just sent). The FAILED presenter line uses the spec's "Didn't work · N credits back", not the phone's "You weren't charged". Voice picks save on **Use this voice**, not on the radio change (web radios fire per arrow key). Server additions beyond S9 (all additive, old phone builds unaffected): `reel.changed` code, `clone.stillMaking`, optional `consentVersion`, scope-keyed recording bucket, https-only library previews.
