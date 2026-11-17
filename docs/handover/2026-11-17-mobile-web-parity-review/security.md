# Mobile → web parity: security and permissions review (before)

Reviewer lens: security and permissions. Read-only review of `apps/server`, `apps/web`, `apps/mobile` as of 2026-11-17 (branch `desktop-shell`). Paths below are relative to `apps/server` unless prefixed `web/` or `mobile/`.

## The one thing to understand first

**Every "mobile-only" route already accepts a web cookie session today.** `requestUserId` (`server/auth/request-user.ts:26-31`) takes a Bearer token if one is sent and otherwise falls back to the Auth.js cookie. `authorizeBrandRoute` (`server/api/brand-route.ts:15-33`) uses it for every brand route. So the migration does not open new routes to cookie callers. They are already open, and their CSRF/abuse exposure is "existing". What the migration adds is real browser callers. That brings browser-only risks: framing, XSS reaching paid actions, double-submits after browser timeouts, file pickers in place of a live microphone, server-side proxies that hide the client IP, and S3 CORS.

How cookie-authenticated writes are defended today:
- **SameSite=Lax session cookie.** This is the Auth.js default. `auth.config.ts:8-11` sets no cookie override, so the default stands and there is no "Lax+POST 2-minute" exception. Cross-site POST/PATCH/PUT/DELETE arrive without the cookie, so classic cross-site CSRF is blocked.
- **No Origin check, no Sec-Fetch-Site check, no content-type enforcement.** The only exception is `POST /me/context` (`app/api/v1/me/context/route.ts:14-23`). It requires JSON and `Origin === AUTH_URL` origin, because, in its own words, "SameSite=lax alone leaves same-site subdomains able to send it". Every other route parses `request.json()` whatever the content-type, so a `text/plain` form post with a JSON body is a valid "simple request". The multipart routes (`/media`, `/recordings`, `/voices/clones`) are simple requests by definition.
- **CORS** (`next.config.ts:16-31`): dev only, `Allow-Origin: http://localhost:8090` (Expo web preview), no `Allow-Credentials`. A cross-origin page therefore never gets a cookie-authenticated response it can read. Production sends no CORS headers. The web app needs none, because it reaches `/api` same-origin (dev rewrite in `web/next.config.ts`, the load balancer in production).
- **`X-Workspace-Id`** is optional (`server/api/workspace-headers.ts`), so it is no preflight-forcing defense.

---

## A. Existing issues (true today)

### Critical

**A1. Voice cloning does not check that the voice belongs to the person who consents.**
- Evidence: `server/reels/clones.ts:52-59`. Consent is a form field (`consent === "1"`, `voices/clones/route.ts:28`). The audio is checked only for container (`isM4a`) and duration (60–90 s). The passage the phone shows (`mobile/src/app/reels/clone.tsx:135-136`) is never verified server-side, and it is fixed text, so it is no challenge. `consent.appVersion` is client-supplied.
- Risk: any account with `voices.manage` (every workspace Owner/Admin, i.e. every self-signed-up user) can POST 60–90 s of anyone's voice (a podcast clip remuxed to M4A) and get an ElevenLabs clone. The workspace can then use it in reels and Higgsfield presenter videos. This is impersonation and deepfake harm to a third party, and the consent record (`audioSha256`, text version) proves nothing. It is reachable today with a cookie or a token and `curl`. A web UI with a file `<input>` would make it one click.
- Fix (before the reels/voices web slice):
  1. Make each clone attempt a challenge. `GET /voices` returns a short random sentence set plus a nonce (stored, 10-minute TTL, single use). The client must read it.
  2. On `POST /voices/clones`, transcribe with the same STT `uploadRecording` uses and require `saysTheScript(challenge, transcript)` (`server/reels/recordings.ts:33`). Reuse it; don't write a second matcher.
  3. On web, record only with `getUserMedia`/`MediaRecorder`. No file picker.
  4. Record the nonce and the transcript hash in `consent`.
- Ceiling: a determined attacker can still play back TTS of the target. The challenge raises the cost from zero to a lot and makes the consent record meaningful.

### Important

**A2. No Origin/Fetch-Metadata check on cookie-authenticated writes (only SameSite=Lax).**
- Evidence: see the "first" section. `middleware.ts:10-16` only rolls the cookie. The single Origin check is `me/context/route.ts:21-23`.
- Risk: any same-site origin can send cookie-authenticated writes. That includes a sibling subdomain (marketing site, docs, a future user-content or preview host), and any XSS or subdomain takeover on one. The migration puts credit-spending and publishing actions behind those writes (render, photoshoot, presenter, preview, clone, Google post, review reply, inbox send).
- Fix (one change, before the first web slice ships a paid action): generalise the `me/context` check into the server `middleware.ts`. For `/api/v1/*` with method ≠ GET/HEAD/OPTIONS **and no `Authorization: Bearer`** header, require `Sec-Fetch-Site ∈ {same-origin, none}` or `Origin` ∈ an allowlist (`AUTH_URL` origin plus dev web origin), else 403.
  - Exempt the routes that are not cookie-authenticated: `/webhooks/*`, `/jobs/run` (CRON_SECRET), `/integrations/*/callback` (GET anyway), and `/mobile/*` (no cookie; Bearer or none).
  - Then delete the now-duplicate check in `me/context` (rule 5: one implementation).
  - Failure mode to test: the dev rewrite proxy forwards the browser's `Origin` (`http://localhost:3000`), so put the dev web origin in the allowlist via env, not hard-coded.

**A3. No clickjacking or CSP protection on the web app.**
- Evidence: `web/next.config.ts` has no `headers()`. `web/middleware.ts` sets none. There is no `X-Frame-Options`, `frame-ancestors` or CSP anywhere.
- Risk: any site can frame the signed-in web app and trick one click. The web already has Approve/Publish today. After migration that one click can be "Make video" (credits), "Generate" photoshoot (credits), "Send reply" to a customer, "Publish" a Google post, or the voice-clone consent tick. Without a CSP, any XSS gets the full cookie session, and httpOnly does not stop same-origin `fetch`.
- Fix (before reels/photoshoot on web): `Content-Security-Policy: frame-ancestors 'none'` plus `X-Frame-Options: DENY` on all web pages. Start a CSP: `default-src 'self'`; `img-src`/`media-src` limited to `'self'`, the storage endpoint origin and Google avatar hosts; `connect-src 'self'` plus the storage origin (for presigned PUTs); scripts by nonce. Ship it report-only first.

**A4. SSRF guard is open to DNS rebinding (check-then-fetch).**
- Evidence: `server/research/crawl.ts:68` resolves and checks the host, then `:85` `fetch(url)` resolves it again. Nothing pins the checked IP.
- Risk: a hostname that answers public then private (TTL 0) passes `assertPublicUrl` and the fetch goes to `169.254.169.254`, `10.x` or the DB host. `site-check` only returns a boolean, but the same `safeFetch` feeds Research (page text goes into context docs the user reads) and brand-asset image fetches. EC2 with IMDSv1 would leak credentials. `/site-check` is unbrandscoped, and onboarding on web makes it a public-form-adjacent endpoint.
- Fix (before the onboarding slice): pin the resolved address. Use an undici `Agent` with a `connect.lookup` that re-runs `isPrivateAddress` on the address actually connected to (one place, `safeFetchBytes`), so every hop and every caller is covered. Enforce IMDSv2 (hop limit 1) on the hosts as a second layer.

**A5. Reel planning runs two AI calls per request with no rate limit and no charge.**
- Evidence: `POST /reels` (`app/api/v1/.../reels/route.ts:27-34`) and `POST /reels/:id/plan` (`reels/[contentId]/plan/route.ts:12-23`) → `createReel`/`chatPlan` (`server/reels/service.ts:112-173`). There is no `hitRateLimit` (the only one in the reel service is the re-check, `:219`), no `postAiAllowed`, no credits.
- Risk: a loop in devtools (or a stuck client retry) burns OpenAI spend without bound, 120 s each. Compare the general content edit path, which is capped by `postAiAllowed` (`content/[contentId]/route.ts:97-103`), and chat (`CHAT_LIMIT`).
- Fix (before the reels slice): add `hitRateLimit(limitKey("reel-plan:user", userId), …)` plus a per-workspace daily cap, like `postAiAllowed`. Put it before the scriptwriter call in both functions.

**A6. Photoshoot creation is not idempotent, so a double submit charges twice.**
- Evidence: `server/photoshoot/shoot.ts:78-83`. The `refId` is a fresh `randomUUID()` each call, so `spendCredits`' duplicate guard (`server/services/credits.ts:50-57`) never matches. Compare reels (`render.ts:110-160`, locked and attempt-keyed) and presenter/preview (`reels/assets.ts:30-45`, which refunds via a unique index).
- Risk: the web `send()` helper times out writes at 30 s (`web/lib/net.ts:27`) while the request keeps running on the server. A user who sees "server took too long" and clicks again pays twice. Double-clicks do the same.
- Fix (before the photoshoot slice): accept a client `requestId` (UUID made once per form submit) and use it as the `refId` and the `PhotoShoot.id`. The duplicate guard then makes the retry free. Disable the button while a request is in flight.

**A7. Any project role with `content.create` spends workspace-wide credits.**
- Evidence: render (`reels/[contentId]/route.ts:53`), presenter, preview, photoshoot and recordings all authorize on `content.create`. "Creator" has it (`server/auth/permissions.catalog.ts:48`). Credits are per workspace (`spendCredits` keys on `workspaceId`).
- Risk: on the phone this is mostly the owner. The web is where multi-member teams with project roles work. A Creator on project A can spend the whole workspace's balance, which also funds projects B and C.
- Fix (decide before the reels/photoshoot slices): either a `credits.spend` permission (PROJECT scope, in Manager and Project admin, not Creator), checked with `content.create` on paid routes, or a per-member monthly cap. Writing it down as accepted is also a valid outcome, but make it a decision.

**A8. Sign-in rate limits are per IP, and the IP is the right-most `X-Forwarded-For`.**
- Evidence: `server/auth/rate-limit.ts:36`. `sendEmailCode` uses `mobile-code:ip` (30/15 min), `sendPhoneCode` uses `mobile-sms:ip` (20/15 min) plus a **global** `mobile-sms:all` of 300/h (`server/services/mobile-auth.ts:187-193`).
- Risk today: SMS pumping (toll fraud). Each text is paid, and one bot can use up the global 300/h, which blocks SMS sign-in for everyone (by design, a cost cap). See B5 for what web adds.
- Fix: in Twilio, enable Geo Permissions for launch countries only and Fraud Guard (already noted as a ponytail in code).

### Minor

- **A9. Upload size pre-check trusts `Content-Length`.** `media/route.ts:25-30`, `recordings/route.ts:21-26` and `voices/clones/route.ts:20-26` reject on the header, then `request.formData()` buffers the whole body before `file.size` is checked. A chunked request without `Content-Length` makes the server buffer any size. This needs an authenticated attacker. Fix: put a body-size cap at the load balancer/nginx for `/api/v1` (for example 6 MB, more on the clone/recording paths), or stream with a byte counter.
- **A10. A side-effecting GET.** `GET /stories/:id/package` (`stories/[contentId]/package/route.ts:18-30`) uses up the per-user 20/h download limit and writes an audit event. Lax cookies are sent on top-level cross-site navigation, so a link elsewhere can trigger it. Low impact. Accept it, or count only `format=zip`.
- **A11. Customer DMs are readable with `brand.read`.** `customers/inbox/route.ts:10` and `.../[conversationId]/route.ts:11`: a project Viewer reads customers' private messages. Decide whether inbox reading needs its own key (for example `inbox.read` in Manager/Approver/Project admin) before the web inbox ships to teams.
- **A12. Credit history is visible to every workspace member** (`workspaces/[workspaceId]/credits/route.ts:22-46`). Names are hidden for brands the person can't open, but amounts and kinds are workspace-wide. This is probably fine. Note it in the permissions doc.
- **A13. Unchecked external `href`.** `web/components/products/products-board.tsx:146` renders `<a href={p.url}>` from catalog data without a scheme check, so a `javascript:` URL is possible if the source can ever be set by a user or a crawl. Fix: use the existing `safeHttpUrl` (`web/shared/website.ts`). There are also two near-identical local helpers (`doc-pane.tsx:41` `safeHref`, `workspace.tsx:447` `safeSite`). Point both at `safeHttpUrl` (rule 5), then use it for every URL the migration renders (inbox, reviews, Google posts, story links, reel `postUrl`).
- **A14. `email-step` reveals whether an account exists** (`mobile-auth.ts:89-98`: register/password/code). It is rate-limited per IP. This is accepted on mobile. Carrying it to web is a product decision; see B7.

---

## B. Risks the migration introduces

### Critical

**B1. Voice cloning on web needs A1 fixed first, and the browser's audio format changes the parsing path.**
- Evidence: `isM4a` (`server/reels/recordings.ts:23-26`) accepts only MP4-family files. `toWav` is hardened: `-f mp4 -protocol_whitelist file` (`recordings.ts:70`). Chrome and Firefox `MediaRecorder` produce WebM/Opus; Safari produces MP4/AAC.
- Risk: the obvious "make web work" change is to drop `-f mp4` or the `isM4a` sniff and let ffmpeg auto-detect. Auto-detect opens HLS/concat demuxers, the classic ffmpeg SSRF and local-file-read path, and any container parser in the build. It also makes a file picker look necessary.
- Fix (in the reels/voices slice): add a `isWebm` magic-byte sniff (`1A 45 DF A3`) and a second explicit branch `-f matroska` (or webm) with the same `-protocol_whitelist file`. Never use auto-detect. Do the same for `/recordings`. Ship only after A1. On web, record from the microphone only.

### Important

**B2. Every new web paid button needs the A2/A3 protections.**
- Order: A2 (Origin/Fetch-Metadata) and A3 (frame-ancestors) land with or before slice 1 (brand look & feel + photos). Slice 1 already adds `/media` multipart writes and `PATCH /assets`; then photoshoot and reels follow. These are small and shared, so doing them once up front is cheaper than per slice.

**B3. Browser timeouts and retries on long writes.**
- Evidence: `web/lib/net.ts:27,48`: a 30 s timeout on all requests, and writes are never retried. But `POST /reels` and `/plan` run up to 120 s, `/voices/clones` up to 60 s, and the reel render/send POST up to 300 s (`maxDuration` in those routes).
- Risk: false "server took too long" errors while the server completes and charges, then a manual retry. Render is safe (locked and attempt-keyed); photoshoot is not (A6); reel plan duplicates the AI spend (A5).
- Fix: when migrating, give `send()` a per-call timeout override for these routes, or use the streaming (`wantsStream`) variants, which keep the connection alive. Every paid POST gets a client `requestId` (A6 pattern).

**B4. Presigned browser uploads need bucket CORS, and canvas use needs CORS GET.**
- Evidence: story uploads hand out a presigned PUT (`server/stories/uploads.ts:31-50`, `server/storage/media.ts:81-87`). The phone needs no CORS; a browser PUT to the storage origin does. A web story editor that draws product/library photos on a `<canvas>` needs CORS GET, or the canvas is tainted.
- Risk: the quick fix is a bucket CORS rule `AllowedOrigins: *`, `AllowedMethods: PUT,GET`, `AllowedHeaders: *`.
- Fix (stories slice): restrict CORS to the web origin(s), allow only `PUT` with `content-type`, and `GET` for media. Keep the signed `content-type` and `content-length` (already done). The `verifyUpload` sniff-then-copy (`uploads.ts:76-110`) already makes uploaded bytes safe. Keep it as the only way an upload becomes usable.

**B5. Sign-in from web must keep the real client IP.**
- Evidence: `clientIp` (`rate-limit.ts:36`) trusts one proxy hop. Web server components and any Server Action call `SERVER_URL` directly (`web/lib/server-fetch.ts:18-24`), so the server sees the **web container's** IP.
- Risk: if onboarding sign-in is built as a server action or a server-component proxy, every user shares one IP. One attacker's 30 requests lock everyone out of email codes (`mobile-code:ip`), and per-IP SMS limits stop protecting anything, so the global cap is the only one left.
- Fix (onboarding slice): all sign-in calls go **browser → /api (load balancer) → server**, never through web server code. Add a test that fails if `web/` code server-side fetches `/api/v1/mobile/*` or any new auth endpoint.

**B6. `check-bundle` does not know several current server secret names.**
- Evidence: `web/scripts/check-bundle.mjs:19-22` checks a CORE list plus secret-looking names from `server/.env.example`. The server reads `ELEVENLABS_API_KEY`, `GOOGLE_MAPS_API_KEY`, `HIGGSFIELD_API_KEY_SECRET`, `TWILIO_AUTH_TOKEN`, `EXPO_ACCESS_TOKEN` and `CREDENTIALS_ENCRYPTION_KEY_<v>`. None of those is in `.env.example`, so none is checked. This is exactly the set the migration's features touch: voices, places, reels, SMS sign-in.
- Also, the check looks for *names*. A secret copied into a `NEXT_PUBLIC_*` var is inlined as its value, and the name check misses it.
- Fix (slice 1): add those names to `server/.env.example`, which also documents them. Add a check that fails the web build if any `NEXT_PUBLIC_` name contains `SECRET|KEY|TOKEN`, except an explicit allowlist (for example a future referrer-restricted browser Maps key, which must be a separate key, never `GOOGLE_MAPS_API_KEY`).

**B7. Email-code and phone SMS sign-in on web.**
- Should they come? **Email code: yes**, done as an Auth.js provider. **Phone SMS: not in the first web release**; at most, sign-in for numbers already linked, behind a challenge.
- Why not just reuse `/mobile/code` and `/mobile/session`: they return a **mobile Bearer token** (`issueMobileToken`, salt `mobile-session`, 30 days, `request-user.ts:13-15`). Putting that in browser JS storage would turn any XSS into a 30-day token theft, which the httpOnly web cookie prevents. Inventing a route that sets the cookie itself skips Auth.js's CSRF double-submit on sign-in and invites login CSRF / session fixation.
- What it takes, safely:
  1. Add a second Auth.js `Credentials` provider (`id: "email-code"`) in `auth.ts` next to the password one (`auth.ts:104-130`). Its `authorize` calls the existing `spendCode(email, code)` and then a shared "find or create verified user" step. Refactor `signInVerifiedEmail` (`mobile-auth.ts`) so the token issuing is split from the user step; do not write a parallel one. Sending the code reuses `sendEmailCode` through a web route under the same per-email and per-IP limits.
  2. Auth.js then sets the normal rolling 7-day cookie, applies its CSRF token and audit, and runs the `jwt` callback's revocation check.
  3. Phone: SMS sending is the costly, abusable part. If it comes to web, require a challenge (Turnstile/hCaptcha) on send, allow sign-in only for numbers already linked (no `phoneTicket` sign-up on web), apply the Twilio Geo/Fraud Guard settings from A8, and keep B5. Sign-up stays email-first.
  4. Keep the same messages for unknown and disabled emails (no enumeration). Decide explicitly whether the web gets the `email-step` probe (A14).

**B8. Google Business connect from onboarding.**
- Evidence: the web OAuth flow is sound. State is bound to the signed-in user at completion (`integrations/[provider]/callback/route.ts:23-42`). It always returns to `/settings?tab=connections` (`:13-14`).
- Risk: onboarding will want "return to where I was". Adding a `?next=` or `returnTo` query parameter to start or callback creates an open redirect on an OAuth endpoint.
- Fix: store an enum return target (`"settings" | "onboarding"`) on `OAuthStateTransaction` at `startConnect` and map it to a fixed path in the callback. Never accept a URL.

### Minor

- **B9. Rendering AI and customer text.** The web has no `dangerouslySetInnerHTML` today. The doc pane renders agent output through its own components. Inbox messages, Google reviews and reviewer names, AI drafts, reel chat replies and story text must stay plain React text. Linkify only through `safeHttpUrl` (A13), with `rel="noreferrer noopener"`. Add `react/no-danger: error` to `web/eslint.config.mjs` so this stays true. Treat AI drafts of customer replies as untrusted: a customer DM can inject instructions ("reply with this link"). Keep human send, as today, and never auto-send from web.
- **B10. Signed media URLs in the browser.** Voice samples, photos and videos come back as 1-hour presigned GETs. Each is a bearer link, fine for `<img>`/`<audio>`. Don't put them in page-view tracking (`/activity/page-views` logs paths only; keep it that way), and don't cache them in localStorage past expiry.
- **B11. ESLint server boundary.** `web/eslint.config.mjs` bans the server packages by name. The migration may tempt imports of `@elevenlabs/*`, `twilio`, `fflate`/`ffmpeg` wrappers or `@googlemaps/*` into web for convenience. Add the server-only ones (`twilio`, `fflate`, `@elevenlabs/*`) to the `paths`/`patterns` list now. Client-side recording libraries (MediaRecorder) are fine.
- **B12. Places on web.** `/places/search` is server-side, keyed by user, 30/h, with a billed key. If the web wants as-you-type autocomplete, use Google's JS widget with a **separate, HTTP-referrer-restricted browser key**. Don't loosen the server limit or expose `GOOGLE_MAPS_API_KEY`.
- **B13. Dev-only CORS.** Leave `next.config.ts:16-31` as is. The web never needs CORS to `/api` (same origin). If someone adds the web origin with `Allow-Credentials: true` to "fix" a dev issue, cross-origin cookie reads become possible. Fix the proxy instead.

---

## Per-endpoint summary (what changes with a cookie caller)

| Endpoint | Permission today | Abuse controls today | Needs before web |
|---|---|---|---|
| POST /reels, /reels/:id/plan | content.create | none (A5) | rate limit (A5), long timeout/stream (B3) |
| PATCH/POST /reels/:id (render/send/recheck/register-link) | content.create / content.approve / publish.execute | render locked and attempt-keyed; recheck limited; link validated | A2, A3 |
| POST /reels/:id/recordings | content.create | 30/h user, 60/h reel; M4A sniff, ffmpeg hardened | WebM branch kept hardened (B1) |
| /voices, /voices/library | brand.read | — | — |
| POST /voices/clones | voices.manage (workspace-only key, enforced in `workspace-admin.ts:23`) | 5/h, 2 live, credits | A1 challenge and STT check, mic-only (B1) |
| PATCH/DELETE /voices/clones/:id | brand.read + owner-or-voices.manage in service | — | — |
| POST /photoshoots | content.create | credits, plan | idempotency (A6) |
| GET/POST /customers/inbox…, /customers/draft | brand.read / publish.execute / content.create | send and draft rate-limited | permission decision (A11), plain text (B9) |
| /google, /google/posts, /google/reviews/:id/reply | brand.read / publish.execute | per-brand limits (`google/business.ts:32`) | A2/A3; B8 for connect |
| GET/PATCH /assets, POST /media (library=1) | brand.read / context.edit / publish.execute | 4 MB, JPEG/PNG sniff, 60-photo cap | A9 at LB; note upload needs publish.execute but remove needs context.edit (inconsistent, harmless) |
| GET/PATCH /automations | brand.read / publish.execute + agents.run | audited | A2 |
| GET /credits?history=1, /subscription | workspace member | read-only | A12 noted; plans purchase (later) needs its own webhook review |
| POST /places/search, /site-check | signed-in user | 30/h each | A4 (rebinding) |
| POST /first-ideas | agents.run | 3 restarts/day/brand | — |
| Stories create/edit/duplicate/delete (POST /content, /content/:id) | content.create | postAiAllowed on edit/rewrite | — |
| /stories/sources, /stories/uploads(/:id) | content.create | 20 slots/h/brand, signed type and size, sniff-then-copy | bucket CORS (B4) |

## Suggested order of work

1. **With slice 1:** A2 (central Origin/Fetch-Metadata check), A3 (frame-ancestors/CSP report-only), B6 (secret names), A13/B9 (one `safeHttpUrl`, `react/no-danger`).
2. **Photoshoot slice:** A6 (requestId), B3 timeout handling.
3. **Reels slice:** A5 (plan rate limit), A1 and B1 (clone challenge, WebM branch, mic-only), A7 decision.
4. **Stories slice:** B4 (bucket CORS).
5. **Inbox/Google slice:** A11 decision, B8 return target.
6. **Onboarding:** A4 (pin resolved IP), B5 (no server-side auth proxy), B7 (Auth.js email-code provider; SMS deferred or challenge-gated), A8 Twilio settings.
