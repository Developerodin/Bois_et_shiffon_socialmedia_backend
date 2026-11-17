# Mobile → web parity: keeping the two clients in sync, and web code structure

Review date 2026-11-17, before any porting. Lens: how mobile and web talk to the server today, where their types
already differ, how to stop ~10 features drifting as they land on web, which mobile logic should move to the server
first, and where each feature goes in the web repo. Read-only review. Paths are relative to `apps/`.

## How each client talks to the server today

**Mobile.** One transport, `mobile/src/api/client.ts` `api<T>()` (:138). It sends a Bearer token from SecureStore, adds
`X-Workspace-Id`, and has a per-call `timeoutMs` (default 20 s) plus `form` for multipart uploads. With `onLine` it reads
an NDJSON stream through `expo/fetch` (:171, `readLines` :186). Errors become `ApiError(status, message, data)`, which
keeps the whole JSON body (:27-42) and exposes `code`. Network failures map to translated text (`common:net.*`). A GET
that fails retries once after a server probe (:166).
All calls (about 70 hand-written types) live in one file, `mobile/src/api/endpoints.ts` (770 lines). The file says
"Shapes mirror apps/server route responses" (:8). Nothing enforces that. State is module-level stores with
`useSyncExternalStore` plus focus refresh: `ui/plans/use-plan.ts`, `ui/posts/use-posts.ts`, `ui/stories/use-stories.ts`,
`ui/reels/use-reel.ts` (with in-flight stream state and dropped-stream recovery, :31-56). `ui/use-credits.ts` re-reads on
focus. Polling is spread across `ui/posts/use-working-poll.ts` (5 s, 3 min cap, then "slow") and
`ui/reels/render-watch.ts` (10 s). Refusal codes are mapped to i18n keys in `ui/stories/errors.ts`.

**Web.** Two `request()` helpers sit on `web/lib/net.ts` `send()`. The first is `web/components/settings/api.ts:71`,
which every other `api.ts` and the content panels import. The second is a private copy in
`web/components/context/api.ts:50`. Cookie auth (Auth.js), relative `/api/v1/...` URLs rewritten to the server
(`web/next.config.ts:19-20`). `ApiError(status, message, code)` keeps only `code`, not the body
(`settings/api.ts:5-14`). The timeout is a fixed 30 s with no per-call override (`lib/net.ts:27`, `:51`), and nothing
reads a stream. Polling goes through `useBrandData` (`web/components/workspace/content-panels.tsx:63-103`). It shares a
6 s poll per URL, pauses when the tab is hidden and has no cap or "slow" state. `LoadGate`/`LoadFailed` (:115-140) and
`ListSkeleton`/`useLoad` (`components/settings/shared.tsx:73`, `:176`) show loading and failure. Types are hand-written
per feature (`products/api.ts`, `context/api.ts`, `ContentItem` in `content-panels.tsx:30-52`, `Release` in
`release-panel.tsx:33-45`).

**Shared code.** `server/shared` and `web/shared` are byte-identical today (`diff -rq` is clean). They hold small
zod-free constants and types (`CAPTION_LIMITS`, `BY_HAND_STEPS`, `CatalogSync`, `PermissionKey`, admin/shell API
types). The server imports `@/shared` in 26 files and web in 28. Mobile has no copy. Neither client has `zod`, only the
server does (`server/package.json:67`). Mobile has no test runner, only `typecheck` and `lint` (`mobile/package.json:58-59`).

---

## Findings

### Critical

**C1. On web, a 402 can't tell "no plan" from "not enough credits", and its message is lost.** Paid routes answer 402
with a body that is not problem+json: `{ insufficientCredits, balance, needed }` or `{ planRequired, title }`
(`server/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/photoshoots/route.ts:36-37`). Mobile keeps the body
(`client.ts:31-32`) and branches on it (`ui/plans/use-plan.ts:247` `isPlanRequired`). Web's `ApiError` drops the body
(`settings/api.ts:5-14`, `:85-92`). For the credits shape there is no `detail` or `title` either, so people see
"Request failed (402)". Every feature in scope (photoshoot, reels, presenters, previews, clones, stories,
calendar) depends on this branch. **Fix first:** give `ApiError` an optional `data` field, as mobile already does. That
is an additive change, and its existing callers (`code`, `message`, `status`) keep working. Also put the two 402 shapes
in shared as a type (see Recommendation step 1).

**C2. Web's transport can't run the reel flows.** Reel create, chat and save stream NDJSON and take 30-120 s
(`endpoints.ts:265`, `:279`, `:290`, `:348`). Uploads take 60-90 s (`:304`, `:325`), and story upload verification
takes 120 s (`:690`). Web's `send()` stops at 30 s with no override (`lib/net.ts:27`, `:51`) and has no stream reader.
Porting needs two additive options on `send` and `request`: `timeoutMs`, plus an `onLine` stream mode. Mobile's
`readLines` (`client.ts:186-202`) is about 15 lines that work as-is with browser `fetch`. Without these, web would
either fork a third `request` helper or silently drop long calls. Mobile's dropped-stream recovery
(`ui/reels/use-reel.ts:31-56`: adopt the newly created reel instead of re-sending, wait for the reply) matters even more
on web, where a tab close drops the stream. It is client-side logic that should move to the server (see section 3, M1).

**C3. Voice recording and cloning won't accept browser audio.** The server only accepts an MP4/M4A container
(`server/server/reels/recordings.ts:23-26` `isM4a`, used by `recordings.ts` and `clones.ts`). Its ffmpeg step forces
`-f mp4` (`:70`). Chrome and Firefox `MediaRecorder` produce WebM/Opus, and only Safari produces MP4. Web would
fail "Record voiceover" (R11) and "Clone a voice" in most browsers. Before any web recorder exists, decide either to
accept WebM on the server (drop `-f mp4` and widen the sniff) or to transcode in the browser. The server change is
smaller and keeps one path.

**C4. There is no contract at all for the features being ported, so drift is the default.** Web has none of the
feature endpoints. A grep of `web/app`, `web/components` and `web/lib` finds no `reels`, `photoshoot`, `/credits`,
`subscription`, `automations`, `customers/inbox`, `stories/sources` or `first-ideas`. Each port will therefore write a
second hand-copy of a mobile type that already differs from the server. The server's response types are mostly
inferred and never exported. For example `releaseState` (`server/server/services/publishing.ts:827`) has no named
return type, and the reel detail has no exported type in `server/server/reels/service.ts`. Neither client can import
what the server actually returns. Already-diverged examples (these are copies of today's server shapes):

| Payload | Server | Web | Mobile |
|---|---|---|---|
| Release `requirements` | `{provider, needsImage, minImages, maxImages, needsVideo, needsBoard, frames?}` (`publishing.ts:65-68`) | same, `provider: string` (`release-panel.tsx:36`) | lacks `needsImage`, `needsVideo` and `frames`, and narrows `provider` to 4 literals (`endpoints.ts:593`) |
| Release `decisions` | returned (`publishing.ts:830`) | typed (`release-panel.tsx:28`, `:42`) | missing from `PostRelease` (`endpoints.ts:591-602`) |
| `ProductIssue` | product: `{productId, kind, message, refuses, overridable}` (`server/content/product-checks.ts:61`); offer: adds `campaignId, state` (`offer-checks.ts:277`) | no `state` (`release-panel.tsx:30`) | adds a `name?` the server never sends (`endpoints.ts:604`) |
| Content status | Prisma `ContentStatus` has 11 values incl. `BRIEF_READY`, `REVIEWED`, `CANCELLED` (`prisma/schema.prisma:814-826`) | `status: string` (`content-panels.tsx:34`) | `ContentStatus` lacks `BRIEF_READY`, `REVIEWED` (`endpoints.ts:227`); `PostStatus` lacks `CANCELLED` (`:480`), so `STATUS_KEY[CANCELLED]` is undefined (`ui/posts/format.ts:27-38`) |
| Content item `body` | full `ContentVersion.body` | no `photoKeys` (`content-panels.tsx:47`) | has `photoKeys?` (`endpoints.ts:478`) |
| Create brand input | `CreateBrandInput` (`server/services/create-brand.ts`, used at `brands/route.ts:49`) | only `{displayName, websiteUrl}`, both required (`web/components/context/api.ts:86-97`) | `{displayName?, websiteUrl?, goal?, about?, location?, placeId?, language?}` (`endpoints.ts:66`); fuller onboarding on web must widen web's copy |
| Product | — | has `externalId`, `updatedAt` (`products/api.ts:11`, `:27`) | lacks both, and keeps its own copy of `CatalogSync` (`endpoints.ts:503`) instead of shared's (`shared/products.ts`) |

**C5. Prices and limits are hard-copied into mobile with "keep in step" comments.** Photoshoot credits: mobile
`SHOOT_TIERS` (`endpoints.ts:443-452`, "keep in step") vs server `TIERS` (`server/server/photoshoot/tiers.ts:31`).
Story limits and text-fit heuristic: `mobile/src/ui/stories/limits.ts:1-10` ("Change them there first, then here") vs
`server/server/stories/body.ts:4` and `stories/render.ts`. Porting to web makes these three copies. The reels flow
already shows the better pattern: the server returns `previewCredits` and `presenterCredits` in `/reels/options`
(`endpoints.ts:221`), so neither client hard-codes them.

### Important

**I1. Polling also drives the jobs, so web screens must keep polling.** Mobile's render watch says "each look also nudges
the render along on the server (the reel detail route kicks due jobs)" (`ui/reels/render-watch.ts:8`). The server
calls `kickIfDue()` in 19 route files (for example `photoshoots/route.ts:17`). Web's `useBrandData` pauses while the
tab is hidden (`content-panels.tsx:93`), which is right for load. But a web-only user with a background tab will see
renders and shoots advance only when someone polls. Name this in the job-poller primitive. Better, make sure a server-side
drain exists that doesn't depend on client polling (check `server/server/jobs/runner.ts`).

**I2. Mobile re-implements a gate the server already applies.** The server returns product issues only while the item is
`AWAITING_APPROVAL | APPROVED | SCHEDULED` (`publishing.ts` releaseState, `gated`). Mobile filters by the same list again
(`mobile/src/app/posts/[id].tsx:108`, `posts/story/[id].tsx:100`). This is harmless today, but it is exactly the kind
of rule web would copy a third time. Drop the client copy.

**I3. Neither client has one place for request helpers.** Web has two `request()` implementations
(`settings/api.ts:71`, `context/api.ts:50`). The content panels import the settings one
(`content-panels.tsx:5`). Mobile has one transport but derives the brand inside every call (`reelBase()`,
`endpoints.ts:266`), while web passes `base` strings around (`useBrandData(base, path)`). Ported features should not
add a third style. Use one `web/lib/api.ts` (a move of `settings/api.ts`'s `request`, `ApiError` and `errorMessage`,
re-exported from the old path so the ~28 callers keep working) with feature modules on top.

**I4. Copy and error wording are separate by design, but the server's stable codes are not catalogued.** Mobile is
i18n'd (about 20 locales, `mobile/src/i18n/locales/*/{reels,posts,plans,...}.json`), and web is English literals with no
i18n library. Mobile maps codes like `story.credits` to keys (`ui/stories/errors.ts:19-23`), and web matches one code
by string (`release-panel.tsx:600` `"story.expiredConfirm"`). The set of codes the server can send exists only inside
server code. Sharing i18n bundles is not worth it now, because web has no i18n. Sharing the **list of codes** as a
string-union type is cheap, and it lets both clients exhaustively map them.

**I5. Time zone parity.** Mobile reads every post time in the phone's zone. It carries a stale comment claiming the
brand has no zone field (`mobile/src/ui/posts/format.ts:19-24`). But `BrandProfile.timeZone` exists
(`prisma/schema.prisma:231-232`), and web campaigns already use it (`web/components/products/campaigns.tsx:44-59`).
Before the calendar and scheduling flows are made "the same" on both, decide on brand time zone vs viewer zone. Otherwise
the two clients will show different days for the same post.

**I6. Onboarding state lives only on the device.** Goal, source, tones, place and created brand id are kept in
`mobile/src/ui/onboarding/state.ts:12-29` (SecureStore), and "where to land" is decided by `GOAL_HOME` (`:32-37`). If web
gets "fuller onboarding", either web keeps a second client-side copy (two step machines) or the server stores the
onboarding draft and next step. `createBrand` already takes `goal` (`endpoints.ts:66`), so most of it is server-known.

### Minor

- **M-a.** Mobile's `PostChannel` comment says the server has no story channel yet (`ui/posts/format.ts:5`). The comment
  is stale, since Prisma has `INSTAGRAM_STORY` (`schema.prisma:805`).
- **M-b.** Client `maxLength` values on mobile all match server zod today: inbox 1000 (`server/customers/inbox.ts:136`),
  review reply 4000 (`server/google/business.ts:150`), Google post 1500 (`:181`), presenter and clone names 40
  (`reels/presenters.ts:41`), colours max 5 (`assets/route.ts:78-79`), tagline/audience 120/240
  (`research/brand-summary.ts:35`), recording 15 s (`reels/recordings.ts:19`). They are literals though
  (`app/business/brand.tsx:17`, `app/reels/record.tsx:14`, `app/onboarding/review.tsx:192`), so web would re-type
  them a third time.
- **M-c.** Mobile `TONE_GROUPS` (`ui/onboarding/tones.ts:4-8`) re-lists the server's `TONES`
  (`research/brand-summary.ts:27-31`) in groups. The values match today.
- **M-d.** `BY_HAND_STEPS` is shared web/server, and the phone deliberately has its own translated steps
  (`shared/by-hand-steps.ts:1-5`). That is fine and documented.
- **M-e.** Story tab (`drafts/scheduled/posted`) is derived on the server (`server/stories/service.ts:320`, content
  `route.ts:54`). This is the pattern to copy for the other derived states.

---

## 2. Recommendation: how to keep the clients from drifting

### Options weighed

| Option | Fits "just split, copy shared code"? | Cost now | Catches drift? |
|---|---|---|---|
| Published npm package (private registry) | No. It adds a registry, versions and a publish step to a three-repo solo setup | High | Only at version bumps |
| Git dependency (`"@espanda/contract": "git+…#tag"`) | Partly, but Metro and Next both need the package pre-built or transpiled, and every change is a tag plus two bumps | Medium | Only at bumps |
| Generated client (OpenAPI from routes) | No. Routes have no response schemas, and responses are inferred from Prisma code. Retro-fitting ~60 routes is a project of its own | Very high | Yes |
| **Vendored copy + check script (server owns it)** | **Yes: it is the "copy into each" decision plus a guard** | **Low** | **Yes, at typecheck or commit time** |

### Recommended: server-owned `shared/contract/`, copied into both clients, with a hash check

1. **Source of truth: `server/shared/`.** Add `shared/contract/<feature>.ts` files with plain TS only: request and response
   types, enums as string unions, limits and prices as `as const` objects, and error-code unions. No zod and no Node
   imports, because neither client has zod (`mobile/package.json`, `web/package.json`).
2. **The server proves its zod and responses match the contract.** For each zod request schema, add a type-level
   equality (`type _ = Assert<Equals<z.infer<typeof ShootRequest>, ShootRequestContract>>`). Routes return
   `Response.json(x satisfies ShootView)`. Server `tsc` then fails the moment a route and the contract disagree. That is
   the contract test, and it needs no runtime harness.
3. **Copy: `server/scripts/sync-shared.mjs`.** It copies `server/shared/**` to `../web/shared/` and
   `../mobile/src/shared/`, and writes `shared/.hash` (sha256 of the tree). Run it in the server repo after changing
   shared.
4. **Check: a `shared:check` script in each client (about 20 lines).** It recomputes the hash of its own `shared/` and
   compares it with its `shared/.hash`. That fails if someone edited the copy by hand. When `../server/shared/.hash`
   exists (the normal side-by-side layout), it also compares against that, which fails on a stale copy. Hook it into
   `typecheck` (`"typecheck": "node scripts/check-shared.mjs && tsc --noEmit"`), so a stale or edited copy fails the
   same command people already run. CI without the sibling repo still gets the "edited by hand" check.
5. **Mobile adopts it by import, not rewrite.** `mobile/src/shared` imports as `@/shared` through the existing `@/*`
   alias (`mobile/tsconfig.json:5-8`). Replace hand types in `endpoints.ts` one feature at a time, as each feature is
   ported, not in one big change.

How it fails, and what it costs. Someone edits web's copy: `shared:check` fails, and the fix is to run sync from the
server. Someone forgets to sync: the clients' check fails when the sibling server is newer, or nothing fails if the
server isn't checked out next to them (accepted; documented). The ceiling: it relies on the three repos sitting side by
side. If they move to separate machines or CI-only, switch the same folder to a git-dependency package, since the
contents are already isolated and import-clean. That is the upgrade path, and it is cheap because nothing else changes.

**Smallest first step (about half a day):** create `server/shared/contract/errors.ts` and
`server/shared/contract/photoshoot.ts`, plus the sync and check scripts, then the web `ApiError.data` change (C1).
- `errors.ts`: `ApiProblem` moved from `server/server/api/http-error.ts:4-13`, the two 402 payloads as
  `PaywallRefusal = { insufficientCredits: true; balance: number; needed: number } | { planRequired: true; title: string }`,
  and `isPlanRequired`/`isInsufficientCredits` guards.
- `photoshoot.ts`: `ShootRequest`, `Shoot`, `SHOOT_TIERS` with credits. Server `tiers.ts` imports the credits from here,
  so mobile's "keep in step" copy at `endpoints.ts:443-452` disappears.

Photoshoot is the smallest feature in scope, so it proves the loop end to end before reels.

### Where derived state should live

Rule: **if two clients would compute it, the server returns it.** The server already does this for the story tab
(`storyTab`), product-issue gating, `approvalValid`, `requirements` and reel prices. Extend that pattern rather than
port client logic. Pure presentation stays per client: wording, colour tone and "slow after N minutes" UX timers.

### Shared copy and i18n

Don't share copy bundles now, because web has no i18n. Share the **error-code union** (`contract/errors.ts`) and keep
server `detail` text in plain English as the fallback, which both clients already show. When web adopts i18n later, it
can read mobile's `en/*.json` keys. Keep key names aligned with codes (`story.credits` → `stories.errors.credits`), as
mobile's `storyCodeText` already does (`ui/stories/errors.ts:19-23`).

---

## 3. Mobile client logic to move to the server before porting

| # | Logic (mobile) | Move to | Why |
|---|---|---|---|
| M1 | Dropped-stream recovery: adopt the newly created reel by `createdAt` and clock skew; wait for a chat reply by turn count (`ui/reels/use-reel.ts:31-56`, `:158-174`) | `POST /reels` accepts a client `requestId` (stories already do: `endpoints.ts:663-666`); the reel detail exposes `planning: {since}` while a turn is in flight | Both clients drop streams. The heuristic "two candidates = unsure" is fragile, and web would copy it |
| M2 | Photoshoot tier prices (`endpoints.ts:443-452`) | `GET /photoshoots/options` (like `/reels/options`), or at least the shared contract | Prices are charged on the server |
| M3 | Product-issue status gate (`app/posts/[id].tsx:108`, `story/[id].tsx:100`) | Delete it; the server already gates | Duplicate rule |
| M4 | "Is a planner running" derived from `/agents` (`endpoints.ts:541-546`) | `GET …/agents/planner/runs?active=1` or a field on the content list | Web has its own run-watch logic already (state-machines `web.md` §4); converge on one server answer |
| M5 | `isLockedIn(status)` and status → label key (`ui/posts/format.ts:27-51`) | Server returns `editable: boolean` on each content item (labels stay client-side, keyed by the shared status union) | Web needs the same lock rule |
| M6 | Plan state `planned = plan \|\| unlimited` (`ui/plans/use-plan.ts:243`) | `GET /subscription` returns `canSpend: boolean` | Small, but it is a gating rule both will use |
| M7 | Onboarding step and next screen (`ui/onboarding/state.ts`, `GOAL_HOME` `:32-37`) | Server stores the onboarding draft on the workspace and returns `nextStep` (see I6) | Needed if onboarding should resume across devices or clients |
| M8 | Story text-fit heuristic (`ui/stories/limits.ts:12-115`) | Keep the client warning, but source `STORY_LIMITS`/`TEXT_BOX` from `shared/contract/stories.ts` and move `estimateLines`/`textFits` into shared (pure functions, no deps) | Three copies otherwise. The server's render is still the truth (`story.textFit`) |
| M9 | Field limits as literals (M-b) | `shared/contract/limits.ts`, imported by the server's zod schemas and both clients | Same numbers, one place |

Leave on the client: the 5 s/3 min "slow" timer (`use-working-poll.ts`), render-finished banners, focus refresh and
connection probing. These are UX choices, and they differ by platform anyway.

---

## 4. Web structure: where each feature should live

The web pattern today: top-level routes under `app/(shell)/` for whole areas (`products`, `connections`, `settings`,
`performance`). The Overview is a configurable `PanelLayout` of panels (`components/workspace/workspace.tsx:286-414`,
`panel-layout.tsx`). Item detail opens inside the content panel with `ReleasePanel` and `DraftEditor`. The nav table is
`web/lib/nav.ts`. Rule of thumb for "desktop layout on web": **multi-step flows get a route** (deep-linkable, survives
refresh, Back works). Short tasks get a **dialog** (`components/ui/dialog.tsx`, `sheet.tsx`). Panels only show
summaries that link into the route.

| Feature | Web home | Reuse | New |
|---|---|---|---|
| Brand look & feel + photo library | `app/(shell)/brand/page.tsx`, tabs "Look & feel" and "Photo library" (copy the `settings-board.tsx:15-55` tab pattern); NAV `main` entry | `useLoad`, `ListSkeleton`, `ConfirmDialog` (`settings/shared.tsx`); colour edit in a dialog | **MediaPicker / uploader** (multipart to `/media`, `library=1`) |
| Photoshoot | `app/(shell)/photoshoot/page.tsx` (list) + `/photoshoot/new` (stepper: kind → source → options → tier) + `/photoshoot/[id]` | `LoadGate`, MediaPicker, paywall dialog | **JobPoller** (see below) |
| Reels studio | `app/(shell)/reels/page.tsx` (list, ideas) + `/reels/[id]`: three columns, chat left (patterns from `chat-pane.tsx`), storyboard/script centre, render + publish right (`ReleasePanel` for approve/schedule) | `ReleasePanel`, `useBrandData` for the detail poll | **NDJSON stream** in `lib/net` (C2), **AudioRecorder** (C3), voice/presenter pickers as dialogs |
| Stories editing | Story detail exists in the content panel with `ReleasePanel` (story attempts, by-hand: `release-panel.tsx:25-26`, `:548`, `:600`). Editor at `app/(shell)/stories/[id]/edit` (frame strip + preview + fields need the width) | `ReleasePanel`, `BY_HAND_STEPS`, shared `STORY_LIMITS`/`textFits` (M8) | MediaPicker with `stories/sources` tabs; direct-to-storage upload slot (`endpoints.ts:684-691`) |
| Post from a brief | Dialog from the content panel ("New post": channel, goal, product photo, direction) → opens the item in the panel | `DraftEditor`, `ReleasePanel`, `CAPTION_LIMITS` | — |
| Customer inbox + Google reviews/posts | `app/(shell)/inbox/page.tsx` with tabs Messages / Reviews / Google posts. Repoint NAV `echo` (now `/settings?tab=connections`, `lib/nav.ts`) | `useLoad`, `LoadGate`, `Textarea`; AI draft is one call (`/customers/draft`) | — |
| Automations + credits | New settings tabs "Automations" and "Plan & credits" in `settings-board.tsx` (tabs at :15-19, permission-gated) | settings tab scaffolding, `StatusPill` | **useCredits/usePlan store** shown in the shell header |
| Plans | "Plan & credits" tab + a **PaywallDialog** opened by any 402 (C1) | `Dialog` | — |
| Fuller onboarding | Extend `app/welcome` + `components/welcome/welcome-flow.tsx` (goal, source, Maps place, tones), not a parallel flow | `createBrand` in `context/api.ts` widened to the shared `CreateBrandInput` | Depends on I6/M7 |

### New shared web primitives (build once, before the features that need them)

1. **`lib/net` additions:** `timeoutMs` and an `onLine` NDJSON reader on `send`/`request`, and `ApiError.data`. All three
   are additive.
2. **`useJob(url, { done, intervalMs, capMs })` / `<JobProgress>`:** a capped poll with a "slow, retry" state (port of
   `use-working-poll.ts`), built on `useBrandData`'s shared cache so panels and routes see one fetch. It is used by
   photoshoot, reel render, story render, catalogue sync and the planner run. Note I1: hidden-tab pause means
   server-side jobs don't get kicked.
3. **`<MediaPicker>`:** upload (multipart, 4 MB JPG/PNG) + library + products (+ story sources), returning a storage
   key. It is used by brand library, photoshoot source, reel photos, story frames and Google posts.
4. **`<AudioRecorder>`:** `MediaRecorder`, 15 s cap, preview, upload. It is blocked on C3.
5. **`usePlan`/`useCredits` + `<PaywallDialog>`:** one store for the shell header and every paid action. It reads the
   shared `PaywallRefusal` type.

### Suggested order

1. Contract scaffolding plus `ApiError.data`, `timeoutMs` and stream support (C1, C2, step 1 above).
2. Plans, credits and automations (small; they give every later feature its paywall).
3. Brand look & feel + library, with MediaPicker.
4. Photoshoot, with JobPoller.
5. Post from brief, then the stories editor.
6. Inbox and Google.
7. Reels (largest; needs C3 settled).
8. Fuller onboarding (after I6/M7 is decided).
