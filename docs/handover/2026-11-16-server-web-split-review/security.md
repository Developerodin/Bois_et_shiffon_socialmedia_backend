# Security and secrets review: server/web split

Branch `server-web-split` at c2ea9c5, against `desktop-shell`. Read-only review: no servers, no Docker. I ran
`node scripts/check-web-bundle.mjs` against the existing `apps/web/.next` build (15:11, after the last web-code
change) and grepped the build output. No env values were printed.

## Summary

No Critical or Important findings. The boundary holds:

- The website's build has no Prisma client and no secret names. The check passed on 2470 files, and the standalone
  `node_modules` has no `@prisma`.
- The website image gets `SERVER_URL` only.
- Auth.js builds every URL and cookie name from `AUTH_URL`, never from the Host header.
- `clientIp` takes the right-most `X-Forwarded-For` entry, and both proxies put the real peer address there.
- `/api/v1/me/context` checks the Origin.
- All 12 admin routes go through one guard.
- Every redirect target is limited to same-site paths.

Eleven Minor findings follow. Most are hardening or deploy-guide lines. M1 (build context) and M3 (worker https
check) are one-line fixes worth doing before merge. None blocks.

## Critical

None.

## Important

None.

## Minor

**M1. Playwright session files enter the website's Docker build context.**
`.dockerignore:1-17` has no entry for `e2e/.auth`. `apps/web/e2e/.auth/{admin,owner,viewer}.json` exist in the
worktree now. They hold signed-in session cookies for the e2e accounts. `apps/web/Dockerfile:18`
(`COPY apps/web apps/web`) copies them into the `build` stage layer. The runtime stage copies only standalone,
static and public, so the final image is clean.
*Failure:* the files are sent to the Docker daemon and kept in the build-stage layer. If anyone exports the build
cache (`--cache-to ... mode=max`, a remote builder or CI cache), valid dev sessions ship with it.
*Fix:* add `**/e2e/.auth` (or `apps/web/e2e`) to `.dockerignore`.

**M2. A local `next build` copies the app's `.env` into standalone output.**
Verified on disk:
- `apps/server/.next/standalone/apps/server/.env` exists (the full Server env).
- `apps/web/.next/standalone/apps/web/.env` exists (`SERVER_URL` only).

Next does this for every env file it loaded. The images are safe because `.dockerignore` excludes `**/.env*`.
*Failure:* a deploy that copies `.next/standalone` from a dev machine (the common non-Docker Next deploy) ships every
Server secret as a plain file next to `server.js`.
*Fix:* one line in `docs/DEPLOY_EC2.md` and `apps/server/README.md`: "deploy only through the images; never copy a
locally built `.next/standalone`." `check-web-bundle.mjs` already catches this for the website, because it scans
standalone and would flag a secret name in a copied `.env`.

**M3. The worker never checks that `AUTH_URL` is https.**
The check lives in `apps/server/instrumentation.ts:2-5`, which only the Next server runs. `worker/main.ts:50-60`
starts without it. `appUrl()` (`server/auth/tokens.ts:14`) only throws when `AUTH_URL` is unset, not when it is
http. In the scaled setup the worker group has its own env, so it can drift from the API's.
*Failure:* with an http `AUTH_URL`, invite and password-reset emails sent from jobs carry `http://…?token=…`. The
token crosses the network in cleartext before the port-80 → https redirect.
The Higgsfield webhook is safe: `server/reels/render.ts:205` only builds its URL for https.
*Fix:* call the same check at the top of the worker's entry block, by importing `register` or copying its two lines.

**M4. The EC2 guide does not pin the ALB's X-Forwarded-For settings.**
`docs/DEPLOY_EC2.md:20-29, 47-50`. `clientIp` (`server/auth/rate-limit.ts:36-39`) assumes the ALB appends a bare IP.
*Failure:*
- If someone enables `routing.http.xff_client_port.enabled`, the right-most entry becomes `ip:port`. The per-IP limits
  on sign-in, password reset and SMS codes are then keyed per connection, so a caller dodges them by reconnecting.
- If `xff_header_processing.mode` is set to `remove`, Next fills XFF with the ALB node's address
  (`next/dist/server/base-server.js:565`). Every visitor then shares about 30 sign-ins per 15 minutes.
- The same lockout happens if a CDN or second ALB is ever put in front of nginx or the ALB.

*Fix:* add to the ALB section: "XFF processing mode `append` (the default), client port off (the default). Adding
any proxy in front means changing `clientIp`." The code comment already names the one-hop ceiling; the guide should
too.

**M5. The internal ALB's security group is not specified, and that hop is plain http.**
`docs/DEPLOY_EC2.md:31-35, 47-52` says the Server accepts traffic only from the two ALBs, but not who may reach the
internal ALB. `serverFetch` (`apps/web/lib/server-fetch.ts:19-24`) forwards the visitor's session cookie over
`http://<internal-alb>`.
*Failure:* an internal ALB open to the whole VPC CIDR lets any VPC host call the Server API. The XFF entry is still
correct, so nobody can spoof an IP this way. Session cookies cross the VPC unencrypted.
*Fix:* add "internal ALB inbound 80 from the web security group only". Optionally give the internal ALB an https
listener.

**M6. No HSTS header (uncertain regression).**
`deploy/nginx.conf:32-64` and the ALB section set no `Strict-Transport-Security`. Vercel, I believe, sends HSTS by
default; I have not verified that for this project's domains. Nothing is live on EC2 yet.
*Failure:* on a first visit over http, an active network attacker can strip the 301. The session cookies are
`__Secure-`/Secure, so they never travel over http, but page content can be tampered with.
*Fix:* `add_header Strict-Transport-Security "max-age=63072000" always;` in the 443 server block. On the ALB, use the
listener's HSTS response-header attribute.

**M7. migrate and worker receive the whole Server env (least privilege).**
`docker-compose.yml:77-96` gives all three the same `server.env`.
- migrate needs only `DATABASE_URL` and `DATABASE_URL_UNPOOLED`.
- The worker never reads `AUTH_SECRET`. Its only readers are `server/auth/request-user.ts:14,18` and
  `server/services/mobile-auth.ts:22,183`, which are API request paths.

*Failure:* a compromised migrate or worker container holds keys it never uses. That is a wider blast radius, not a
bug.
*Fix (optional):* give migrate a two-variable env file. `AUTH_SECRET` can stay in the worker's env for simplicity.

**M8. The admin "visit" POSTs have no Origin check and are triggered by a page GET.**
`apps/server/app/api/v1/admin/{people/[userId],workspaces/[workspaceId]}/visit/route.ts:6-12`, called from
`apps/web/app/(shell)/admin/people/[userId]/page.tsx:14` and `.../workspaces/[workspaceId]/layout.tsx:14-15`.
*Failure:* a link that gets a platform admin to open `/admin/people/<id>` writes a "viewed" audit row. That was
already true with `after()`. A same-site subdomain could also POST directly. The only effect is a false audit row.
*Fix:* none needed. If wanted, apply the `me/context` Origin check. Note that the SSR call sends no Origin, so it
would need to be exempt, for example by trusting only calls with no Origin header.

**M9. Missing storage credentials become empty strings instead of stopping the app.**
`apps/server/server/storage/media.ts:20-22`. The credentials are always passed explicitly, so the SDK never falls back
to the instance role. A missing value therefore fails signing rather than leaking, but `STORAGE_ENDPOINT` unset
sends requests to AWS S3's default endpoint and to a bucket named `media`, which belongs to someone else.
*Failure:* uploads fail at run time with confusing S3 errors. Nothing is written.
*Fix:* in production, throw at startup when `STORAGE_ENDPOINT` or a key is missing. Also fix `docs/ENV_SETUP.md`,
whose `neon env pull` note still says `AWS_*`. A pulled env would leave `STORAGE_*` empty.

**M10. The production website image keeps the dev `/api` rewrite, pointing at `http://localhost:3101`.**
`apps/web/next.config.ts:89-91` is baked at build time; the built `routes-manifest.json` shows it. In production the
ALB or nginx sends `/api/*` to the Server, and nothing listens on localhost:3101 in the web container, so this is
harmless today.
*Failure:* if anyone builds the image with `SERVER_URL` set, any `/api…` path that reaches the website is proxied
through it. Next's proxy does not add the caller's address, so XFF attribution would be lost.
*Fix (optional):* `if (process.env.NODE_ENV !== "development") return [];`, the same guard the Server's
`headers()` uses.

**M11. The accept-invitation route sets the shell cookies without `secure` (pre-existing).**
`apps/server/app/api/v1/auth/invitations/accept/route.ts:17` omits `secure`, which `me/context/route.ts:11` sets in
production. The values are only workspace and brand ids, and membership is re-checked on every read, so this is
consistency, not exposure.
*Fix:* reuse `me/context`'s cookie options.

## Deferred-minor triage (security lens)

| Ledger item | Verdict |
|---|---|
| T2: nginx should append XFF | **Superseded, sound.** Ruling I (overwrite with `$remote_addr`) is correct for one hop: the right-most entry is the peer either way, and overwriting also drops forged entries. `nginx.conf:47`. |
| T2: extra `clientIp` edge tests | Optional. `tests/client-ip.test.ts` covers spoofed-then-appended, single entry and fallbacks. |
| T3: me-context tests miss denied-brand 404, missing Origin, `secure` in production | **Recommended before merge, not blocking.** Missing Origin is the CSRF guard's main case. The code is right (`route.ts:21-23` rejects `!origin`), but only the wrong-origin case is tested. Two short tests. |
| T3: serverFetch tests miss `init.headers` override | No fix. `init.headers` could override `cookie` (`server-fetch.ts:23`), but no caller passes headers. |
| T3: middleware wrapper untested; auth cast | No security fix. The wrapper only passes redirects through and copies `set-cookie` (`apps/server/middleware.ts:10-16`); each route checks the session itself. |
| T4: no Origin check on visit POSTs | Accept (M8). |
| T4: layout guard ignores ACTIVE status | **Moot.** A non-ACTIVE user has no session at all: `auth.ts:65-71` returns null from `jwt`, and `request-user.ts:21` does the same for Bearer tokens. The admin API guard also checks status (`platform-admin.ts:17`). |
| T4: route tests cover 4 of 12 for 404 | Low risk. All 12 call `adminOnly` as their first line (grep verified). A table-driven test is optional. |
| Walk: `/admin` for a non-admin is HTTP 200 with a "Platform admin" title | Parity: `desktop-shell` also called `notFound()` from the layout. The console's existence is visible in the public JS route chunks anyway. The data guard is the API's 404. No fix. |
| T6: web middleware `healthz` exclusion unanchored | No security fix. It only skips the cookie-presence redirect for paths starting `healthz`, and no page has that name. The Server still enforces auth. Anchoring is optional. |
| T6: `SERVER_URL` read at build time | See M10. Harmless now; optional dev-only guard. |
| T7: missing `STORAGE_*` credentials become `""` | See M9. Fails closed; fail-fast recommended. |
| T7: ENV_SETUP `neon env pull` says `AWS_*` | Doc fix (M9). |
| T1, T5, T7 (kickIfDue, unknown types), T8 (npm ci, sharp, stop grace, ipv6) | Outside this lens. |

## What I checked and found sound

- **Website bundle and image.**
  - `check-web-bundle.mjs` passes (0 hits, 18 secret names plus `PrismaClient`). Standalone `node_modules` has no
    `@prisma` or `.prisma`.
  - No `NEXT_PUBLIC_*` and no `process.env` in `packages/shared`. Web `process.env` reads are only `SERVER_URL`
    (`server-fetch.ts`, `next.config.ts`) and e2e/test config.
  - No `@/server` imports in `apps/web`. The lint bans Prisma, next-auth (except `/react`), `@auth/*`, `@aws-sdk/*`,
    nodemailer and others, plus relative imports that leave the app.
  - `server-fetch.ts` imports `server-only`. No `"use server"` remains in either app, and the Server has no
    `page.tsx` or `layout.tsx`.
  - Web Dockerfile: the build stage copies only `apps/web` and `packages/shared` sources. The runtime stage is
    standalone, static and public, runs as `USER node`, and bakes no env. compose gives `web` only `SERVER_URL`, with
    no `env_file`. `public/` holds only images.
- **Server images.** No env baked (`ENV` holds only `NODE_ENV`, `PORT` and `HOSTNAME`); runtime and migrate run as
  `node`. `.dockerignore` excludes `**/.env*`, `.git`, `.claude`, `.superpowers` and `docs`. Root `.gitignore`
  excludes `deploy/env/` and `deploy/certs/`; `apps/*/.gitignore` excludes `.env*` (`git check-ignore` verified).
- **Auth through the load balancer.**
  - next-auth 5.0.0-beta.32's `reqWithEnvURL` (`node_modules/next-auth/lib/env.js`) rewrites every request's origin
    to `AUTH_URL`. `trustHost: true` therefore never builds URLs or cookie names from Host or X-Forwarded-Host, and
    with an https `AUTH_URL` the cookies are `__Secure-`.
  - The web middleware checks both cookie names and their `.0` chunks.
  - `instrumentation.ts` refuses a non-https `AUTH_URL` in production. Next's `registerInstrumentation` rethrows, so
    startup should fail; this is not run-verified because Docker was down.
  - `appUrl()` builds email and OAuth links from `AUTH_URL` only.
  - No Server code reads Host, `x-forwarded-host` or `nextUrl.origin`.
- **Forwarded headers.**
  - `clientIp` takes the right-most entry (`rate-limit.ts:36-39`).
  - The `x-real-ip` fallback is effectively unreachable: Next sets XFF from the socket when it is absent
    (`base-server.js:565`).
  - nginx overwrites XFF (`nginx.conf:47`); the ALB appends by default.
  - Server SSR calls carry the website's address, as the spec names.
  - The Server is reachable only from the ALBs (guide) or via the compose network: `expose` only, no published port.
- **CSRF on `/api/v1/me/context`.** JSON only (415), and Origin must equal the `AUTH_URL` origin; missing,
  `null` or unset all fail closed (`route.ts:18-23`). Membership is checked, a denied workspace or brand gets a 404,
  and the cookies are httpOnly, lax, and `secure` in production. The dev rewrite keeps Origin `localhost:3100`,
  which matches the dev `AUTH_URL`.
- **Admin guards.**
  - All 12 `/api/v1/admin/*` handlers call `adminOnly` first. A signed-out caller gets 401; any non-admin, or an
    admin who is not ACTIVE, gets 404 (`admin-route.ts:9-12`, `platform-admin.ts:13-21`).
  - Responses map to explicit fields. Invitations expose email, role, project and expiry only, never `tokenHash`.
    Person detail exposes `accounts.provider` only.
  - The website's admin layout guards with `isPlatformAdmin`, and each page's data comes from the guarded API.
  - Admin paths are built with `api\`\`` (encoded segments) or `withQuery` (URLSearchParams), and `workspaceId`
    overrides any query value.
- **Open redirects.**
  - Login `safeNext` (`app/login/page.tsx:195-212`) accepts paths only: it rejects `//`, backslashes and control
    characters, and keeps only the path of `callbackUrl`. Next 308-normalises `//` and `\` before middleware
    (`resolve-routes.js:93`).
  - Google `signIn(..., { redirectTo: next })` gets the same safe `next`, and Auth.js's default redirect callback
    pins it to `AUTH_URL`.
  - `serverFetch`'s 401 `next=` comes from `x-pathname`, which the middleware sets and overwrites
    (`middleware.ts:61-62`). It is encoded and re-checked by `safeNext`.
  - Middleware redirects are relativised by Next (`getRelativeURL`), so the `HOSTNAME=0.0.0.0` base never leaks into
    a Location header.
- **Logs.**
  - nginx's only access log is `noargs` (no `$args`), and the error log is `crit`.
  - The guide warns that ALB logs keep query strings.
  - No Server code logs `request.url`. The integrations callback logs only the provider's `error` and
    `error_description`.
  - The Higgsfield webhook compares its secret in constant time and always answers `{}`.
- **Worker.** Runs as `node` with no inbound port. `/api/v1/jobs/run` fails closed with `CRON_SECRET` unset
  (`jobs/run/route.ts:8-9`). `RUN_JOBS_IN_API=false` keeps renders out of the API. The dev CORS block is limited to
  `NODE_ENV=development` (`apps/server/next.config.ts:17`).
- **e2e.** `global-setup.ts` takes only `E2E_*` names from the Server's `.env`, so no Server secret reaches the
  Playwright process. It also refuses non-local hosts.
