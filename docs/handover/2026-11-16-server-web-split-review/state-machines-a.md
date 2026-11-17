# State machines, domain A: queue, agent runs, catalog, email, voices, credits

Branch `server-web-split`, reviewed read-only on 2026-11-16. Paths are relative to `apps/server/`. "Pre-existing" means the
same code is on `desktop-shell` (`apps/web/...`), checked with `git show desktop-shell:apps/web/<path>` and a
CRLF-insensitive diff. In domain A, only `server/jobs/queue.ts` (`releaseJob`), `server/jobs/runner.ts` (abort signal,
`RUN_JOBS_IN_API`, unknown-type release) and `worker/main.ts` changed. `engine.ts`, `outbox.ts`, `clones.ts`,
`credits.ts`, `connections.ts`, `automations.ts`, `shoot.ts`, `assets.ts` and `stories/service.ts` are unchanged apart
from moving (`sync.ts` changed only its type imports).

Focused tests run: `tests/runner-unknown-type.test.ts`, `tests/worker-loop.test.ts`, `tests/agent-run-refund.test.ts`,
`tests/reel-clones.test.ts`: 4 files, 30 tests, all pass.

## Summary

The queue core is sound. The claim uses `FOR UPDATE SKIP LOCKED`, and complete, fail, release and lease renewal all
compare-and-set on `leasedBy` and `status = RUNNING`. Every `runDueJobs` call has its own UUID worker id, so the 4 worker
loops, several worker instances and an in-API runner can't hold one job at once. The failJob lease-loss fix holds: a
runner that lost the lease writes nothing and skips the failure hook (`runner.ts:89-92`). The `attempts > maxAttempts`
guard ends kill-and-retry loops. Ledger refunds can't double, because the unique `(workspaceId, reason, refId)` key
makes every refund at most once per charge.

The remaining risks are in what sits around the queue:

1. **Failure hooks run at most once, and nothing retries them.** They run after `failJob` commits, outside its
   transaction, and their errors are swallowed. A hook that throws, or a process that dies in between, leaves a dead
   job and an entity still marked as running, with no refund. For voice deletes, it also drops the 6-hour re-delete.
2. **AgentRun status writes have no guard.** A runner that lost its lease can't tell: there is no abort signal and no
   CAS, so it can overwrite FAILED with SUCCEEDED after the refund, or the reverse.
3. **An abandoned voice-clone reservation is only reclaimed by the next clone in the same workspace.** If nobody clones
   again, the reservation stays, its credits aren't refunded, and the ElevenLabs voice (the person's audio) may stay.

All three are pre-existing. The split makes no state machine in this domain worse in a way that matters. Several
things got better: on Vercel, `maxDuration` killed long runs at 300 s, and the worker's 360 s stop grace now lets most
of them finish.

Counts: **Critical 0, Important 3, Minor 9.**

## Machines

| Machine | States | Writers of status (file:line) | Guard on each transition |
|---|---|---|---|
| Job | PENDING → RUNNING → COMPLETED / PENDING (retry) / DEAD_LETTER. RUNNING with an expired lease → RUNNING (reclaim). | claim `jobs/queue.ts:42-60`; renew `:67-74`; complete `:77-82`; release `:92-97`; fail `:100-112`; prune COMPLETED `jobs/runner.ts:170`; scripts `scripts/smoke-*.ts` (test only) | Claim: SKIP LOCKED row lock, status/runAt/lease predicate. Renew, complete, fail and release: `leasedBy` + `status='RUNNING'` CAS. `failJob` reports a lost lease (`count !== 1` → null). |
| Daily sweep | one Job per UTC day, key `daily-sweep:YYYY-MM-DD` | `enqueueDailySweep` `runner.ts:176-183`, called by `worker/main.ts:36-44` and `app/api/v1/jobs/run/route.ts:21` | Unique `idempotencyKey`. Steps inside: plans keyed per period, monthly plan keyed per brand+month, catalog syncs keyed per day, scheduled agents count-checked (`runner.ts:146-154`). |
| AgentRun | QUEUED → RUNNING → SUCCEEDED / FAILED; RUNNING → QUEUED (retryable failure) | create `agents/engine.ts:95`; RUNNING `:173-176`; SUCCEEDED `:204-207`; QUEUED/FAILED `:234-239`; `scripts/smoke-agents.ts:23` | Create: advisory lock per brand+agent, dedup of in-flight runs. Every other write is an unconditional `update` by id. `:153` and `:232-233` read the status first, then write without a CAS. |
| Agent credits | charge → (refund) | spend `engine.ts:74`, `automations.ts:58`, `competitor-audits.ts:91`; refund `engine.ts:137,141,243`, `automations.ts:61,63`, `stories/writer.ts:162`, `stories/service.ts:279` | Ledger unique `(workspaceId, reason, refId)`, so one refund per chargeId. Spends serialised by a per-workspace advisory lock (`credits.ts:63-73`). |
| Catalog sync | Job PENDING/RUNNING (`catalogSyncRunning`) + `BrandProfile.catalogSync` note | `catalog/sync.ts:287-313` (`record`), `:339-344` request, `:347-362` daily | Daily key `catalog-sync:<brand>:<day>`. "Sync now" is check-then-create (comment at `:335-338`). No per-brand mutual exclusion while running. |
| Shopify connection (via the sweep and sync) | ACTIVE → ERROR | `services/connections.ts:19-24` `markReconnect`; refresh `:48-52` | Both CAS on `status: ACTIVE`. The sweep selects ACTIVE only (`:67-72`). |
| EmailOutbox | PENDING → SENT / FAILED / NOT_CONFIGURED; FAILED → SENT on a retry | `email/outbox.ts:22` create; `:61`, `:77-80`, `:83-86` | No CAS. One job per row (`email:<id>` key), so only one runner per row unless the lease is lost. |
| Voice (clone) | reserved (providerVoiceId null, archivedAt null) → live (providerVoiceId set) → archived → deleted at provider (providerVoiceId null); reserved → row deleted (release) | `reels/clones.ts:74` create; `:76` delete; `:99` live (CAS `archivedAt: null`); `:124` sampleKey; `:149` rename; `:156` archive (unconditional); `:186` provider cleared | Reservation under advisory lock `clones:<ws>`. Live CAS on `archivedAt: null`. Archive has no CAS (benign). |
| VOICE_DELETE job | Job machine + 6 h re-enqueue on exhaustion | `clones.ts:157` (key `voice:<id>:delete`), `:208` (key `...:delete:<runAt>`) | `runVoiceDelete` is idempotent: 404 counts as done, and it no-ops unless archived. |
| Photoshoot / ReelAsset / ReelRender credits (job-touched refunds) | RUNNING → DONE / FAILED (render: ACTIVE steps → FAILED) | `photoshoot/shoot.ts:158-165`, `:174`; `reels/assets.ts:94-102`, `:76`; `reels/render.ts:428-441` | All CAS on the RUNNING/ACTIVE status, with the refund in the same transaction. |

## Critical

None found.

## Important

### I1. Failure hooks run at most once and their errors are swallowed: a missed hook strands an AgentRun as RUNNING with no refund, and drops the voice-delete retry (pre-existing)

- `jobs/runner.ts:89-92`: `failJob` commits `DEAD_LETTER` first. Then `handler.onFailure?.(...).catch(() => {})` runs as
  a separate step, with no log and no retry. `:72` (the reclaim-after-last-attempt path) does the same.
- Nothing recomputes a hook later. No sweep looks for DEAD_LETTER jobs whose entity is still active. ReelAsset has a
  lazy give-up (`assets.ts:36-37`), and render and shoot have the step machine's own give-up. AgentRun and VOICE_DELETE
  have neither.

Interleaving (agent run, paid manual run):
1. Worker loop L1 runs the last attempt of `agent.run` for run R. The handler throws.
2. `failJob` commits Job → DEAD_LETTER.
3. `onAgentRunFailure` → `prisma.agentRun.update` (`engine.ts:234`) hits a transient DB error (pool timeout, failover),
   or the process is SIGKILLed between steps 2 and 3. The error is swallowed.
4. R stays RUNNING (or QUEUED) forever. Its 5 credits are never refunded (`engine.ts:243` never ran). The UI shows a
   run in progress. `startAgentRun`'s dedup (`engine.ts:87`) folds new identical requests into the dead run for 30
   minutes.

Interleaving (voice delete, privacy):
1. A delete job uses its 8th attempt during an ElevenLabs outage. `failJob` → DEAD_LETTER.
2. `onVoiceDeleteFailure` (`clones.ts:202-210`) throws on `enqueueJob` or `audit`, or the process dies before it runs.
3. No 6-hour re-delete is ever queued. A voice whose owner withdrew consent stays at ElevenLabs for good. The
   voice-delete retry fix holds only when the hook actually runs.

The split doesn't make this worse. It is more exposed with more processes, and with SIGKILL after the stop grace.

Fix: run the exhausted transition and the hook in one transaction where the hook is DB-only (pass `tx` to the hook),
or make the hooks reconcilable. A daily-sweep step can call the matching hook for DEAD_LETTER `agent.run` and
`voices.delete` jobs whose entity is still RUNNING/QUEUED or archived with `providerVoiceId` set. At minimum, replace
`.catch(() => {})` with a logged catch.

### I2. AgentRun transitions have no compare-and-set, and a runner that lost its lease can't tell (pre-existing)

- `engine.ts:173-176` (→ RUNNING) and `:204-207` (→ SUCCEEDED) are unconditional `update`s by id.
- `engine.ts:232-239` reads the status, then writes FAILED/QUEUED unconditionally (TOCTOU).
- `jobs/queue.ts:67-74`: lease renewal errors are swallowed (`.catch(() => {})`). Handlers get no `AbortSignal`, so a
  runner that lost its lease keeps running and writing.

Interleaving (free run after a refund):
1. Loop A runs paid run R. Three renewals in a row fail (a DB blip or pool exhaustion: `LEASE_MS / 3` = 100 s each, so
   5 minutes in all). The lease expires.
2. Loop B (another loop or another worker instance) reclaims the job. It's on its last attempt, the handler throws,
   `failJob` succeeds for B, and `onAgentRunFailure` reads R as RUNNING (`:232`).
3. A finishes and writes SUCCEEDED (`:204`).
4. B writes FAILED (`:234`). Its `delivered()` check (`:216-222`) runs before A writes its ContentVersion, so it
   refunds (`:243`). The run's output exists but shows FAILED, and the credits are back.

The reverse also happens: if B fails first (FAILED + refund) and A then finishes, `:204` turns FAILED into SUCCEEDED
with the refund already given.

How likely: low, because it needs lease loss. Render, shoot and asset avoid this by CAS-ing on their own status;
AgentRun is the one machine in this domain that doesn't.

Fix:
- `:204`: `updateMany({ where: { id, status: "RUNNING" } })`.
- `:234`: `updateMany({ where: { id, status: { in: ["QUEUED", "RUNNING"] } } })`, and refund only if `count === 1`.
- `:173`: CAS from QUEUED/RUNNING.
- Log renewal failures. Optionally have `holdLease` abort an `AbortController` passed to the handler when a renewal
  updates 0 rows.

### I3. An abandoned clone reservation is reclaimed only by the next clone in the same workspace (pre-existing)

- `reels/clones.ts:64-70`: the only code that archives and refunds reservations older than 5 minutes runs inside
  `createClone`, for that workspace. No sweep does it (checked with grep for `providerVoiceId: null` and
  `voice.clone.abandoned`).

Interleaving:
1. `createClone` reserves row V (`:74`) and charges 10 credits (`:79`).
2. ElevenLabs makes the voice (`:90-92`).
3. The API process dies before `:97-103`: OOM, a deploy that outlasts its 330 s grace, or a crash.
4. V stays with `providerVoiceId: null` and `archivedAt: null`. `liveClones` hides it (`:128-129`), so the person can't
   see or delete it, and no VOICE_DELETE job exists.
5. If nobody in that workspace clones again, the credits are never refunded and the person's voice stays at ElevenLabs
   indefinitely.
6. V also takes one of the two places until a later clone reclaims it.

The abandoned-reservation fix is correct when it runs (archive + refund under the lock, and the delete job finds the
voice by name via `voicesNamedFor`). It just doesn't run unless someone clones again.

Fix: add a daily-sweep step that runs the same abandoned query across all workspaces (`createdAt < now - 5 min`,
`providerVoiceId: null`, `archivedAt: null`) → `archiveClone` + `refundCharge`, each workspace under its `clones:<ws>`
advisory lock.

## Minor

### M1. Two catalog syncs for one brand now run at the same time more often (pre-existing, more likely after the split)

- `catalog/sync.ts:335-338` says two queued syncs "run one after the other". With 4 loops per worker, plus several
  workers, they run in parallel. Sources: "Sync now" pressed twice (check-then-create, `:339-344`), the daily sync
  (`:361`) and a connect-time sync. On Vercel, two `kickRunner`s could already overlap, so this isn't new, but it is
  now the normal case.
- Interleaving: sync S1 fetches the feed at t0. S2 fetches at t1, after the shop changed. S2 runs `saveRows` first.
  S1 then diffs against its own `stored` snapshot (`:240-242`) and writes t0 values over S2's fresher rows (`:260-262`).
  On a complete fetch, S1 also archives rows S2 had just un-archived (`:266-267`). `record` is last-writer-wins, so the
  screen may show the older count. Products look stale until the next sync. Nothing is lost.
- Fix: take `pg_advisory_xact_lock(hashtext('catalog-sync:'||brandId))` around `saveRows` + `record`, or have
  `runCatalogSync` return early when another CATALOG_SYNC job for the brand is RUNNING. Correct the comment either way.

### M2. Lease renewal fails silently (pre-existing)

- `jobs/queue.ts:71` uses `.catch(() => {})` with no log. This is what turns a DB blip into the silent double run in I2.
- Fix: log it, and count consecutive failures.

### M3. When a clone fails, `createClone` deletes the row even if it was archived meanwhile, and its ElevenLabs delete is best-effort (pre-existing)

- `clones.ts:76`, `:107-111`. If `:99` updates 0 rows (the owner was removed: `archiveMemberClones` archived V and
  queued its delete job), the catch block does three things:
  1. Deletes at ElevenLabs once, swallowing errors (`:109`).
  2. Hard-deletes the row (`:110`).
  3. Refunds the charge (`:111`).
- The queued `runVoiceDelete` then finds no row (`:177-178`) and returns. If step 1 failed, the voice stays at
  ElevenLabs with no record.
- A related race: `makeSample` (`:105`, `:120-125`) can write `sample.wav` and `sampleKey` after `runVoiceDelete`
  cleared them (`:185-186`). That leaves an orphaned synthesized sample in our storage.
- Fix: in the catch, when `providerVoiceId` was obtained, archive through `archiveClone` instead of `release()`, so
  the retrying delete job owns the cleanup. Make `makeSample`'s update a CAS on `archivedAt: null`, and delete the
  file when it updates 0 rows.

### M4. The daily sweep is one all-or-nothing job, and its key blocks a second try that day (pre-existing)

- `jobs/runner.ts:129-163` runs 8 steps in order. If an early step keeps throwing (for example a slow
  `pruneOldRows` delete, `:166-174`), the job dead-letters after 5 attempts in about 7.5 minutes (backoff
  30/60/120/240 s). Every later step is skipped for the day: plan renewals, monthly plans, catalog syncs, scheduled
  agents.
- The `daily-sweep:<day>` key stops a new sweep being queued until tomorrow. On the 1st, `runMonthlyPlans` then skips
  the whole month (`services/automations.ts:36-40`).
- Retrying is otherwise safe: every step is keyed or count-checked.
- Fix: wrap each step in its own try/catch and log it (as `renewDuePlans` already does per workspace), then rethrow at
  the end if any step failed. Or give each step its own job.

### M5. Email: a duplicate send is still possible on a kill, and failed rows keep their links (pre-existing, documented)

- `email/outbox.ts:65-66` already documents this: a send that succeeds followed by a failed SENT update, or a SIGKILL
  between `:68` and `:83`, sends the email twice on retry. Two concurrent senders need a lost lease, which is unlikely
  with 7 s SMTP timeouts against a 5-minute lease.
- The worker's 360 s stop grace makes the kill window smaller than it was on Vercel.
- Rows that end FAILED keep their unscrubbed link until the token expires, and are never pruned
  (`runner.ts:171` deletes only SENT and NOT_CONFIGURED).
- A sign-in code email retried after backoff can arrive after a newer code has replaced it.

### M6. `/api/v1/jobs/run` runs jobs in the API even when `RUN_JOBS_IN_API=false` (new: the flag is new)

- `app/api/v1/jobs/run/route.ts:19-28` calls `runDueJobs` directly. Only `kickRunner` and `kickIfDue` check the flag.
- `docs/DEPLOY_EC2.md:123` says `CRON_SECRET` is unset in production, so the route refuses every call. No current
  impact.
- Fix: return 404/409 when the flag is false, or drop the route.

### M7. A charge can be taken with no run to refund it (pre-existing)

- `engine.ts:74` charges with a random `chargeId`. The run that records it is created later, in the transaction at
  `:82-135`.
- If the process dies between the two, the 5 credits are gone with no run that could refund them. The same pattern
  exists at `competitor-audits.ts:91`, and `render.ts:155-156` documents it.
- This is an API request path, not a job.

### M8. Mixed-version safety is one-way (new)

- `releaseJob` (`queue.ts:92-97`) only protects a release that has it. On `desktop-shell`, `runner.ts` dead-letters
  unknown types (`retryable && Boolean(handler)`).
- The handler sets are the same today, so nothing is affected. If the old Vercel deployment's cron still drains the
  same database during cutover, any job type that only the split knows would be dead-lettered by it.

### M9. Concurrent `enqueueJob` upserts with the same key (uncertain)

- `queue.ts:35-39` uses `upsert` with `update: {}`. I couldn't confirm whether Prisma 6 runs this as a native
  `ON CONFLICT` statement. If it doesn't, two concurrent enqueues with the same key (several workers queuing the
  sweep, or poll chains queuing the same slot) can throw P2002.
- Every caller tolerates that: the worker resets `sweptDay` and retries (`worker/main.ts:40-43`), and a failed handler
  retries.

Also noted, not counted: nothing caps a job's run time. `holdLease` renews for as long as the handler runs, so a hung
handler would hold a loop and its lease indefinitely. Every outbound fetch in domain A has an `AbortSignal.timeout`
(AI 150 s, Shopify 30 s, ElevenLabs 15-30 s, SMTP 7 s), so I found no way for one to hang. `runner.ts:54-58` already
documents that an agent run longer than the 360 s grace is killed and re-run (AI spend twice, user credits once).

## What's sound

- **Claim, lease and attempts.**
  - SKIP LOCKED claim plus a UUID worker id per `runDueJobs` call (`runner.ts:61`): two loops, two workers, or a worker
    and the in-API runner can't hold one job.
  - complete, fail, release and renew are all CAS-guarded on `leasedBy` + RUNNING.
  - A job killed mid-run is reclaimed after the lease. On its last attempt, `attempts > maxAttempts` (`runner.ts:70-74`)
    dead-letters it and runs the exhausted hook once.
  - `releaseJob` gives back the attempt it counted.
- **failJob lease-loss fix holds.** `failJob` returns null when it wasn't the lease holder, and both hook call sites
  check for that (`runner.ts:72`, `:92`), so a stale runner can't mark failed or refund under another runner.
- **Shutdown.** An abort claims nothing new (`runner.ts:64`), the in-flight job finishes, `sleep` returns at once,
  `runWorker` resolves and the process exits 0. The 360 s grace covers everything in domain A except very long agent
  runs (documented).
- **Daily sweep.** Unique per UTC day, and `sweptDay` is taken before the await, so only one loop per process queues
  it. Several workers or a restart are harmless, and a retried sweep can't double-charge:
  - plan grants are keyed per period (`subscriptions.ts:81-86`);
  - the monthly plan charge is keyed per brand and month, and runs are count-checked (`automations.ts:54-61`);
  - catalog syncs are keyed per day;
  - scheduled agents are count-checked and free.
- **Credits ledger.** Spends are serialised per workspace with an advisory lock, and spends with a refId are
  idempotent. Refunds are idempotent per chargeId, enforced by the unique key, so no double refund is possible
  anywhere. Shoot, asset and render move to FAILED and refund in one transaction, CAS'd on status (`shoot.ts:158-165`,
  `assets.ts:94-102`, `render.ts:428-441`). Agent runs that already delivered are not refunded (`engine.ts:216-222`,
  `:243`), and the story-render refund covers the hand-off.
- **Agent runs.** One job per run (`agent-run:<id>`). Starts are deduplicated under an advisory lock, and a joined run
  refunds the joiner's charge (`engine.ts:141`).
- **Token refresh only when ACTIVE holds.** The refresh write and `markReconnect` both CAS on ACTIVE, and the sweep
  selects only ACTIVE connections (`connections.ts:19-24`, `:48-52`, `:67-72`). A catalog sync on a refused token is
  not retried (`runner.ts:87`).
- **Voice delete retry holds** whenever its hook runs (see I1). `runVoiceDelete` is idempotent (404 counts as done) and
  falls back to finding the voice by name when no provider id was saved.
- **Email.** One job per outbox row, and an already-SENT row is a no-op. `emailConfigured` reads the same env in the
  worker, because compose shares `server.env`.
