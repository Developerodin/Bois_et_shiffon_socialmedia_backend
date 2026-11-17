# Foundations 0a · Server safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the server enforce every paid/plan rule and refuse duplicate paid starts, forged browser writes and unverified voice clones, so web features can be built on it safely.

**Architecture:** One small expiring key-value table (`TransientEntry`) backs the clone challenge, the reel in-flight marker and the inbox/Google read cache. Rules go into the existing service functions (`createClone`, `createShoot`, `createReel`, `chatPlan`, `startRender`) behind optional, additive request fields; the CSRF check goes into the existing API middleware. The phone gets two small changes (clone challenge screen, `requestId` on clone and photoshoot).

**Tech Stack:** Next.js 15 route handlers, Prisma 6 / Postgres (Neon), vitest 5 with `vi.mock` of `@/server/db/prisma` (see `tests/reel-clones.test.ts` for the pattern), Expo 58 for the mobile change.

**Spec:** `docs/superpowers/specs/2026-11-17-foundations-design.md` (§5 0a). Review findings it cites: `docs/handover/2026-11-17-mobile-web-parity-review/`.

## Global Constraints

- Run npm inside each repo with `--prefix .` (the repos still sit inside the old monorepo folder): e.g. `npm test --prefix . -- tests/x.test.ts`.
- Every server change is additive for existing callers except the two named breaks: clone without `challengeId` → 409 `clone.updateApp`; render of a version that already has a DONE render without `again: true` → 409 `render.alreadyDone`.
- Reuse, don't duplicate: `hitRateLimit`/`limitKey` (`server/auth/rate-limit.ts`), `saysTheScript` (`server/reels/recordings.ts:33`), the `spendCredits` `refId` duplicate guard, `requirePlan`.
- ffmpeg is never run with format auto-detect; every input branch passes `-f <format>` and `-protocol_whitelist file`.
- Error bodies keep the existing problem shape (`problemResponse`) plus a `code` string; 402 bodies keep `{ insufficientCredits, balance, needed }` / `{ planRequired, title }`.
- Commit messages: describe the change and why. No co-author, no tool/session lines, no mention of tests.
- Plan gate and limit values (owner, 2026-11-17): reel planning needs any active plan; 20 scriptwriter runs per brand per hour; no credit charge. Inbox/Google: no plan gate.
- Read cache TTL 45 s; clone challenge TTL 10 min, single use; reel in-flight marker 6 min.

## Review Focus

1. **A retried POST /photoshoots with a `requestId` that belongs to another workspace's shoot** must not return or touch that shoot (expect 409, never the other record). Test in Task 5.
2. **Two simultaneous POST /reels with the same `requestId`** (double click): exactly one scriptwriter run; the other gets 409 `reel.stillPlanning`. Test in Task 6.
3. **A clone challenge used twice, or used by another user** must be refused (single use, bound to user + workspace). Test in Task 3.
4. **Browser write behind the dev rewrite proxy** (`Origin: http://localhost:3100`, `Sec-Fetch-Site: same-origin`) must pass, and a Bearer mobile write with no Origin must pass. Test in Task 8.
5. **Cache invalidation after a reply**: GET inbox right after sending a reply must not return the 45 s-old list. Test in Task 9.

---

### Task 1: Expiring key-value store

**Files:**
- Modify: `prisma/schema.prisma` (add model next to `RateLimitBucket`, line ~558)
- Create: `prisma/migrations/20261117120000_transient_entries/migration.sql`
- Create: `server/db/transient.ts`
- Modify: `server/jobs/runner.ts:190` (`pruneOldRows`: delete expired entries)
- Test: `tests/transient.test.ts`

**Interfaces:**
- Produces:
  - `model TransientEntry { key String @id; value Json; expiresAt DateTime; @@index([expiresAt]) }`
  - `getTransient<T>(key: string): Promise<T | null>` (null when missing or expired)
  - `putTransient(key: string, value: unknown, ttlMs: number): Promise<void>` (upsert)
  - `claimTransient(key: string, value: unknown, ttlMs: number): Promise<boolean>` (true only if no live entry existed; atomic `INSERT … ON CONFLICT (key) DO UPDATE … WHERE "expiresAt" < now()` returning a row)
  - `takeTransient<T>(key: string): Promise<T | null>` (atomic `DELETE … WHERE key = $1 AND "expiresAt" > now() RETURNING value`)
  - `dropTransient(key: string): Promise<void>`

- [ ] **Step 1: Write failing tests** (mock `prisma.$queryRaw`/`$executeRaw`/`transientEntry` as in `tests/reel-clones.test.ts`): `claimTransient` returns true when the raw insert returns a row and false when it returns none; `takeTransient` returns the value once and null when the delete returns no row; `getTransient` returns null for a row whose `expiresAt` is in the past.
- [ ] **Step 2: Run** `npm test --prefix . -- tests/transient.test.ts` → FAIL (module missing).
- [ ] **Step 3: Add the model, write the migration** (`CREATE TABLE "TransientEntry" ("key" TEXT PRIMARY KEY, "value" JSONB NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL); CREATE INDEX … ON "TransientEntry"("expiresAt");`), run `npx --prefix . prisma generate`, implement `server/db/transient.ts`, and add `await prisma.transientEntry.deleteMany({ where: { expiresAt: { lt: new Date() } } })` to `pruneOldRows`.
- [ ] **Step 4: Run** the test → PASS; `npm run typecheck --prefix .` → exit 0.
- [ ] **Step 5: Commit** "Add a small expiring key-value table for challenges, in-flight markers and read caches".

### Task 2: Shared contract scaffolding and the clone passages

**Files:**
- Create: `shared/contract/errors.ts`, `shared/contract/clone-passages.ts`, `shared/contract/index.ts`
- Modify: `shared/index.ts` (re-export `./contract`)
- Modify: `server/api/http-error.ts:4-13` (import `ApiProblem` from `@/shared` instead of declaring it)
- Create: `scripts/sync-shared.mjs`; Modify: `package.json` (script `"sync:shared": "node scripts/sync-shared.mjs"`)
- Create (one-off, not committed): a node snippet that reads `../mobile/src/i18n/locales/*/reels.json` → `clone.passage`
- Test: `tests/contract.test.ts`

**Interfaces:**
- Produces:
  - `type ApiProblem` (moved as is, plus optional `code?: string`)
  - `type PaywallRefusal = { insufficientCredits: true; balance: number; needed: number } | { planRequired: true; title: string }`
  - `isPlanRequired(x: unknown): x is { planRequired: true; title: string }`, `isInsufficientCredits(x: unknown): x is { insufficientCredits: true; balance: number; needed: number }`
  - `type ErrorCode = "clone.updateApp" | "clone.notTheChallenge" | "clone.challengeExpired" | "reel.stillPlanning" | "render.alreadyDone" | "request.idTaken" | "csrf.crossOrigin" | "paid.pausedForClient"`
  - `CLONE_PASSAGES: Record<string, string>` keyed by mobile locale code (all 24 in `mobile/src/i18n/locales`), values copied verbatim from `clone.passage`; `clonePassage(lang: string): { lang: string; text: string }` falls back to `"en"`.
  - `scripts/sync-shared.mjs`: copies `shared/**` to `${WEB_DIR ?? "../web"}/shared/` and `${MOBILE_DIR ?? "../mobile"}/src/shared/` (replacing the folders), and writes `.hash` (sha256 over sorted relative paths + file bytes, excluding `.hash`) into all three. Prints the hash.

- [ ] **Step 1: Write failing tests**: `isPlanRequired({ planRequired: true, title: "x" })` is true and `isPlanRequired({ insufficientCredits: true })` false (and the mirror for `isInsufficientCredits`); `Object.keys(CLONE_PASSAGES).length === 24`; `clonePassage("xx").lang === "en"`; every passage splits into at least 2 sentences (Hindi has 2, the rest 7+) with the Task 3 splitter regex `/(?<=[.!?。！？।])\s*/`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the files; generate `clone-passages.ts` from the mobile JSON with the one-off snippet; write the sync script; run `npm run sync:shared --prefix .` once (this creates `../mobile/src/shared/` and refreshes `../web/shared/`).
- [ ] **Step 4: Run** the test and `npm run typecheck --prefix .` → PASS; `git -C ../web status --short shared` and `git -C ../mobile status --short src/shared` show the copies.
- [ ] **Step 5: Commit** in server ("Start the shared contract with error shapes and the clone passages, and a script that copies it to web and mobile"), then commit the copies in web and mobile ("Take the server's shared contract copy").

### Task 3: Voice-clone challenge (A1)

**Files:**
- Create: `server/reels/clone-challenge.ts`
- Create: `app/api/v1/workspaces/[workspaceId]/brands/[brandId]/voices/clones/challenge/route.ts`
- Modify: `server/reels/recordings.ts:50` (export `transcribe`)
- Modify: `server/reels/clones.ts:52-77` (`createClone` input and checks)
- Modify: `app/api/v1/workspaces/[workspaceId]/brands/[brandId]/voices/clones/route.ts` (read `challengeId`, map codes)
- Test: `tests/reel-clone-challenge.test.ts`; extend `tests/reel-clones.test.ts`

**Interfaces:**
- Consumes: `claimTransient`/`takeTransient`/`putTransient` (Task 1), `clonePassage`, `ErrorCode` (Task 2), `saysTheScript`.
- Produces:
  - `makeChallenge(scope: { workspaceId: string; userId: string }, lang: string): Promise<{ challengeId: string; lang: string; sentences: string[] }>` — splits the passage on `/(?<=[.!?。！？।])\s*/` and builds **rounds**: each round is the sentences in a fresh crypto-random Fisher–Yates order (re-shuffle a round equal to the original order, unless the passage has fewer than 3 sentences); add rounds until the total is at least 140 words, minimum two rounds. *(Why: the passages are 57–98 words, about 25–40 s spoken, and a clone needs 60–90 s; `saysTheScript` matches word multisets both ways, so repeated rounds still match.)* Stores `{ userId, workspaceId, lang, text }` under `clone-challenge:<uuid>` for 600 000 ms.
  - `takeChallenge(scope, challengeId: string): Promise<{ lang: string; text: string }>` — `takeTransient`; throws `PublishingError(…, 410)` with code `clone.challengeExpired` when missing, and the same when `userId`/`workspaceId` don't match (no hint which).
  - `createClone(scope, input: { name; bytes; consent; appVersion?; challengeId?: string; requestId?: string })` — order: consent → `requirePlan` → no `challengeId` ⇒ 409 `clone.updateApp` ("Update the app to clone a voice.") → `takeChallenge` → format/size → `toWav` → seconds → `transcribe(wav, lang)` → `saysTheScript(text, transcript)` false ⇒ 422 `clone.notTheChallenge` ("Read the sentences on screen, in that order.") → existing flow. Consent record gains `challengeId` and `transcriptSha256`.
  - `GET …/voices/clones/challenge?lang=xx` (permission `voices.manage`, rate limit `clone-challenge:user:<id>` 20/h) → `{ challengeId, lang, sentences }`.
- `PublishingError` gains an optional third constructor argument `code?: string`, and `toReelProblem` copies it into the problem body as `code` (check `server/services/publishing.ts` for the class; keep existing call sites unchanged).

- [ ] **Step 1: Write failing tests**: the challenge has at least two rounds and at least 140 words, each round is a permutation of the passage's sentences, and the first round differs from the original order; a challenge is stored with TTL 600 000 ms; `takeChallenge` twice → second throws 410; another `userId` → 410; `createClone` without `challengeId` → 409 code `clone.updateApp` before any charge; transcript that doesn't match → 422 `clone.notTheChallenge` and `spendCredits` not called; matching transcript → voice created with `consent.challengeId` set.
- [ ] **Step 2: Run** `npm test --prefix . -- tests/reel-clone-challenge.test.ts tests/reel-clones.test.ts` → FAIL.
- [ ] **Step 3: Implement** the module, the route, the `createClone` changes and the `PublishingError` code field. Update existing `tests/reel-clones.test.ts` inputs to pass a `challengeId` with `takeChallenge` mocked.
- [ ] **Step 4: Run** the tests → PASS; full `npm test --prefix .` → all pass.
- [ ] **Step 5: Commit** "Make voice cloning prove the reading is live: a shuffled passage per attempt, checked against what was said".

### Task 4: WebM recordings (B1, I3)

**Files:**
- Modify: `server/reels/recordings.ts:23-26, 64-79`
- Modify: `server/reels/clones.ts:55` (accept WebM too)
- Modify: the recordings route under `app/api/v1/…/reels/[contentId]/recordings/route.ts` only if it sniffs the type itself
- Test: `tests/reel-recordings-format.test.ts`

**Interfaces:**
- Produces: `isWebm(b: Uint8Array): boolean` (first four bytes `1A 45 DF A3`); `audioFormat(b: Uint8Array): "mp4" | "matroska" | null`; `toWav(bytes, maxSeconds?)` picks `-f mp4` or `-f matroska` from `audioFormat`, keeps `-protocol_whitelist file`, throws the existing 400 when `audioFormat` is null.

- [ ] **Step 1: Write failing tests**: `isWebm` true for `[0x1a,0x45,0xdf,0xa3,…]`, false for an M4A header; `audioFormat` returns `"mp4"`/`"matroska"`/`null`; with `run` mocked (`vi.mock` of the ffmpeg runner `toWav` uses), `toWav(webmBytes)` passes `["-f","matroska"]` and `"-protocol_whitelist","file"` and never omits `-f`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; `createClone` and `uploadRecording` accept `audioFormat(bytes) !== null` instead of `isM4a(bytes)`.
- [ ] **Step 4: Run** the test and the clone/recording tests → PASS.
- [ ] **Step 5: Commit** "Accept WebM recordings from browsers, with ffmpeg still told the exact format".

### Task 5: `requestId` on photoshoot and clone starts (A6, I2)

**Files:**
- Modify: `server/photoshoot/shoot.ts:26-47` (schema: optional `requestId: z.string().uuid()`), `:78-95` (`createShoot`)
- Modify: `app/api/v1/…/photoshoots/route.ts` (repeat → 200 with the existing shoot; new → 202 as now)
- Modify: `server/reels/clones.ts` (`createClone` uses `requestId` as the voice id when given)
- Modify: `app/api/v1/…/voices/clones/route.ts` (form field `requestId`; repeat → 200)
- Test: extend `tests/photoshoot-tiers.test.ts` or create `tests/photoshoot-request-id.test.ts`; extend `tests/reel-clones.test.ts`

**Interfaces:**
- Produces: `createShoot(scope, request): Promise<{ shoot: PhotoShoot; repeated: boolean }>` (callers updated); `createClone(…): Promise<{ voice: Voice; repeated: boolean }>`.
- Rule: with `requestId`, look up `photoShoot`/`voice` by id. Found in the same workspace (and brand, for shoots) → return it, `repeated: true`, no charge. Found elsewhere → 409 code `request.idTaken`. Not found → create with `id = requestId` and `refId = requestId`; a P2002 on create (lost a race) → re-read and return it as `repeated`.

- [ ] **Step 1: Write failing tests**: same `requestId` twice → `spendCredits` called once, second returns `repeated: true`; a `requestId` whose shoot is in workspace `w2` → 409 `request.idTaken` and nothing charged (Review Focus 1); no `requestId` → behaviour as today (random id); clone with a repeated `requestId` → one charge, one ElevenLabs call.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** "Let a retried photoshoot or clone start return the first one instead of charging again".

### Task 6: Reel planning: plan gate, rate limit, one run per `requestId` (owner decision, A5, M1)

**Files:**
- Modify: `server/reels/service.ts:112` (`createReel`), `:145` (`chatPlan`), `:175` (`editPlan`)
- Modify: `app/api/v1/…/reels/route.ts` (`Create` schema: optional `requestId: z.string().uuid()`)
- Test: `tests/reel-plan-gate.test.ts`

**Interfaces:**
- Consumes: `requirePlan`, `hitRateLimit`, `claimTransient`/`dropTransient` (Task 1).
- Produces:
  - `planGate(scope: Scope): Promise<void>` in `service.ts` — `requirePlan(scope.workspaceId)` then `hitRateLimit(\`reel-plan:brand:${scope.brandId}\`, 20, 3_600_000)`; over → `PublishingError("You've planned a lot of reels this hour. Try again later.", 429)`.
  - `createReel(scope, input & { requestId?: string }, emit?)`: if `requestId` — existing `contentItem` with that id in this brand → return its latest plan (same shape as now) without AI calls; else `claimTransient(\`reel-plan:${requestId}\`, scope, 360_000)` false → 409 code `reel.stillPlanning`; create with `id: requestId`; `dropTransient` in `finally`. Then `planGate` before `writePlan` (before the claim when there is no `requestId`).
  - `chatPlan`: `planGate` before `writePlan`. `editPlan`: `requirePlan` only (not counted).

- [ ] **Step 1: Write failing tests**: no plan → `createReel` and `chatPlan` throw `PlanRequiredError` before `writePlan` is called; 21st call in the hour → 429 and `writePlan` not called; `editPlan` calls `requirePlan` and never `hitRateLimit`; two concurrent `createReel` with the same `requestId` (claim mocked true then false) → one `writePlan`, the other 409 `reel.stillPlanning` (Review Focus 2); a finished `requestId` → returns the stored plan, no `writePlan`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `PlanRequiredError` already maps to 402 in `toReelProblem`; confirm, else add the mapping there.
- [ ] **Step 4: Run** → PASS; `tests/reel-plan.test.ts` still passes (mock `requirePlan` there if needed).
- [ ] **Step 5: Commit** "Make reel planning need a plan, cap it per brand per hour, and run once per request".

### Task 7: Re-render needs confirmation (parity #3)

**Files:**
- Modify: `server/reels/render.ts:111-131` (`startRender`)
- Modify: the render action in `app/api/v1/…/reels/[contentId]/route.ts` (pass `again` from the body)
- Test: `tests/reel-render-again.test.ts`

**Interfaces:**
- Produces: `startRender(input: { …existing; again?: boolean })`. Inside the first locked transaction, after the version check: if `tx.reelRender.findFirst({ where: { contentVersionId: latest.id, step: "DONE" } })` exists and `!input.again` → `PublishingError("This version already has a video. Make it again?", 409, "render.alreadyDone")`. A running render still returns as today (checked first).

- [ ] **Step 1: Write failing tests**: latest version with a DONE render, no `again` → 409 `render.alreadyDone`, no charge; with `again: true` → charges and creates attempt 2; a newer version with no render → renders without `again`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** "Ask before paying again for a video the same plan already has".

### Task 8: Cross-origin check for cookie writes (A2)

**Files:**
- Modify: `middleware.ts` (server)
- Modify: `app/api/v1/me/context/route.ts:20-23` (remove its Origin check; keep the JSON check)
- Modify: `.env.example` (document `WEB_ORIGINS`, `CSRF_MODE`)
- Modify (web repo): `../web/lib/server-fetch.ts:20-24` (send `Origin: new URL(process.env.WEB_ORIGIN ?? "http://localhost:3100").origin` on non-GET)
- Test: extend `tests/middleware.test.ts`; adjust `tests/me-context.test.ts`

**Interfaces:**
- Produces: in `middleware.ts`, `crossOriginWrite(request: NextRequest): boolean` — true when method ∉ {GET, HEAD, OPTIONS}, no `authorization` header starting with `Bearer `, path not under `/api/v1/webhooks/`, `/api/v1/jobs/run`, `/api/v1/mobile/`, `/api/v1/integrations/` (callbacks are GET), and neither `sec-fetch-site ∈ {same-origin, none}` nor `origin ∈ allowedOrigins()`. `allowedOrigins()` = `new URL(AUTH_URL).origin` plus `WEB_ORIGINS` (comma list). `CSRF_MODE=log` logs `csrf.crossOrigin` with method, path, origin and sec-fetch-site and lets it through; any other value (default) returns 403 problem with code `csrf.crossOrigin`. The check runs before the Auth.js call.

- [ ] **Step 1: Write failing tests** (table): POST with `Sec-Fetch-Site: same-origin` → passes; POST with `Origin: http://localhost:3100` and `AUTH_URL=http://localhost:3100` → passes (Review Focus 4); POST with `Origin: https://evil.example` → 403; POST with `Authorization: Bearer x` and no Origin → passes; POST to `/api/v1/webhooks/meta` with no headers → passes; GET with a foreign Origin → passes; `CSRF_MODE=log` with a foreign Origin → passes and logs.
- [ ] **Step 2: Run** `npm test --prefix . -- tests/middleware.test.ts tests/me-context.test.ts` → FAIL.
- [ ] **Step 3: Implement**; update `me-context` tests that asserted its own 403 to go through the middleware instead (or drop them: the middleware test now owns that rule).
- [ ] **Step 4: Run** → PASS; in the web repo `npm run typecheck --prefix .` → exit 0.
- [ ] **Step 5: Commit** in server ("Refuse cookie-authenticated writes from other origins in one place") and in web ("Send the website's origin on the server-side writes it makes").

### Task 9: Read cache for inbox and Google (C3)

**Files:**
- Modify: `server/customers/inbox.ts:65` (`inbox`), `:139` (`sendReply`)
- Modify: `server/google/business.ts:121` (`businessReviews`), `:164` (`businessPosts`), `:154` (`replyToReview`), `:186` (`createPost`)
- Create: `server/db/read-cache.ts`
- Test: `tests/read-cache.test.ts`; extend `tests/google-business.test.ts`

**Interfaces:**
- Consumes: `getTransient`/`putTransient`/`dropTransient` (Task 1).
- Produces: `cachedRead<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>` and `forgetRead(...keys: string[]): Promise<void>`. Keys: `read:inbox:<brandId>`, `read:google-reviews:<brandId>`, `read:google-posts:<brandId>`; TTL 45 000 ms. The existing per-brand rate limit moves inside `load` (only a cache miss counts). `sendReply` forgets the inbox key; `replyToReview` the reviews key; `createPost` the posts key. `thread()` is not cached.

- [ ] **Step 1: Write failing tests**: two `inbox()` calls within the TTL → one Graph fetch and one `hitRateLimit`; after `sendReply` the next `inbox()` fetches again (Review Focus 5); a `load` that throws stores nothing.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (existing `tests/google-business.test.ts` too).
- [ ] **Step 5: Commit** "Cache inbox and Google reads for 45 seconds per brand, cleared when a reply or post goes out".

### Task 10: Fewer queries on every brand route, and no grant write on balance reads (I6, I7)

**Files:**
- Modify: `server/api/brand-route.ts:30-31`
- Modify: `server/auth/access.ts:34-60` (`requireBrandAccess` returns `{ brand, perms }`; keep a thin wrapper if other callers expect the brand only)
- Modify: `server/services/credits.ts:36-39` (`creditBalance` without `ensureStarterGrant`; keep it inside `spendCredits`)
- Modify: `server/services/accounts.ts:215-223` (grant the starter credits in the workspace-creation transaction)
- Create: `prisma/migrations/20261117120100_backfill_initial_grants/migration.sql` (insert `initial-grant` for every workspace that lacks one, `ON CONFLICT DO NOTHING`)
- Test: `tests/brand-route.test.ts`; extend the credits tests

**Interfaces:**
- Produces: `authorizeBrandRoute` calls `memberRole` once and `brandMember.findFirst` once per request (via one `effectivePermissions`), plus `brand.findFirst`; `requireWorkspaceMember` is no longer called on this path (a null role ⇒ the same `AccessDeniedError("Not a workspace member")`). Return value and error classes unchanged. Every caller of `requireBrandAccess` listed by `grep -rn "requireBrandAccess(" server app` keeps working.

- [ ] **Step 1: Write failing tests**: with prisma mocked, one `authorizeBrandRoute` call → `workspaceMember.findUnique` once, `brandMember.findFirst` once; non-member → 403 as before; member without the route permission → `AccessDeniedError("Missing permission …")` as before; `creditBalance` does not call `creditEntry.createMany`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** and write the backfill migration. **Step 4: Run** the full suite → PASS.
- [ ] **Step 5: Commit** "Work out a caller's permissions once per brand request, and grant starter credits when the workspace is made".

### Task 11: Client tag, paid kill switch for web, and paid-start logs (I11, I12)

**Files:**
- Create: `server/api/client.ts`
- Modify the paid-start routes: `…/photoshoots/route.ts` (POST), `…/voices/clones/route.ts` (POST), `…/reels/[contentId]/route.ts` (render action), `…/reels/presenters/route.ts` and `…/reels/previews/route.ts` (POST), `…/agents/[agentKey]/runs/route.ts` (POST)
- Modify (mobile repo): `../mobile/src/api/client.ts` (send `X-Client: mobile/<Constants.expoConfig.version>`)
- Modify: `.env.example` (`PAID_STARTS_OFF_FOR`)
- Test: `tests/client-tag.test.ts`

**Interfaces:**
- Produces: `clientOf(request: Request): { kind: "web" | "mobile" | "unknown"; version: string | null }` (from `X-Client: <kind>/<version>`); `paidStartsPaused(request: Request): Response | null` — 503 problem, code `paid.pausedForClient`, title "Making this from the website is paused", when the client kind is listed in `PAID_STARTS_OFF_FOR` (comma list); `logPaidStart(e: { feature: string; client: string; workspaceId: string; refId: string | null; outcome: "started" | "repeated" | "402" | "409" | "429"; ms: number }): void` — one `console.log(JSON.stringify({ event: "paid.start", ...e }))`. Each paid route calls `paidStartsPaused` right after authorization and `logPaidStart` on every outcome, and adds `client` to the audit metadata it already writes.

- [ ] **Step 1: Write failing tests**: `clientOf` parses `web/1.2.0`, `mobile/1.0.0`, missing → unknown; `PAID_STARTS_OFF_FOR=web` + `X-Client: web/1` → 503 code `paid.pausedForClient`; `X-Client: mobile/1` → null; unset env → null.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** and wire the routes. **Step 4: Run** the full suite → PASS; mobile `npm run typecheck --prefix .` → exit 0.
- [ ] **Step 5: Commit** in server ("Tag requests by client, and let paid starts from the web be paused on their own") and mobile ("Tell the server which app and version is calling").

### Task 12: Mobile — clone challenge screen and `requestId`s

**Files (mobile repo):**
- Modify: `src/api/endpoints.ts:320-326` (`cloneVoice` form adds `challengeId`, `requestId`; new `cloneChallenge(lang)`), `:470-474` (`photoshoots.create` adds `requestId`)
- Modify: `src/app/reels/clone.tsx:44-50, 86-87, 50-76` (load the challenge with `i18n.language`; show `sentences` joined by a space instead of `t("clone.passage")`; one `requestId` per take; on 410 `clone.challengeExpired` reload the challenge and keep the take; on 422 show the server's title)
- Modify: the photoshoot screen that calls `photoshoots.create` (`src/app/photoshoot/…`): one `randomUUID()` per Generate press, reused if that press is retried
- Test: `npm run typecheck --prefix .`, `npm run lint --prefix .`; manual run on the emulator (HANDOVER "Local setup after the merge")

- [ ] **Step 1: Implement** the endpoint changes and the screens (`expo-crypto`'s `randomUUID`; check `package.json` first — if absent, use `crypto.randomUUID()` which Hermes in Expo 58 provides; do not add a dependency for it).
- [ ] **Step 2: Run** typecheck and lint → exit 0, 0 problems.
- [ ] **Step 3: Manual check** on the emulator against the local server: the clone screen shows a reordered passage that changes on each open; reading it clones; reading the old fixed order fails with "Read the sentences on screen, in that order." A double-tap on Generate in photoshoot charges once (check the credit history).
- [ ] **Step 4: Commit** "Read the server's shuffled passage to clone a voice, and send one request id per photoshoot or clone".

### Task 13: Documentation of the new settings

**Files:**
- Modify: `.env.example` — add `ELEVENLABS_API_KEY`, `GOOGLE_MAPS_API_KEY`, `HIGGSFIELD_API_KEY_SECRET`, `TWILIO_AUTH_TOKEN`, `EXPO_ACCESS_TOKEN`, `CREDENTIALS_ENCRYPTION_KEY_1` (empty values, one comment line each), plus anything Tasks 8 and 11 added if not already there
- Modify: `docs/DEPLOY_EC2.md` — region line (API in eu-central-1, next to Neon), first deploy with `CSRF_MODE=log`, then `enforce`; `PAID_STARTS_OFF_FOR`
- Modify: `docs/HANDOVER.md` — a "Foundations 0a" entry: what changed, the two deliberate breaks, the new envs, how to run `sync:shared`
- Verify: in the web repo, `npm run build --prefix .` then `npm run check:bundle --prefix .` reports the larger secret-name count (24 instead of 18)

- [ ] **Step 1: Edit** the three files. **Step 2: Run** the web build and bundle check → "none of 24 secret names" (or the new count). **Step 3: Commit** "Document the new server settings and the deploy order for the origin check".

### Task 14: Whole-slice check

- [ ] **Step 1:** server: `npm run typecheck --prefix .`, `npm run lint --prefix .` (0 errors), `npm test --prefix .` (all pass), `npm run build --prefix .`, `npm run build:worker --prefix .`.
- [ ] **Step 2:** `npx --prefix . prisma migrate dev` against the dev database applies both migrations; `SELECT count(*) FROM "CreditEntry" WHERE reason='initial-grant'` equals the workspace count.
- [ ] **Step 3:** web and mobile: typecheck and lint pass; `node scripts/check-shared.mjs` is not yet present (0b adds it) — instead compare `.hash` files by eye: identical in all three repos.
- [ ] **Step 4:** run the web e2e suite (`npm run test:e2e --prefix .` in web, servers started from each repo) and record the result in HANDOVER.
- [ ] **Step 5:** request a whole-branch review (superpowers:requesting-code-review) before calling 0a done.
