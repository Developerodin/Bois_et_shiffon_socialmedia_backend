# Server/web split: correctness and behaviour review

Branch `server-web-split` (head c2ea9c5) against `desktop-shell`. Read-only review. I compared every real (non-move) change with
`git show desktop-shell:apps/web/<path>` and ran the focused vitest files listed at the end.

## Summary

The split keeps behaviour well. Shell data parity holds, the sign-in wording is unchanged, the 401 → `/login?expired=1&next=` and
403/404 → notFound paths work, the OAuth callbacks still build their URLs from `AUTH_URL`, and the phone app is untouched
apart from the `:3101` fallback. Workspace and brand switching keeps the old cookie semantics. I found two real behaviour
changes:

1. Moving jobs into the worker made the queue **serial**. Before, every request ran its own `after()` runner, so jobs ran in
   parallel. Now one sequential loop on a 15 s poll handles every job, so a sign-in-code or password-reset email can wait
   behind a 5-minute Research run.
2. The admin console's "Latest activity" and "Recent agent runs" sections on the overview and workspace pages used to show
   the newest rows **from all time**. They now show only the **last 30 days**, because the new `/admin/logs` endpoint applies
   the Logs page's default period.

- Critical: 0
- Important: 2
- Minor: 10

## Critical

None.

## Important

### I1. The worker drains the whole queue serially, so short urgent jobs wait behind long ones

- **Where:** `apps/server/worker/main.ts:40` (one `runDueJobs` at a time) and `:58` (15 s default poll);
  `apps/server/server/jobs/runner.ts:96-99` (`kickRunner` is a no-op when `RUN_JOBS_IN_API=false`); `docker-compose.yml`
  (one `worker` service, `RUN_JOBS_IN_API: "false"` on `server-api`).
- **Before:** every enqueueing route called `kickRunner()`, and each call started its own `runDueJobs` in `after()`. A
  password-reset email (`app/api/v1/auth/password/forgot/route.ts:20`), a phone sign-in code (`app/api/v1/mobile/code/route.ts:17`)
  or a publish started straight away, alongside any long agent run.
- **Now:** in production a single loop claims one job, runs it to the end, then claims the next. `runDueJobs` only checks
  its budget between jobs, and `holdLease` exists because a Research run takes 5+ minutes.
- **Failure scenario:** a new customer starts the welcome flow, which queues Research (5+ min), and the posts chain queues
  brief → creator → quality. Meanwhile someone on the phone asks for a sign-in code, or a user asks for a password reset.
  That email job sits PENDING until the running agent job ends. The wait can exceed the phone code's validity window, or
  look like "the email never came". Scheduled publications also slip by minutes. Even with an idle queue, user-triggered
  work now starts up to 15 s late, where it used to start at once. This is visible in the welcome "watch it being read"
  step.
- **Spec status:** the spec (§Running on EC2) describes the worker as "`runDueJobs` on a loop" and says several workers
  are safe. It does not say that one worker serialises everything. The compose file runs one.
- **Fix (pick one):**
  - Run N loops in the worker process, for example `WORKER_CONCURRENCY` (default 3–4): N independent `runDueJobs` calls,
    each with its own workerId. Claims already use `SKIP LOCKED`.
  - Or give email and publish jobs a fast lane, i.e. a second loop that only claims those types.
  - Either way, also keep a light API-side kick for `EMAIL_SEND_JOB` (it doesn't render), or shorten the poll interval
    for it.
  - At minimum, document the head-of-line blocking in DEPLOY_EC2.md and set `deploy.replicas`/two worker services in
    compose.

### I2. The admin overview and workspace overview lost their all-time "latest" rows (now last 30 days)

- **Where:** `apps/web/app/(shell)/admin/page.tsx:20` (`serverFetch("/api/v1/admin/logs")`);
  `apps/web/app/(shell)/admin/workspaces/[workspaceId]/page.tsx:19-20` (audit and runs);
  `apps/server/app/api/v1/admin/logs/route.ts` (`days: period(q.days).days`, where `period(undefined)` = 30, see
  `packages/shared/src/api/admin.ts:18-20`).
- **Before:** `platformLogs({ kind: "audit" })` on the overview, and `platformLogs({ kind: "audit" | "runs", workspaceId })`
  on the workspace overview. `platformLogs` defaults to `days = null`, which means all time
  (`apps/server/server/services/platform-admin.ts:349,353`). The sections showed the 8 newest rows however old they were.
- **Now:** the endpoint applies the Logs page's 30-day default, so these sections only show the last 30 days.
- **Failure scenario:** a workspace with no activity in the last 30 days opens on empty "Latest activity" and "Recent agent
  runs" sections, where it used to list its last sign-ins and runs. On a quiet platform the console's front page has the
  same problem. The person page is unaffected, because its route calls `platformLogs` directly with no days.
- **Fix:** pass `days: "all"` from these three page calls, e.g.
  `withQuery("/api/v1/admin/logs", {}, { workspaceId, days: "all" })` and `"/api/v1/admin/logs?days=all"`. The Logs page
  keeps its 30-day default.

## Minor

- **M1. The visit POST runs in `Promise.all` with the page read** (deferred: Task 4).
  - Where: `admin/people/[userId]/page.tsx:14`, `admin/workspaces/[workspaceId]/layout.tsx:13`.
  - Failure 1: if the audit write fails, the page fails with it (500 → error page). The old `after()` never affected the
    page.
  - Failure 2: layouts and pages render concurrently, so the workspace overview's "Latest activity" can now include the
    admin's own visit row from this request. Before, it never could, because `after()` ran once the response was sent.
  - Fix: chain `.catch()` on the visit call so it rethrows only Next redirect/notFound errors (`isRedirectError`/notFound
    digest) and swallows the rest. Or fire it without awaiting.
  - Admin-only.
- **M2. `worker:dev` now queues the paid daily sweep locally.**
  - Where: `apps/server/worker/main.ts:31`.
  - The old `scripts/worker-dev.ts` only drained the queue. The new one is the production loop, so the first run after
    05:00 UTC starts every daily agent for every ACTIVE brand in the dev database. The implementer avoided this by
    shifting the clock (ledger, Task 7).
  - ENV_SETUP.md:107 documents it, but it is easy to trigger by accident.
  - Fix: skip the sweep unless `NODE_ENV=production` or `WORKER_SWEEP=1`.
  - Also: the dev poll went from 5 s to 15 s.
- **M3. `/api/v1/me/context` Origin check is an exact match on `AUTH_URL`'s origin.**
  - Where: `apps/server/app/api/v1/me/context/route.ts:22-23`.
  - In dev, opening the site as `http://127.0.0.1:3100` or a LAN IP (`AUTH_URL=http://localhost:3100`) gives a 403 on every
    brand or workspace switch. The old server actions accepted any origin that matched the Host header.
  - The brand switcher's error surfaces at the error boundary. The workspace switcher fails silently (M5).
  - Production is fine.
  - Fix: document it, or also accept the request's own forwarded host.
- **M4. Google button and subtitle flash** (deferred: Task 5).
  - Where: `apps/web/components/auth/login-form.tsx:48,52`.
  - The first paint always says "Use the email and password from your invitation." with no Google button. It switches
    once `/api/auth/providers` answers.
  - The wording is unchanged, but the first paint is wrong when Google is enabled.
  - Fix: pass `googleEnabled` from the server page. One `serverFetch` to `/api/auth/providers`, or a
    `/api/v1/auth/options` flag.
- **M5. Workspace switch fails silently** (deferred: Task 3).
  - Where: `apps/web/components/shell/workspace-switcher.tsx:28`.
  - This matches the old behaviour, where `void setActiveWorkspace(id)` was also an unobserved rejection, so it is not a
    regression.
  - The radio value doesn't move because there is no refresh. The person sees nothing happen.
  - Fix: a toast on rejection.
- **M6. Unknown-type jobs churn and inflate counts.**
  - Where: `runner.ts:62,72`.
  - A released job is claimed again every minute, forever, and `processed++` counts it. The worker then logs "processed 1
    job(s)" every minute for a job it never ran.
  - Fix: count only handled jobs, and log once per type.
- **M7. `kickIfDue` queries the database every 30 s per instance even when `RUN_JOBS_IN_API=false`** (deferred: Task 7).
  - Where: `runner.ts:108-116`.
  - The result is thrown away by `kickRunner`.
  - Fix: return early on the same env check.
- **M8. Cursor and query edge cases.**
  - `before` is now the raw query string (`admin/activity/[userId]/page.tsx:18`, `components/admin/logs-view.tsx:27`), so
    `?before=garbage` shows a "Newest" link. The old `parseCursor` treated it as absent.
  - The `queryOf` comment ("the first value of each key", `server/api/admin-route.ts:18-19`) is wrong:
    `Object.fromEntries` keeps the **last** value. This is harmless because `withQuery` only forwards single values.
  - Fix: correct the comment, and use `parseCursor`'s validity for `before` (or have the API echo the parsed cursor).
- **M9. `requirePlatformAdminPage` is now unused.**
  - Where: `apps/server/server/auth/platform-admin.ts:31`.
  - It also imports `next/navigation` `notFound`/`redirect` into the API-only app.
  - Mention only; delete it in a cleanup.
- **M10. A signed-in visitor to `/login` sees the form briefly** (deferred: Task 5).
  - Where: `login-form.tsx:54`.
  - It is a client `getSession` → `router.replace`, where the old page redirected on the server.
  - Fix, if wanted: check for the cookie in the web middleware and redirect, unless `expired=1`.

## Deferred-minor triage (correctness lens)

| Deferred item | Verdict |
|---|---|
| Silent workspace-switch failure | Keep as Minor (M5). Same as desktop-shell: the old `void setActiveWorkspace(id)` was equally silent. |
| Visit POST in Promise.all | Keep as Minor (M1), with a second effect: your own visit can appear in "Latest activity". |
| Google button flash | Keep as Minor (M4). Wording is unchanged; only the first paint is wrong. |
| `/admin` returns 200 + not-found for non-admins | **Not a regression.** desktop-shell had the same shape: `(shell)/loading.tsx` and `admin/loading.tsx`, plus `notFound()` thrown from `admin/layout.tsx` via `requirePlatformAdminPage`. The streamed 200 status is the same. Close. |
| Layout guard ignores ACTIVE status (suspended admin sees an empty frame) | **Moot.** A non-ACTIVE user has no session: the `jwt` callback returns null (`apps/server/auth.ts:64-71`), so `/me/shell` answers 401 → `/login?expired=1`. Close. |
| `(shell)/page.tsx` `find(...)!` drops the `findFirstOrThrow` workspace re-check | **Safe.** `loadShellContext` only picks `activeBrandId` from `listAccessibleBrands(activeWorkspaceId)`, including the catch fallback `brands[0]` (`server/shell/load-shell-context.ts:41-55`). The brands are filtered by that workspace. Close. |
| `kickIfDue` DB query when `RUN_JOBS_IN_API=false` | Keep as Minor (M7). |
| Unknown-type jobs re-released forever | By design (spec). Keep the logging/count part as Minor (M6). |
| Worker stop timeout must exceed the longest job | Satisfied in compose (`stop_grace_period: 360s`). DEPLOY_EC2.md covers the ASG hook. |
| Missing `STORAGE_*` creds become `""` | Not a correctness regression for the request path: the first upload fails with an S3 auth error. An ops item, outside my lens. |
| `queryOf` keeps the first value only | Wrong comment: it keeps the last. Harmless (M8). |
| Middleware `healthz` exclusion unanchored | Harmless: `/healthzX` skips only the cookie check, and the page's `serverFetch` still 401s → login. |
| Signed-in `/login` shows the form briefly | Keep as Minor (M10). |
| Authorize codes mismatch | Parity confirmed. Credentials only ever carry `rate_limited` or the default code (`auth.ts:11-13,118`). A non-`CredentialsSignin` failure comes back as `error=Configuration` → "We couldn't check your sign-in just now…", the same text the old server action chose. |

## What I checked and found sound

**Shell data parity** (`/api/v1/me/shell` vs the old direct calls):
- Workspaces, brands (including `websiteUrl` from `profile`, `status`), the active ids, `roleLabel`, and
  `brand.create` from workspace permissions all match.
- The brand-scoped permissions for connections and products match: `effectivePermissions(ws, user, brand)`.
- `isPlatformAdmin` matches.
- `user` now comes from the database instead of the JWT snapshot, which is fresher. The fields are the same.
- `getShell` is wrapped in `cache()`, so it is one call per request across the layout and page.
- The `/` redirects (platform-only → `/admin`, no brand → `/welcome`) are unchanged.

**Welcome page:**
- `canCreate` and the resume logic are unchanged.
- "Open <workspace>" is now a client POST then `router.push("/")`. The cookies are the same, including the brand cookie
  being deleted.

**Switching:**
- `/me/context` reproduces `setActiveWorkspace` (sets the workspace cookie, deletes the brand cookie) and `setActiveBrand`
  (sets both, with `allowArchived`). Same name, path, maxAge and httpOnly; `secure` is added in production.
- Denied access answers 404.
- The callers `router.refresh()` where the old `revalidatePath` did the refresh: brand switcher, workspace switcher,
  new-brand dialog, welcome flow.
- The browser `fetch` POST sends Origin, and nginx and the dev rewrite pass it through.

**Sign-in:**
- All nine error strings, the three notices and the subtitle are byte-identical.
- `safeNext`/`pathOf` are unchanged.
- The `expired` loop guard is kept.
- Client `signIn("credentials", { redirect: false })` maps codes correctly. The tests are in `tests/login-errors.test.ts`.
- Google uses `signIn("google", { redirectTo: next })`. Error redirects (`/login?error=google_unverified|disabled`) resolve
  against `AUTH_URL` = the website.
- Sign-out uses the Auth.js client (unchanged).

**Session cookies across the hop:**
- With `AUTH_URL` set, next-auth's `reqWithEnvURL` and `createActionURL` use the https `AUTH_URL`. The secure cookie name
  (`__Secure-authjs.session-token`) is therefore chosen the same way for browser calls and for `serverFetch`'s plain-http
  call to `server-api:3101`.
- The `instrumentation.ts` https check enforces this in production.

**Session renewal:**
- The server middleware (`apps/server/middleware.ts`) runs the edge Auth.js middleware on `/api/v1/*` and copies its
  `Set-Cookie` onto `NextResponse.next()`, so every browser API call rolls the 7-day JWT forward.
- Page loads no longer renew (the web middleware only checks that the cookie exists), and `serverFetch` drops the
  server's `Set-Cookie`. But every shell page sends the `PageViewTracker` beacon to `/api/v1/activity/page-views` on each
  navigation, so an active person still renews per page.
- Revoked or expired sessions now land on `/login?expired=1&next=…` (before: a bare `/login`). That is an improvement.

**401/403/404 handling:**
- `serverFetch` redirects with `next` from `x-pathname`, which the middleware overwrites, so a client can't inject it. It
  rejects `//`.
- 403/404 → notFound.
- Other non-2xx statuses throw to `error.tsx`.
- A database outage during the session check (`SessionUnverifiedError`) becomes a 500 → the error page, the same as the
  old layout's `auth()` throw.

**Admin console:**
- Every page's data and query handling matches the old service calls: period, sort, `page`/`pages`/`hasMore`, cursor
  `next`, workspace pickers, `usdInr` → Fx.
- Each `/admin/*` route answers 404 for non-admins and 401 when signed out.
- Person, workspace and visit routes 404 on missing ids.
- `notFound` when `!s.user && !t.total` is kept for deleted accounts.
- The person page's audit is still all time, top 15.
- The `NO_WORKSPACE` and `period` helpers moved to shared unchanged.
- `PERMISSIONS`, `offerPercents` (the NBSP and NNBSP bytes are identical), `productName`, `CAPTION_LIMITS` and the
  website helpers are verbatim moves.

**OAuth callbacks:**
- `integrations/[provider]/callback` is unchanged.
- All redirects go through `appUrl()` (`AUTH_URL`), so they land on the website, never on `:3101`.
- The mobile hand-off (`espanda://connect`) is unchanged.
- The provider redirect URIs still point at the website's `/api/v1/...`. The dev rewrite and nginx `/api/` send these to
  the Server.

**Phone app:**
- Only the fallback `API_URL` (`:3101`) and comments changed. `GET /api/v1/me` and the other routes are untouched.
- The dev CORS headers for the Expo web preview moved with the Server's `next.config.ts`.
- Via `:3100` the phone still works in dev through the rewrite (`proxyTimeout` 330 s).

**Job runner:**
- `releaseJob` is lease-guarded (`leasedBy`, status RUNNING), puts the job back in 60 s, and decrements the attempt the
  claim added.
- The exhausted-attempts check still runs first.
- `kickRunner` is gated on `RUN_JOBS_IN_API === "false"` only, so dev stays on by default.
- No job handler calls `after()` or `kickRunner`: the only non-route caller, `reels/service.ts:222`, is reached from a
  route. The worker therefore never hits "after outside a request scope".
- The worker's daily sweep is idempotent per UTC day (`daily-sweep:<day>` key), retries on error, and survives restarts.
- SIGTERM finishes the current run.
- `/api/v1/jobs/run` still refuses calls when `CRON_SECRET` is unset.

**Tests run (all pass):**
- `npx -w web-frontend vitest run tests/server-fetch.test.ts tests/middleware.test.ts tests/login-errors.test.ts`: 20/20.
- `npx -w server vitest run tests/middleware.test.ts tests/me-shell.test.ts tests/me-context.test.ts tests/admin-api.test.ts tests/runner-unknown-type.test.ts tests/worker-loop.test.ts`: 37/37.
- `tsc --noEmit` on `apps/web`: clean.

**Uncertain (not verified by running):**
- That browsers store `Set-Cookie` from `sendBeacon` responses. Per the Fetch spec they do, since beacons are credentialed
  requests.
- Whether the `x-pathname` the middleware captures on client-side RSC navigations includes Next's internal `_rsc` query
  param. If it does, `next=` would carry it. That is harmless: the target page still loads.
