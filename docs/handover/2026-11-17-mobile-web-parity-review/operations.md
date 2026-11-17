# Mobile → web parity: operations and performance review (before)

Lens: what changes for the Server, the worker, storage and the bill when a browser becomes a second client for the
mobile-only flows. Read-only review of `apps/server`, `apps/web`, `apps/mobile` on `desktop-shell`, 2026-11-17.

Feature order used below ("lands with"): **F1** brand look & feel + photo library, **F2** photoshoot, **F3** reels
studio (scripts, storyboard, presenter, voice clone, voiceover recording, render, publish), **F4** stories editing + post
from brief, **F5** customer inbox + Google reviews/posts, **F6** automations + credits, **F7** onboarding, **F8** plans.
**F0** means "shared groundwork, before F1".

Ratings: **Critical** = ships money loss or an outage path the browser makes easy; must land before (or with) that
feature. **Important** = real load, cost or wrong-state risk; land with the feature. **Minor** = do when convenient.

## Summary

| # | Rating | Finding | Lands with |
|---|---|---|---|
| C1 | Critical | Photoshoot "Generate" has no idempotency: a double click or a retry after the 30 s browser timeout charges and runs twice | F2 |
| C2 | Critical | Browser default timeout (30 s) is shorter than paid/slow writes (clone, recording, plan edit/chat, brand create); the server keeps going, the person retries, work is paid twice | F0 |
| C3 | Critical | Inbox and Google reviews are live provider reads with a shared 30/min per-brand cap; plugging them into `useBrandData` (6 s) would 429 everyone on that brand, phone included | F5 |
| I1 | Important | A stale tab can start a second paid render of the same version after the phone's render finished (no "last attempt seen" check) | F3 |
| I2 | Important | Voice clone has no client key: two submits make two clones and two charges | F3 |
| I3 | Important | Browser recordings are WebM/Opus on Chrome/Firefox; clone and voiceover only accept M4A | F3 |
| I4 | Important | Every poll re-signs every media URL, so `<img>`/`<video>` re-download on each poll (egress, NAT per GB, flicker) | F1 |
| I5 | Important | Direct-to-storage PUT from a browser needs bucket CORS; nothing documents or sets it; the API path is capped at 5 MB | F1 (F4 for clips) |
| I6 | Important | Hot read path: ~13 sequential round trips per reel poll; auth alone is 7-9, half of them duplicates | F0 |
| I7 | Important | Every reel/credits read does an INSERT (starter grant) and a full-ledger SUM; render view reads the ledger without `workspaceId` (no usable index) | F3 / F6 |
| I8 | Important | Worker: 4 FIFO loops shared by minutes-long shoots/agent runs and 1-attempt publishes; no lane or lag metric | F2 |
| I9 | Important | Web polling helpers: N fetches on mount, no in-flight guard, no backoff, some 3 s polls ignore tab visibility, no stop on terminal state | F0 |
| I10 | Important | Onboarding brand create has no idempotency: a double submit makes two brands and two sets of Research/SEO/GEO runs (our cost) | F7 |
| I11 | Important | No feature flags and no per-client tagging; can't roll out or kill a web flow without a deploy, nor tell web from phone in the ledger | F0 |
| I12 | Important | No observability for queue lag, job duration, refunds or 429s; the nginx log has no upstream time | F0 |
| M1 | Minor | Agent-run double click charges then refunds; at a low balance the second click can see a false 402 | F6 |
| M2 | Minor | Reel GET writes (`enqueueTick`) on every poll once a render is >60 s quiet, per client | F3 |
| M3 | Minor | Open handover items that a second client makes more likely (A-M7, B-M5, join downloads without timeout, no per-job ceiling) | F3 |
| M4 | Minor | Dev-only: React strict mode + 170 ms RTT makes a 3 s poll overlap itself | F0 |

What is already safe (checked, no action): reel render start is serialised per item and the charge is idempotent per
`versionId:attempt` (`server/reels/render.ts:117-158`); a second start while one runs returns the running render
(`:120-121`, `:131`). Agent runs dedupe in-flight runs under an advisory lock and refund the joiner
(`server/agents/engine.ts:82-93`, `:141`). Reel assets (presenter, template preview) allow one RUNNING per kind via a
partial unique index and refund the loser (`server/reels/assets.ts:30-46`). Credit spends are serialised per workspace
(`server/services/credits.ts:61-71`). The state-machine audit's Critical (render polls forever,
`2026-11-16-state-machines/server.md` §10) is fixed: `render.ts:170` now applies the 24 h give-up on read failures.
The lost-lease refund (server.md §1) is now skipped when `failJob` returns null (`server/jobs/runner.ts:93-97`); the
remaining window is open minor B-M5 (M3 below).

---

## Critical

### C1. Photoshoot start is not idempotent (lands with F2)

Evidence: `server/photoshoot/shoot.ts:81` makes a fresh `randomUUID()` per request and uses it as the charge `refId`
(`:83`) and the row id (`:85`). Nothing ties two requests together; the route (`app/api/v1/.../photoshoots/route.ts:27-45`)
takes no key. Unlike renders there is no "one running" rule.

Why web makes it likely: the browser button is live until the response, and that response sits behind 7-9 auth round
trips plus a charge transaction (seconds in dev). A double click, an Enter + click, or a retry after C2's 30 s timeout
each buys another shoot. Ultra tiers are the expensive ones and OpenAI shoots get one attempt.

Fix (small): accept an `Idempotency-Key` header (or `requestId` in the body, a UUID the client makes once per form
submit and keeps across retries). Use it, validated as a UUID and namespaced by workspace, as the shoot id and charge
`refId`. `spendCredits` already returns the existing charge for a repeated `refId` (`credits.ts:55`); on the
`photoShoot.create` P2002, return the existing shoot instead of refunding. Disable the button until the response on the
web side too, but do not rely on it. Mobile should send the same key (same endpoint).

### C2. Browser timeout is shorter than slow writes (lands with F0)

Evidence: every web call goes through `send` with `TIMEOUT_MS = 30_000` (`apps/web/lib/net.ts:27`). Writes that can run
longer, server side:
- voice clone: ffmpeg convert + ElevenLabs `voices/add` with a 30 s timeout + a sample read 15 s
  (`server/reels/clones.ts:55-91`);
- voiceover recording: convert + OpenAI transcription with a 30 s timeout (`server/reels/recordings.ts:55`),
  route `maxDuration = 60` (`.../reels/[contentId]/recordings/route.ts:8`);
- reel plan edit and reel chat ("Directing an edited plan is an AI call", `.../reels/[contentId]/route.ts:12-13`,
  `maxDuration = 300`);
- brand create (Maps lookup, name-from-website fetch, three agent starts; `server/services/create-brand.ts:61-108`).

The abort does not stop the server. The person sees "The server took too long", presses again, and the second request
pays again (clone, I2) or races the first (plan version conflict, a second brand, I10).

Fix: give `send` a per-call `timeoutMs` (default stays 30 s); pass 120 s for clone/recording/brand create and 330 s for
plan edit/chat (the ALB and nginx allow 330 s, `docs/DEPLOY_EC2.md:25`, `deploy/nginx.conf:50`). Pair every paid or
creating write with a client key (C1, I2, I10) so a retry after a timeout is harmless. Show "still working" after 10 s
rather than an error.

### C3. Inbox and Google reads share a 30/min per-brand budget (lands with F5)

Evidence: `server/customers/inbox.ts:22` `READS_PER_MIN = 30`, checked per brand at `:66`; each read fans out to the Graph
API per connected account (`:67-98`). `server/google/business.ts:13-20`: live reads, no cache, 30/min per brand, to
protect the project-wide Business Profile quota (~300/min). Mobile reads them on focus only
(`apps/mobile/src/app/marketing/reply.tsx:31`).

If the web port uses `useBrandData` (6 s, `apps/web/components/workspace/content-panels.tsx:54`), one open tab is
10/min; three tabs or two teammates plus a phone exceed 30, and every client on that brand gets "Messages are being
refreshed too often" for a minute. All brands share the Google project quota, so this scales badly with customers.

Fix: do not poll these on the web. Load on open, on window focus (at most once per 60 s) and on a Refresh button. Add the
30-60 s server cache that the `business.ts:13-14` comment already names as the upgrade (keyed by brand; the
`RateLimitBucket`-style table or an in-process LRU is enough for one API instance; note the scaled setup has several, so
a DB row is the safe choice). Invalidate it on a reply sent. Count 429s (I12).

---

## Important

### I1. Stale tab re-renders a finished reel (lands with F3)

Evidence: `startRender` refuses only when a render is ACTIVE or the plan version changed (`render.ts:120-123`); once the
phone's render is DONE, a web tab still showing the pre-render "Make video" for the same version starts attempt N+1 and
charges again (`:129`, `:136-137`). The tab polls, but a click can land between polls, and a hidden tab is paused.

Fix: send `afterAttempt` (the latest attempt the client has seen for this version, 0 if none) with `action: "render"`.
In the first transaction, if `_max.attempt > afterAttempt` and the latest is DONE, return 409 with the current detail
("This reel was just made on another device"). Mobile sends it too. This is the "client idempotency key" for renders;
the server-side CAS is already there.

### I2. Voice clone double submit (lands with F3)

Evidence: `server/reels/clones.ts:63-80`: each call reserves a new `Voice` row and charges with `refId: voice.id`.
Two submits (or C2's retry) make two rows, two charges and two ElevenLabs voices, up to `MAX_CLONES`. Open audit item
A-M3 and server.md §13 (orphan at ElevenLabs after a crash) also get more likely with retries.

Fix: client key as in C1, stored on the reservation (unique per workspace); a repeat returns the existing voice. With C2's
longer timeout.

### I3. Browser audio format (lands with F3)

Evidence: `isM4a` accepts only an MP4 `ftyp` container (`server/reels/recordings.ts:23-26`); used by recordings (`:85`)
and clones (`clones.ts:55`). `MediaRecorder` gives `audio/webm;codecs=opus` on Chrome/Edge/Firefox; only Safari gives
MP4. So most desktop browsers get "That recording couldn't be read" on both features. Not a load issue, but it decides
where conversion runs.

Fix: accept WebM (EBML magic `1A 45 DF A3`) as well; `toWav` already runs ffmpeg, which reads WebM. Keep the byte caps
(1 MB / 4 MB). Conversion stays on the API instance (it is seconds of CPU per take, rate-limited at 30/h per person,
`recordings/route.ts:29`), which is fine at current scale; note the ceiling (many concurrent takes on one API box) in the
code.

### I4. Media URLs re-signed on every poll (lands with F1, matters most for F2/F3)

Evidence: `signedMediaUrl` signs with the current time (`server/storage/media.ts:69-75`). Every poll re-signs:
`reelDetail` video + every scene photo (`server/reels/service.ts:260`, `:280`); `listShoots` up to 50 shoots × (source +
4 shots) (`server/photoshoot/shoot.ts:232-235`, `:227-228`). Already a deferred minor ("calendar thumbnails re-signed on
each poll", `docs/HANDOVER.md` ~line 191).

On the web this is worse than on the phone: a new URL is a cache miss, so the photoshoot results grid re-downloads up to
~250 images every 10 s while a shoot runs, and a `<video src>` that changes reloads the player mid-watch. That is storage
egress and, on EC2 private subnets, NAT per-GB charges (`docs/DEPLOY_EC2.md`, "Known ceilings").

Fix (one function): sign with a bucketed `signingDate` (floor of now to 30 min) and `expiresIn` of bucket + 1 h, so a URL
is byte-identical for 30 minutes. `@aws-sdk/s3-request-presigner` takes `signingDate`. On the web, keep the previous
`src` when the key is unchanged.

### I5. Browser uploads: CORS and size paths (lands with F1; clips with F4)

Evidence:
- Through the API: images up to 4 MB (`app/api/v1/.../media/route.ts:11`), clone 4 MB, recordings 1 MB; nginx caps bodies
  at 5 MB (`deploy/nginx.conf:41`). These buffer the whole file in API memory (`file.arrayBuffer()`), acceptable at
  these sizes.
- Direct to storage: story photos 15 MB / clips 100 MB via a presigned PUT with signed `content-type` and
  `content-length` (`server/stories/uploads.ts:16`, `:47`; `media.ts:81-87`). A browser PUT to the storage endpoint is
  cross-origin, so the bucket needs a CORS rule (origin = the website, method PUT and GET, header `content-type`). Neither
  `docs/DEPLOY_EC2.md` nor `docs/ENV_SETUP.md` mention CORS, and the Neon Object Storage bucket's CORS support must be
  checked. If it isn't possible there, nothing else works: the API path can't take a 100 MB clip.
- The presigned URL lives 600 s (`uploads.ts:23`); a 100 MB clip on a slow uplink can outlast it.

Fix: verify and document bucket CORS before F1 (the photo library could go direct too, removing the 4 MB cap). Browser:
`fetch(url, { method: "PUT", body: file, headers: { "Content-Type": type } })` (the browser sets Content-Length from the
File, which must equal the signed size). Use XHR if you want upload progress. Raise `PUT_SECONDS` for video to 30 min, or
re-issue a slot on 403. Library images: keep 4 MB through the API for F1 unless CORS is confirmed; then move them to
the slot flow.

### I6. Per-request query count on the hot endpoints (lands with F0)

Sequential DB round trips, web cookie auth, counted from code:

`authorizeBrandRoute` (`server/api/brand-route.ts:20-31`), used by every brand route:
1. `auth()` jwt callback: `user.findUnique` (`auth.ts:60`)
2. `requireWorkspaceMember` (`server/auth/access.ts:40` → `:19`)
3. `brand.findFirst` (`access.ts:42`)
4. `effectivePermissions` → `memberRole` with `roleRef` include (`permissions.ts:32`; +1 for a legacy role, `:38`)
5. `brandMember.findFirst` (`permissions.ts:54`)
6. `requirePermission` → `memberRole` again (`permissions.ts:75` → `:49`)
7. `brandMember.findFirst` again

= **7-9**, of which 2 (member) + 2 (`memberRole`, `brandMember` twice) are duplicates.

`GET /reels/:id` (`app/api/v1/.../reels/[contentId]/route.ts:18-31`), the one the generating/review screens poll every
3-5 s: auth 7-9; `contentItem` with versions and checks (Prisma without `relationJoins` = up to 3 sequential queries,
`service.ts:252-255`); then in parallel `renderView` (2 sequential, `render.ts:493-495`) and `creditBalance` (INSERT +
aggregate, `credits.ts:29-38`); `reelRender.findFirst` (`route.ts:24`); maybe `enqueueTick` (M2); `kickIfDue` in dev
(`runner.ts:136-140`). **≈13-15 round trips**: ~2.3 s per poll at 170 ms (dev in India → Frankfurt), single-digit ms in
production if the EC2 region is `eu-central-1` (same as Neon, `docs/ENV_SETUP.md:5`). Put the API in that region; this
review assumes it.

`GET /photoshoots`: auth 7-9 + 1 + signing (I4). `GET /customers/inbox`: auth + rate-limit upsert + accounts + Graph.

Cheap wins, in order:
1. `authorizeBrandRoute`: compute `effectivePermissions` once and check both `brand.read` and the route's permission
   from that one set; drop the separate `requireWorkspaceMember` (the `memberRole` read already proves membership; a
   null result is the same 403). 7-9 → 4-5, on every brand route, both clients. Keep the error types the same.
2. `creditBalance`: stop running `ensureStarterGrant` on reads (grant at workspace creation and keep the call only in
   `spendCredits`), see I7.
3. `reelDetail`: run `reelRender.findFirst` (route `:24`) inside the same `Promise.all`, or derive it from `renderView`'s
   rows (it already loads the latest 20 renders).
4. Optional: Prisma `relationJoins` preview for the hot `include`s. Preview feature; measure first.

Request-scoped memo (`React.cache`) is not available in route handlers in the same way; passing the computed permission
set down is simpler.

### I7. Writes and full scans on every balance read (lands with F3, then F6)

Evidence: `creditBalance` always runs `createMany ... skipDuplicates` (an INSERT attempt) and then `SUM(delta)` over the
whole workspace ledger (`server/services/credits.ts:29-38`). It is called on every reel poll (`service.ts:260`) and on
`GET /credits` (`app/api/v1/workspaces/[workspaceId]/credits/route.ts:30`). `renderView` reads
`creditEntry where refId in (...)` without `workspaceId` (`render.ts:495`); the only indexes are
`@@unique([workspaceId, reason, refId])` and `@@index([workspaceId, createdAt])` (`prisma/schema.prisma:1113-1114`), so
that query cannot use an index and scans the whole table, on every reel poll from every client.

Fix: add `workspaceId: r.workspaceId` to the `renderView` query (one line, uses the unique index's prefix). Move the
starter grant out of the read path. The SUM is fine until a workspace has tens of thousands of rows; note that ceiling
in `credits.ts` (upgrade: a balance column updated in the spend transaction).

### I8. Worker capacity and head-of-line blocking (lands with F2)

Evidence: `WORKER_CONCURRENCY` default 4 loops (`worker/main.ts:39-41`), each sequential (`runner.ts:54`); the claim is
plain FIFO by `runAt` across all types (`server/jobs/queue.ts:50-56`). Long holders: OpenAI photoshoots run inline for
minutes (`shoot.ts:122`), agent runs up to 300 s, reel JOIN downloads + ffmpeg (downloads have no timeout: open item in
`docs/HANDOVER.md` ~line 121). Publish jobs get one attempt and a lease. With the API not running jobs in production
(`RUN_JOBS_IN_API=false`, `runner.ts:124-126`), a newly queued job waits up to `WORKER_INTERVAL_MS` (15 s) for a loop.

A desktop user is likelier to start several shoots or renders in a row than a phone user. Four Ultra shoots from one
workspace fill every loop; a scheduled publish then waits minutes.

Fix, in order of cost:
1. Measure first (I12: queue lag per type).
2. Raise `WORKER_CONCURRENCY` to 8 with the pool at ≥ 10 (`connection_limit` on `DATABASE_URL`,
   `docs/DEPLOY_EC2.md:117-119`). Each idle loop adds a claim query per interval (Neon wake-ups; same doc).
3. If lag still shows: reserve one loop for short types (`publish`, `email.send`, reel/asset/shoot ticks) by passing a
   type filter into `claimNextJob`. Small change, keeps one queue.
Also cap concurrent paid starts per workspace (e.g. 3 running shoots) so one account can't occupy the worker.

### I9. Web polling helpers (lands with F0)

Evidence (`apps/web/components/workspace/content-panels.tsx:63-103`): shared cache per URL and a visibility pause (good),
but every hook calls `load()` on mount (`:89`), so N panels on one URL send N requests at once; there is no in-flight
guard, no backoff on errors (`:75` just sets `failed`), and polling never stops at a terminal state. Story render polling
runs every 3 s with no visibility check (`:555-558`), as does the release panel (`release-panel.tsx:81-85`). Nothing
coordinates tabs. Mobile's `useReel` also has no in-flight guard (`apps/mobile/src/ui/reels/use-reel.ts:96`) and the
generating screen polls the same reel twice (`useReel(3000)` at `app/reels/generating.tsx:24` plus the 10 s
render watcher, `ui/reels/render-watch.ts:14`).

Recommended intervals for the new web screens (one hook, chained `setTimeout`, not `setInterval`):

| Thing | While running | Stop when | Hidden tab |
|---|---|---|---|
| Reel render | 5 s for the first 2 min, then 10 s, then 30 s after 10 min | DONE / FAILED | pause; refetch on show |
| Photoshoot | 5 s (detail), 10 s (list, only while any RUNNING) | DONE / FAILED | pause |
| Presenter / template preview | 10 s | DONE / FAILED | pause |
| Story render / "Preparing frames" | 3 s for 1 min, then 10 s | rendered / error | pause (fix the existing 3 s loops too) |
| Publishing now | 5 s, cap 10 min, then show "check the account" (PENDING_VERIFY) | PUBLISHED / FAILED / PENDING_VERIFY | pause |
| Credits, plan | on focus and after a paid action; no timer | n/a | n/a |
| Inbox, reviews | no timer (C3) | n/a | n/a |

On error: double the delay up to 60 s; on 429 respect the minute. One request in flight per URL (dedupe in the shared
map). Cross-tab: a `BroadcastChannel` per URL so only the visible tab polls and others take its result; cheap and
optional, do it if two-tab usage shows up in the logs.

Push channel: not now. Polling at the table above is ~12 req/min per watching tab, short-lived, and the hot path is
cheap once I6/I7 land. SSE through the ALB works (330 s idle) but needs fan-out across API instances (Postgres
`LISTEN/NOTIFY` per instance) and reconnect handling; revisit if poll traffic is a visible share of API load in
production. Mobile already has push for "render finished".

### I10. Onboarding brand create double submit (lands with F7)

Evidence: `createBrandWithResearch` (`server/services/create-brand.ts:50-110`) has no key; a second submit makes a second
brand with slug `-2` (`:71-84`) and starts Research, SEO and GEO again (`:97-108`, trigger `event`, so free to the person
and paid by us). Only a 10/day limit (`:57`). Same shape as the phone's Critical in `state-machines/mobile.md` §2
(every sign-in re-runs onboarding and makes a new brand): the web flow must not copy it.

Fix: client key (as C1), stored on the brand row or the audit event, returning the existing brand on repeat; and the web
onboarding must check `/me/shell` for an existing brand before offering "create".

### I11. Feature flags and client tagging (lands with F0)

Evidence: no flag mechanism exists in either repo (searched `FEATURE_`, `flags`, env toggles). The only per-workspace
switch is the `UNLIMITED_CREDIT_WORKSPACES` env list (`credits.ts:18-19`). Paid charges and audit events don't record
which client started them; page visits do (`server/services/activity.ts`, `platform: "web" | "mobile"`).

Fix (minimal, matches existing patterns):
- `WEB_FEATURES` env on the Web Frontend (comma list: `library,photoshoot,reels,stories,inbox,automations,onboarding,plans`)
  read in server components to show the nav entries; plus `WEB_FEATURE_WORKSPACES` to open a feature to listed
  workspaces first. No new table.
- A server kill switch for paid starts from the browser: the web sends `X-Client: web/<version>`; env
  `PAID_STARTS_OFF_FOR=web` makes the paid POSTs (render, shoot, clone, asset, agent run) answer 503 "Making this from the
  website is paused". Lets you stop a web bug from spending without stopping the phone.
- Put `client` into the audit-event metadata of each paid start (render already writes an audit event for clones,
  `render.ts:148-149`), so the ledger can be split by client without a schema change.

### I12. Observability (lands with F0, extended per feature)

Today: `console.log` lines from the worker (`worker/main.ts:71`), job errors on the row, the admin logs/spend pages, nginx
log with `$request_time` only (`deploy/nginx.conf:20`). Nothing reports queue lag, job duration, refunds or 429s.

Add (log lines first; ship to CloudWatch with the container logs):
- Worker, per job: `type, waitMs = claimedAt - runAt, runMs, outcome (done/retry/dead), attempt`. Queue lag p95 per type
  is the number that tells you when to act on I8.
- Paid start, per call: `feature, client, workspaceId, refId/chargeId, outcome (started / joined existing / 402 / 409),
  ms`. "Joined existing" counts are the duplicate-click rate.
- Daily (from the ledger, an admin query): refunds by reason, charges with no entity (A-M7), DEAD_LETTER count by type,
  renders older than 1 h still ACTIVE, shoots RUNNING > 1 h.
- nginx: add `$upstream_response_time` and keep `$uri` (no args) to get per-route latency and poll rate.
- Counters for 429s on `inbox:read`, `google:read`, `rec:user`, `story-upload` keys.
- Per feature on web: the poll rate per route (requests/min) for the first week after each flag opens.

---

## Minor

### M1. Agent-run double click: charge, then refund (F6)

`startAgentRun` charges without a `refId` (`server/agents/engine.ts:74`) before the dedupe (`:82-93`) and refunds the
joiner after (`:141`). Correct money, but at a low balance the second click's charge can fail with a 402 while the run
actually started. Fix if it shows: move the in-flight lookup before the charge (read-only), or pass a refId derived from
the dedupe key.

### M2. Reel GET writes on every poll (F3)

`route.ts:24-25`: when the active render's `updatedAt` is over 60 s old, each GET calls `enqueueTick`. The idempotency key
per 20 s slot (`render.ts:105`) dedupes it, but it is still an upsert per poll per client during long CLIPS waits. Fine
at current scale; the worker owns the tick in production, so this nudge could be limited to `RUN_JOBS_IN_API !== "false"`
like `kickIfDue`. Check that a webhook-less production setup still advances renders before changing it
(server.md §10, "Polls need something to drain the queue").

### M3. Open handover items a second client makes likelier (F3)

From `docs/HANDOVER.md` ~lines 104-121: A-M7 a charge with no run to refund (more starts, more chances); B-M5 a lost
lease can fail and refund a shoot/asset/render that then finishes (logged, not prevented); reel join downloads have no
timeout (a hung join holds a worker loop, I8); "Nothing caps a job's run time"; `WORKER_INTERVAL_MS` unclamped. None
change because of the web, but I8 and I12 make them visible; land the join download timeout with F3.

### M4. Dev only: polls overlap (F0)

At ~2.3 s per reel GET in dev (I6) and strict mode's double effects, a 3 s `setInterval` stacks requests. The chained
`setTimeout` in I9 fixes it; I6's cheap wins make dev usable for testing these flows.

---

## Order of work

1. **F0** before any feature: C2 (per-call timeouts), I6 items 1-3 (auth once, balance read without INSERT, parallel
   render lookup), I9 (one polling hook), I11 (flags, `X-Client`, paid-start kill switch), I12 (worker and paid-start
   log lines, nginx upstream time).
2. **F1**: I4 (stable signed URLs), I5 (bucket CORS verified and documented).
3. **F2**: C1 (shoot key), I8 (measure lag, concurrency 8, per-workspace running cap).
4. **F3**: I1 (`afterAttempt`), I2 (clone key), I3 (WebM), I7 (`renderView` workspaceId), M2, M3 join timeout.
5. **F4**: I5 for clips (PUT expiry), story render polls paused when hidden (I9).
6. **F5**: C3 (no polling, server cache).
7. **F6**: I7 balance note, M1.
8. **F7**: I10.
9. **F8**: nothing new beyond I11 (plan reads on focus, not a timer).
