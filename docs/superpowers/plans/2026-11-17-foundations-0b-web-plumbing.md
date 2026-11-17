# Foundations 0b · Web plumbing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the website the transport, contract check, job polling, plan/credits store, paywall event, feature flags and security headers that the eight mobile features will be built on.

**Architecture:** All additive on what exists: `lib/net.ts` `send()` gains a per-call timeout and the `X-Client` tag; the one `request()` in `components/settings/api.ts` absorbs the copy in `components/context/api.ts`, keeps the error body, reads NDJSON streams and raises a paywall event on every 402. `useBrandData`'s per-URL cache moves into `components/workspace/use-job.ts`, gains an in-flight guard, and `useJob` (chained timeouts, terminal stop, backoff, hidden-tab pause) is built on it; `useBrandData` becomes a never-ending `useJob`. Headers go in the existing web `middleware.ts`; flags in a server-only `lib/features.ts`.

**Tech Stack:** Next.js 15.5 / React 19.1 (web), vitest 5 in the node environment (no jsdom; `tests/**/*.test.ts`), Playwright e2e, Expo 58 (mobile, check script only).

**Spec:** server repo `docs/superpowers/specs/2026-11-17-foundations-design.md` §5 "0b · Web plumbing", §6. Findings: `docs/handover/2026-11-17-mobile-web-parity-review/` (operations C2, I9, I11; sync-architecture I3; security A3, A13, B6, B9, B11).

## Decisions (ambiguities and spec/code conflicts, settled here)

1. **One `request()`, where it already lives.** It stays in `components/settings/api.ts` (24 importers) instead of moving to a new `lib/api.ts`. `components/context/api.ts` deletes its private `request` and `ProblemError` and re-exports `ApiError as ProblemError`, so its 5 importers keep their `instanceof` checks. Side effect accepted: context calls now also send people to sign-in on a 401 and accept a 204.
2. **`X-Client` version** = `package.json` version, inlined at build through `next.config.ts` `env: { WEB_VERSION: process.env.npm_package_version ?? "dev" }`. Sent by `send()`, `serverFetch`, the chat transport (`useChat` doesn't go through `send`) and the story zip download (a raw `fetch`).
3. **Timeouts:** only `SLOW_MS = 120_000` is added now, used by `createBrand`. Clone, recording, reel plan/chat have no web caller yet; the 330 s constant arrives with feature 3. Default stays 30 s.
4. **`requestId()`** is `crypto.randomUUID()` in `lib/net.ts`. No current web call takes one. The two existing creating submits (`new-brand-dialog.tsx`, `welcome-flow.tsx`) already disable while pending, so no change there; the rule goes into Global Constraints for the features.
5. **Paywall event fires only for a recognisable refusal:** a 402 whose body (or streamed error line) passes `isPlanRequired` / `isInsufficientCredits`. A streamed line has no `title`, so `detail` becomes the title. Any other 402 only throws.
6. **Plan and credits:** one store keyed by `workspaceId` (credits are per workspace, shared by its brands — owner), reading `/credits` and `/subscription` together, at most once per 30 s on focus, forced after a paid action or a 402. The `Subscription` type is hand-written in web (it is not in the shared contract; it moves there with feature 8). Stores are React-free modules; the hooks live in a separate client file, so server components that import `settings/api` never pull hooks.
7. **`useJob` signature** adds `pick` (required on a cache shared by panels that read different parts of one response, exactly as `useBrandData` does). After `capMs` it keeps polling at the last interval and returns `slow: true` (0c's "keep waiting or retry"). A 429 waits 60 s (the server sends no `Retry-After`). The interval clock starts at mount. No `BroadcastChannel` (I9 calls it optional).
8. **Hook tests:** `useJob`'s pure parts (`nextDelay`, `fetchShared`) are unit-tested; no jsdom/testing-library is added. The hook glue is checked in the browser and by the existing e2e suite.
9. **The two 3 s loops move onto `useJob`.** `StoryFrames` and `ReleasePanel` read the same URL (`content/:id`), so they now share one fetch (that GET also loads Pinterest boards, so this halves real work). `ReleasePanel.act()` drops its optimistic `setData` merge and awaits a reload instead.
10. **Flags:** `WEB_FEATURES` = comma list of features on for everyone; `WEB_FEATURE_WORKSPACES` = comma list of `feature:workspaceId` pairs that open one feature to one workspace. Read per call (run time, not build). No flagged route exists yet; nav entries are 0c.
11. **Headers in `middleware.ts`, not `next.config.ts` `headers()`:** the nonce is per request and the image bakes no env. New web env `STORAGE_ORIGIN`. `img-src` allows `https:` because product images (any shop host, `products-board.tsx:141`) and Google avatars are not on the storage origin — a deliberate widening of the spec's "storage origin for img". No report endpoint: violations show in the browser console until the policy is enforced.
12. **Links:** `workspace.tsx` `safeSite` already calls `safeHttpUrl` (it adds the host) and stays; `doc-pane.tsx` `safeHref` is replaced; `products-board.tsx:146` is checked.
13. **`NEXT_PUBLIC_` name check** scans source, `.env*`, `Dockerfile`, `next.config.ts` and the build's env, and runs before the `.next` check so it works without a build. Allowlist starts empty.
14. **`check-shared.mjs` exists twice** (web and mobile), as the spec places it; `shared/` stays plain TS. A web test pins its hash to the server's algorithm by hashing `web/shared` against the `.hash` the server wrote.

## Global Constraints

- Run npm inside each repo with `--prefix .`: `npm test --prefix . -- tests/x.test.ts`. Windows; Git Bash for the commands below; PowerShell 5.1 has no `&&`. Paths below are relative to the repo named in the task (web = `../web`, mobile = `../mobile` from the server repo).
- Every web task leaves `npm run typecheck --prefix .`, `npm run lint --prefix .`, `npm test --prefix .` green. Mobile tasks leave `npm run typecheck --prefix .` and `npx --prefix . expo lint` green (mobile has no test runner).
- Commit messages: describe the change and why. No co-author lines, no tool/session lines, no mention of tests. Commit only in the repo the task names.
- Reuse, don't duplicate: `send`/`NetworkError` (`lib/net.ts`), `request`/`ApiError` (`components/settings/api.ts`), `safeHttpUrl` (`shared/website.ts`), `PaywallRefusal`/`isPlanRequired`/`isInsufficientCredits` (`shared/contract/errors.ts`), the `components/ui/dialog.tsx` parts. Never edit `web/shared` or `mobile/src/shared` by hand (server `npm run sync:shared` owns them).
- Credits are per workspace, shared by all its brands.
- The paywall UI is 0c: 0b ships the store, the 402 event and a plain stub dialog only.
- Any paid or creating submit added later: one `requestId()` per press, reused on retry; button disabled while the request is in flight.
- Keep it minimal: no new dependencies, no speculative options.

## Review Focus

1. **A multipart upload through `request()`** (`release-panel.tsx:339` posts `FormData` with `headers: {}` precisely to dodge the JSON content type): after the header merge it must still go out with no `Content-Type` set by us. Test in Task 2.
2. **A stream that stops before its last line** (proxy timeout, server crash, a line split across chunks): the call rejects with status 0 and never resolves `undefined` or hangs; split lines still parse. Test in Task 2.
3. **Several panels (or StrictMode's double effect) mounting on one URL**: exactly one request; a failed request rejects every waiter and stores nothing. Test in Task 5.
4. **A 402 that isn't a known refusal** (a gateway page, an old route): no empty paywall opens; the call still throws. Test in Task 3.
5. **Switching workspace while a plan/credits read is in flight**: the answer lands under the workspace it was asked for, never the newly active one. Test in Task 3.

Also watch, no test: static pages (e.g. `/login`) prerender without the nonce, so the report-only CSP will list their scripts — make them dynamic before enforcing. While a story is publishing, the shared `content/:id` poll re-signs frame links every 5 s and the frame pictures reload. `ReleasePanel`'s "due within a minute" is time-based and only re-evaluates on a render.

---

### Task 1: Transport: per-call timeout, client tag, request ids (web)

**Files:**
- Modify: `lib/net.ts:27, 47-66` (`send`)
- Modify: `next.config.ts` (`env`)
- Modify: `lib/server-fetch.ts:26` (headers), `components/workspace/chat-pane.tsx:178` (transport headers), `components/workspace/release-panel.tsx:502` (download headers)
- Test: `tests/net.test.ts`; update `tests/server-fetch.test.ts`

**Interfaces:**
- Produces:
  - `export const CLIENT_TAG: string` = `` `web/${process.env.WEB_VERSION ?? "dev"}` ``
  - `export const SLOW_MS = 120_000`
  - `export type SendInit = RequestInit & { timeoutMs?: number }`
  - `send(url: string, init: SendInit = {}, retried = false): Promise<Response>` — timeout `init.timeoutMs ?? 30_000`; `timeoutMs` is not passed to `fetch`; headers become `new Headers(init.headers)` with `X-Client: CLIENT_TAG` set.
  - `export const requestId = (): string => crypto.randomUUID()`

- [ ] **Step 1: Write failing tests** in `tests/net.test.ts` (stub `fetch` with `vi.stubGlobal`):
  - `send("/x")` → `new Headers(fetchMock.mock.calls[0][1].headers).get("x-client") === "web/dev"`; with `{ headers: { a: "1" } }` both `a` and `x-client` are present.
  - `vi.spyOn(AbortSignal, "timeout")`: `send("/x")` calls it with `30_000`; `send("/x", { timeoutMs: 120_000 })` with `120_000`; `"timeoutMs" in fetchMock.mock.calls[0][1]` is false.
  - a `fetch` that rejects only when its signal aborts + `send("/x", { timeoutMs: 20 })` → rejects `NetworkError` with `failure === "timeout"`.
  - `requestId()` matches `/^[0-9a-f-]{36}$/` and two calls differ.
  - `tests/server-fetch.test.ts`: `init.headers["x-client"]` is `"web/dev"`.
- [ ] **Step 2: Run** `npm test --prefix . -- tests/net.test.ts tests/server-fetch.test.ts` → FAIL.
- [ ] **Step 3: Implement** the `lib/net.ts` changes (update the header comment's "timeout: no answer within 30 s" line); `next.config.ts` adds `env: { WEB_VERSION: process.env.npm_package_version ?? "dev" }`; `serverFetch` adds `"x-client": CLIENT_TAG`; chat transport gets `headers: { "X-Client": CLIENT_TAG }`; the zip `fetch` gets `headers: { "X-Client": CLIENT_TAG }`.
- [ ] **Step 4: Run** the tests → PASS; `npm run check:net --prefix .` → no assertion errors; typecheck, lint, full `npm test --prefix .` → green.
- [ ] **Step 5: Commit** (web) "Let each call set its own timeout, tag every request as the website with its version, and add a request id helper".

### Task 2: One `request()`: error body, header merge, NDJSON streams (web)

**Files:**
- Modify: `components/settings/api.ts:5-14` (`ApiError`), `:71-96` (`request`)
- Modify: `components/context/api.ts:41-76` (delete `ProblemError` class and `request`; import and re-export), `:86-97` (`createBrand` passes `timeoutMs: SLOW_MS`)
- Test: `tests/api-request.test.ts`

**Interfaces:**
- Consumes: `send`, `SendInit`, `SLOW_MS`, `NetworkError` (Task 1).
- Produces:
  - `class ApiError(status: number, message: string, code?: string, data?: unknown)` — `data` is the parsed error body (or the streamed error line); existing two- and three-argument calls unchanged.
  - `export type RequestOptions = SendInit & { onLine?: (line: unknown) => void }`
  - `request<T>(url: string, init?: RequestOptions): Promise<T>` — `cache: "no-store"`; `Content-Type: application/json` only when `typeof init.body === "string"`; caller headers merged over that; `Accept: application/x-ndjson` when `onLine`; an ok `application/x-ndjson` response is read line by line (port of mobile `readLines`, `mobile/src/api/client.ts:186-202`): `{type:"done",result}` resolves `result`, `{type:"error",status,detail}` rejects `ApiError(status ?? 500, detail, line.code, line)`, other lines go to `onLine`, end of stream without either → `ApiError(0, "The answer stopped partway. Try again.")`. Non-ok: `ApiError(status, detail || title || "Request failed (N)", body.code, body)`. 401 redirect and 204 as today.
  - `components/context/api.ts`: `export { ApiError as ProblemError } from "@/components/settings/api"`.

- [ ] **Step 1: Write failing tests** (stub `fetch`; build streamed bodies with `new Response(new ReadableStream({ start(c) { … } }), { headers: { "content-type": "application/x-ndjson" } })`):
  - 409 `{ title: "t", detail: "d", code: "render.alreadyDone", extra: 1 }` → `ApiError` with `status 409`, `message "d"`, `code "render.alreadyDone"`, `data.extra === 1`.
  - JSON body → `content-type: application/json`; `FormData` body with `headers: {}` → no `content-type` header set by us (Review Focus 1); caller `headers: { "x-a": "1" }` with a JSON body keeps both.
  - `onLine` with chunks `'{"type":"stage","stage":"reading"}\n{"type":"do'` + `'ne","result":{"x":1}}\n'` → `onLine` called once with the stage line, resolves `{ x: 1 }`, request had `accept: application/x-ndjson`.
  - error line `{"type":"error","status":402,"detail":"Needs a plan","planRequired":true}` → rejects `ApiError` status 402, `data.planRequired === true`.
  - a stream that closes after one progress line → rejects `ApiError` status 0 (Review Focus 2).
  - `new ApiError(400, "x") instanceof ProblemError` (import from `@/components/context/api`).
  - `createBrand("w", {…})` → `AbortSignal.timeout` called with `120_000`.
- [ ] **Step 2: Run** `npm test --prefix . -- tests/api-request.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; typecheck (every `ProblemError` importer compiles), lint, full test → green.
- [ ] **Step 5: Commit** (web) "Use one request helper everywhere, keep the server's error body, and read streamed answers".

### Task 3: Paywall event and the plan/credits store (web)

**Files:**
- Create: `lib/paywall.ts`, `lib/plan-credits.ts`
- Create: `components/shell/use-plan-credits.ts` (`"use client"`), `components/shell/paywall-stub.tsx` (`"use client"`)
- Modify: `components/settings/api.ts` (`request`: open the paywall on a 402 body or a 402 error line)
- Modify: `app/(shell)/layout.tsx` (mount `<PaywallStub workspaceId={workspaceId} />` next to `<PageViewTracker … />`)
- Test: `tests/paywall.test.ts`, `tests/plan-credits.test.ts`

**Interfaces:**
- Consumes: `request` (Task 2); `PaywallRefusal`, `isPlanRequired`, `isInsufficientCredits` from `@/shared`.
- Produces:
  - `lib/paywall.ts` (no React): `refusalOf(body: unknown): PaywallRefusal | null` — credits shape → `{ insufficientCredits: true, balance, needed }`; plan shape → `{ planRequired: true, title: body.title ?? body.detail ?? "This needs a plan" }`; else null. `openPaywall(r: PaywallRefusal): void`, `closePaywall(): void`, `currentPaywall(): PaywallRefusal | null`, `onPaywallChange(fn: () => void): () => void`.
  - `request`: when status is 402 (response or error line) and `refusalOf(body)` is not null → `openPaywall`, then throw as before.
  - `lib/plan-credits.ts` (no React): `type Subscription = { plan: { id: string; credits: number; renewsAt: string } | null; unlimited: boolean; plans: { id: string; credits: number }[] }`; `type PlanCredits = { credits: number | null; subscription: Subscription | null; failed: boolean; readAt: number }`; `planCredits(workspaceId: string): PlanCredits` (a shared frozen `EMPTY` for unknown workspaces; same object until it changes — `useSyncExternalStore` needs that); `loadPlanCredits(workspaceId: string, force = false): Promise<void>` (skip when `readAt` is under 30 000 ms old and not forced; one in flight per workspace; `GET /api/v1/workspaces/:w/credits` and `/subscription` together; on failure keep old values, `failed: true`; never rejects); `onPlanCredits(fn: () => void): () => void`.
  - `components/shell/use-plan-credits.ts`: `useCredits(workspaceId: string | null): { credits: number | null; failed: boolean; reload: () => Promise<void> }` and `usePlan(workspaceId: string | null): { loaded: boolean; planned: boolean; plan: Subscription["plan"]; unlimited: boolean; failed: boolean; reload: () => Promise<void> }` (`planned` = plan or unlimited). Both load on mount and on `window` `focus`; `reload` forces. Null workspace → empty values, no request.
  - `PaywallStub({ workspaceId }: { workspaceId: string | null })`: subscribes to the paywall store; when open, renders `Dialog`/`DialogContent`/`DialogTitle`/`DialogDescription` — plan: title = `r.title`, text "Plans aren't on sale yet. Ask us to turn one on for this workspace."; credits: title "Not enough credits", text `` `This needs ${needed} credits. The workspace has ${balance}.` `` — and calls `loadPlanCredits(workspaceId, true)` once per opening. Closing calls `closePaywall()`. 0c replaces it with `PaywallDialog`.

- [ ] **Step 1: Write failing tests:**
  - `tests/paywall.test.ts`: `refusalOf({ insufficientCredits: true, balance: 3, needed: 10, title: "x" })` → `{ insufficientCredits: true, balance: 3, needed: 10 }`; `refusalOf({ planRequired: true, detail: "Needs a plan" })` → title `"Needs a plan"`; `refusalOf({ title: "Payment Required" })` → null. Through `request` with `fetch` stubbed: a 402 credits body → `currentPaywall()` equals the refusal and the call rejects `ApiError` 402; a 402 HTML/unknown JSON body → `currentPaywall()` stays null (Review Focus 4); a streamed 402 error line with `planRequired` → paywall open with its detail as title. `closePaywall()` → null; a listener from `onPaywallChange` fires on open and close.
  - `tests/plan-credits.test.ts`: two concurrent `loadPlanCredits("w1")` → 2 fetches total (credits + subscription), not 4; values stored (`credits`, `subscription.plan`); a second load within 30 s → no fetch, with `force` → fetches; a failing fetch → `failed: true`, previous `credits` kept; a load for `w1` still in flight when `w2` loads → `planCredits("w1")` gets w1's answer and `planCredits("w2")` w2's (Review Focus 5); `planCredits("unknown") === planCredits("unknown2")` (same `EMPTY`).
- [ ] **Step 2: Run** `npm test --prefix . -- tests/paywall.test.ts tests/plan-credits.test.ts` → FAIL.
- [ ] **Step 3: Implement**, mount the stub.
- [ ] **Step 4: Run** → PASS; typecheck, lint, full test → green. Manual (dev app): in a workspace with no plan or 0 credits, press Run on an agent tile (`components/agents/agent-tile.tsx`; agent runs charge credits) → the stub dialog opens with the server's numbers or title, and the Network tab shows one forced `/credits` + `/subscription` read. If no 402 is reachable from the web today, say so in HANDOVER and rely on the tests.
- [ ] **Step 5: Commit** (web) "Open the paywall on any 402 the server sends, and keep one plan and credits store per workspace".

### Task 4: Shared contract check in web and mobile

**Files:**
- Create: `../web/scripts/check-shared.mjs`, `../mobile/scripts/check-shared.mjs` (same file; `LOCAL` = `"shared"` in web, `"src/shared"` in mobile)
- Modify: `../web/package.json` and `../mobile/package.json` (`"typecheck": "node scripts/check-shared.mjs && tsc --noEmit"`)
- Test: `../web/tests/check-shared.test.ts`

**Interfaces:**
- Produces: `export function hashTree(dir: string): string` — byte-for-byte the algorithm of server `scripts/sync-shared.mjs` (sorted relative paths with `/` separators, excluding `.hash`; `update(path) \0 update(bytes) \0`; hex sha256). Run as a script (guard `import.meta.url === pathToFileURL(process.argv[1]).href`), with the repo root taken from the script's own folder: compare with `<LOCAL>/.hash` (mismatch → `check-shared: <LOCAL> was edited by hand. Run npm run sync:shared in the server repo.` exit 1); if `${SERVER_DIR ?? "../server"}/shared/.hash` exists and differs → `check-shared: <LOCAL> is older than the server's shared/. Run npm run sync:shared in the server repo.` exit 1; else print `check-shared: ok <hash>` plus ` (server repo not found: only the hand-edit check ran)` when it is missing. One comment line: "Must hash exactly like server scripts/sync-shared.mjs."

- [ ] **Step 1: Write failing tests** (web): `hashTree("shared") === readFileSync("shared/.hash", "utf8").trim()`; copy `shared` to a temp dir (`mkdtempSync`), append a space to `index.ts` → `hashTree(tmp)` differs.
- [ ] **Step 2: Run** `npm test --prefix . -- tests/check-shared.test.ts` → FAIL.
- [ ] **Step 3: Implement** the script in web, copy it to mobile with `LOCAL = "src/shared"`, wire both `typecheck` scripts.
- [ ] **Step 4: Verify** in web: `npm test --prefix .` → PASS; `node scripts/check-shared.mjs` → `check-shared: ok 722c31f4…`; append a byte to `shared/index.ts` → exit 1 "edited by hand", then `git checkout shared/index.ts`; `SERVER_DIR=<tmp dir holding shared/.hash with other text> node scripts/check-shared.mjs` → exit 1 "older than the server's". In mobile: `node scripts/check-shared.mjs` → ok with the same hash; `npm run typecheck --prefix .` and `npx --prefix . expo lint` → green.
- [ ] **Step 5: Commit** in web and in mobile: "Fail the typecheck when the shared contract copy was edited by hand or is older than the server's".

### Task 5: `useJob` on the shared per-URL cache (web)

**Files:**
- Create: `components/workspace/use-job.ts`
- Modify: `components/workspace/content-panels.tsx:54-103` (move `POLL_MS`, the three maps and `useBrandData` out; add `export { useBrandData } from "@/components/workspace/use-job"` so `workspace.tsx` and `competitors-panel.tsx` keep their imports)
- Test: `tests/use-job.test.ts`

**Interfaces:**
- Consumes: `request`, `ApiError` (Task 2).
- Produces:
  - `type Intervals = readonly (readonly [untilMs: number, everyMs: number])[]`
  - `JOB_INTERVALS` (operations I9 table): `always: [[Infinity, 6_000]]`, `reelRender: [[120_000, 5_000], [600_000, 10_000], [Infinity, 30_000]]`, `photoshoot: [[Infinity, 5_000]]`, `photoshootList: [[Infinity, 10_000]]`, `preview: [[Infinity, 10_000]]`, `storyRender: [[60_000, 3_000], [Infinity, 10_000]]`, `publishing: [[Infinity, 5_000]]` (publishing's 10 min cap is the caller's `capMs: 600_000`).
  - `nextDelay(intervals: Intervals, elapsedMs: number, errors: number, rateLimited: boolean): number` — rate limited → 60 000; else the `everyMs` of the first step with `elapsedMs < untilMs` (last step if none), times `2 ** errors`, capped at 60 000.
  - `fetchShared(url: string): Promise<unknown>` — one in flight per URL; success stores the response and its time and notifies subscribers; failure rejects every waiter and stores nothing. `sharedResponse(url: string): unknown | undefined`, `subscribeShared(url: string, fn: (d: unknown) => void): () => void`.
  - `useJob<T>(url: string, opts: { pick: (d: never) => T; done?: (data: T) => boolean; intervals: Intervals; capMs?: number }): { data: T | null; failed: boolean; slow: boolean; reload: () => Promise<void> }` — starts from `sharedResponse`; fetches on mount unless the cached response is younger than half the current interval; while `data` is null or `!done(data)` (evaluated each render) and the tab is visible, chains `setTimeout(nextDelay(...))`; a tick whose URL was fetched by someone else within half the delay skips its own fetch; errors count up (reset on success), a 429 `ApiError` sets rate limited; hidden tab → no timer, `visibilitychange` to visible → fetch now and resume; `slow` = `capMs` passed since mount and not done; `reload` never rejects (failure sets `failed`); `pick` and `done` must be stable (module-level), as with `useBrandData` today.
  - `useBrandData<T>(base: string, path: string, pick: (d: never) => T)` = `useJob(\`${base}/${path}\`, { pick, intervals: JOB_INTERVALS.always })`, returning `{ data, failed, reload }` as before.

- [ ] **Step 1: Write failing tests:**
  - `nextDelay(JOB_INTERVALS.storyRender, 0, 0, false) === 3_000`, at `61_000` → `10_000`; `reelRender` at `0` → `5_000`, `130_000` → `10_000`, `700_000` → `30_000`; `storyRender` at 0 with 1 error → `6_000`; with 10 errors → `60_000`; rate limited → `60_000`.
  - `fetchShared`: two concurrent calls for `/a` → `fetch` called once, both resolve the same body, a subscriber fires once, `sharedResponse("/a")` is it; a later call fetches again; two concurrent calls that fail → both reject, `sharedResponse("/b")` undefined (Review Focus 3).
- [ ] **Step 2: Run** `npm test --prefix . -- tests/use-job.test.ts` → FAIL.
- [ ] **Step 3: Implement** and move `useBrandData`.
- [ ] **Step 4: Run** → PASS; typecheck, lint, full test → green. Manual (dev app, DevTools Network, filter `opportunities`): the Overview with four panels on `opportunities`/`content` sends one request per URL on load and one per 6 s; hidden tab → none; back → one at once.
- [ ] **Step 5: Commit** (web) "Poll jobs through one hook on the shared per-URL cache: one request in flight, backoff, stop when done, pause when hidden".

### Task 6: Move the two 3 s loops onto `useJob` (web)

**Files:**
- Modify: `components/workspace/content-panels.tsx:536-560` (`StoryFrames`)
- Modify: `components/workspace/release-panel.tsx:60-105` (`ReleasePanel` data, polling, `act`)

**Interfaces:**
- Consumes: `useJob`, `JOB_INTERVALS` (Task 5).
- Produces:
  - `StoryFrames`: `useJob(url, { pick: pickStoryView, done: (v) => !v.rendering, intervals: JOB_INTERVALS.storyRender })` with module-level `pickStoryView(d: Partial<StoryView>): StoryView` (the defaults it applies today); `useEffect(() => void reload(), [reload, version])`; `failed` replaces its local state.
  - `ReleasePanel`: `useJob(url, { pick: asRelease, done: notGoingOut, intervals: JOB_INTERVALS.publishing, capMs: 600_000 })`, `notGoingOut(d: Release)` = `!` the current `busy` expression; `useEffect(() => void reload(), [status, version, reload])`; `act` = `await request(url, POST…)`, `await reload()`, `onChanged()`; "Try again" calls `reload`. When `slow`, show one muted line under the attempts: "Still not confirmed. Check the account to see whether it posted." (I9: cap 10 min then "check the account").

- [ ] **Step 1: Implement** (no new unit: the behaviour is Task 5's, covered there).
- [ ] **Step 2: Run** typecheck, lint, full test → green; `npm run test:e2e --prefix . -- e2e/stories.spec.ts` with both servers up → passes as before.
- [ ] **Step 3: Manual** (dev app): open a story that is rendering → one `content/:id` request per 3 s, dropping to 10 s after a minute, stopping when rendered; hide the tab → no requests; show → one at once. A post being published → 5 s polls that stop when it is out.
- [ ] **Step 4: Commit** (web) "Poll story renders and posts going out through the shared hook, so they pause in a hidden tab and stop when done".

### Task 7: Feature flags (web)

**Files:**
- Create: `lib/features.ts` (`import "server-only"`)
- Modify: `.env.example` (`WEB_FEATURES=`, `WEB_FEATURE_WORKSPACES=`, one comment line each with the format)
- Test: `tests/features.test.ts`

**Interfaces:**
- Produces:
  - `type WebFeature = "library" | "photoshoot" | "reels" | "stories" | "inbox" | "automations" | "onboarding" | "plans"`
  - `featureOn(feature: WebFeature, workspaceId: string | null): boolean` — true when `feature` is in `WEB_FEATURES` (comma list, trimmed) or `` `${feature}:${workspaceId}` `` is in `WEB_FEATURE_WORKSPACES`; env read on every call.
  - `requireFeature(feature: WebFeature, workspaceId: string | null): void` — `notFound()` when off. Feature pages call it first, with `(await getShell()).activeWorkspaceId`.

- [ ] **Step 1: Write failing tests** (`vi.stubEnv`; mock `next/navigation` as `tests/server-fetch.test.ts` does): unset → `featureOn("reels", "w1")` false; `WEB_FEATURES=" reels, photoshoot"` → true for `reels` and any workspace, false for `inbox`; `WEB_FEATURE_WORKSPACES="inbox:w1"` → `inbox` true for `w1`, false for `w2` and for `null`; `requireFeature("plans", "w1")` with nothing set → `notFound` called; when on → not called.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; typecheck, lint, full test → green.
- [ ] **Step 5: Commit** (web) "Add website feature flags, on for everyone or for listed workspaces, read from the environment".

### Task 8: Framing and CSP headers (web)

**Files:**
- Modify: `middleware.ts:15-27`
- Modify: `.env.example` (`STORAGE_ORIGIN=` — "the origin signed media links point at, e.g. https://<bucket host>; allowed for media and uploads in the CSP")
- Test: extend `tests/middleware.test.ts`

**Interfaces:**
- Produces: `contentSecurityPolicy(nonce: string, storageOrigin?: string): string` (exported) =
  `default-src 'self'; script-src 'self' 'nonce-<n>' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: <storage>; connect-src 'self' <storage>; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'` (`<storage>` omitted when unset). Every response the middleware returns (redirect and pass-through) carries `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'` and `Content-Security-Policy-Report-Only: <policy>`. The pass-through also sets the **request** header `content-security-policy-report-only` to the same policy (Next reads the nonce from it and stamps its scripts); never set `content-security-policy` on the request, or Next reads that one and finds no nonce. Nonce: `btoa(crypto.randomUUID())`, new per request. `STORAGE_ORIGIN` read per request.

- [ ] **Step 1: Write failing tests:** a signed-in page response has `x-frame-options: DENY`, `content-security-policy: frame-ancestors 'none'`, a report-only policy containing `'nonce-` and `default-src 'self'`; two requests get different nonces; `x-middleware-request-content-security-policy-report-only` equals the response's report-only header; no `x-middleware-request-content-security-policy`; the no-cookie redirect also has `x-frame-options: DENY`; `vi.stubEnv("STORAGE_ORIGIN", "https://media.example")` → `media-src` and `connect-src` include it; unset → no `undefined` in the policy.
- [ ] **Step 2: Run** `npm test --prefix . -- tests/middleware.test.ts` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; typecheck, lint, full test → green.
- [ ] **Step 5: Verify the nonce reaches the page:** `npm run build --prefix .`, `STORAGE_ORIGIN=https://media.example npm run start --prefix .`, then `curl -si -b "authjs.session-token=x" http://localhost:3100/ | grep -iE "x-frame-options|content-security|nonce="` → both headers, the storage origin, and `<script … nonce="…">` matching the header's nonce (the page itself may redirect to `/login` after the server's 401; check `/login` too and record whether its scripts carry the nonce — a static page won't, see Review Focus).
- [ ] **Step 6: Commit** (web) "Refuse framing on every page and start a report-only content security policy with per-request script nonces".

### Task 9: Link, lint and bundle hygiene (web)

**Files:**
- Modify: `components/context/doc-pane.tsx:40-50, 316` (delete `safeHref`; use `safeHttpUrl(source.url)?.href ?? null`)
- Modify: `components/products/products-board.tsx:145-151` (link only when `safeHttpUrl(p.url)`, else the plain `<p>`; add `noopener` to `rel`)
- Modify: `eslint.config.mjs` (in `boundary()`: add `"twilio"`, `"fflate"` to `paths`, `"@elevenlabs/*"` to the first `patterns` group; new block `{ rules: { "react/no-danger": "error" } }` after the `compat.extends(...)` spread)
- Modify: `scripts/check-bundle.mjs` (public name check before the `.next` check)
- Verify: by the commands in Step 2 (no new unit test: `safeHttpUrl` is the existing shared helper; the guards are lint and script exits)

**Interfaces:**
- Produces: in `check-bundle.mjs`, `PUBLIC_ALLOW = []` (names allowed despite the pattern, each with a comment why) and a scan of `app`, `components`, `lib`, `shared` (`.ts/.tsx/.mjs`), `.env*`, `Dockerfile`, `next.config.ts` and `Object.keys(process.env)` for `/NEXT_PUBLIC_[A-Z0-9_]+/g`; any name matching `/SECRET|KEY|TOKEN/` and not allowed → `check-bundle: NEXT_PUBLIC_ name looks like a secret: <name> (<file>)`, exit 1. Header comment updated.

- [ ] **Step 1: Implement** the four changes.
- [ ] **Step 2: Verify** each guard fails when it should (Git Bash, web repo):
  - `printf 'import "twilio";\nimport "@elevenlabs/elevenlabs-js";\nimport "fflate";\nexport const X = () => <div dangerouslySetInnerHTML={{ __html: "" }} />;\n' > components/zz-guard.tsx && npx --prefix . eslint components/zz-guard.tsx; rm components/zz-guard.tsx` → 4 errors (3 × "Server-only", 1 × `react/no-danger`).
  - `NEXT_PUBLIC_MAPS_KEY=x node scripts/check-bundle.mjs` → exit 1 naming `NEXT_PUBLIC_MAPS_KEY (env)`.
  - `npm run build --prefix .` then `npm run check:bundle --prefix .` → passes, "none of N secret names".
  - `npm run lint --prefix .` → 0 errors (no existing `dangerouslySetInnerHTML`, per security B9); typecheck, full test → green.
- [ ] **Step 3: Manual:** a product whose `url` is `javascript:alert(1)` (set in dev DB or by editing the response in DevTools overrides) shows as plain text, not a link.
- [ ] **Step 4: Commit** (web) "Link only http(s) addresses, forbid raw HTML and server-only packages in the website, and fail the build check on secret-looking public env names".

### Task 10: Documentation and whole-slice check

**Files:**
- Modify (server): `docs/HANDOVER.md` — a "Foundations 0b" entry: what changed, new web envs (`WEB_FEATURES`, `WEB_FEATURE_WORKSPACES`, `STORAGE_ORIGIN`), the check-shared failure messages and their fix, the Review Focus "also watch" items, and the CSP report-only → enforce step (make static pages dynamic first).
- Modify (server): `docs/DEPLOY_EC2.md` — the three web envs on the Web Frontend service.

- [ ] **Step 1: Edit** both files; commit in server: "Document the website's new settings, the shared contract check and the path to enforcing its CSP".
- [ ] **Step 2: Web:** `npm run typecheck --prefix .` (runs check-shared), `npm run lint --prefix .`, `npm test --prefix .`, `npm run check:net --prefix .`, `npm run build --prefix .`, `npm run check:bundle --prefix .` → all green.
- [ ] **Step 3: Mobile:** `npm run typecheck --prefix .`, `npx --prefix . expo lint` → green.
- [ ] **Step 4: e2e:** `npm run test:e2e --prefix .` in web (servers started from each repo); record the result in HANDOVER.
- [ ] **Step 5:** request a whole-branch review (superpowers:requesting-code-review) across web and mobile before calling 0b done.
