# Step 0 · Foundations for bringing the mobile flows to the web — design

Date: 2026-11-17. Status: approved by the owner 2026-11-17.
Repos (side by side): `apps/server`, `apps/web`, `apps/mobile`, each its own git repo on `main`.
Inputs: the six-lens "before" review in `docs/handover/2026-11-17-mobile-web-parity-review/` (parity, security,
sync-architecture, operations, design-ux, accessibility). Finding ids below (A1, C2, I6…) refer to those files.

## 1. Intent

The owner wants everything a person can do on the phone to be possible on the web, with the **same steps, the same
choices and the same server calls**, laid out for desktop inside the web workspace (decided 2026-11-17; not a literal
copy of the phone screens). Eight features follow in this order: 1 brand look & feel + photo library, 2 photoshoot,
3 reels studio, 4 stories editing + post from a brief, 5 customer inbox + Google reviews/posts, 6 automations + credits,
7 fuller onboarding, 8 plans.

The review showed the web can't take those features on safely yet: paid rules live only in the phone app, paid writes
can charge twice, the browser cuts requests at 30 s, there is no CSRF/framing defence beyond SameSite=Lax, and the web
has no credits, paywall, shared status/page parts or contract with the server. Step 0 builds those once, so each of the
eight features is UI work on a safe, shared base. One finding is live today on the phone (A1, voice cloning) and is
fixed here.

## 2. Goals, non-goals, anti-goals

Goals
- The server, not a client, enforces every paid and plan rule the features rely on.
- A retry, double click or timeout never charges twice or creates a second record for the paid starts in scope.
- Browser-session writes are protected against cross-origin and framed requests.
- The web can make long and streamed calls, tells "no plan" from "not enough credits", and shows credits and a paywall.
- One server-owned contract of types/constants, copied into web and mobile, with a check that fails on a stale or
  hand-edited copy.
- Shared web parts (page header, status badge, job progress, credits chip, paywall) so the eight features look like one
  product.
- The four critical accessibility faults in the web shell are fixed.

Non-goals (land with their feature, per the review's order)
- Any of the eight features' screens. Media picker (feature 1), audio recorder (feature 3), story bucket CORS (4),
  inbox permission key (5), onboarding sign-in and SSRF pinning (7), plan purchase (8).
- Idempotency for non-paid creating writes (post from brief, inbox send, Google post, brand create): each gets the
  same `requestId` mechanism in its own slice.
- Translations on the web. A push channel instead of polling. Prisma `relationJoins`.

Anti-goals (would make this a failure even if it works)
- Changing what existing phone builds get, except where stated (A1 clone challenge, re-render confirmation). Every other
  server change is additive and optional for old callers.
- A second implementation of something that exists (rate limiter, STT matcher `saysTheScript`, `safeHttpUrl`,
  `useBrandData` cache, settings tab scaffolding).
- Hiding the WebM change behind ffmpeg auto-detect (B1).

## 3. Decisions already made (owner, 2026-11-17)

- Same steps/choices/server calls as mobile, desktop layout on web.
- Order: step 0 (this), then features 1–8 as above.
- Reel planning (`POST /reels`, `POST /reels/:id/plan`, plan edits/chat): needs **any active plan**, plus a **rate
  limit (about 20 plans an hour per brand)**, **no credit charge**.
- Inbox and Google: **open to any plan** until pricing is real (pricing is off; nobody can upgrade). The server does not
  gate them by plan.
- Keeping clients in sync: server-owned contract folder copied into both clients with a hash check (vendored copy;
  a published package or git dependency is too heavy right after the split).
- Voice cloning: the person reads a random sentence; the server checks it with the speech-to-text it already has.

## 4. Approaches considered

| Area | Options | Picked | Why |
|---|---|---|---|
| Contract between server and clients | npm package; git dependency; OpenAPI-generated client; vendored copy + hash check | Vendored copy + check (owner agreed) | Matches the "copy into each" decision made at the split; low cost; catches drift at typecheck. Upgrade path: the same folder becomes a git dependency if the repos stop sitting side by side. |
| Double-charge protection | Disable the button only; server dedupe by time window; client `requestId` used as the record id and charge `refId` | Client `requestId` | Stories already use it; the ledger's unique `refId` guard (`credits.ts:50-57`) then makes a retry free. A time window guesses; a disabled button doesn't survive a timeout or a second tab. |
| CSRF | Per-route Origin checks; CSRF tokens; one middleware check on cookie writes | One middleware check (`Sec-Fetch-Site` / `Origin`) | One place, covers every route, no client change; `me/context` already does it per route and becomes the duplicate to delete. |
| Web polling for jobs | Keep `useBrandData` as is; new poller per feature; one `useJob` on `useBrandData`'s cache | One `useJob` | One fetch per URL shared by panels and routes; adds stop-at-terminal, backoff, hidden-tab pause. |
| Paid-start rollout | Ship features directly; flags per feature + a paid kill switch for web | Flags + kill switch | Lets a web bug stop spending without stopping the phone; no table needed (env lists). |

## 5. Design

Built in three slices, in this order. Each is its own plan and its own commits (0a in server, plus the mobile changes
it names; 0b and 0c in web, plus server where named).

### 0a · Server safety (server repo; small mobile changes)

1. **Voice-clone challenge (A1, live today).**
   - The challenge is the existing clone passage with its sentences in a **random order** per attempt, in the person's
     language, repeated in a second (differently shuffled) round so the reading fills 60–90 s (the passages are
     57–98 words, about 25–40 s spoken). *(Settled from the builder check: the clone needs 60–90 s of speech (`clones.ts:23`) and `saysTheScript`
     matches both ways, so a short challenge inside a long take would fail; a shuffled full passage fills the take,
     keeps the one matcher, and needs no new translations.)* The 24 translated passages move from mobile's i18n
     (`clone.passage`) into `shared/contract/clone-passages.ts`, which the server reads; mobile shows what the server
     returns.
   - `GET /voices/clones/challenge?lang=xx` returns `{ challengeId, sentences }`, stored with a 10-minute TTL, single
     use, bound to user + workspace (storage is the builder's call).
   - `POST /voices/clones` requires `challengeId`. The server transcribes with the same STT `uploadRecording` uses
     (in the challenge's language) and requires `saysTheScript(challengeText, transcript)`
     (`server/reels/recordings.ts:33`); reuse it, no second matcher. A failed match is 422 `clone.notTheChallenge`
     ("Read the sentences on screen, in that order"). Store `challengeId` and a transcript hash in the consent record.
   - Mobile `reels/clone.tsx` fetches the challenge, shows its sentences instead of the fixed passage, and sends
     `challengeId`. A request without `challengeId` gets 409 `clone.updateApp` (the one deliberate break for old
     builds; see §7).
2. **Idempotent paid starts.** Optional `requestId` (UUID, made once per form submit) on `POST /photoshoots`,
   `POST /voices/clones` and `POST /reels`. When present it is the record id and the charge `refId`; a repeat with the
   same id returns the existing record (200) instead of starting again. Without it, behaviour is unchanged. Mobile sends
   one on photoshoot and clone.
   - `POST /reels` writes its record only after both AI calls finish, so a repeat **while the first is still running**
     must not start a second run. *(Builder's call, settled here: no placeholder reel in the list.)* Keep an in-flight
     marker keyed by `requestId` (a rate-limit-style row with a 6-minute expiry); a repeat while it is held answers 409
     `reel.stillPlanning` and the client polls the reel list for the record with that id. Mobile's create flow is
     unchanged (it doesn't send `requestId` yet).
3. **Re-render confirmation (parity #3).** *(Settled from the builder check: "already has a video" means the **latest
   plan version** has a DONE render, which is exactly what the phone checks at `reels/storyboard.tsx:33-39`. An edit
   writes a new version without a render, so edit-then-render is unaffected.)* `startRender` refuses a reel whose latest
   version already has a DONE render with 409 `render.alreadyDone` unless the body has `again: true`. The phone never
   calls render in that case (it opens Review), so **no mobile change**; the rule exists so the web and any stale tab
   can't buy the same video twice.
4. **Reel planning gate (owner decision).** `createReel` and `chatPlan` (the calls that run the scriptwriter) call
   `requirePlan(workspaceId)` and a rate limit before the scriptwriter call:
   `hitRateLimit(limitKey("reel-plan:brand", brandId), 20, 1h)` (reuse `server/auth/rate-limit.ts`). *(Settled from the
   builder check: manual storyboard edits through `editPlan` get the plan check but are **not counted** in that bucket,
   so ordinary editing on the phone never hits 429; their director call stays under the existing content-edit limit.)*
   Refusals: 402 `planRequired` (existing shape), 429 with the existing rate-limit problem.
5. **CSRF check (A2).** In server `middleware.ts`, for `/api/v1/*` with a non-GET/HEAD/OPTIONS method and **no**
   `Authorization: Bearer` header: allow when `Sec-Fetch-Site` is `same-origin` or `none`, or when `Origin` is in an
   allowlist (`AUTH_URL`'s origin plus `WEB_ORIGINS`, a comma env for dev origins); else 403. Exempt `/webhooks/*`,
   `/jobs/run`, `/integrations/*/callback`, `/mobile/*`. Then delete the per-route check in `me/context`.
   - The web's own server-side writes go through `serverFetch` with the cookie but no browser headers
     (`web/app/(shell)/admin/people/[userId]/page.tsx:14`, `admin/workspaces/[workspaceId]/layout.tsx:15`):
     `serverFetch` sends the web's origin as `Origin`, so they pass. *(Found in the builder check.)*
6. **WebM recordings (B1, I3).** Add a WebM magic-byte sniff (`1A 45 DF A3`) next to `isM4a` and a second explicit ffmpeg
   branch (`-f matroska` with the same `-protocol_whitelist file`). Never auto-detect. Applies to `/recordings` and
   `/voices/clones`.
7. **Inbox and Google reads cache (C3).** A 45 s per-brand cache of the inbox list and Google reviews/posts reads, in a
   DB row (several API instances in the scaled setup), invalidated on a reply or post sent. The 30/min per-brand limit
   then protects the provider quota, not the clients. No plan gate (owner decision).
8. **Fewer queries per brand route (I6).** `authorizeBrandRoute` computes `effectivePermissions` once and checks
   `brand.read` plus the route's permission from that set; drop the separate `requireWorkspaceMember` (the role read
   proves membership). Error types unchanged. Stop `ensureStarterGrant` on balance reads (I7). 7–9 → 4–5 round trips on
   every brand route, both clients.
9. **Client tag and paid kill switch (I11).** Clients send `X-Client: web/<version>` or `mobile/<version>`. Env
   `PAID_STARTS_OFF_FOR=web` makes paid starts (render, photoshoot, clone, presenter/preview, agent runs) answer 503
   "Making this from the website is paused". Each paid start logs `feature, client, workspaceId, refId, outcome, ms`
   (I12) and puts `client` in its audit metadata.
10. **Secret names (B6).** Add `ELEVENLABS_API_KEY`, `GOOGLE_MAPS_API_KEY`, `HIGGSFIELD_API_KEY_SECRET`,
    `TWILIO_AUTH_TOKEN`, `EXPO_ACCESS_TOKEN`, `CREDENTIALS_ENCRYPTION_KEY_1` to `.env.example` so the web bundle check
    covers them.
11. **Contract scaffolding.** `shared/contract/errors.ts` (move `ApiProblem` from `server/api/http-error.ts`; the two 402
    shapes as `PaywallRefusal`; guards `isPlanRequired` / `isInsufficientCredits`; error-code union starting with the
    codes this slice adds). `scripts/sync-shared.mjs` copies `shared/**` to `../web/shared/` and
    `../mobile/src/shared/` and writes `shared/.hash`. Feature contracts (`photoshoot.ts`, …) arrive with each feature.

### 0b · Web plumbing (web repo; check script also in mobile)

1. **Transport (`lib/net.ts`, additive).** `timeoutMs` per call (default stays 30 s; 120 s for clone/recording/brand
   create, 330 s for reel plan/chat); an NDJSON `onLine` reader for streamed replies; `ApiError.data` keeps the parsed
   body. Every call sends `X-Client: web/<version>`. A `requestId()` helper for paid/creating submits; buttons disable
   while a request is in flight. Fold the second `request()` helper into this one (sync report I-finding).
2. **Contract check.** `scripts/check-shared.mjs` (about 20 lines) in web and mobile: recompute the hash of the local
   `shared/`, compare with its `.hash` (hand edit) and with `../server/shared/.hash` when present (stale copy). Hooked
   into `typecheck`. Mobile adopts the copy at `src/shared` by import, one feature at a time.
3. **`useJob(url, { done, intervals, capMs })`** on `useBrandData`'s shared cache: one request in flight per URL, chained
   timeouts, stop at a terminal state, doubling backoff on errors up to 60 s, respect 429, pause in a hidden tab and
   refetch on show. Interval table from operations I9. Also fix the existing 3 s loops that ignore visibility
   (`content-panels.tsx:555-558`, `release-panel.tsx:81-85`).
4. **Plan and credits store.** `usePlan` / `useCredits`: load on focus and after a paid action, no timer. Every 402 from
   any call opens the paywall (0c) with the refusal's data.
5. **Feature flags.** `WEB_FEATURES` (comma list) and `WEB_FEATURE_WORKSPACES` env on the web, read in server components
   to show nav entries and routes. Unflagged routes 404.
6. **Web security headers and hygiene (A3, A13, B6, B9, B11).** `frame-ancestors 'none'` + `X-Frame-Options: DENY` on
   all pages; a CSP in report-only mode (`default-src 'self'`, storage origin for img/media/connect, nonce scripts).
   `react/no-danger: error`. One `safeHttpUrl` for every rendered link (replace `doc-pane.tsx` `safeHref`,
   `workspace.tsx` `safeSite`, and the unchecked `products-board.tsx:146`). Bundle check fails if a `NEXT_PUBLIC_*` name
   contains SECRET/KEY/TOKEN (explicit allowlist). Ban `twilio`, `fflate`, `@elevenlabs/*` in web eslint.

### 0c · Web UI kit and accessibility (web repo)

1. **Page parts.** `PageHeader` (title, description, actions; one title size) and `PageSection` (card on the grey page,
   `px-5`, per `DESIGN_SYSTEM.md` §4). Apply to the existing pages outside the Overview (settings, products, context,
   connections, agents, performance) so they share one layout.
2. **`StatusBadge`.** One component, one map of statuses to tone, at least 4.5:1 contrast. Replace the five existing
   pill implementations.
3. **`JobProgress`** card on `useJob`: steps with state, a progress value, "taking longer than usual, keep waiting or
   retry" after the cap, polite live-region announcements.
4. **Credits chip and paywall.** A credits chip in the top bar (balance; opens Settings → Plan & credits once feature 6
   exists, a small popover until then). `PaywallDialog` for both refusals: "needs a plan" and "not enough credits
   (balance, needed)". Paid buttons show their price, from the server.
5. **Navigation.** Sidebar groups Create and Customers, entries behind the feature flags (empty groups hidden). Add
   `/studio` and the new routes to `lib/nav.ts` so breadcrumbs are right.
6. **Accessibility criticals (C1–C3 of the a11y report) plus cheap wins.**
   - Sidebar below `md`: collapses into a `Sheet` with a menu button; `overflow-x: clip` no longer hides overflow.
   - "Create a business" is a real menu item (arrow keys, Enter), not a plain button inside the Radix menu.
   - Panel "Move left/right", "Hide panel": focus moves to the moved panel's header (or the Layout button when hidden),
     with a live-region message.
   - Page titles per route (`<title>` from `lib/nav.ts`), a skip link, the loading placeholder visible against cards.
   - Extend `scripts/audit-ui.ts` with a 320 px pass and the new routes.

## 6. Constraints

- Dev latency: each DB round trip is ~170 ms from the dev machine to Neon Frankfurt; production runs the API in
  eu-central-1 (assumed by the operations review; `DEPLOY_EC2.md` should state it).
- npm 11 `allowScripts`: new dependencies with install scripts need approval in `package.json`.
- Repos sit side by side; scripts reach siblings at `../server`, `../web`, `../mobile` (overridable by env).
- The web has Next 15 / React 19; mobile has Expo 58 / RN 0.88 / React 19.3. Contract files are plain TS, no zod, no
  Node imports.
- Commit messages: no co-author or tool lines, no test talk (owner's rule).

## 7. Risks and how this fails

- **Old phone builds and the clone challenge.** A build without `challengeId` can no longer clone (409 `clone.updateApp`).
  The owner confirmed on 2026-11-17 that no released build (store or TestFlight) uses cloning, so there is **no grace
  window**.
- **Origin check false positives.** A proxy that strips `Origin`/`Sec-Fetch-Site` would 403 real writes. Mitigation:
  the allowlist env, a log line on every 403 with the headers seen, and a dry-run mode (log, don't block) for the first
  deploy.
- **Cache staleness (inbox/Google).** Up to 45 s old, refreshed on send; the person has a Refresh button (feature 5).
- **Hash check without the server checked out.** Only the "edited by hand" half runs; documented.
- **Kill switch is env-based.** Changing it needs a restart of the API; acceptable at this scale.

## 8. Left to the builder

- TTL storage for the clone challenge and the reel in-flight marker (existing rate-limit table vs a new small table).
- Cache table shape for inbox/Google; whether the rate-limit table can host it.
- Component APIs of `PageHeader`, `StatusBadge`, `JobProgress`, `PaywallDialog`; the status→tone map.
- Which existing pages move to `PageHeader`/`PageSection` in 0c versus with their feature, as long as every page outside
  the Overview uses them by the end of 0c.
- Test shape: server vitest for each 0a behaviour (challenge accept/reject, requestId repeat, re-render 409, plan gate,
  rate limit, Origin allow/deny matrix, WebM sniff, cache invalidation, query count); web vitest for `net.ts`, `useJob`,
  the paywall; the a11y audit script for 0c.

## 9. Open decisions held for later slices (owner's)

- Should Creators spend the whole workspace's credits (A7)? Before feature 2 (photoshoot).
- Should project Viewers read customer DMs (A11)? Before feature 5.
- Should email-code sign-in on the web create new accounts (parity #1, B7)? Before feature 7.
- Web translations (24 languages on the phone)? Before any feature ships to non-English customers.
- Captions on reels (a11y)? Before feature 3.
