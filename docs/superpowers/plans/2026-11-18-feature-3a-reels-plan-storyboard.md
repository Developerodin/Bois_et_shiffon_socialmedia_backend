# Feature 3a · Reels on the web: plan and storyboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person can plan a reel (prompt, idea or template) and revise it in a streamed chat on the website, see its storyboard read-only, and make the video on the phone; the server stops two plan turns from running at once on one reel and lets a dropped stream be recovered by request id.

**Architecture:** Server: the reel types, limits and the "which reply answers this request" rule move to `shared/reels.ts` (synced to web and mobile); `chatPlan` checks the reel's brand first, then takes a lock and a `requestId` like `createReel`, both claim before counting, and a stream whose reader left keeps running. Web: pure helpers (`components/reels/reel.ts`), a recovery core with no React (`plan-stream.ts`), `useJob`-based hooks on a shared link cache and the generic presser (both lifted from photoshoot, photoshoot unchanged), then `/reels` and `/reels/[id]` (Plan and Storyboard steps only). The global assistant panel undocks on `/reels/*` (owner, Q1).

**Tech Stack:** Next.js 15.5 / React 19.1, Tailwind 4, vitest (node, no jsdom). Server: Next.js route handlers, zod, Prisma, vitest.

**Spec:** server repo `docs/superpowers/specs/2026-11-18-feature-3-reels-design.md` (approved 2026-11-18, owner answers in §9). This plan is slice **3a** (§7). Parent: `docs/superpowers/specs/2026-11-17-foundations-design.md`. Model plan: `docs/superpowers/plans/2026-11-18-feature-2-photoshoot.md`.
**Phone source of truth (mobile repo):** `src/app/reels/{index,chat,ideas,templates,storyboard}.tsx`, `src/api/endpoints.ts:205-262` (types), copy in `src/i18n/locales/en/reels.json`.

**Plan lenses (2026-11-18):** correctness, security, performance and maintainability ran on the first draft; findings and evidence in the server ledger `.superpowers/sdd/2026-11-18-feature-3a-reels-plan-storyboard/lens-*.md`. All are folded in below; finding ids are cited in brackets (e.g. [C-I1] correctness Important 1, [S-I1] security, [P1] performance, [M-C1] maintainability Critical 1). **Spec deviation, approved by the owner 2026-11-18:** the plan markers expire after 150 s, not 6 minutes (§ Task 2, [S-M3]).

## Reuse map (don't rebuild)

| Need | Already there |
|---|---|
| Streamed call, 402 → paywall, error text | `request()` with `onLine` + `timeoutMs`, `ApiError`, `errorMessage` (`components/settings/api.ts`). A body that breaks off is `ApiError(0)`; so is an offline write that was never sent (`lib/net.ts:47`) |
| Request id, long timeout, offline | `requestId()`, `SLOW_MS` (120 s), `isOffline()`, `NET_MESSAGE` (`lib/net.ts`) |
| Keep an id while the outcome is unknown | `makePresser` + `shouldKeepRequestId` (`components/photoshoot/press.ts`, `shared/photoshoot.ts`): Task 4 lifts the core to `lib/presser.ts` |
| Polling + shared cache | `useJob` (`stopOn`, `status`, `done`), `fetchShared`, `putShared`, `sharedAt`, `JOB_INTERVALS.reelRender` (`components/workspace/use-job.ts`) |
| Signed links kept across polls | `shown` map + `steady` + `linksAt` + `useRereadWhenStale` (`components/photoshoot/use-shoots.ts`), `linksFetchedAt` (`components/photoshoot/shoot.ts`): Task 4 lifts them to `lib/signed-links.ts` + `components/workspace/use-steady-links.ts` |
| Gate (flag, business, brand.read) | `components/photoshoot/access.tsx`: Task 6a lifts it to `components/shell/feature-access.tsx`; nav entry `/reels` exists (`lib/nav.ts:28`) |
| Has a plan | `usePlan(workspaceId)` → `{ loaded, planned }` (`components/shell/use-plan-credits.ts`); `openPaywall` (`lib/paywall.ts`) |
| Page parts | `PageHeader`, `PageSection`, `PageSkeleton`, `EmptyState`, `StatusBadge`, `SegmentedRadios`, `ChoiceCards`, `Dialog`, `Sheet`, `Button`, `Textarea` (`components/ui/*`) |
| Ideas | `GET …/brands/{b}/opportunities` → `{ opportunities }`, web type `Opportunity` (`components/workspace/content-panels.tsx:21`). Read once with `useJob` at the same URL (shares the cache), **not** `useBrandData` (that polls every 6 s for ever) [P3, M-I6] |
| Product titles for starters | `useBrandLook(w, b).view?.assets?.products.map(p => p.title)` (`components/library/use-brand-look.ts`; stops polling when fresh) [M-I6] |
| Marker for one-at-a-time | `claimTransient` / `dropTransient` (`server/db/transient.ts`), as `createReel` uses |
| Lazy client part | `dynamic(() => import(…), { ssr: false })`, as `setup-parts.tsx:15` [P4] |

## Global Constraints

- Repos side by side: `C:\Users\INTEL\Desktop\Social Media Agent\apps\{server,web,mobile}`. Branch `feature-3a-reels` exists in all three (from `main`). Commit only in the repo the task names.
- Run npm inside the repo with `--prefix .`. Windows, Git Bash.
- Every task leaves its repo green: server `npm run typecheck|lint|test --prefix .`; web `npm run typecheck|lint|test --prefix .` (typecheck runs `check-shared`); mobile `npm run typecheck --prefix .`.
- Shared code: edit `shared/` in the server only, then `npm run sync:shared --prefix .` (server) and commit the copies in web and mobile. Never hand-edit `web/shared` or `mobile/src/shared`.
- Old phone builds see no change except S5's one race (a message sent while another device's message on the same reel is still being written gets 409 `reel.stillPlanning` at once).
- No new dependencies. Web tests unit-test pure logic only; components are checked by build, `scripts/audit-ui.ts` and the owner.
- Copy is the phone's English (`reels.json`), copied by hand; desktop-only labels follow its tone. The web is English only and sends `language: "en"`. Never show provider error text.
- `DESIGN_SYSTEM.md`: one primary button per view (Plan on `/reels`; Send in the Plan step), cards `rounded-2xl border border-border bg-card shadow-sm`, inputs `rounded-xl`, buttons pill, `focus-visible:ring-2 ring-ring`, icons `aria-hidden` beside text.
- Commit messages: the change and why. No co-author lines, no tool or session URLs, no mention of tests.
- Don't call paid providers; don't touch port 3100's running process. Planning calls OpenAI (not paid per credit); an unlimited test workspace may plan live.
- Slice scope: no Make video, no Presenter / Photos / Script & voice / Video / Review / Publish steps, no paid buttons (3b, 3c).
- `scripts/check-bundle.mjs` only scans the build for secrets and Prisma; it measures no size. Size is checked by reading the build table [P4].

## Review Focus

1. **A revise or create resent after a dropped stream with the same `requestId`** must never add a second turn, make a second reel or run the scriptwriter twice, including a repeat that claims just after the first run finished. → Task 2 `a repeat request id returns the saved turn`, `a repeat that claims after the first finished returns the saved turn`; Task 5 `resend reuses the id`, `late keeps the id`, `same create body after late → same id`.
2. **A second tab or a phone sending while a turn is being written** gets 409 `reel.stillPlanning` with nothing counted against the 20 an hour; the web waits for the other reply, then shows it **without** claiming it as the person's own (their text stays). → Task 2 `a second message while one is planning counts nothing`; Task 5 `stillPlanning resolves other when the version moves without our id`.
3. **Another brand's reel id** is refused (404) before any marker, count or repeat lookup; no 409-vs-404 oracle. → Task 2 `another brand's reel is refused before any marker`.
4. **Switching business or leaving while a create streams or recovers** must not open the old brand's reel or keep polling it. → Pages remount on `key={brandId}`; recovery stops when `alive()` is false (Task 5 `recovery stops when alive turns false`); URLs carry `&b=`.
5. **A chat at its 40-turn cap** still finds the just-sent turn by id (the newest turns are kept). → Task 1 `answeredTurn finds the id at the end of a 40-turn chat`. Ceiling, written in a comment: a repeat whose turn has been trimmed runs again.
6. **A reel that can't be read** (unknown id, another brand's, `plan: null`) shows "Couldn't load this reel" with a link to Reels or the Plan step, never a polling loop; a phone-made reel (cuid id) opens. → Task 4 `isReelId` cuid + UUID, `defaultStep(null plan) is plan`; Task 7 uses `stopOn: [403, 404]`.

---

### Task 1: Shared reels contract (server → web, mobile copies)

**Files (server):** create `shared/reels.ts`; modify `shared/index.ts`; point the server's literals at the shared constants [M-I8]:
- `server/reels/router.ts`: `export { SCENE_KINDS, TRANSITIONS, type SceneKind, type Transition } from "@/shared"` (keeps its public names, so `agents.ts`, `plan.ts` and other importers are untouched);
- `server/reels/plan.ts`: `MAX_SCENE_WORDS`, `.max(VOICE_TEXT_MAX)`, `.min(REEL_SCENES.min).max(REEL_SCENES.max)`, plus the type checks below;
- `app/…/reels/route.ts` and `app/…/reels/[contentId]/plan/route.ts`: `.max(CHAT_MESSAGE_MAX)`; `server/reels/service.ts:176` `turn.slice(0, CHAT_MESSAGE_MAX)`;
- `server/reels/presenters.ts:41` and `app/…/voices/clones/[voiceId]/route.ts:14`: `.max(NAME_MAX)`;
- `server/reels/recordings.ts`, `server/reels/clones.ts`: take the caps from `@/shared` and keep re-exporting them (`export { MAX_RECORDING_BYTES, MAX_RECORDING_SECONDS } from "@/shared"`), so the two upload routes are untouched [C-M5];
- `server/reels/service.ts`, `server/reels/agents.ts`: `PlanEvent`, `DraftSoFar`, `ChatTurn` from shared.

Test `tests/reel-contract.test.ts`. **Mobile:** `src/api/endpoints.ts` uses the shared reel types (form below), three mirror comments, synced `src/shared/**`. **Web:** synced `shared/**`.

**Interfaces — Produces (`@/shared`):**
```ts
export const SCENE_KINDS = ["detail", "room", "physics"] as const;
export const TRANSITIONS = ["cut", "match", "dissolve"] as const;
export type SceneKind = (typeof SCENE_KINDS)[number]; export type Transition = (typeof TRANSITIONS)[number];
// mirrors mobile src/app/reels/storyboard.tsx MODEL_NAMES; keys must equal server router.ts VIDEO_MODELS (tested)
export const VIDEO_MODEL_NAMES: Readonly<Record<string, string>> = { "kling-3-std": "Kling 3.0", "seedance-2.5": "Seedance 2.5", "hailuo-2.3": "Hailuo 2.3" };
export const REEL_SCENES = { min: 2, max: 6 } as const;
export const MAX_SCENE_WORDS = 30; export const VOICE_TEXT_MAX = 400; export const CHAT_MESSAGE_MAX = 2000; export const NAME_MAX = 40;
export const MAX_RECORDING_SECONDS = 15; export const MAX_RECORDING_BYTES = 1024 * 1024; export const MAX_CLONE_BYTES = 4 * 1024 * 1024;
export const REEL_DURATION_CHIPS = [20, 30] as const;
// All 11 DB values [M-M1]; the phone's narrower union is assignable to it.
export type ContentStatus = "PLANNED" | "BRIEF_READY" | "DRAFT_REVIEW" | "REVIEWED" | "AWAITING_APPROVAL" | "APPROVED" | "SCHEDULED" | "PUBLISHED" | "REJECTED" | "BLOCKED" | "CANCELLED";
// Types copied from mobile endpoints.ts:205-262 unchanged, except ChatTurn gains `requestId?: string`:
export type { ReelScene, ReelPlan, ReelTemplateOption, TemplatePreview, ReelVoiceOption, LibraryVoice, LibraryFilters, CloningInfo, Presenter,
  PresenterTrait, ReelOptions, RenderStep, RenderFailure, ReelSummary, ChatTurn, CheckResult, ReelDetail, PlanResult, PlanStage, DraftSoFar, PlanEvent };
export type ReelStage = "draft" | "processing" | "ready" | "failed";
export function reelStage(r: Pick<ReelSummary, "render" | "videoUrl">): ReelStage;   // mirrors mobile src/app/reels/index.tsx statusOf (+ "failed")
export const REEL_SENDABLE: readonly ContentStatus[] = ["AWAITING_APPROVAL", "APPROVED", "SCHEDULED", "PUBLISHED"];   // mirrors mobile review.tsx
export const REEL_SCHEDULABLE: readonly ContentStatus[] = ["AWAITING_APPROVAL", "APPROVED"];
export function isReelIdea(o: { channels: readonly string[]; decision: string }): boolean;
/** The assistant's reply to the person's turn sent with `requestId`, or null (not in the chat, or no reply after it yet). One rule for server and web [C-M7, M-I1]. */
export function answeredTurn(chat: readonly ChatTurn[], requestId: string): string | null;
```
- `reelStage`: render step VOICE/CLIPS/JOIN → "processing"; else a `videoUrl` → "ready"; else render step FAILED → "failed"; else "draft".
- `isReelIdea`: `channels.includes("INSTAGRAM_REEL") && decision !== "REJECT"`.
- `answeredTurn`: find the user turn with that `requestId`; the reply is the next turn **only if** it is an assistant turn (two user turns then a reply → null for the first). Comment: `// ponytail: the chat keeps its last 40 turns; a repeat whose turn was trimmed runs again.`
- Server `plan.ts`: keep the zod `ReelPlan`. Type checks both ways [M-I9]: `const _fits = (p: z.infer<typeof ReelPlan>): SharedReelPlan => p;` and, in the test file, `expectTypeOf<Omit<Z["scenes"][number], "model">>().toEqualTypeOf<Omit<SharedReelPlan["scenes"][number], "model">>()` and `expectTypeOf<Omit<Z, "scenes">>().toEqualTypeOf<Omit<SharedReelPlan, "scenes">>()`. `model` is the only permitted difference (the server's is an enum of its ids, the shared one a `string`, as the phone has it). Also `const _all = (s: import("@prisma/client").ContentStatus): ContentStatus => s;`.
- No `Opportunity` type in shared; `isReelIdea` is structural. No `isReelId` in shared (it's a web URL guard).
- Mobile [C-M5, M-M2]: replace the declarations at `endpoints.ts:205-262` with `import type { ReelScene, … } from "@/shared"; export type { ReelScene, … };` (the form used for `Shoot` at lines 6 and 460). Keep `Opportunity`, `Connection` and `reelSeconds` where they are. Before widening `ContentStatus`, grep the phone for exhaustive `switch`es on it. Add `// shared/reels.ts has the same rule` at `src/app/reels/index.tsx` (statusOf), `review.tsx` (the two status lists) and `storyboard.tsx` (MODEL_NAMES) [M-M4].

- [ ] **Step 1: Failing test** `tests/reel-contract.test.ts`: `reelStage` for render null + no video → draft; step CLIPS → processing (even with a video); DONE + video → ready; FAILED + no video → failed; FAILED + an older video → ready. `isReelIdea` true for `["INSTAGRAM_REEL"]`/RECOMMEND, false for REJECT and for `["INSTAGRAM_POST"]`. `REEL_SENDABLE`/`REEL_SCHEDULABLE` equal the phone's lists. `Object.keys(VIDEO_MODEL_NAMES)` equals `Object.keys(VIDEO_MODELS)` (router.ts). `answeredTurn`: id followed by an assistant turn → its text; id as the last turn → null; unknown id → null; two user turns then the reply → null for the first id; the id at the end of a 40-turn chat with its reply → the text. The two `expectTypeOf` checks.
- [ ] **Step 2:** `npm test --prefix . -- tests/reel-contract.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Write `shared/reels.ts`, export from `shared/index.ts` (check no name clash with `photoshoot.ts`, which owns `MODEL_NAMES` and `SCENES`); point the server constants and types at it as listed; `npm run sync:shared --prefix .`.
- [ ] **Step 4:** Server typecheck, lint, test green. Mobile changes as above; `npm run typecheck --prefix .` green. Web typecheck green.
- [ ] **Step 5:** Commit in server, then mobile, then web (synced copies).

### Task 2: One plan turn at a time per reel, and a chat request id (server, S5)

**Files:** modify `server/reels/service.ts` (`createReel`, `chatPlan`, new `onePlanAtATime`), `app/api/v1/workspaces/[workspaceId]/brands/[brandId]/reels/[contentId]/plan/route.ts` (zod `requestId: z.string().uuid().optional()`); test `tests/reel-plan-gate.test.ts`.

**Interfaces — Produces:**
```ts
export function chatPlan(scope, itemId: string, input: { version: number; message?: string; language?: string; templateId?: string; presenterId?: string; requestId?: string }, emit?): Promise<PlanResult>;
/** Claims `marker`, runs `run`, always awaits the drop. A held marker → 409 reel.stillPlanning with `message`. [M-M3] */
async function onePlanAtATime<T>(marker: string, scope: Scope, message: string, run: () => Promise<T>): Promise<T>;
```
`answeredTurn` comes from `@/shared` (Task 1); no local copy.

**Marker expiry: 150 s, for both markers** [S-M3]. `// ponytail: route maxDuration 120 s + 30 s; a run killed before its finally frees the reel after this.` *Spec deviation (§5.0 S5 says 6 minutes), owner approved 2026-11-18: a run the platform kills at 120 s never drops its marker, and 6 minutes would outlast the web's 3-minute recovery.* Fix the stale "330 s budget" comment.

Order in `chatPlan`:
0. **Tenant check first** [S-I1, S-M1, P6]: `prisma.contentItem.findFirst({ where: { id: itemId, workspaceId, brandId, studio: true }, select: { brief: true } })`; null → 404 (the same error `loadReel` throws). Never `findUnique` by id. Nothing claimed or counted yet.
1. With `requestId`: if `answeredTurn(chatOf(brief), requestId)` is a string, `loadReel` and return `{ version: latest.version, plan, price: reelPrice(plan), reply, droppedRecordings: [] }`. No claim, no count, no scriptwriter.
2. `onePlanAtATime(\`reel-chat:${itemId}\`, scope, "This reel is still being planned. Wait for the reply.", async () => { … })`:
   a. `loadReel(scope, itemId)` (the existing body's read; do **not** reuse step 0's read for the scriptwriter).
   b. With `requestId`, **check again** with this read [C-I1]: answered → return the saved turn (the other run committed between step 1 and the claim).
   c. `(latest?.version ?? 0) !== input.version` → the existing 409 "This plan changed in the meantime…" before `planGate` [C-M4] (`savePlan`'s check stays for edits and renders that land during the run).
   d. presenter lookup; `planGate(scope)`; …existing body…; the person's turn saved with `requestId`.
3. `onePlanAtATime`'s `finally` **awaits** `dropTransient(marker).catch(() => {})` [C-I2], so `done` never reaches the client while the marker is still held.

`createReel` with `requestId`: `reelForRequest` → `onePlanAtATime(marker, scope, "This reel is still being planned.", async () => { reelForRequest again (return it if made) [C-I1]; planGate; planReel })`. (Today `planGate` runs before the claim, so a 409 repeat uses up one of the 20 an hour.) Without `requestId`, unchanged.

- [ ] **Step 1: Failing tests** in `tests/reel-plan-gate.test.ts`:
  - `chat: another brand's reel is refused before any marker`: `findFirst` → null; rejects 404; `m.claim`, `m.limit`, `m.requirePlan` not called. Also with a `requestId`: 404, no repeat answer.
  - `chat: a second message while one is planning counts nothing`: `m.claim` → false; `chatPlan(…, { version: 1, message: "x" })` rejects `{ status: 409, code: "reel.stillPlanning" }`; `m.limit`, `m.requirePlan`, `m.write` not called; claim key `reel-chat:i1`, ttl `150_000`.
  - `create: a repeat while planning counts nothing`: `m.claim` → false with a `requestId`; `m.limit` not called.
  - `chat: a repeat request id returns the saved turn`: `findFirst` → `{ id: "i1", brief: { reelChat: [{ role: "user", text: "x", at: "", requestId: RID }, { role: "assistant", text: "Done", at: "" }] }, versions: [{ version: 4, body }] }` (body as the existing finished-request test); result `{ version: 4, reply: "Done", droppedRecordings: [] }`, `plan.title` "Bunting"; `m.claim`, `m.write` not called.
  - `chat: a repeat that claims after the first finished returns the saved turn`: the reads answer without the id first and with `{ user requestId: RID }, { assistant "Done" }` after the claim. Result `reply: "Done"`; `m.limit`, `m.write` not called; `m.drop` called with `reel-chat:i1`.
  - `create: a repeat that claims after the first finished returns the reel`: `findUnique` null, then the reel; `m.limit`, `m.write` not called.
  - `chat: a stale version is refused before the scriptwriter`: latest version 5, input 4 → 409; `m.limit`, `m.write` not called.
  - `chat: drops the marker after a failure`: `m.write` rejects → `m.drop` called with `reel-chat:i1`, and `chatPlan` stays pending until `m.drop` (a deferred promise) resolves.
- [ ] **Step 2:** Run the file → FAIL.
- [ ] **Step 3:** Implement as above; the user turn written by `savePlan` carries `requestId` when sent.
- [ ] **Step 4:** Server typecheck, lint, test green.
- [ ] **Step 5:** Commit (server).

### Task 3: A dropped reader doesn't stop the plan (server, S6)

**Files:** modify `server/reels/service.ts` (`streamPlan`; ceiling comment at `listReels`); test `tests/reel-stream.test.ts` (new).

- `streamPlan`: a `gone` flag set on the first `enqueue` that throws or on the source's `cancel()`. Once set, `send` returns **before** `JSON.stringify` / `encode` [P10]; `controller.close()` is guarded the same way. `run` keeps going and saves.
- `listReels`: `// ponytail: scans the brand's content items (no studio index); add @@index([workspaceId, brandId, studio, createdAt]) if a brand passes a few thousand.` [P9]

- [ ] **Step 1: Failing test** `keeps running and saving after the reader goes away`: `run` emits a stage, awaits a gate, emits again, then calls `saved()`; read one chunk, `reader.cancel()`, open the gate; `await vi.waitFor(() => expect(saved).toHaveBeenCalled())`; the second emit after cancel enqueues nothing (count `enqueue` calls).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Server green. **Step 5:** Commit (server).

### Task 3b: Index-friendly render view (server, S10)

**Files:** modify `server/reels/render.ts` (`renderView(itemId, workspaceId)`), `reelDetail`'s call; test `tests/reel-render.test.ts`.

- `renderView`: the `creditEntry.findMany` where becomes `{ workspaceId, reason: "reel-render", refId: { in: … }, delta: { lte: 0 } }` (matches `@@unique([workspaceId, reason, refId])`).

- [ ] **Step 1: Failing test** `renderView reads charges within the workspace`: `creditEntry.findMany` called with `expect.objectContaining({ where: expect.objectContaining({ workspaceId: "w1", reason: "reel-render" }) })` (add `findMany` mocks to that file's fake db if missing).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Server green. **Step 5:** Commit (server).

### Task 4: Reels logic, API and data hooks (web), on lifted photoshoot helpers

**Files:**
- Lift, photoshoot output unchanged [M-I2, M-I3, C-I6, P5]:
  - move `linksFetchedAt` to `lib/signed-links.ts`; `shoot.ts` keeps `export { linksFetchedAt } from "@/lib/signed-links"`;
  - create `components/workspace/use-steady-links.ts`: `createLinkCache<T>(idOf: (x: T) => string, keep: (prev: T | undefined, next: T, prevAt: number) => T)` → `{ steady(next, fetchedAt): T; linksAt(items: readonly T[]): number }` (the `shown` map, `steady`, `linksAt` from `use-shoots.ts`, generic, same ceiling comment) and `useRereadWhenStale(oldestAt: number | null, reload)`. `use-shoots.ts` becomes the first caller (`createLinkCache<Shoot>(s => s.id, keepLinks)`);
  - create `lib/presser.ts`: `makePresser<R, T>(send: (r: R, requestId: string) => Promise<T>, keyOf: (r: R) => string, newId = requestId)` (the body of photoshoot's, incl. the one `request.idTaken` retry). `components/photoshoot/press.ts` keeps `export const makePresser = (send, newId?) => core(send, shootRequestKey, newId)` and its other exports.
- Create `components/reels/reel.ts` (pure), `components/reels/labels.ts`, `components/reels/api.ts`, `components/reels/use-reels.ts`; modify `components/workspace/use-job.ts` (add `reelList: [[Infinity, 10_000]]` to `JOB_INTERVALS`, additive). Test `tests/reels.test.ts`; `tests/photoshoot.test.ts` must stay green unchanged.

**Interfaces — Produces:**
```ts
// reel.ts
export const REEL_STEPS = ["plan", "presenter", "photos", "script", "storyboard", "video", "review", "publish"] as const;
export type ReelStep = (typeof REEL_STEPS)[number];
export const BUILT_STEPS: readonly ReelStep[] = ["plan", "storyboard"];        // 3b adds presenter, photos, script; 3c adds video, review, publish
export function defaultStep(d: ReelDetail | null): ReelStep;                   // spec §5.3, unclamped [M-I7]
export function reachable(step: ReelStep, d: ReelDetail | null): ReelStep;     // step if built, else storyboard with a plan, else plan
export function stepFrom(param: unknown, d: ReelDetail | null): ReelStep;      // reachable(valid param ?? defaultStep(d), d)
export function stepState(step: ReelStep, d: ReelDetail | null): string;      // rail text
export function durationChips(seconds: number | null): number[];              // REEL_DURATION_CHIPS with |s - d| > 5
export type Starter = { label: string; message: string; opportunityId?: string };
export function starters(ideas: { id: string; title: string }[], productTitles: string[]): Starter[]; // ideas first, max 3; callers pass ideas.filter(isReelIdea) [C-M6]
export function countByStage(reels: ReelSummary[]): { all: number; ready: number; processing: number };
// cuid (phone-made) or UUID (web-made); only keeps path-ish input out of the URL, the server decides existence [M-C1]
export const isReelId = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s);
export function keepReelLinks<T extends ReelSummary | ReelDetail>(prev: T | undefined, next: T, prevAt: number, now?: number): T;
// keeps thumbUrl and videoUrl while id + version (and videoKey) match, and each photoUrls[k] by key, while prev's links are fresh
// labels.ts — phone English
export const STEP_LABELS: Record<ReelStep, string>;  // Plan, Presenter, Photos, Script & voice, Storyboard, Video, Review, Publish
export const STAGE_LABELS: Record<PlanStage, string>; // reading "Reading your brand and photos", writing "Writing the script", directing "Choosing a video model for each scene"
export const JOIN_LABELS: Record<Transition, string>; // storyboard.join.* from reels.json
export const TEMPLATE_LABELS: Record<string, { title: string; subtitle: string }>; // reels.json templates.item.*
export const chipMessage = (s: number) => `Make it about ${s} seconds.`;
export const starterProduct = (p: string) => `A reel about ${p}`;
// api.ts
export const reelsUrl = (w, b) => string;          // /api/v1/workspaces/{w}/brands/{b}/reels
export const reelUrl = (w, b, id) => string;       // encodes id
export const reelOptionsUrl = (w, b) => string;
export const opportunitiesUrl = (w, b) => string;
export const reelsApi = {
  create(w, b, body: { prompt?: string; opportunityId?: string; templateId?: string }, requestId: string, onLine: (l: unknown) => void): Promise<PlanResult & { id: string }>,
  chat(w, b, id, body: { version: number; message?: string; templateId?: string }, requestId: string, onLine: (l: unknown) => void): Promise<PlanResult>,
}; // both: language "en", timeoutMs SLOW_MS, onLine set (NDJSON)
// use-reels.ts — one module link cache per type (createLinkCache), steady() inside a memoised pick, linksAt feeds done and useRereadWhenStale
export function useReels(w, b): { data: ReelSummary[] | null; failed; status; reload };   // reelList while any reelStage is "processing"
export function useReel(w, b, id): { data: ReelDetail | null; failed; status; reload };  // reelRender while a render runs; stopOn [403, 404]
export function useReelOptions(w, b): { data: ReelOptions | null; failed; reload };      // read once: done = () => !stale(sharedAt(url)) [P3]
export function useReelIdeas(w, b): { data: Opportunity[] | null; reload };              // useJob once (done: () => true), filtered by isReelIdea; reload after Use this idea only [P3]
```
- `defaultStep`: plan null → plan; any `standIn` → photos; `renders[0]` running or FAILED → video; `videoUrl` → review; else storyboard.
- `stepState`: plan → "Done" / "None"; storyboard → "None" (no plan) / "Needs a photo" (stand-ins) / "Making…" (render running) / "Done" (video) / "Ready".
- No `needsPlan`: pages use `usePlan(workspaceId)` and `locked = loaded && !planned` [M-I5].

- [ ] **Step 0:** Lift `linksFetchedAt`, `createLinkCache` / `useRereadWhenStale` and the presser core as above; `tests/photoshoot.test.ts` green before and after; commit (web) on its own.
- [ ] **Step 1: Failing tests** `tests/reels.test.ts`: `defaultStep` for null detail, plan null, stand-in → photos, running render → video, FAILED render → video, video → review, plain → storyboard; `reachable` one per branch; `stepFrom("plan")`, `stepFrom("photos")` with a plan → storyboard, `stepFrom(undefined)`; `stepState` cases; `durationChips(22)` → `[30]`, `(null)` → `[20, 30]`, `(30)` → `[20]`; `starters` with 4 ideas → 3 ideas; 1 idea + 3 products → idea + 2 "A reel about …"; `countByStage`; `isReelId` true for a cuid (`"cm1abcdefghijklmnopqrstuv"`) and a UUID, false for `""`, `"../admin"`, `"a/b"`, `undefined`, `["x"]`; `keepReelLinks` fresh-same-key kept (thumb, photo, video), stale replaced, new key / new version replaced; the link cache keeps a link fetched at t0 through a re-read at t0+40 min (recorded `at` stays t0) and reports it stale at t0+50 min [C-I6]; the generic presser with a text key: resend after ApiError(0) reuses the id, success → new id, 400 → new id.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Web typecheck, lint, test green.
- [ ] **Step 5:** Commit (web).

### Task 5: Streamed plan with recovery (web)

**Files:** create `components/reels/plan-stream.ts` (no React), `components/reels/use-reel-stream.ts` (the spec's `useReelStream`, §5.11) [M-M6]; test `tests/reel-plan-stream.test.ts`.

**Interfaces — Produces:**
```ts
// plan-stream.ts
export const RECOVER_EVERY_MS = 3000; export const RECOVER_CAP_MS = 180_000;
export type Deps = { sleep: (ms: number) => Promise<void>; now: () => number; alive: () => boolean };  // [C-M2, P1]
export const TOO_LONG = "The reply is taking too long. Check back in a moment.";
/** Thrown when the page left mid-recovery; the hook ignores it. */
export class Gone extends Error {}
/** Create: on ApiError(0) or 409 reel.stillPlanning, polls get() (GET /reels/{requestId}); 404 or status 0 = not yet. At the cap throws ApiError(0, TOO_LONG). */
export function createWithRecovery(send: () => Promise<{ id: string }>, get: () => Promise<ReelDetail>, deps: Deps): Promise<{ id: string }>;
export type ReviseOutcome =
  | { kind: "done"; result: PlanResult }       // the stream finished
  | { kind: "answered"; detail: ReelDetail }   // our requestId has its reply
  | { kind: "other"; detail: ReelDetail };     // the version moved without our turn: ours didn't run  [C-I3]
/** Revise: on ApiError(0), polls until answeredTurn(chat, id) → answered, else version > sentVersion → other. On stillPlanning, the same (answered checked first). 403/404 from get end it with that error; only status 0 is "not yet" [C-M8]. At the cap throws ApiError(0, TOO_LONG). */
export function reviseWithRecovery(send: () => Promise<PlanResult>, get: () => Promise<ReelDetail>, requestId: string, sentVersion: number, deps: Deps): Promise<ReviseOutcome>;
// use-reel-stream.ts
export function useReelStream(w: string, b: string): {
  stage: PlanStage | null; draft: DraftSoFar | null; sending: boolean; error: string | null;
  create(body: { prompt?: string; opportunityId?: string; templateId?: string }): Promise<string | null>;  // the reel id, or null
  revise(id: string, version: number, body: { message?: string; templateId?: string }): Promise<boolean>;
};
```
- Both loops check `alive()` before each `get` and throw `Gone` when false. Recovery `get` for revise goes through `fetchShared(reelUrl(…), true)` so it joins an in-flight read and feeds `useReel` [P1].
- **Ids** [C-I4, C-I5, M-I3]: one presser (`lib/presser.ts`) per mount for creates, keyed `JSON.stringify({ prompt, opportunityId, templateId })`, and one per `(w, b, reelId)` for revises, keyed `message ?? \`template:${templateId}\`` [C-M6]. The presser's `send` runs the whole send + recovery, so the id is settled once, on the final outcome: success clears it; `TOO_LONG` (status 0) keeps it; a 4xx refusal clears it. For revise, `done` and `answered` are success; `other` → `putShared(reelUrl, detail)` then throw `ApiError(0, "This reel changed while yours was waiting. Your text is still here; send again.")`, which keeps the id (ours was never stored, so the resend runs).
- `useReelStream`: one send at a time (ref guard). **Offline first** [C-M1]: `isOffline()` → `NET_MESSAGE.offline`, keep the text, no id, no recovery. `onLine` writes `stage`/`draft` to a ref and flushes to state at most once per animation frame, always on a stage change and at the end [P2]. On `done`, `fetchShared(reelUrl, true)`; on `answered`/`other`, `putShared(reelUrl, detail)` directly [P8]. `Gone` and results after unmount are dropped (alive ref).
- Messages: `TOO_LONG` as is; any 409 other than `reel.stillPlanning` and `request.idTaken` → reload the reel, keep the text, show the server's sentence, adding "Your text is still here; send again." only for "changed in the meantime" [C-M3]; 429 and others → `errorMessage`; a 402 says nothing (the paywall opened).
- Comment: `// ponytail: recovery ends when the page unmounts; the plan still lands and shows next time.`

- [ ] **Step 1: Failing tests** `tests/reel-plan-stream.test.ts` (fake `sleep`/`now` advancing a counter, `alive` true unless set):
  - `create recovers by id after a dropped stream`: send rejects `ApiError(0)`; get rejects `ApiError(404)` twice then resolves → `{ id }`; get called 3 times.
  - `create gives up after three minutes` → rejects `ApiError(0, TOO_LONG)`.
  - `create rethrows a refusal`: send rejects `ApiError(400)` → rejects, get never called.
  - `stillPlanning resolves other when the version moves without our id`: get returns version 3, then 4 with no our-id turn → `{ kind: "other" }`.
  - `stillPlanning resolves answered when our own id lands`.
  - `a dropped stream resolves other when another edit moved the version`.
  - `revise recovers when the turn is answered`: answered on the second read → `{ kind: "answered" }`.
  - `revise ends on 404`: get rejects 404 → rejects after one get.
  - `recovery stops when alive turns false`: alive false after the first poll → get called once, rejects `Gone`.
  - `late keeps the id`, `same create body after late → same id`, `a different prompt → new id`, `other keeps the id` (through the presser with the real `send` wrapper).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Web typecheck, lint, test green.
- [ ] **Step 5:** Commit (web).

### Task 6a: The assistant undocks on `/reels` (web, shell)

**Files:** modify `lib/nav.ts` (`undocksAssistant?: true` on the reels entry; `assistantDocks`), `components/shell/assistant-panel.tsx`, `components/shell/top-bar.tsx`; test `tests/assistant-docks.test.ts`.

```ts
export function assistantDocks(pathname: string): boolean;   // !navEntryFor(pathname)?.undocksAssistant — the shell names no feature route [M-M5]
```
- In `AssistantPanel`, compute `const docked = wide && assistantDocks(pathname)` once and use `docked` for **every** current use of `wide` [C-I7]: `shown`/inert (`:36`, `:44`), the close-when-docked effect (`:40`), Escape (`:49`, `:74`), focus (`:58-59`), the scrim (`:65-66`), `role="dialog"` (`:72`), the Close button (`:85`) and `Body`'s `mr-8 xl:mr-0` (`:127`, pass `docked`). Replace each `xl:hidden` / `xl:mr-0` / `xl:static xl:z-auto xl:translate-x-0 xl:border-l-0` with a class applied only when `docked`. The top bar's toggle drops `xl:hidden` when not docked.

- [ ] **Step 1: Failing test:** `/` true, `/reels` false, `/reels/abc` false, `/reelsx` true, `/photoshoot` true.
- [ ] **Step 2:** Run → FAIL; implement → PASS.
- [ ] **Step 3:** The panel and top-bar change; build; at 1440 px `/` still docked, `/reels` a drawer.
- [ ] **Step 4:** Web typecheck, lint, test, build green. **Step 5:** Commit (web).

### Task 6b: The reels home `/reels` (web)

**Files:** create `components/shell/feature-access.tsx` [M-I4]; modify `components/photoshoot/access.tsx` (calls it, identical output); create `components/reels/home.tsx`, `components/reels/start-card.tsx` [M-M6], `components/reels/ideas-dialog.tsx`, `components/reels/your-reels.tsx`, `components/reels/reel-card.tsx`, `app/(shell)/reels/page.tsx`; modify `scripts/audit-ui.ts` (add `/reels`).

**Interfaces — Produces:**
```ts
export function featureAccess(p: { feature: WebFeature; path: string; icon: LucideIcon; noBusiness: string; noRead: string }): Promise<Access>; // the body of photoshootAccess, parameterised
export function ReelsHome(p: { workspaceId: string; brandId: string; canCreate: boolean }): JSX.Element;
```
Layout (spec §5.2, without 3b/3c parts): `PageHeader` "Reels" / "Plan, make and post short videos for your business."; a grid `lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]`:
- **Plan a reel** (`StartCard`): "What should your next reel be about?", `Textarea maxLength={CHAT_MESSAGE_MAX}`, primary **Plan** (`type="button"`, not a form submit); on an empty prompt, the `starters(ideas, productTitles)` as buttons (ideas from `useReelIdeas`, titles from `useBrandLook`); "N reel ideas ready" + **View ideas** when any. While streaming: the stage (`STAGE_LABELS`, `aria-live="polite"`, outside the draft component so it's announced once per stage) and the draft ("Scene N · shot", a `React.memo` child). Success → `router.push(\`/reels/${id}?step=plan&b=${brandId}\`)`; `TOO_LONG` → the line, and the list reads again.
- **View ideas** (`IdeasDialog`, loaded with `dynamic(…, { ssr: false })`, mounted after the first press) [P4]: the same `useReelIdeas` data, each title + summary + **Use this idea** (create `{ opportunityId, prompt: title }`, as the phone sends). Empty: "No reel ideas yet. They appear here after the ideas agent runs."
- Side column: **Presenters** (read-only list: name and "Being made…" / "Ready" / "Didn't work"; empty "No presenters yet.") and **Templates** (`TEMPLATE_LABELS` title + subtitle, the poster as `<img loading="lazy" decoding="async">`; **Preview** swaps that card to `<video controls preload="none">`, never more than one video at a time [P4]; **Use** → create `{ templateId }`).
- **Your reels**: `SegmentedRadios` All / Ready / Processing with counts; cards (`React.memo`, `<img loading="lazy" decoding="async">` of `thumbUrl`, alt = title) linking to `/reels/{id}?b={brandId}`; badge from `reelStage` ("Draft", "Processing", "Ready", "Didn't work"), overridden by item status SCHEDULED "Scheduled" / PUBLISHED "Posted"; seconds as "N s". Empty: "No reels yet."
- `const { loaded, planned } = usePlan(workspaceId); const locked = loaded && !planned;` → banner "Reels need a plan. You can look around; planning and making videos are locked." and Plan / Use / Use this idea open the paywall (`openPaywall` with a plan refusal) without sending.
- `canCreate` false: no Plan card, no Use buttons, the line "Your role can view reels but not make them."
- Page: `featureAccess({ feature: "reels", path: "/reels", … })` gate; `<ReelsHome key={brandId} … canCreate={perms.has("content.create")} />`; `metadata.title` "Reels". `library/page.tsx`'s inline gate stays (noted in the handover).

- [ ] **Step 1:** `featureAccess` + photoshoot on it; both photoshoot pages unchanged; build.
- [ ] **Step 2:** Build the home.
- [ ] **Step 3:** `npm run build --prefix .`, `check:bundle`, typecheck, lint, test green. Record `/reels` first-load JS from the build table and compare with `/photoshoot`; justify more than 15 kB extra [P4].
- [ ] **Step 4:** Commit (web).

### Task 7a: Kit parts `StepsRail`, `PreviewFrame` (web)

**Files:** create `components/ui/steps-rail.tsx`, `components/ui/preview-frame.tsx`; the two rows in server `docs/DESIGN_SYSTEM.md` (moved here from Task 8) [M-I10].

```ts
export function StepsRail<T extends string>(p: { label: string; steps: readonly { id: T; label: string; state: string; href: string }[]; current: T }): JSX.Element;
// <nav aria-label={label}> list of links, aria-current="step" on current, state as text; below md a "Step N of M: <label>" button opening a Sheet with the same list, rendered only when opened [P4].
export function PreviewFrame(p: { photoUrl?: string; videoUrl?: string; alt: string; onScreenText?: string; children?: ReactNode }): JSX.Element;
// 9:16 box, at most 60vh below md; on-screen text as real text over the photo; <video> only when videoUrl is set, native controls, no autoplay.
```
- [ ] **Step 1:** Build; typecheck, lint green. **Step 2:** Commit (web), then the DESIGN_SYSTEM rows (server).

### Task 7b: One reel `/reels/[id]`: page and Plan step (web)

**Files:** create `components/reels/reel-page.tsx`, `components/reels/plan-step.tsx`, `app/(shell)/reels/[id]/page.tsx`; modify `scripts/audit-ui.ts` (fixture reel only if one exists; else note it in the handover).

```ts
export function ReelPage(p: { workspaceId: string; brandId: string; reelId: string; step: string | undefined; canCreate: boolean }): JSX.Element;
```
- Page [S-M2]: `featureAccess({ feature: "reels", … })` gate first (flag → 404, no business, no `brand.read` → lock); then `isReelId(params.id)` false → "Couldn't load this reel" with no request; `<ReelPage key={brandId} … canCreate={perms.has("content.create")} />`.
- `ReelPage` calls `useReel` and `useReelOptions` **once** and passes `detail` / `options` down as props; steps and `PreviewFrame` take props only [P7].
- Layout: `lg`: rail | editor | preview; `md`–`lg`: rail | editor, preview under; below `md`: rail menu, editor, preview. "Skip to preview" link. Document title "<Step> · <Reel title> · Reels · Espanda".
- Rail: `BUILT_STEPS` only, with `stepState`; links `?step=…&b=…` (`router.replace`, no history spam). Step comes from `stepFrom(searchParams.step, detail)`.
- **Plan step:** chat thread `role="log"` (user and assistant turns; `React.memo`); after the last assistant turn the plan card (`React.memo`): title, "N scenes · ~N s" (`detail.seconds`), "Opening hook" + `scenes[0].voiceText`, duration chips ("~N s now" shown, then `durationChips` each sending `chipMessage`). Composer `Textarea maxLength={CHAT_MESSAGE_MAX}` "Ask for changes…" + **Send** (primary, Enter without Shift sends). "Start from a template": `ChoiceCards` of templates + Use (revise `{ templateId }`). While sending: the sent text shows at once, the stage and the draft (its own `React.memo` child) under it, "Plan ready" announced once when it lands. A failed send keeps the text in the composer with **Try again** (same request id, via the presser). Editing locks: a running render → controls disabled with "A video is being made from this plan. Wait for it to finish."; SCHEDULED/PUBLISHED → "This reel is already scheduled or posted."
- Not found: `useReel` `status` 403/404 → "Couldn't load this reel" + link to `/reels`.
- `canCreate` false: no composer, chips or Use; the read-only line.
- [ ] **Step 1:** Build. **Step 2:** Build, `check:bundle`, typecheck, lint, test green. **Step 3:** Commit (web).

### Task 7c: Storyboard step and preview column (web)

**Files:** create `components/reels/storyboard-step.tsx`; modify `components/reels/reel-page.tsx`.

- **Storyboard step (read-only):** facts "N s · 9:16 vertical · <presenter name from options, or "No presenter"> · N scenes"; per scene: photo (`photoUrls[photoKey]`, alt = shot), shot, direction, "On screen: …", voice text, `VIDEO_MODEL_NAMES[model] ?? model` or "Presenter", stand-in line where flagged, and `JOIN_LABELS[transition]` before the next scene. A video → **Watch the video** showing it in the preview. No Make video; the line "Make the video in the Espanda app for now." (3c replaces it).
- Preview column: the current scene's photo with its on-screen text, "◀ N of M ▶" buttons; the video when there is one and it is shown.
- [ ] **Step 1:** Build. **Step 2:** Build, `check:bundle`, typecheck, lint, test green; record `/reels/[id]` first-load JS against `/photoshoot/[id]`. **Step 3:** Commit (web).

### Task 8: Documentation and whole-slice check

**Files (server):** `docs/HANDOVER.md` (new "Feature 3a: reels plan and storyboard on the web" section at the top: what was built, owner's manual checks, not checked live, ceilings: the 150 s marker (spec deviation), `listReels` without a studio index, the link cache never evicts, the library page's inline gate not moved to `featureAccess`).

Owner's manual checks: flag off → `/reels` and `/reels/{id}` 404 and no nav entry; plan from a prompt, an idea and a template; open a phone-made reel on the web; close the tab mid-plan and reopen → one reel; a phone and a tab send a message on one reel at once → one is told to wait, both see the reply, and the waiting tab keeps its text; send, kill the network mid-stream, send again → one turn; press Plan while offline → the offline line, no wait; a Viewer sees the list and the reel with no composer; no plan → banner, Plan opens the paywall; keyboard through the rail, chips and templates; 375 px no horizontal scroll; switch business on `/reels/{id}` → "Couldn't load this reel", no loop; at 1440 px on `/reels` the assistant is a drawer: Tab never reaches it closed; open, its Close button, the scrim and Escape close it and focus returns to the toggle; docked elsewhere.

- [ ] **Step 1:** Write the docs (grep both for stale lines about reels on the web).
- [ ] **Step 2:** All three repos green (server typecheck/lint/test; web typecheck/lint/test/build/check:bundle; mobile typecheck).
- [ ] **Step 3:** Commit (server).
