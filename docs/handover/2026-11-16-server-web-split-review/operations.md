# Server/web split review: deployment and operations

Reviewer lens: deployment and operations. Branch `server-web-split` at c2ea9c5, compared with `desktop-shell`.
This was a static read only. Docker was not running, so no image was built or run. I read the existing Windows-built
standalone outputs under `apps/server/.next/standalone` and `apps/web/.next/standalone`, and the worker bundle
`apps/server/dist/worker.js` (built 15:16 on 16 Nov, the same time as the HEAD commit).

## Summary

The images, compose file, nginx config and docs fit together. Ports, health checks, the migrate target, standalone
paths (fonts, email logo, Prisma debian engine, linux ffprobe) and the worker's externals all check out on paper.
This branch adds no migrations: the 55 prisma files are pure moves, and only `schema.prisma` gained a 2-line comment
and binaryTargets.

Three Important gaps are all about stopping and keeping connections in a real AWS setup, not about the code paths
that were exercised:

1. After SIGTERM the worker keeps claiming new jobs for up to 30 s, and once off Vercel no job has an upper time limit.
   The 360 s grace is therefore not a guarantee.
2. On EC2, an ASG lifecycle hook alone never sends SIGTERM to the worker container. The documented graceful
   shutdown does not happen as written.
3. Node's 5 s keep-alive sits behind an ALB with a 330 s idle timeout. This is the classic setup for intermittent 502s
   on both target groups.

Counts: Critical 0, Important 3, Minor 12.

## Critical findings

None.

## Important findings

### I1. The worker keeps claiming jobs after SIGTERM, and nothing caps a job's run time any more

- `apps/server/worker/main.ts:40` calls `runDueJobs({ budgetMs: BUDGET_MS })` without the abort signal.
- `apps/server/server/jobs/runner.ts:55-61`: `while (Date.now() < deadline) { const job = await claimNextJob(...)`.
  The signal is only seen by the outer loop (`main.ts:28`).
- Spec §Graceful shutdown says the worker "stops claiming, finishes its current job, exits".
- On Vercel, `maxDuration = 300` killed a runaway invocation. On EC2 nothing enforces it. `queue.ts:63` already
  notes "a 5+ minute Research run", and `holdLease` keeps renewing the lease for as long as the job runs.

**Failure scenario.** A deploy or scale-in sends SIGTERM 2 s into a drain. The runner claims more jobs for the
remaining 28 s, and the last one might be a Research agent run or a reel render that takes 5+ minutes. Compose's
`stop_grace_period: 360s` (or the instance shutdown) SIGKILLs the job mid-run. The lease expires within 5 minutes and
the job is retried with `attempts+1`. For `publish` jobs that means a possible duplicate post if the platform had
already accepted the post. For paid AI or render work it means paying twice. The same race existed on Vercel at
300 s, but there the 300 s ceiling was real and documented. Here the doc says the grace "must exceed the longest
job", and that number is now unbounded and unmeasured.

**Fix.**
- Pass the signal through: `runDueJobs({ budgetMs, signal })`, and in the loop use
  `while (Date.now() < deadline && !signal?.aborted)`. This is a one-line, additive change and existing callers are
  unaffected.
- Then either measure the real longest job (for example max `updatedAt - createdAt` of COMPLETED `agent.run` /
  `reel.render` jobs) and set the grace above it, or add a per-job ceiling (`Promise.race` with a timeout, after
  which the lease is released) so that 360 s is actually true.

### I2. The documented EC2 worker shutdown does not deliver SIGTERM, and the container run flags are not documented

- `docs/DEPLOY_EC2.md:56-60` says: "Set the ASG termination lifecycle hook to at least 360 s".
- A lifecycle hook only holds the instance in `Terminating:Wait`. Nothing signals the container during that time.
  At the end of the hook the OS shuts down, and dockerd stops containers with each container's stop timeout, which is
  **10 s by default**.
- The guide never says how containers are started on the instances. There is no `docker run` line, so nothing
  covers `--init`, `--restart unless-stopped` or `--stop-timeout`, which compose provides on the single box.

**Failure scenario.**
1. A worker-group roll or scale-in starts.
2. The worker keeps claiming jobs for the whole 360 s hook.
3. The instance shuts down.
4. The worker gets SIGTERM, then SIGKILL 10 s later, mid-job.

This is the I1 outcome every time, not occasionally. A crash (for example an unhandled rejection) without a restart
policy leaves that instance's worker dead until the instance is replaced.

**Fix.** Document the worker's run line:
`docker run -d --init --restart unless-stopped --stop-timeout 360 --env-file … espanda-server-worker`, and the same
`--init --restart` flags for api and web. Then add a lifecycle-hook handler, either:

- EventBridge "EC2 Instance-terminate Lifecycle Action" → SSM Run Command `docker stop -t 360 <worker>` →
  `complete-lifecycle-action`, or
- an on-instance poller.

Also say that the hook timeout must be at least the stop timeout.

### I3. Node keep-alive (5 s) is shorter than the ALB idle timeout (330 s), so expect sporadic 502s

- The standalone `server.js` takes `KEEP_ALIVE_TIMEOUT` from the environment
  (`apps/server/.next/standalone/apps/server/server.js:11`). `node_modules/next/dist/server/lib/start-server.js:250`
  only sets `server.keepAliveTimeout` when that value is given. Otherwise Node's default of 5000 ms applies.
- Neither Dockerfile (`apps/server/Dockerfile` runtime stage, `apps/web/Dockerfile` runtime stage) nor
  `docs/DEPLOY_EC2.md` sets it. `docs/DEPLOY_EC2.md:24` sets the ALB idle timeout to 330 s.

**Failure scenario.** The ALB reuses a pooled connection that the target closed after 5 s idle, and the client gets a
502. AWS documents this ("the target's keep-alive timeout must be greater than the load balancer's idle timeout"). It
hits the public ALB to web, the public ALB to server-api, and the internal ALB (website SSR) to server-api. It shows
up as rare, unreproducible 502s under light load. The single box is not affected: nginx uses a variable
`proxy_pass` with no upstream keepalive pool, so it opens a new connection per request.

**Fix.** Add `KEEP_ALIVE_TIMEOUT=335000` to the `ENV` line of both runtime stages, and add one line to
DEPLOY_EC2's ALB section. At first build, confirm that requests longer than 60 s still work. Node's `headersTimeout`
(60 s) only applies while headers are being received, but check it once anyway.

## Minor findings

### M1. Compose `server-api` has no `stop_grace_period`, so a single-box redeploy cuts chat streams after 10 s

`docker-compose.yml` (server-api block). Next 15.5 does close gracefully (`start-server.js:330-359`:
`server.close()` waits for in-flight responses). Docker kills it at 10 s. **Fix:** `stop_grace_period: 330s` on
server-api (and 15–30 s on web).

### M2. Quoted values in env files break with `docker run --env-file`

`apps/server/.env.example` quotes every value and has inline comments (`DATABASE_URL=""   # pooled …`). Compose
strips both. `docker run --env-file` (and ECS environment files) keep them literally. Then `AUTH_URL="https://…"`
fails `startsWith("https://")` (`apps/server/instrumentation.ts:3`) and the DB URL is malformed. **Fix:** one line in
DEPLOY_EC2: unquoted `KEY=value`, no inline comments, for any non-compose env file.

### M3. The server image installs root devDependencies for nothing

`apps/server/Dockerfile:22`, `--include-workspace-root`. It pulls root `rea-agents`, which brings an optional
`frida` package with a native install (prebuild download, or a compile that fails on slim). The `server` workspace
imports none of the root deps (`@neon/*`, `rea-agents`): grep found no use under `apps/server`. **Fix:** drop the
flag. Do not use `--omit=optional` instead, because sharp's platform builds are optional deps.

### M4. Missing required env is not fail-fast

- `apps/server/server/storage/media.ts:22` turns missing `STORAGE_*` into `""`. The first upload or render then fails
  with a signature error.
- `register()` (`apps/server/instrumentation.ts`) only checks AUTH_URL and only runs in the api. The worker never
  runs it, so a worker with an http or missing AUTH_URL starts and only fails when it builds an email link
  (`server/auth/tokens.ts:14`).

**Fix.** A small `assertProductionEnv()` (`AUTH_SECRET`, `AUTH_URL` https, `DATABASE_URL`, `STORAGE_ACCESS_KEY_ID`,
`STORAGE_SECRET_ACCESS_KEY`), called from `register()` and at the top of `worker/main.ts`'s entry block.

### M5. `kickIfDue` queries the DB every 30 s per api instance even though the api never runs jobs

`apps/server/server/jobs/runner.ts:108-115`. With `RUN_JOBS_IN_API=false`, `kickRunner` is a no-op (`:98`), but
`findFirst` still runs while anyone polls. It is cheap, but it is a query that does nothing. **Fix:**
`if (process.env.RUN_JOBS_IN_API === "false") return;` at the top.

### M6. Jobs of an unknown type are put back forever

`runner.ts:71-73` and `queue.ts:92-96` reset the job to pending every 60 s with the attempt uncounted. After a
rollback (a newer release queued a type the older release does not know), those rows churn every minute forever.
**Fix:** dead-letter when `createdAt` is older than, say, 7 days.

### M7. The worker has no liveness signal

The worker has no healthcheck in compose and no health check on EC2. A wedged `await`, such as a provider call
without a timeout (14 bare `await fetch(` in `server/` have no visible signal, though most go through helpers with
`AbortSignal.timeout`), blocks the single sequential loop. `holdLease` keeps renewing, so no other worker can reclaim
the job. Sign-in-code emails (`mobile/code` → outbox) then stop going out, because the api no longer runs jobs.
**Fix:** write a heartbeat timestamp each loop and add a compose `healthcheck` / CloudWatch alarm on its age, or rely
on the per-job ceiling from I1.

### M8. One-release compatibility should cover job types and payloads, not just schema

`docs/DEPLOY_EC2.md:84-87` covers columns and tables only. Removing a job handler, or changing a payload shape, in
the same release as the producer breaks during the step 2–3 overlap (new workers, old API). **Fix:** one sentence
saying job types and payload shapes follow the same add-then-remove rule.

### M9. Compose order and re-runs

`docker-compose.yml:9-11` and DEPLOY_EC2 "Single box":

- `up -d worker server-api …` re-runs `migrate`, because both depend on it with `service_completed_successfully`.
  Migrate therefore runs twice per release. That is harmless because it is idempotent.
- worker and server-api start in parallel, so "migrate → worker → api" is not enforced.
- Recreating server-api gives a short window of nginx 502s.

**Fix:** state this in the doc, or drop the separate `run --rm migrate` step. Add "a brief 502 during recreate" to
Known ceilings.

### M10. TLS issuance and renewal are not covered

`deploy/nginx.conf:30-34` redirects all of :80, and no `/.well-known/acme-challenge/` location exists. DEPLOY_EC2
says "Let's Encrypt" (compose comment) but gives no issue or renew procedure. **Fix:** add an ACME location on :80
(webroot volume), or document certbot standalone with nginx stopped.

### M11. Docs do not match the split

- `README.md:31` says "Prisma in `apps/web/prisma`". `README.md:40` says to copy Neon vars "into `apps\web\.env`".
  There is no `apps/server` row and no `apps/mobile` row.
- `docs/ARCHITECTURE.md:22-38,215-223` still labels the pre-split layout **[Today]** (Vercel cron, `vercel.json`,
  `scripts/worker-dev.ts` "every 5 s"; the file is deleted and the worker now runs every 15 s). `:238` still lists
  `AWS_*` storage names.
- `apps/server/README.md` lists no `build:worker` and no Docker or worker run instructions.
- `docs/ENV_SETUP.md:139` says "Full list of Server groups: `apps/server/.env.example`". The example lacks variables
  the code reads: `HIGGSFIELD_API_KEY_ID`, `HIGGSFIELD_API_KEY_SECRET`, `ELEVENLABS_API_KEY`, `GOOGLE_MAPS_API_KEY`,
  `EXPO_ACCESS_TOKEN`, `LANGUAGETOOL_URL`, `USD_INR`, `AI_MAX_TIER`, `AI_ALLOW_MOCK`, `TWILIO_SMS_USD`,
  `UNLIMITED_CREDIT_WORKSPACES`. This gap predates the branch (the old root `.env.example` lacked them too), but the
  new per-role table points operators at it.

### M12. The web image bakes `/api` rewrites to `http://localhost:3101`

`apps/web/next.config.ts:6`; confirmed in `apps/web/.next/standalone/apps/web/.next/routes-manifest.json`
(`afterFiles` destination). This is by design, and production routes `/api/*` before the website. Any `/api` request
that does reach the web container still fails with a 500, for example the bare path `/api` under nginx's
`location /api/`, or a misordered ALB rule. **Fix (optional):** guard the rewrite with
`NODE_ENV !== "production"`. The comment in `apps/web/Dockerfile` already explains the rest.

## Deferred-minor triage

| Deferred item (ledger) | Verdict |
|---|---|
| Worker stop timeout must exceed the longest job | **Promoted to Important (I1, I2).** The worker keeps claiming after SIGTERM, there is no job ceiling off Vercel, and the EC2 mechanism doesn't signal. |
| server-api 10 s default stop grace cuts chat streams on redeploy | Minor (M1), compose only. On EC2 the ALB deregistration delay of 330 s covers it, provided instances are terminated after draining (ASG does this). |
| `npm ci -w` with mobile/brandpilot `package.json` absent | **First-build check.** Reading npm's `ci` lockfile validation (ideal → lock), extraneous lock entries for absent workspaces are pruned, not flagged, so this probably works. Unverified. Fallback: copy the two missing `package.json` files as well (they are tiny), or use `npm install --workspaces=false`-style per-app lockfiles. |
| sharp libvips tracing | **First-build check, likely fine.** `next/dist/build/collect-build-traces.js:197-200` ignores `**/node_modules/sharp/**` and `**/@img/sharp-libvips*/**` only when `hasNextSupport` (Vercel). That ignore list implies NFT does trace the libvips package on Linux. The local trace only proves win32 (`@img/sharp-win32-x64/lib/libvips-42.dll` is in-package). |
| Root workspace postinstalls | Server: the root has no postinstall. `--include-workspace-root` only adds `rea-agents` → optional `frida` native install, so drop the flag (M3). Web: the web deps stage copies `apps/server/package.json`. **Unverified** whether npm runs the unselected `server` workspace's `postinstall` (`prisma generate`, with no prisma installed and no `prisma/` dir), which would fail the web build. **First-build check.** If it fails, stop copying `apps/server/package.json` in `apps/web/Dockerfile:14`. |
| `kickIfDue` polling when `RUN_JOBS_IN_API=false` | Minor (M5), with a one-line fix. |
| Missing STORAGE creds not failing fast | Minor (M4). Add the worker AUTH_URL check alongside. |
| Unknown-type jobs re-released forever | Minor (M6). Only bites after a rollback. |
| Products e2e needing data | Not an ops issue. Accept: it is a test-data precondition, and `E2E_PRODUCTS_BRAND` is documented in `apps/web/e2e/README.md`. |
| (also listed) nginx resolver `ipv6=off` | Fine for Docker's embedded DNS. No action. |

## First-build checklist (when Docker is available)

Run these from the repo root, in this order. Every item is unknown until it has been done once.

1. `docker build -f apps/server/Dockerfile --target api -t espanda-server-api .`
   - The `deps` stage `npm ci -w server -w @espanda/shared --include-workspace-root` succeeds with the mobile and
     brandpilot workspaces absent.
   - The ffmpeg-static install downloads its linux binary (GitHub network access needed). Prisma generate downloads
     the debian-openssl-3.0.x engine.
   - `next build` succeeds **with no env at all**. This is the first env-less build: locally `.env` was always present,
     and `.dockerignore` excludes `**/.env*`. Lint and typecheck run inside it.
2. The same command with `--target worker`. The esbuild bundle builds on Linux.
3. `--target migrate` installs `prisma@6.19.3` and the schema engine.
4. `docker build -f apps/web/Dockerfile -t espanda-web .` The web deps stage does not die on the server workspace's
   `postinstall`.
5. Inspect the api image:
   `docker run --rm --entrypoint sh espanda-server-api -c 'ls node_modules/@img; ls node_modules/.prisma/client; ls node_modules/ffmpeg-static; ls -l node_modules/ffprobe-static/bin/linux/x64; ls assets/fonts server/email/assets'`.
   Expect:
   - `sharp-linux-x64` and `sharp-libvips-linux-x64`
   - `libquery_engine-debian-openssl-3.0.x.so.node`
   - an executable `ffmpeg` and `ffprobe`
   - the fonts and the logo
6. In the worker image:
   `docker run --rm --entrypoint node espanda-server-worker -e "require('sharp');require('@prisma/client');console.log(require('ffmpeg-static'),require('ffprobe-static').path)"`.
   This must run from `/app/apps/server`.
7. The api refuses an http AUTH_URL. `docker run -e NODE_ENV=production -e AUTH_URL=http://x espanda-server-api`
   should exit non-zero and not serve. Confirm that Next's `ensureInstrumentationRegistered` really propagates the
   throw.
8. Bring up the compose stack with a self-signed cert and `AUTH_URL=https://localhost`. Check:
   - `docker compose ps`: server-api and web are healthy.
   - `curl -k https://localhost/api/v1/health` returns `{ok:true}`. `/healthz` is not exposed through nginx, so test
     it inside the web container.
9. Streaming through nginx: `curl -kN` a chat turn and see chunks arrive incrementally. Next calls `res.flush()` under
   compression (`pipe-readable.js:78`), but verify it once through nginx with `proxy_buffering off`.
10. A >60 s request (an agent run or chat) succeeds through nginx. If an ALB is in the path, run it several times and
    after idle gaps to catch keep-alive 502s (I3).
11. Upload a 4 MB image and a voice-clone sample through nginx (5 MB cap).
12. Worker:
    - `docker compose logs worker` shows `started, polling every 15000 ms`.
    - Queue a job and see `processed 1 job(s)`.
    - `docker compose stop worker` during a job: the log shows "finishing the current run" and `stopped` before the
      grace period ends.
13. Story render in the worker container: fontconfig cache under `/home/node/.cache`, text renders with the bundled
    fonts, and ffmpeg runs as the `node` user.
14. Sign-in end to end through nginx: the `__Secure-` cookie is set, then SSR pages load (web → `server-api:3101`
    with the forwarded cookie).
15. Image sizes. Expect the api image to be large: ffmpeg is about 75 MB and the full ffprobe-static package is
    traced. Note the numbers for the EC2 disk and pull time.

## What I checked and found sound

- **Ports.** Server 3101 (`package.json` dev/start, Dockerfile `PORT`/`EXPOSE`, compose `expose`, nginx upstream).
  Web 3100 likewise. Only nginx publishes ports (80, 443). `HOSTNAME=0.0.0.0` in both runtime stages.
- **Standalone layout.** `outputFileTracingRoot` is the repo root, so `server.js` sits at `apps/<app>/server.js`. The
  Dockerfiles copy `standalone/` to `/app` and `.next/static` (plus `public` for web) to the right places, with
  WORKDIR `apps/<app>`. `.next/static` exists for the server too, so its `COPY` won't fail.
- **cwd-relative assets.** `server/stories/render.ts:14` (`assets/fonts`, `FONTCONFIG_FILE`) and
  `server/email/sign-in-code.ts:6` (`server/email/assets/espanda-logo.png`) resolve under WORKDIR
  `/app/apps/server`. Both are present in the traced output. The fontconfig cachedir `xdg` resolves to `/home/node`,
  which the node user can write.
- **Prisma.** `binaryTargets = ["native", "debian-openssl-3.0.x"]`, and the debian engine is in the traced
  `.prisma/client`. openssl is installed in the base image. `directUrl = DATABASE_URL_UNPOOLED` is used by migrate,
  which runs with `--schema prisma/schema.prisma` from `/app`.
- **Worker bundle.** Externals are exactly `@prisma/client`, `sharp`, `ffmpeg-static` and `ffprobe-static`; I checked
  the `require(` list in `dist/worker.js`. All four are present in the standalone `node_modules` that the worker
  stage inherits. `kickRunner`/`after()` is reachable only from route code (`server/reels/service.ts:222` is called
  only by a route), so the bundled `next/server` `after` never runs in the worker.
- **Worker loop.**
  - Sequential loop with an abortable sleep.
  - The 05:00 UTC sweep uses `getUTCHours() >= 5` with an in-memory `sweptDay`, backed by the per-day idempotency key
    (`runner.ts:170-176`), so restarts and multiple workers are safe.
  - The sweep is retried on the next loop if it fails.
  - `init: true` in compose; SIGTERM and SIGINT are handled.
  - The 360 s grace is right in intent (see I1 and I2 for the gaps).
- **Health.**
  - `/api/v1/health` takes no DB or error details. It does pass through the auth middleware, which returns `next()`
    for non-redirects, so it stays 200 even if Auth.js complains.
  - `/healthz` is excluded from the web middleware matcher and is not prerendered: it is absent from
    `prerender-manifest`, so it is dynamic.
  - Both compose healthchecks use `node -e fetch`, which needs no curl in the slim image.
  - `web` waits for a healthy api; nginx waits for both.
- **Timeouts.** ALB idle 330 s, nginx `proxy_read_timeout` and `proxy_send_timeout` 330 s, and Next dev
  `proxyTimeout` 330 s are all above the 300 s routes. `proxy_buffering off` on `/api/`. Next flushes compressed
  streams. The `Connection ""` and `X-Forwarded-For $remote_addr` overwrite match `clientIp`'s right-most rule
  (`server/auth/rate-limit.ts:36-39`).
- **Body size.** nginx `client_max_body_size 5m` covers the largest body-reading routes: media 4 MB, voice clones
  4 MB, recordings 1 MB. Story media goes direct to storage.
- **Env per role.**
  - Web reads only `SERVER_URL` (`lib/server-fetch.ts:18`, `next.config.ts:6`).
  - The api, worker and migrate needs in ENV_SETUP §8 and DEPLOY_EC2 match the code: `RUN_JOBS_IN_API`,
    `CRON_SECRET` unset → `/api/v1/jobs/run` fails closed (`route.ts:9`), `STORAGE_*`, and `AUTH_URL` + `NODE_ENV`
    for the worker's email links (`server/auth/tokens.ts:11-17`).
  - No `AWS_*` readers remain in the server code.
  - `.dockerignore` keeps every `.env*`, `deploy/env` and `deploy/certs` out of the build context. `.gitignore`
    covers `deploy/env/` and `deploy/certs/`.
- **Migrations.** None added on this branch. The migration folder set is identical before and after the move. The
  migrate target pins the Prisma CLI to the lockfile version.
- **nginx.** A complete `nginx.conf` with the no-args log as the only access log. The Docker resolver with variable
  `proxy_pass` passes the full original URI. The inherited `proxy_set_header` set is not overridden in either
  location. Temp dirs get chowned to the worker user by nginx at start.
- **Graceful api shutdown.** Next 15.5 `start-server` `server.close()` waits for in-flight requests (Docker's 10 s
  is the only limiter, M1). On EC2 the 330 s deregistration delay covers it.
- **Root scripts.** `build:server`, `build:web`, `dev:*` and `db:*` point at the right workspaces. Playwright starts
  both dev servers (3101 health via `/api/auth/providers`, 3100).
