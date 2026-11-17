# Server/web split: state machines, domain B

Read-only review of branch `server-web-split` (worktree `sma-split`). It covers the content lifecycle, publishing, story
render, reel render and assets, photoshoots, connections, mobile auth, membership and invites, and the shell cookies.
Paths are relative to `apps/server/` unless they say otherwise.

Baseline used for "new or pre-existing": `git show desktop-shell:apps/web/server/<path>`. With CRLF ignored, every
domain-B service file matches desktop-shell exactly. The only differences are the `safeHttpUrl` import in
`services/publishing.ts:8` and `import "server-only"` in `services/credits.ts:1`. So a finding is **new with the split**
only when the split changes how existing code runs: a standalone worker with `WORKER_CONCURRENCY` claim loops, no
Vercel `maxDuration` cap on job run time, and the API no longer draining the queue in `after()`.

These tests pass on the branch: `stories-publish`, `connections`, `reel-render`, `stories-runner` and `worker-loop`
(5 files, 91 tests).

## Summary

- **Critical: 0. Important: 1. Minor: 7.**
- All six hardening fixes hold under the new concurrency (see "What's sound").
- The one Important finding is new with the split. `releaseState` declares a publish lost after 10 minutes. That was
  safe while Vercel killed every job at 300 s. Now a slow non-story publish can still be running when a page view marks
  it `PENDING_VERIFY`. That worker can then post after a person has said "it didn't post" and booked it again: a
  double post. A lost lease leads to the same place through `onPublishJobLost`.
- No double charge was found. Every paid step is protected by an idempotency key, a compare-and-set, `maxAttempts: 1`
  (OpenAI shoots) or an idempotent refund. Wasted provider spend is possible in places, and those are listed.

## Machines

| Machine (field) | States | Writers (file:line) | Guard on each transition |
|---|---|---|---|
| ContentItem (`status`) | PLANNED, BRIEF_READY, DRAFT_REVIEW, AWAITING_APPROVAL, APPROVED, SCHEDULED, PUBLISHED, REJECTED, BLOCKED. No writer sets REVIEWED or CANCELLED. | `saveDraft` publishing.ts:232; `decide` :312; `schedulePublication` :414; `executePublication` finish :434 / finishStory :449; `storyJobLost` :652; `settlePublication` :694; `settleFrame` :737; `markDone` :781; `createStoryVersion` stories/service.ts:211; `failStoryStart` :483; `reopenStoryWrite` :515; `setByHand` stories/by-hand.ts:41 (byHand only); `registerManualPost` manual-post.ts:32; reel `joinClips` reels/render.ts:400; reel `savePlan` reels/service.ts:93; `disconnect` connections.ts:259; agents brief.ts:105, creator.ts:231, quality.ts:133; creates in publishing.ts:179, stories/service.ts:388/467, planner.ts:148, reels/service.ts:129 | Person and agent writes run under the per-post advisory `lock` and re-read status and version (saveDraft, decide, schedule, createStoryVersion, joinClips, creator, quality, setByHand, manual post, settleFrame, postRest, markDone). brief.ts uses a status CAS. Publishing's item writes depend on the attempt CAS (the item stays SCHEDULED throughout). Without the lock or an item CAS: `settlePublication` :694 (relies on the attempt CAS) and `failStoryStart` :483 (no guard). |
| PublicationAttempt (`status`) | SCHEDULED, PUBLISHING, PUBLISHED, FAILED, PENDING_VERIFY, PARTIAL, CANCELLED | create publishing.ts:406, :762; claim :424; finish :432 / :447; story `save` :567; `onPublishJobLost` :625; `storyJobLost` :650; `releaseState` 10-min sweep :803 (+ :799); `settlePublication` :681, :689; `settleFrame` :726; `postRest` :758; `markDone` :779; `disconnect` connections.ts:251, :257 | Every transition is an `updateMany` on the expected prior status. `storyJobLost` also takes `FOR UPDATE`. Each story frame write needs PUBLISHING. One live attempt per (version, account) is checked under the item lock (:402). |
| Job (`status`) | PENDING, RUNNING, COMPLETED, DEAD_LETTER | jobs/queue.ts: claim :43 (SKIP LOCKED), `holdLease` :67, `completeJob` :76, `releaseJob` :92, `failJob` :101 | Lease (`leasedBy` + RUNNING) on complete, release, fail and renew. A job reclaimed after its last attempt is failed once (runner.ts:73). |
| Story render (Job chain + version) | job steps `next=0..n`, then the version | stories/service.ts `queueStep` :180, `renderStep` :250, `createStoryVersion` :192 | Each step checks `assertEditable` (status, byHand, statusAtSave, baseVersion). The final write is under the lock. A retried final step recognises its `renderId` (:255). Follow-up keys are idempotent (:183). |
| ReelRender (`step`, `claimedAt`) | VOICE, CLIPS, JOIN, DONE, FAILED | reels/render.ts: create :146; VOICE→CLIPS :267; submit claim :276, ids :285/:290; retries :315/:327; CLIPS→JOIN / JOIN re-claim :335-336; release :348; JOIN→DONE :394; `failRender` :433 | Step CAS everywhere. `claimedAt` CAS on submit and join. Stale reclaim after 2 min (submit) or 6 min (join). `failRender` CAS on ACTIVE steps, refunding in the same transaction. |
| ReelAsset (`status`) | RUNNING, DONE, FAILED | reels/assets.ts: create :42; requestId :68; DONE :78; `failAsset` :92 | DONE and FAILED CAS on RUNNING. FAILED and the refund share one transaction. A partial unique index allows one RUNNING row per kind. |
| PhotoShoot (`status`) | RUNNING, DONE, FAILED | photoshoot/shoot.ts: create :84; requests :128; `finish` :170; `failShoot` :160 | DONE and FAILED CAS on RUNNING. FAILED and the refund share one transaction. OpenAI shoots run with `maxAttempts: 1`. Higgsfield requests use per-shot idempotency keys. |
| Credits (ledger) | charge, refund | services/credits.ts `spendCredits` :47, `refundCharge` :78 | Charges are unique on (workspace, reason, refId) under a workspace advisory lock. A refund is a unique row per charge (`skipDuplicates`). |
| IntegrationConnection (`status`) | ACTIVE, ERROR, REVOKED | `markReconnect` connections.ts:19; refresh :48; `saveConnections` upsert :186; `disconnect` :238 | Refresh and markReconnect CAS on ACTIVE. Disconnect CAS on not REVOKED. A reconnect (upsert) is unconditional by design. |
| OAuth state | open, consumed | connections.ts :148 | CAS on `consumedAt: null` and not expired. |
| Email sign-in code (VerificationToken) | live, spent or replaced | mobile-auth.ts :47-48 (replace), :74 (spend) | The spend is a delete CAS on hash and expiry. Replacement is delete-then-create with no lock (see M2). |
| Phone code | owned by Twilio Verify | mobile-auth.ts :191-201 | Twilio's own check. The link is `createMany skipDuplicates`, so the first link wins. |
| Mobile session | valid or invalid by `sessionVersion` | auth/request-user.ts:13-21; bumped by accounts.ts:166, :279 | Every request compares the token's `sv` with the user's `sessionVersion`, status and deletedAt. |
| Push device | registered or forgotten | notifications/push.ts:23 (upsert on unique token), :32, :56 | The token is unique, and a native upsert moves the token to the newest user. |
| Invitation | pending, accepted, revoked (expired by time) | accounts.ts:62 (revoke older), :158 (accept CAS); project-members.ts:80; workspace-admin.ts:238 | Accept and revoke are CAS on `acceptedAt: null, revokedAt: null`. |
| Shell cookies (`/me/context`) | workspace and brand ids in cookies | app/api/v1/me/context/route.ts | JSON only, Origin must equal AUTH_URL, access checked before the cookie is set. `loadShellContext` re-validates the cookie against membership on every read. |

## Critical

None.

## Important

### I1. A slow non-story publish can be declared lost while its worker is still running, which can lead to a double post — new with the split

- **Where:**
  - `server/services/publishing.ts:794-805`: `releaseState`, run on every GET or POST of the post view (web and phone),
    flips a PUBLISHING attempt to PENDING_VERIFY once `updatedAt` is more than 10 minutes old.
  - `:511-517`: the non-story path calls `publisher(...)`, which ends in `media_publish` / `threads_publish` / `photos`.
    Nothing re-checks the attempt between the claim at `:424` and that irreversible call.
  - `:621-629`: `onPublishJobLost` is the other way in. It runs when the job's lease was lost and the job reclaimed
    (`jobs/runner.ts:73-77`, `attempts > maxAttempts` with `maxAttempts: 1`).
  - `server/integrations/publishers.ts:55-67, 120-137`: container polling makes up to 50 polls for a reel and up to 10
    for each carousel child and for the parent. Each poll is a call with a 30 s timeout plus a 3 s sleep, so one publish
    can run for well over 10 minutes when Graph is slow.
- **Why it's new:** the code is unchanged, but the comment at `:794` assumes "a crashed worker leaves PUBLISHING forever".
  On Vercel every job ran under `maxDuration = 300`, so an attempt that had been PUBLISHING for 10 minutes was certainly
  dead. The worker has no cap on run time (`jobs/runner.ts:54`), so the 10-minute rule now also catches live publishes.
- **Interleaving (double post):**
  1. 10:00. Worker loop W claims the attempt (SCHEDULED→PUBLISHING) and starts a reel. Graph is slow, and each status
     poll takes 20-30 s.
  2. 10:11. A person opens the post on the phone. `releaseState` sees PUBLISHING for more than 10 minutes and writes
     PENDING_VERIFY with "Check the account before trying again". The item stays SCHEDULED.
  3. 10:12. The person checks Instagram, sees nothing (the container isn't published yet), and taps "It didn't post".
     `settlePublication` moves PENDING_VERIFY→FAILED (`:689`) and the item to APPROVED (`:694`).
  4. 10:13. They schedule it again on the same account. `LIVE` (`:63`) doesn't include FAILED, so a new attempt and job
     are created.
  5. 10:14. W's container finishes and W calls `media_publish`: the reel is live. `finish("PUBLISHED")` matches 0 rows
     (the attempt is FAILED) and does nothing.
  6. The new attempt's job posts the same reel again.

  The same sequence starts from step 2' instead: `holdLease` renewals fail for 5 minutes (they are swallowed at
  `jobs/queue.ts:71`), another loop reclaims the job, and `onPublishJobLost` writes PENDING_VERIFY while W keeps running.
- **Stories are not affected.** Each frame's `save` (`:566-569`) must match PUBLISHING before its publish call, so a
  story worker stops as soon as the attempt has been settled.
- **Fix:**
  1. Before the irreversible call, do what the story path does. Run
     `updateMany({ where: { id, status: "PUBLISHING" }, data: { updatedAt: new Date() } })` and stop if `count !== 1`.
     The simplest place is just before `publisher(...)` at `:514`. Better: move the platform's publish step behind a
     callback, as stories do with `onPublishing`, so the check runs after the container is ready.
  2. Make the `releaseState` sweep judge the job, not `updatedAt`. Only flip the attempt when its `content.publish`
     job is no longer RUNNING with a live lease (`leasedUntil > now()`). Otherwise raise the threshold well above
     the longest publish and the worker stop grace (360 s).
  3. Update the stale comment at `:794`.

## Minor

### M1. The reel JOIN stale-claim window assumed a 300 s cap, so two joins can now run at once — new with the split

- **Where:** `server/reels/render.ts:39-41` (comment: "inside one job (300 s cap)"), `:85`, `:331-336`, `:348`.
- **Interleaving:** a join (downloads, seam checks, ffmpeg, upload) takes more than 6 minutes on a slow EC2 host.
  During the JOIN step, "wait" ticks keep running every 20 s (`:190`), and the app's GET enqueues ticks too
  (`app/api/v1/workspaces/[workspaceId]/brands/[brandId]/reels/[contentId]/route.ts:25`). With 4 loops, a tick at 6 min
  re-claims JOIN (`:336`) and starts a second join in parallel. Only one can write DONE (CAS at `:394`). The other throws
  "no longer joining", is retried and finds DONE. Result: double seam-check AI calls, double ffmpeg work and a wasted
  upload, but no corruption and no double charge. If the first join fails, `:348` also clears the second join's claim,
  so a third join can start.
- **Fix:** refresh `claimedAt` periodically while a join runs (a heartbeat, like `holdLease`). Or raise `JOIN_STALE_MS`
  above the worker stop grace plus the longest join, and fix the comment.

### M2. "One live sign-in code per email" doesn't hold for parallel requests — pre-existing

- **Where:** `server/services/mobile-auth.ts:41-54`. Schema: `VerificationToken` is unique on `token` and on
  `(identifier, token)`, not on `identifier` (`prisma/schema.prisma:100-107`).
- **Interleaving:** two `sendEmailCode` requests for one email arrive together. Under READ COMMITTED, each `deleteMany`
  sees neither code, and both `create`s commit. Two (up to 5, the per-email rate limit) codes are live at once, which
  multiplies a guesser's odds within the 8 tries per 15 minutes. The fix pass guarantees one live code only when
  requests are sequential.
- **Fix:** take `pg_advisory_xact_lock(hashtext('mobile-code:'||email))` at the start of the transaction, or make
  `identifier` unique for `mobile-code:*` rows and upsert.

### M3. A disconnect racing the publish claim can return a publishing item to APPROVED — pre-existing

- **Where:** `server/services/connections.ts:243` (plain read), `:257` (attempt CAS), `:259` (item update by the ids
  read at :243).
- **Interleaving:** the disconnect reads attempt A as SCHEDULED. The worker then claims A (SCHEDULED→PUBLISHING) and has
  already read the connection as ACTIVE. The disconnect's attempt `updateMany` skips A, but its item `updateMany` still
  moves A's item SCHEDULED→APPROVED. The worker posts and then `finish` writes PUBLISHED over whatever happened to the
  item in between. In that window a person can edit the item (APPROVED is editable), and that new version is
  overwritten. Or they can schedule it on another account, so it posts twice. The audit also counts A as cancelled.
- **Fix:** have the attempt `updateMany` return the ids it changed (`UPDATE … RETURNING`, or re-read with
  `status: "CANCELLED"` and `updatedAt` from this transaction). Update only those items, and audit that count.

### M4. A publish job that dies before the attempt is claimed leaves the post SCHEDULED for good — pre-existing

- **Where:** `server/services/publishing.ts:424` (the first statement), `:621-629`; `jobs/runner.ts:73-77, 87-93`.
- **Interleaving:** the job is claimed, then the process dies, or the CAS at `:424` throws on a database error, before
  the attempt reaches PUBLISHING. With `maxAttempts: 1`, the job dead-letters. `onPublishJobLost` only acts on
  PUBLISHING, so the attempt and the item stay SCHEDULED, with a run time in the past and no job left. Nothing
  surfaces it. A person has to notice and cancel.
- **Fix:** in `onPublishJobLost`, also move a SCHEDULED attempt to FAILED ("didn't start, nothing was posted") and its
  item SCHEDULED→APPROVED, in one transaction. Or have `releaseState` flag a SCHEDULED attempt whose `runAt` is more
  than a few minutes past and has no live job.

### M5. A lost lease can fail and refund a shoot, asset or render whose original runner then finishes — pre-existing

- **Where:** `jobs/runner.ts:73-77` → `onShootFailure` (`photoshoot/shoot.ts:149-152`), `onAssetFailure`
  (`reels/assets.ts:85-88`), `failRender` (`reels/render.ts:426`).
- **Interleaving:** the lease lapses because renewals failed for 5 minutes (the error is swallowed at
  `jobs/queue.ts:71`), and the job is reclaimed after its last attempt. The new holder marks the row FAILED and refunds.
  The original runner then finishes `finish()` / `store()` / `joinClips`. Its DONE write is CAS-guarded and writes
  nothing, so the shots or video are uploaded but never shown, and the person is refunded. The state stays consistent
  and nobody is charged twice. The person just loses output they were going to get.
- **Fix:** none needed now. If it shows up, have `holdLease` log its renewal failures so the cause can be seen.

### M6. Two token refreshes at once can mark a working account "Needs reconnect" — pre-existing, more likely with 4 loops (uncertain)

- **Where:** `server/services/connections.ts:30` (comment: "two refreshes at once both succeed … the platforms allow
  it"), `:46-62`.
- **Interleaving:** the daily sweep (`refreshExpiringTokens`) and a publish refresh the same Pinterest connection at
  once. If the provider rotates refresh tokens, the second call is refused with a 4xx and `markReconnect` sets ERROR
  even though the first call stored good credentials. The worker's parallel loops make this overlap more likely than
  the old sequential runner did. **Uncertain:** whether Pinterest's continuous refresh revokes the old refresh token
  hasn't been checked. Instagram and Threads refresh with the access token, and Google doesn't rotate.
- **Fix:** serialise refreshes per connection with `pg_advisory_xact_lock(hashtext('conn-refresh:'||id))`, then
  re-read the row and skip the refresh if another holder already pushed `tokenExpiresAt` forward.

### M7. Smaller items

- `server/stories/service.ts:483` (`failStoryStart`) writes BLOCKED with no status guard. It is only reached when
  `startAgentRun` throws, which happens before the run and job are created, so this is unreachable in practice. Adding
  `status: { in: ["BRIEF_READY", "BLOCKED"] }` costs nothing. Pre-existing.
- `reels/assets.ts:37-38`: the stale sweep in `createAsset` can fail and refund a row at the 1-hour mark while its job
  is storing the result. Harmless (CAS-guarded, the person keeps the refund). Pre-existing.
- `ContentStatus.REVIEWED` and `CANCELLED` (`prisma/schema.prisma:822, 825`) have no writer.
- Comments written for the in-request runner are now stale. They change no behaviour:
  - `photoshoot/shoot.ts:90` ("the POST's kickRunner picks it up"; in production the worker does, within
    `WORKER_INTERVAL_MS`).
  - `photoshoot/shoot.ts:202` ("under the 300 s job cap").
  - `reels/render.ts:39`.
  - `maxDuration = 300` on routes whose only reason was `after()`. Harmless.

## Things that relied on the old in-request runner or `maxDuration`

- The publish "lost after 10 min" rule (I1) and the reel JOIN 6-minute stale claim (M1) both assumed jobs end within
  300 s. Neither assumption holds now.
- Phone sign-in codes, password reset emails and publishes due now used to start in the request's `after()`. With
  `RUN_JOBS_IN_API=false` they wait up to `WORKER_INTERVAL_MS` (15 s) for a worker loop. This is a latency change, not
  a correctness one, and it is already on the handover's open list.
- Story clip renders (about 4 min) and OpenAI shoots (up to 200 s) are no longer at risk of being killed at 300 s. That
  is an improvement.

## What's sound

- **Render give-up when status reads fail** holds. `reels/render.ts:168-171` waits (re-ticks) on a failed status read
  and only gives up after `GIVE_UP_MS`, through `failRender`. That is a CAS on ACTIVE steps, with the refund in the same
  transaction, so a second give-up from a parallel tick is a no-op. Photoshoots (`shoot.ts:137`) and assets
  (`assets.ts:76`) do the same.
- **Render's DRAFT_REVIEW write guard** holds.
  - Story: `createStoryVersion` (stories/service.ts:192-211) runs under the per-post lock and re-checks status, byHand,
    `statusAtSave` and `baseVersion`. An approval or schedule that lands during a render refuses the version.
  - Reel: `joinClips` (reels/render.ts:390-401) runs under the lock. It checks the JOIN step (CAS) and skips the new
    version when the item is SCHEDULED or PUBLISHED.
- **The publishing finish is guarded by PUBLISHING** (`publishing.ts:430-433, 443-448`). The attempt CAS and the item
  write share one transaction. A slow worker can't overwrite a PENDING_VERIFY or a person's settle. I1 is about the
  step before the finish, not the finish.
- **Disconnect keeps PARTIAL story frames** (`connections.ts:246-254`): a Post the rest attempt that carries posted
  frames goes back to PARTIAL, and its item stays SCHEDULED.
- **Token refresh only when ACTIVE** (`connections.ts:46-51`): the refreshed credentials are written with a CAS on
  ACTIVE. A Disconnect during a refresh keeps its credentials gone, and the caller gets ReconnectNeeded.
- **Two workers on one job:** the claim uses `FOR UPDATE SKIP LOCKED` (`jobs/queue.ts:43-60`). Complete, fail, release
  and renew are all lease-guarded. A runner that lost its lease runs no `onFailure` (`runner.ts:86-89`).
- **Publish retries can't double-post:** the job has `maxAttempts: 1`, the attempt claim is a CAS, and a rerun after
  a kill or reclaim posts nothing and goes to PENDING_VERIFY. A story records each frame before and after its publish
  call. `storyJobLost` locks the row and decides from the recorded frames.
- **A person racing the worker:** edits, approvals and scheduling are all refused while the item is SCHEDULED.
  `executePublication` re-checks the seal and the product gate before posting. Creator and Quality write under the lock
  only when status and version are unchanged. Brief writes with a CAS on PLANNED and no versions.
- **Phone and website on the same item:** both go through the same handlers. Every mutation carries the version the
  person saw, or the attempt's expected status, under the per-post lock: a stale tap gets a 409 and nothing is
  overwritten. The exceptions are `settlePublication` (an attempt CAS only, enough while the item is SCHEDULED) and M3.
- **Charges:**
  - Reel renders are charged once per (version, attempt) refId, and the loser of a start race is refunded.
  - Higgsfield clips, shots and assets resend with the same Idempotency-Key.
  - OpenAI shoots get one attempt.
  - Story-write charges are refunded once per refId.
  - `refundCharge` writes at most one refund per charge.
- **Mobile sessions** are revoked by `sessionVersion`, which is checked on every request. A phone (`verifyPhoneCode`)
  is linked to the first account only. The emailed code is spent by a delete CAS, so two parallel submits can't both
  sign in.
- **Invites:** accept is a single-use CAS, and revoke is a CAS on the open invite.
- **Push devices:** the token is unique, and a native upsert moves it to the newest user.
- **Shell cookies:** `/me/context` checks JSON, Origin and membership before setting cookies. `loadShellContext`
  re-validates the cookie's workspace and brand against the user's current access on every `/me/shell` read, so a
  removed member's stale cookie falls back to a workspace and brand they can still see. `serverFetch` forwards the
  browser's cookies to the server.
