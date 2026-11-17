# Mobile → web parity review: process parity and correctness

Date: 2026-11-17. Lens: does the web reproduce the **same process** as mobile (same steps, choices and server calls), and what breaks if it does?
Read-only review of `apps/mobile`, `apps/server`, `apps/web` (branch `desktop-shell`). No code changed.

Path keys: **M** = `apps/mobile/src`, **S** = `apps/server`, **R** = `S/app/api/v1/workspaces/[workspaceId]/brands/[brandId]`, **W** = `apps/web`.
All brand-scoped calls go to `/api/v1/workspaces/:ws/brands/:brand/...` with `X-Workspace-Id` (must match the path when present, `S/server/api/workspace-headers.ts`, `S/server/api/brand-route.ts:29`).

## 0. Cross-cutting facts every feature depends on

| Topic | Mobile | Web today | Consequence |
|---|---|---|---|
| Auth | Bearer token from `/mobile/*` (M/api/client.ts:153); 401 clears token and signs out (176-179) | Auth.js cookie, `/api/*` rewritten to the server in dev (W/next.config.ts:19-21); server components use `serverFetch` (W/lib/server-fetch.ts) | Server accepts Bearer first, else cookie (S/server/auth/request-user.ts:25-31), so **all data routes work from web as-is**. Only the `/mobile/*` sign-in routes don't (token, no cookie). |
| Timeouts | 20 s default (client.ts:125), 120 s for AI (endpoints.ts:265), 60 s uploads, 90 s clone | 30 s (W/lib/net.ts) | Any web call to a reel plan / chat must raise the timeout or it aborts mid-AI. |
| Retries | GETs wait up to 60 s for the server and retry once; writes never repeat (client.ts:130-168) | Same rule in `send` (W/lib/net.ts) | Same contract; good. Writes that are not idempotent (photoshoot, brief post, inbox send, Google post) rely on this. |
| Streaming | NDJSON via `Accept: application/x-ndjson`, lines `{type:stage|draft|done|error}` (client.ts:171, 186-202) | Chat pane streams its own format; nothing reads NDJSON plan events | Web reels chat must implement the same reader. Error line carries only `status, detail`, no `code` (client.ts:197). |
| Current business | Saved per device in SecureStore/localStorage (endpoints.ts:154-203) | From the URL/shell (W/components/workspace/workspace.tsx:122,179) | Fine; but never assume the phone's "current brand" equals the web's. |
| Permissions | `GET /workspaces/:ws/my-permissions?brandId=` (endpoints.ts:584-588); most screens don't check it before showing actions | Already loaded in content panels (W/components/workspace/content-panels.tsx:105-109), `W/shared/permissions.ts` | Web should hide/disable by permission; mobile mostly shows the raw 403 afterwards (findings I-9). |
| 402 shapes | `planRequired:true` → plans; `insufficientCredits` → low-credits sheet (M/ui/photoshoot/start.ts:9-19, use-plan.ts:60) | Not handled anywhere | Web needs one shared 402 handler before features 2, 3, 4. |
| i18n | 24 locales × 9 namespaces; English source ≈ 2,000 strings (business 226, marketing 130, onboarding 294, photoshoot 167, plans 104, posts 468, recovery 58, reels 508, common 41) | **No i18n library at all**; hard-coded English (e.g. W/lib/net.ts NET_MESSAGE, release-panel.tsx:320-328) | Decide before step 1 whether web is English-only. Server errors are English for both clients. Reels/onboarding also **send** UI-language text to the AI (see feature 3). |

---

## 1. Brand look & feel + photo library (mobile M07/M08)

| # | Step | Mobile screen | Endpoint + body | States | Web today |
|---|---|---|---|---|---|
| 1 | Load brand view (shared cache) | M/ui/use-current-brand.ts:11-68 | `GET R/assets` (brand.read, assets/route.ts:56) → `BrandAssetsView` (endpoints.ts:75-97) | Loading placeholder (brand.tsx:75, photos.tsx:282); reload on focus when >50 min old because signed URLs last 1 h (use-current-brand.ts:12, assets/route.ts:22); failure retries on next mount (59-61); `assets:null` until Research has read the site | None |
| 2 | Edit palette | brand.tsx:68-90,136; M/ui/onboarding/color-sheet.tsx:165-301 | `PATCH R/assets {colors:[hex…]}` — always the **whole** palette, on every edit (color-sheet.tsx:292,295); needs context.edit (route.ts:99) | No assets → "noColors" and server 409 (route.ts:104-106); save error keeps sheet open (209-211); can't close while saving (169-172) | None |
| 3 | Tones | brand.tsx:30-36,106-135 | `PATCH R/assets {tones:[…]}` on Save (brand.tsx:47); enum list M/ui/onboarding/tones.ts:4-8 = server route.ts:83 | Save disabled until loaded / none picked / saving (64); unchanged → just back (43) | None |
| 4 | Logo | brand.tsx:92-104 | display only; no upload exists | hidden when null | None |
| 5 | Library list (Website tab = Research product photos, Uploads tab newest first) | photos.tsx:202-206 | same GET | empty text per tab (309-313); "refresh" reloads view, does **not** re-run Research (256) | None |
| 6 | Upload (≤10 per pick, sequential) | photos.tsx:221-235 | `POST R/media` multipart `file`, `library=1`, `title=<t("Photo")>` (endpoints.ts:431-441); needs publish.execute (media/route.ts:23) | 413 > 4 MB (media/route.ts:11,30); 400 non JPG/PNG (33); 409 at 60-photo cap / no profile (8,38-39); view reloads after a partial batch (232-234) | `POST R/media` already used without `library=1` (W/components/workspace/release-panel.tsx:331-347) — reuse, add flag + title |
| 7 | Remove upload | photos.tsx:236-240 | `PATCH R/assets {removeUpload:key}` (context.edit) | per-tile spinner (299); atomic (route.ts:110-117); file stays in storage; website photos not removable | None |

## 2. Photoshoot (F01–F07)

| # | Step | Mobile screen | Endpoint + body | States | Web today |
|---|---|---|---|---|---|
| 1 | Pick product / fashion | photoshoot/index.tsx:94-113 | — | — | None |
| 2 | Source photo (library, or upload new) | photoshoot/source.tsx:190-231 | library from `GET R/assets`; upload = `POST R/media library=1` (209-226) then reload + auto-select | placeholder (285), empty per tab (286), raw upload error (284) | None |
| 3a | Product setup | photoshoot/product.tsx:36-62 | `POST R/photoshoots {kind:"product", tier, sourceKey, ratio:"1:1"|"4:5"|"9:16", scene:"studio"|"interior"|"custom", brief}` (endpoints.ts:454-474); content.create (photoshoots/route.ts:31) | defaults 4:5 (or ratio passed from story), interior, base, first library photo (41,43-46); disabled without photo / while busy / custom scene with empty brief (50,79); price + balance shown (42,74-76) | None |
| 3b | Fashion setup | photoshoot/fashion.tsx:219-243 | `{kind:"fashion", tier, sourceKey, ratio:"4:5"|"9:16", model?:"natural"|"editorial"|"casual", pose, background}` | disabled until garment picked (254); defaults fullBody, 4:5, studioMinimal (224-228) | None |
| 4 | Generate → result of POST | M/ui/photoshoot/start.ts:9-19 | 202 `{shoot}` → F05 | 402 planRequired → `/plans`; 402 insufficientCredits → low-credits sheet; other inline. Server charges, then queues, refunds if queueing fails (S/server/photoshoot/shoot.ts:146-165) | None |
| 5 | Generating (F05) | photoshoot/generating.tsx:22-51 | `GET R/photoshoots/:id` every **5 s** while RUNNING (16,37); error → retry every 10 s forever (42) | DONE → F07; FAILED → stop, "credits are back" (87-90,132); progress steps are decorative (53-57) | None |
| 6 | Results list (F06) | photoshoot/results.tsx:18-46 | `GET R/photoshoots` (latest 50, shoot.ts:301-305) every **10 s** while any RUNNING | loading/empty; filter all/product/fashion counted client-side; failed shows "N credits refunded" (98-123) | None |
| 7 | Result detail (F07) | photoshoot/[id].tsx:27-191 | `GET R/photoshoots/:id` per focus | not DONE → F05 (46); Download/Share = share sheet (61-66); **Variation re-POSTs same request, charges again, no confirm** (108); "Use in story" returns to story editor (99) | None |

Server state machine (S/server/photoshoot/shoot.ts): `RUNNING → DONE | FAILED`; plan required (148); source key must belong to the brand (149); charge keyed to the new shoot id (150-152); OpenAI tiers one 200 s attempt (171,273); Higgsfield tiers 3 attempts × 4 shots, poll 15 s, give up after 1 h (90-91,214); fail + refund in one tx (225-232); client only sees `failed:true` (293). Finished shots are stored in brand media but **not added to the photo library** (234-244). Prices: base 4, moderate 6, higher 12, ultra 24 (S/server/photoshoot/tiers.ts:31-57).

## 3. Reels studio (R01–R13, X01)

| # | Step | Mobile screen | Endpoint + body | States | Web today |
|---|---|---|---|---|---|
| 0 | Plan gate | reels/index.tsx:22-26 | `GET /workspaces/:ws/subscription` (via usePlan) | no plan → `/plans/reels` — **client-only** (see C-5) | None |
| 1 | Home | reels/index.tsx:28-33 | `GET R/opportunities` filtered client-side `channels∋INSTAGRAM_REEL && decision≠REJECT` (31; repeated ideas.tsx:31, chat.tsx:47); `GET R/reels` first 2 (32) | reload on focus; status derived client-side (13): processing / ready / draft | None |
| 2a | From an idea | reels/ideas.tsx:38-48 | `POST R/reels {opportunityId, language}` (language = i18n.language, endpoints.ts:279) — **not streamed** | spinner; error; empty `ideas.empty` (67) | None |
| 2b | Chat create / revise | reels/chat.tsx:57-62 → M/ui/reels/use-reel.ts:147-184 | create `POST R/reels {prompt, opportunityId?, templateId?, language}`; revise `POST R/reels/:id/plan {version, message, templateId?, presenterId?, language}` (endpoints.ts:277-291); both NDJSON | stream stages reading/writing/directing + draft (S/server/reels/service.ts:31-46); 120 s timeout; error row "Try again" with last message (chat.tsx:222-235); message ≤2000 (route.ts:23); one in flight per device (use-reel.ts:148) | None |
| 2c | Dropped-stream recovery | use-reel.ts:30-56,158-175 | create: list `R/reels` before sending; on status 0 poll list every 3 s ≤3 min for a reel created after `sentAt−60 s`; revise: poll `GET R/reels/:id` every 3 s until `chat.length > turnsBefore` | then "taking too long" | None |
| 3 | Storyboard → Make video | reels/storyboard.tsx:22-52 | `POST R/reels/:id {action:"render", version}` → 202 `{render}`; 402 insufficientCredits / planRequired ([contentId]/route.ts:64-74) | planRequired → `/plans/gate`; 402 → low-credits(needed=price); client-only guards: already rendering → generating, already has video → review, stand-ins → assets (31-40) | None |
| 4 | Pick photos | reels/assets.tsx:37-60 | `POST R/media` ×≤6, then `PATCH R/reels/:id {version, plan}` with `scenes[i].photoKey = pick[i]` | pick order = scene order; extras ignored (55) | None |
| 5 | Presenter | reels/actor.tsx:28-100 | `GET R/reels/options` (every 10 s while one RUNNING, 19,51-55); `POST R/reels/presenters {name, traits}` 202/402; `DELETE …/presenters/:id`; continue = chat `{presenterId}` or PATCH plan `presenter:"none"` (97) | RUNNING/DONE/FAILED; one RUNNING per brand, 2 credits, refund on fail (S/server/reels/assets.ts:31-32,94-100) | None |
| 6 | Templates | reels/templates.tsx:38-82 | options GET (10 s while making); Use = chat `{templateId}` with **translated title as the message** (69); Preview = `POST R/reels/previews {templateId}` 202/402, 10 credits | making/failed/own; `canPreview=false` = no photo | None |
| 7 | Script + voice | reels/script.tsx:20-55; voices.tsx:120-150 | `PATCH R/reels/:id {version, plan}` → `droppedRecordings` sheet (47); `GET R/voices`; `GET R/voices/library?language&gender&age&useCase&search&page` | client: split on blank lines, ≤30 words/scene, scene count (24-27); server enforces 30 words (S/server/reels/plan.ts:47,74) | None |
| 8 | Record take | reels/record.tsx:24-101 | `POST R/reels/:id/recordings` multipart `file`(M4A), `text`, `language` → `{id, seconds, transcript, matches}`; then PATCH plan with `recordingId` ("Keep it" also replaces text with transcript, 96) | mic denied; 413/400 >15 s / >1 MB (S/server/reels/recordings.ts:18,91); 429 30/h/user, 60/reel | None |
| 9 | Clone voice | reels/clone.tsx:41-110 | `POST R/voices/clones` multipart `file, name, consent=1, appVersion` 201/402/409; `DELETE …/clones/:id[?withdraw=1]` | shown only if `cloning.allowed` (voices.manage); 60–90 s reading, ≤2 clones, 10 credits, 5 tries/h (S/server/reels/clones.ts:20-23,55-65) | None |
| 10 | Generating | reels/generating.tsx:22-43 | `GET R/reels/:id` every **3 s**; each GET re-queues a render stuck >60 s ([contentId]/route.ts:24-26) | VOICE → CLIPS → JOIN from `renders[0].step`; notes offline / no render after 30 s / long after 15 min (15-16,33); DONE → review; FAILED → X01 | None |
| 11 | Ready banner | M/ui/reels/render-watch.ts:195-246 | `GET R/reels/:id` every 10 s, only for renders started on this device | 10 s banner; suppressed when push is on | None (no push on web) |
| 12 | Video failed (X01) | recovery/video-failed.tsx:28-75 | reload on focus; Try again = step 3 | `failure.kind` unavailable/slow/scene/voiceDeleted/other + `stoppedAt` (S/server/reels/render.ts:461-473); refund shown = `renders[0].credits` | None |
| 13 | Review | reels/review.tsx:30-100,222 | GET every 5 s; `POST R/reels/:id {action:"recheck"}`; caption edit = `POST R/content/:id {action:"edit", version, body:{caption, hashtags, hook: scenes[0].onScreenText, script: scenes.map(voiceText)}}` (endpoints.ts:365-369); Download = `{action:"send", version, how:"download"}` (content.approve; approves AWAITING_APPROVAL, service.ts:187-195) | auto recheck at 90 s, "slow" at 150 s (22-24,71-80); Download in AWAITING_APPROVAL/APPROVED/SCHEDULED/PUBLISHED, Schedule in AWAITING_APPROVAL/APPROVED (18-20); blocker blocks both | Web draft editor can edit studio-reel hook/script freely (see I-6) |
| 14 | Publish | reels/publish.tsx:17-75 | `GET R/connections` → first ACTIVE INSTAGRAM; then `{action:"decide", version, verdict:"APPROVED", noAutoPublish:true}` (unless APPROVED) and `{action:"publish", version, connectionId, runAt?}` (endpoints.ts:375-384) | no account → locked; "expired" = IG exists none active; on error reload (72-73); slots next 1–7 days at 9/12/18/20 in **phone timezone** (17-29) | Release panel publishes, but **cannot publish a studio reel** (C-6) |
| 15 | Scheduled | reels/scheduled.tsx:20-80 | reel GET every 5 s + `GET R/content/:id`; `{action:"cancel", attemptId}`; `{action:"posted"|"not-posted", attemptId}` | publish.execute checked (110,116) | Cancel / posted / not-posted already in release-panel History (W/…/release-panel.tsx:566-600) |
| 16 | Results | reels/results.tsx:28-56,175-200 | `GET R/reels` every 5 s; retry render; `{action:"register-link", url}` (publish.execute) | filters all/ready/processing; "downloaded" = APPROVED without post link (118) | None |

Server: plan saves lock the row and compare versions → 409 "This plan changed in the meantime" (S/server/reels/service.ts:86-100, verified); blocked while a render is active or SCHEDULED/PUBLISHED (90-91). Render `VOICE → CLIPS (poll 20 s, one retry on backup model) → JOIN → DONE | FAILED`, 24 h cap; **DONE writes a new version** (latest+1, `createdBy:"agent"`, videoKey) and sets DRAFT_REVIEW (render.ts:402-414); FAILED + refund in one tx (427-443); startRender re-checks version after charging and refunds if it lost (125,143-159).

## 4. Stories editing + new post from a brief

### 4a. Stories

| # | Step | Mobile screen | Endpoint + body | States | Web today |
|---|---|---|---|---|---|
| 1 | List (Drafts / Scheduled / Posted) + due-by-hand card | posts/stories.tsx:36-118; M/ui/stories/use-stories.ts:332-373 | `GET R/content` filtered to INSTAGRAM_STORY; tab from server `storyTab` (S/server/stories/service.ts:320-324); `GET R/stories/due` (publish.execute; errors → empty, use-stories.ts:350) | skeleton; error + Retry (74-79); empty (80-86); poll **5 s** only while something renders/writes, skip if a read is in flight (323,361-370); badges card.tsx:17-26 | Stories only as calendar rows (content-panels.tsx:399,415); due list exists (workspace.tsx:945) |
| 2 | New story sheet | stories.tsx:122-222 | `GET R/products` filtered to `imageUrl` (139); `POST R/content {channel:"INSTAGRAM_STORY", requestId, goal, productId, direction?≤500}`; requestId one per sheet open, server `z.uuid()` (SR content/route.ts:97-103) | cost 5 credits hard-coded (26); 402 `story.credits` + "See plans" (161,216); 429 = daily limit (160); 502 `story.writeStart` treated as created (server parked it BLOCKED + refunded, service.ts:478-488); 409 `story.requestUsed`; hidden without content.create (68) | None |
| 3 | Duplicate / delete | M/ui/stories/card.tsx:39-62 | `{action:"duplicate"}` 201 `{id}`; `{action:"delete"}` 204 or 409 `story.notDeletable` | delete drafts only, confirm | None |
| 4 | Detail | posts/story/[id].tsx:30-269 | `GET R/content/:id` → release + `rendering, renderError(Code/Data), frames[{n,url,sourceUrl,sourceSize,kind,headline}]` (service.ts:337-373) | "working" = rendering ∨ BRIEF_READY ∨ DRAFT_REVIEW without check ∨ changes requested ∨ fix in flight (75-78); poll 5 s up to 3 min then slow + Try again (M/ui/posts/use-working-poll.ts); newest read wins (45-59) | `StoryFrames` read-only, polls 3 s without cap (content-panels.tsx:533-559) |
| 5 | Fix it / Try again | story/[id].tsx:124-135,195-207 | `{action:"rewrite", version}` (409 unless BRIEF_READY/DRAFT_REVIEW/BLOCKED and version matches, route.ts:275-277); no-version refunded story is **charged 5 again** (service.ts:496-518) | no price shown, no plans link on 402 | Web uses `POST R/agents/creator/runs {}` instead (content-panels.tsx:477) — wrong for stories (C-3) |
| 6 | Approve / anyway / request changes | M/ui/posts/decision-card.tsx:51-106 | `decide APPROVED`; `+note≤500, override:true` (rules.approve); `CHANGES_REQUESTED, note, switchProducts?` | waiting-for-approver line without content.approve | **Built** (release-panel.tsx:117,199-246) |
| 7 | Edit story | posts/edit-story.tsx:67-529 | `{action:"editStory", version:<base>, story:{frames:[{source?,label,headline,body,composition?,crop?,clip?}],cta,link,brandMark}}` → release + `saved:"saved"|"rendering"`; photo-only renders inline, clips → background job (service.ts:102-109) | editable statuses (43), needs content.create and not byHand (176-177); read-only while rendering/busy (180); fit warning (198-201); https link (44); "someone saved first" banner (347); 409 `story.stale/notEditable/byHandOn`; 429 `story.renderLimit` (30/user, 100/business per h, service.ts:87-88); 400 `story.textFit/source/clipWindow/invalid` | None; draft editor says "edited on the phone" (draft-editor.tsx:26-32); plain `edit` on a story → 400 `story.useEditStory` (S/server/services/publishing.ts:222) |
| 8 | Picker (Phone / Products / Library / Generate) | M/ui/stories/picker.tsx:20-229 | `GET R/stories/sources?productIds=a,b` (≤20) | rights yes/no first (154-164); type, 15 MB photo / 100 MB video, ≤180 s clip checked client-side (22-27,97-101) | None |
| 9 | Upload | M/ui/stories/upload.ts:203-275 | `POST R/stories/uploads {kind, contentType, bytes, rightsConfirmed:true}` → `{uploadId,url,headers}`; `PUT url` direct to storage (600 s, type + length signed, S/server/storage/media.ts:81-87); `POST R/stories/uploads/:id {}` (120 s) → VERIFIED / REJECTED{code} | retry with a new slot, give up after 3 failures while server answered (185,247-264); 20 slots/business/h (S/server/stories/uploads.ts:24,41-43) | None |
| 10 | Crop / trim | M/ui/stories/crop.tsx:14-62, trim.tsx:12-18 | inside editStory: `crop{x,y,scale}`, `clip{start,sound}` | crop locked for reel source (edit-story.tsx:318) | None |
| 11 | Generate in Photoshoot/Reels and return | M/ui/stories/generate.ts:125-170; edit-story.tsx:99-133,238-268 | saves first; `returnTo=story:<id>:<frame>:<base>`, back with `source=<kind>:<id>` | tied to `base`; in-memory only | None |
| 12 | Schedule / by hand | edit-story.tsx:297; story/[id].tsx:233-244 | decide(noAutoPublish) + publish; `{action:"byHand", at|null}`; `{action:"cancel", attemptId}` | 409 `story.cancelScheduledFirst/notApproved` | **Built** (release-panel.tsx:155,486-543) |
| 13 | Post by hand | M/ui/stories/by-hand.tsx:221-305, package.ts | `GET R/stories/:id/package`; `{action:"postedByHand", url?}` (≤300) | 409 notApproved/gate/framesNotReady; 400 linkInvalid/linkAccount | **Built**, zip variant (release-panel.tsx:502) |
| 14 | Partly posted | card.tsx:114-183 | `postRest {attemptId, confirm?}` (409 `story.expiredConfirm` → confirm on next tap); `markDone`; `settleFrame {attemptId, frame, appeared}` | | **Built** (release-panel.tsx:653-666) |

### 4b. New post from a brief

| # | Step | Mobile screen | Endpoint + body | States | Web today |
|---|---|---|---|---|---|
| 1 | Format, goal, photo, direction | posts/brief.tsx:260-404 | photos from the **library** (`GET R/assets`, use-current-brand.ts:75-78), not the catalog | no photos → "Add photos" to `/business/photos` (339-345); cost "included" | None |
| 2 | Draft it | brief.tsx:275-287 | `POST R/content {channel:"INSTAGRAM_POST"|"INSTAGRAM_CAROUSEL", goal:"newArrival"|"productFeature"|"specialOffer", product:{title≤200, photoKey}, direction?≤500}`; server checks photo ownership (publishing.ts:172-196), creates BRIEF_READY, starts writer (route.ts:133-136) | busy; raw `e.message` (284); 429 daily limit; then opens `/posts/:id` | None; landing page (post detail + release panel) exists |

## 5. Customer inbox + Google reviews + Google posts

All via `authorizeBrandRoute`; errors mapped by `toCustomersProblem` (S/server/customers/problem.ts:7-15): 409 = reconnect / outside window, 502 = platform didn't answer, 429 = rate limit. Everything is read live (no cache).

| # | Step | Mobile screen | Endpoint + body | States | Web today |
|---|---|---|---|---|---|
| 1 | Hub | marketing/index.tsx:19-71 | — | photo prompt dismissal in memory only (29) | None |
| 2 | Inbox | marketing/inbox.tsx:178-265; M/ui/marketing/inbox.ts | `GET R/customers/inbox` (brand.read) → `accounts[{connectionId,channel,name,canRead,error}]`, `conversations` | loading; error + Retry (186-191); "can read anything" derived client-side (181) → empty state to Connections (194-205); connected-but-empty (217-220); per-channel line derived (231-238); WhatsApp hard-coded "coming soon" | None |
| 3 | People | marketing/people.tsx:17-70 | same GET | derived from conversations | None |
| 4 | Thread | marketing/reply.tsx:323-328 | `GET R/customers/inbox/:connectionId/:conversationId` (last 20, S/server/customers/inbox.ts:118) | missing ids → back | None |
| 5 | AI draft | reply.tsx:342-346 | `POST R/customers/draft {kind:"message", text}`; text = last 10 messages as "Customer:/Us:" lines **built on the phone** (344); content.create | 429 60/brand, 40/person per h (S/server/customers/drafts.ts:42-45); 20 s default timeout | None |
| 6 | Send | reply.tsx:347-353,386 | `POST` same path `{text}` 1–1000 → 204; publish.execute | 409 outside 24 h window / dead token (inbox.ts:51-54); 429 60/h | None |
| 7 | Google connected? | marketing/google.tsx:30-41 | `GET R/google` → `{profile, posts}` | connected → workspace | None |
| 8 | Connect Google Business | google.tsx:42-53; M/ui/connect-social.ts | `POST R/connections/start {provider:"GOOGLE_BUSINESS", client:"mobile"}` → in-app browser → `POST /integrations/:slug/complete {state, code}` | empty = closed | **Built**: W/components/settings/connections-tab.tsx:31 |
| 9 | Google workspace | marketing/google-workspace.tsx:36-48 | `GET R/google` | not connected → back (40); unverified banner (109) disables New post (88); post state mapping LIVE/REJECTED/else processing (180); profile checklist derived (213-221) | None |
| 10 | New Google post | google-workspace.tsx:53,68-80 | draft `{kind:"googlePost", topic: photo.title}` (photo list = first 20 library photos, built client-side); `POST R/google/posts {summary 1–1500, photoKey?}` | Google 400 → 502 "verify first"; 30 writes/brand/h (S/server/google/business.ts:20-35) | None |
| 11 | Reviews | marketing/reviews.tsx:19-75 | `GET R/google/reviews` → `{connected, average, total, reviewUrl, reviews≤50}` | not connected empty; no reviewUrl tag (72); no paging | None |
| 12 | Reply to review | reviews.tsx:100-106,136 | draft `{kind:"review", text, rating, author}`; `PUT R/google/reviews/:id/reply {comment 1–4000}` (replaces) | existing reply → "Edit reply" (145) | None |

## 6. Automations + credits (M10, M11, X02)

| # | Step | Mobile screen | Endpoint + body | States | Web today |
|---|---|---|---|---|---|
| 1 | Load | business/automations.tsx:31-36 | `GET R/automations` → `{monthlyPlan, autoPublish}`; `GET R/connections` ("linked" = any ACTIVE) | placeholders (70); raw error; reload on focus | None |
| 2 | Toggle | automations.tsx:37-47 | `PATCH R/automations {monthlyPlan}|{autoPublish}`; autoPublish needs publish.execute, monthlyPlan agents.run (automations/route.ts:26-31) | spinner on switch (84); 403 raw; 409 no profile; atomic merge (S/server/services/automations.ts:28-33) | None |
| 3 | Replies switch / Ads card | automations.tsx:14-18,76,102-113 | — | permanently disabled placeholders; don't build backend | — |
| 4 | Billing | business/billing.tsx:20-30 | `GET /workspaces/:ws/credits?history=1` (last 20 lines, credits/route.ts:34) + `GET /workspaces/:ws/subscription` (use-plan.ts:36-48, 30 s cache) | plan card plan/unlimited/none/loading/failed+retry (61-74); empty "noUsage" | None (only competitor audit balance, competitors-panel.tsx:28-78) |
| 5 | Header balance | M/ui/use-credits.ts:6-17 | `GET …/credits` per focus | "–" while loading | None |
| 6 | Low-credits sheet | recovery/low-credits.tsx:18-67; M/ui/recovery/open.ts:7-8 | re-reads balance | balance vs needed bar; no purchase path | None |

Server: monthly plan runs on the 1st (UTC) only (automations.ts:40), 5 credits once per brand per month (58), **silently skipped** without plan or credits (52-53,63-64). Auto-publish after approval schedules on the first matching active account; skips stories, posts < 5 min ahead, Pinterest, and channels with no active account (74-92).

## 7. Fuller onboarding

Order: phone or email → password (sometimes) → code → welcome → goal → source → website / Maps / by hand → learning → review → brand preferences → first ideas → connect → goal's home.

| # | Step | Mobile screen | Endpoint + body | States | Web today |
|---|---|---|---|---|---|
| 0 | Route on launch | M/app/index.tsx:10; M/ui/account-actions.ts:48-55 | `GET /me`, `GET /workspaces/:ws/brands` | no token → sign-in; no brand → welcome; **any other error incl. offline → `/posts`** (53) | No brand → /welcome |
| 1 | Phone | onboarding/sign-in.tsx:20-41 | `POST /mobile/phone/code {phone}` (E.164 client-side) | 5/number, 20/IP per 15 min, 300/h (S/server/services/mobile-auth.ts:189-196) | Password + Google only |
| 2 | Email first | onboarding/email.tsx:33-45 | `POST /mobile/email-step {email}` → `next: password|code|register` | 503 = email not configured | — |
| 3 | Password / register | onboarding/password.tsx:33-50 | `/mobile/password {email,password}` (wrong = 400, mobile-auth.ts:104); `/mobile/register {email,password}` (password kept in memory, M/ui/onboarding/state.ts:66-69); or `/mobile/code` | | Password + forgot/reset exist |
| 4 | Code | onboarding/verify.tsx:31-79 | `/mobile/register/verify {email,code,password}`; `/mobile/session {email,code,phoneTicket?}`; `/mobile/phone/session {phone,code}` → token or `{needsEmail, phoneTicket}` (46-50) | 6 digits, resend after 42 s, 8 tries/15 min, 10 min validity (mobile-auth.ts:41-50,72-79); register path loses password on restart → back to email (38) | — |
| 5 | Welcome, goal | welcome.tsx:21; goal.tsx:14-35 | — (goal kept on device) | | No goal step |
| 6 | Source | source.tsx:14-38 | — **never sent to server** | marketplace/wholesale/none/other → by hand | — |
| 7a | Website | website.tsx:24-38 | `POST /site-check {url}` → `{ok}` (30/h, site-check/route.ts:50) | ok:false → import-failed (retry / change / by hand) | No pre-check; W/shared/website.ts normalises |
| 7b | Maps | maps.tsx:29-48 | `POST /places/search {query 2–200, language}` (30/h, places/search/route.ts:8-23); button-triggered, no debounce (77); single result auto-picked | 503 lookup failed | None |
| 7c | By hand | manual.tsx:24-29 | — name >1, "what you sell" >3; limits 80/500/120 | | None |
| 8 | Learning | onboarding/learning.tsx; M/ui/onboarding/use-research.ts:26-129 | picks **owner's** workspace (75); `POST /workspaces/:ws/brands` with `{websiteUrl, goal}` / `{placeId, language, goal}` / `{displayName, about, location, goal}`; polls context-docs + agent-events every **2.5 s** | done = BrandReview event **or** run SUCCEEDED (48-53); stops at **3 min** → keep waiting / continue; retry = `POST R/agents/research/runs {}` (114-125); 10 brands/person/day (S/server/services/create-brand.ts:57); duplicate guard is on-device (70-73) | W/components/welcome/welcome-flow.tsx: name + website only, active workspace (W/app/welcome/page.tsx:19), polls 2 s up to 20 min, done = SUCCEEDED |
| 9 | Review | onboarding/review.tsx:29-58; M/ui/onboarding/use-brand-assets.ts | `GET R/assets`; name `PATCH R {displayName}`; tagline/audience `PATCH R/assets`; optimistic with rollback (89-108); "use the website we found?" = `PATCH R {websiteUrl}` + restart Research → back to learning | per-field save error | None |
| 10 | Preferences | onboarding/brand.tsx:27-60 | `PATCH R/assets {tones, contentLanguage:"fr"|"en"}`; colours same route | Next disabled without tones; failed save → error, second press continues | None |
| 11 | First ideas | onboarding/preparing.tsx:27-100 | `POST R/first-ideas {}` (returns existing unless failed; `waiting:true` while Research runs; 3 restarts/day, first-ideas/route.ts:43-64); poll GET every 2.5 s | stop at 5 min → Try again / Continue without | None |
| 12 | Connect, finish | onboarding/connect.tsx:20-46 | `POST R/connections/start {provider:"INSTAGRAM"|"META", client:"mobile"}` + complete | saves brand on device, clears onboarding state, goes to goal home (state.ts:32-37) | Web Connections (reuse) |

## 8. Plans (placeholder)

| # | Step | Mobile screen | Endpoint | States | Web today |
|---|---|---|---|---|---|
| 1 | Read plan | M/ui/plans/use-plan.ts:36-57 | `GET /workspaces/:ws/subscription` → `{plan|null, unlimited, plans}` | ≤ every 30 s | Never read |
| 2 | Gates | reels/index.tsx:22-26; posts/index.tsx:27 | — | no plan → `/plans/reels`, `/plans/posts` | No gates |
| 3 | 402 plan refusal | use-plan.ts:60 | server returns plain JSON `{planRequired:true, title}`, not problem+json | | No handling |
| 4 | Choose plan | plans/index.tsx:17-41 | — | features from M/ui/plans/sample.ts:27-34, credits from server; pricing off (13) → Continue disabled | None |
| 5 | Marketing tools lock | plans/marketing.tsx:22-73 | — | Inbox/Google locked unless Professional or unlimited (sample.ts:44-46) | None |
| 6 | "Plan active" | plans/activated.tsx; use-plan.ts:66-76 | — | once per phone (SecureStore; skipped on web) | None |
| 7 | Billing | plans/billing.tsx | redirect to business/billing | | |

Plans can only be switched on via `S/scripts/set-plan.ts`.

---

## Logic only on mobile (must move to server or be duplicated)

Ordered by how badly a divergent web copy would hurt.

| Logic | Where (mobile) | Server today | Recommendation |
|---|---|---|---|
| Don't re-render a version that already has a video (avoids double charge) | reels/storyboard.tsx:33-39 | `startRender` accepts it (S/server/reels/render.ts:118-133) | **Move to server** (refuse or require `confirm`) |
| Reels plan gate | reels/index.tsx:22-26 | `createReel`/`chatPlan` have no plan check, no credits, no rate limit (S/server/reels/service.ts:112-172) | **Move to server** |
| Marketing (inbox/Google) Professional-only lock | M/ui/plans/sample.ts:44-46 | routes check permission only | Server, or drop the lock |
| Onboarding progress (goal, source, place, tones, brand made, run followed) and the "don't create a second brand" guard | M/ui/onboarding/state.ts:12-29; use-research.ts:70-73 | none | Server-side onboarding record both clients resume from |
| Research "done" rule + timeout | use-research.ts:48-53 (BrandReview ∨ SUCCEEDED, 3 min) | — | One shared rule (web uses SUCCEEDED, 20 min) |
| Photoshoot tier prices | endpoints.ts:447-452 ("keep in step") | S/server/photoshoot/tiers.ts:31-57 | Expose prices from the server (`GET R/photoshoots` or a tiers route) |
| Story cost 5, Fix-it re-charge never shown | posts/stories.tsx:26 | CREDIT_COSTS.storyWrite; rewrite re-charges (stories/service.ts:496-518) | Server returns price on the release state |
| Story text limits + fit check | M/ui/stories/limits.ts:1-96 (copy of server body.ts / render.ts) | authoritative | Share via `S/shared` (web would be a third copy) |
| Crop math, clip window (`floor((d−15)*10)/10`) | M/ui/stories/crop.tsx:20-50; trim.tsx:18 | render.ts; body.ts:8 (window ≥0.5 s before end) | Share module |
| Upload types / caps / retry policy | picker.tsx:22-27,97-101; upload.ts:185,247-264 | uploads.ts:16-22 | Share caps; retry policy per client but must respect 20 slots/business/h |
| Story "working" predicate + 5 s/3 min poll | story/[id].tsx:75-78; use-working-poll.ts | — | Pick one rule; web currently 3 s unbounded |
| Dropped-stream recovery for reel create / revise | M/ui/reels/use-reel.ts:30-56 | — | Better: idempotency key on `POST R/reels` and `…/plan` so a resend returns the same result |
| Reel caption edit must carry plan's hook + script | endpoints.ts:364-367 | `saveDraft` merges whatever is sent (publishing.ts:205-240) | Server should derive hook/script for studio reels |
| Approve-then-publish as two client calls | endpoints.ts:375-384 | — | Acceptable; both clients must reload on error (publish.tsx:72-73) |
| Schedule slots in device timezone | reels/publish.tsx:17-29 | posts use brand wall-clock (endpoints.ts:600) | Use brand timezone on web; fix mobile |
| Idea filter (`INSTAGRAM_REEL`, not REJECT) | index.tsx:31, ideas.tsx:31, chat.tsx:47 | — | Server query param |
| Derived reel / review / scheduled states | index.tsx:13; review.tsx:18-20; scheduled.tsx:42-55; results.tsx:117-118 | — | Duplicate carefully or return from server |
| Inbox derived states and AI-draft context text | inbox.tsx:181,231-238; people.tsx:20-21; reply.tsx:344 | — | Server builds draft context from the thread id |
| Google post-state names, profile checklist, unverified disables posting | google-workspace.tsx:53,88,180,213-221 | — | Duplicate (low risk) |
| Defaults: tones Modern/Luxurious/Elegant/Premium + French saved unless changed | state.ts:29 | — | Don't copy; ask (Minor-4) |
| Text sent to the AI in UI language (duration chips, template title as chat turn) | chat.tsx:164; templates.tsx:69 | — | Web must send same `language` + equivalent text, or server should accept structured `{seconds}` |
| Palette rules (≤5, hex, unique, ≥1) and "≥1 tone" | brand.tsx:17,64; color-sheet.tsx:11-15,122,216 | palette enforced (assets/route.ts:65-80); empty tones allowed (83) | Server should require ≥1 tone |
| "Plan active" seen-once flag | use-plan.ts:67-75 | — | Server flag if web needs it |
| Polling intervals | photoshoot 5 s/10 s; reels 3/5/10 s; stories 5 s; onboarding 2.5 s; brand view 50 min | no hints | Document one table; note inbox/Google reads are rate-limited 30/min per brand shared by both clients |

---

## Findings

### Critical

**C-1. Email-code and phone sign-in cannot work on web as built.** `/mobile/session`, `/mobile/password`, `/mobile/register/verify`, `/mobile/phone/session`, `/mobile/google` return a Bearer token and set no cookie (S/server/services/mobile-auth.ts:104,167,220; M/api/endpoints.ts:20-55). Web signs in via Auth.js cookies (S/auth.ts:104-130); the token salt is deliberately different so it can't be replayed as a cookie (S/server/auth/request-user.ts:5-10). Step 7 needs a server-side Auth.js credentials provider (or cookie-setting twins of these routes) before any UI. Also: code sign-in **creates an account + workspace for any new email** (mobile-auth.ts:173-176); web sign-in never creates accounts today. Decide that consciously.

**C-2. Same story, two editors, clip render: one person's edits are lost silently.** Both `editStory` calls pass the version check; each background render re-checks (S/server/stories/service.ts:260) and the loser fails, but only failures for a save based on the latest version are reported (service.ts:310-311). Mobile treats any new version as its own save (M/app/posts/edit-story.tsx:138), so it shows the other person's version with no "someone else saved" banner. Web + phone editing the same story makes this likely. Fix server-side (return a render id; report that render's own outcome) before building the web editor.

**C-3. Web's "Write it / Fix with the Creator" is wrong for stories (and over-broad for posts).** It calls `POST R/agents/creator/runs {}` (W/components/workspace/content-panels.tsx:431-437,477). Without an item id the creator skips unwritten paid stories (S/server/agents/definitions/creator.ts:74-77) and rewrites every BRIEF_READY/DRAFT_REVIEW post in the brand (creator.ts:57). Mobile sends `{action:"rewrite", version}` on the one item (M/app/posts/story/[id].tsx:124-129), which is version-checked and charges correctly. Web must use `rewrite`.

**C-4. Re-rendering a reel that already has a video charges full price; only the phone prevents it.** Guard is client-only (M/app/reels/storyboard.tsx:33-39). After DONE the latest version is a fresh agent version with no renders (S/server/reels/render.ts:402-414), and `startRender` doesn't refuse (118-133). A web "Make video" button without this guard double-charges. Move the guard to the server.

**C-5. Paid features are gated on the client only.** Reel plan writing (two AI calls per message) has no plan check, credit charge or rate limit server-side (S/server/reels/service.ts:112-172); only render/assets/clones call `requirePlan` (render.ts:112, assets.ts:35, clones.ts:54). Inbox/Google "Professional only" exists only in M/ui/plans/sample.ts:44-46; `/marketing` itself opens freely (M/app/marketing/index.tsx:19-24). Web built "same server calls" will give these to every workspace. Enforce on the server first.

**C-6. Web cannot publish a studio reel today.** Server marks every INSTAGRAM_REEL as needing a video link (S/server/services/publishing.ts:67), so the release panel demands an https "Video link" (W/components/workspace/release-panel.tsx:326,406-411), and if one is given the server refuses studio reels: "This reel posts its own video" (publishing.ts:390). Return a `studio` flag in `requirements` and drop the link field for studio reels, or route them through the reels publish flow.

**C-7. Browser uploads to storage likely blocked (CORS).** Story uploads PUT straight to a signed storage URL with type+length in the signature (S/server/storage/media.ts:81-87). No storage CORS config exists in the repo; the only CORS is a dev block on the API (S/next.config.ts:15). Phones don't need CORS; browsers do. Confirm the bucket allows PUT from the web origin before step 4.

**C-8. Browser audio won't be accepted for voiceover/clone.** Server accepts MP4/M4A only (S/server/reels/recordings.ts:22-25,67,83; clones.ts:55). Chrome/Firefox MediaRecorder produce webm/ogg → 400 "couldn't be read". Accept webm/opus server-side (transcode) before building record/clone on web.

### Important

**I-1. Photoshoot (and brief post, inbox send, Google post) are not idempotent; a timed-out request can charge or send twice.** Every `POST R/photoshoots` makes a new id and charge (S/server/photoshoot/shoot.ts:150-152); phone gives up after 20 s (M/api/client.ts:125). Brief posts take no requestId (R content/route.ts:89-94,133). Inbox send notes "a retry would send twice" (S/server/customers/inbox.ts:168); Google posts the same (S/server/google/business.ts:186). Stories already use a `requestId` (endpoints.ts:664-666) — extend that pattern; web uses `crypto.randomUUID()` per dialog open.

**I-2. Reels: chatting on the same version from two clients pays twice and loses one turn.** Version is checked only at save, after both AI calls (S/server/reels/service.ts:162-170, 89). Mobile also blocks only one message per device (use-reel.ts:148). Consider a per-reel "plan in progress" lock checked before the AI runs.

**I-3. A finished render bumps the reel version by itself** (render.ts:412). Any client holding the old version gets 409 on next save, caption edit, Download or approve (service.ts:190; publishing.ts:262). Web must reload the reel when a render reaches DONE (mobile does via polling).

**I-4. Palette/tones/review fields: last write wins.** `PATCH R/assets` has no version check; mobile sends the whole palette on every edit and the whole tones list on save (color-sheet.tsx:292,295; brand.tsx:47). Two people (or phone + web) editing overwrite each other silently. Same for Google review replies (PUT replaces, business.ts:154-161). Add an `updatedAt` precondition or accept and document.

**I-5. Onboarding can create two brands, in different workspaces.** Duplicate guard is per device (use-research.ts:70-73). Mobile picks the owner's workspace (use-research.ts:75); web uses the active one (W/app/welcome/page.tsx:19). Mobile sends `goal`/`placeId`/`about`; web sends name+website only. Only the 10/day limit stops duplicates (create-brand.ts:57).

**I-6. Web draft editor lets studio-reel text drift from the video.** It edits hook/script freely; `saveDraft` merges whatever is sent (publishing.ts:205-240). Mobile sends the plan's own hook and script with a caption edit (endpoints.ts:364-367). Web should open studio reels (`studio:true` on PostItem, endpoints.ts:483) in the reels review, or lock hook/script.

**I-7. Web has no 402 / plan handling.** Server sends `planRequired` as plain JSON, not problem+json (use-plan.ts:60). Web `send` treats it as an ordinary error. Build one handler (plans vs low-credits) before features 2–4.

**I-8. Credit history labels photoshoot / clone / presenter / preview / story charges as "added".** Unrecognised reasons map to "added" (S/app/api/v1/workspaces/[workspaceId]/credits/route.ts:10-16), shown as "Credits added … spent N" (M/app/business/billing.tsx:104-105). Fix server before web reuses it.

**I-9. Permission checks are missing on mobile action buttons; don't copy that.** Photoshoot Generate/Upload (content.create, publish.execute), palette/tones/remove (context.edit), reel Download/Schedule (content.approve, review.tsx:43-45), inbox Send/Draft, Google Post, brief create (brief.tsx has none; stories.tsx:68 does). Web already has the permission set (content-panels.tsx:105-109) — gate with it.

**I-10. Polling rules differ between clients and some are unbounded.** Stories: phone 5 s / 3 min cap, web 3 s no cap and re-signs every frame URL each tick (content-panels.tsx:537,557; release-panel.tsx:83). Photoshoot F05/F06 retry every 10 s forever including on 403/404 (generating.tsx:39-43; results.tsx:34-38). Inbox/Google reads are rate-limited 30/min per brand shared by phone and web — a polling web screen throttles the phone.

**I-11. Monthly plan toggle shows "on" when it will never run.** Server skips silently without plan or credits (S/server/services/automations.ts:52-53,63-64). Auto-publish "needs a connection" is derived from *any* active connection (automations.tsx:34,76) while the server needs a matching channel (automations.ts:84-87). Web should state the real condition.

**I-12. Photoshoot results never reach the photo library** (shoot.ts:234-244), and **Variation re-charges with no confirmation** (photoshoot/[id].tsx:108). Either add shots to the library or say so; add a confirm on web.

**I-13. Fix-it on a refunded, never-written story charges 5 credits silently** (stories/service.ts:496-518; story/[id].tsx:124-129,195-199); 402 there shows no plans link. Show the price.

**I-14. Three-frame minimum isn't enforced while editing** (frame-strip.tsx:96, server caps only max, body.ts:44; minimum appears later as a check blocker, checks.ts:17-20). Web should warn below 3.

**I-15. Streamed errors drop `code` and extra data** (S/server/reels/service.ts:39-40; M/api/client.ts:197), so `planRequired`/`insufficientCredits` from create/chat can't be told apart from other failures on either client.

**I-16. i18n.** Web has no i18n; ~2,000 mobile strings × 24 locales. Stories alone has 10 server error codes with no phone text (businessOnly, dailyLimit, gate, invalid, limitUnknown, ownFrames, refused, render, unconfirmed, useEditStory). Reels and onboarding send UI-language text to the AI (chat.tsx:164, templates.tsx:69; `language` on create/chat, endpoints.ts:279,290; Maps `language`). Web must at least send `language` or the scriptwriter replies in English.

### Minor

1. Reel recovery after a dropped stream never succeeds on reels with ≥40 chat turns — server keeps last 40 (S/server/reels/service.ts:95), recovery waits for the count to grow (use-reel.ts:35). Compare last turn's timestamp instead. Recovery also adopts a reel/turn made by the other client (use-reel.ts:35,48-52).
2. Ideas → reel isn't streamed and has no recovery (ideas.tsx:41); a timeout + retap makes a second reel.
3. "Plan required" routes to `/plans` in some screens (actor.tsx:71, templates.tsx:79, clone.tsx:107) and `/plans/gate` in others (storyboard.tsx:46, results.tsx:49, video-failed.tsx:70). Pick one on web.
4. Default tones Modern/Luxurious/Elegant/Premium + French are saved unless changed (M/ui/onboarding/state.ts:29); don't copy silent defaults.
5. Onboarding "source" is collected and discarded (source.tsx:14-38).
6. Offline new user is routed to `/posts`, skipping onboarding (M/ui/account-actions.ts:53).
7. "Resend code" restarts the 42 s timer even when sending failed (verify.tsx:62-66).
8. Low-credits close always falls back to reels storyboard (low-credits.tsx:23); billing "missing credits" opens reels results even for photoshoot refunds (billing.tsx:124).
9. AI drafts use the 20 s default timeout (endpoints.ts:740-743) vs 120 s for other AI calls.
10. Learning screen shows a hard-coded sample favicon (learning.tsx:78).
11. Story requestId via `Math.random` (stories.tsx:29-33) — use `crypto.randomUUID`.
12. Errors loading due stories silently become an empty list (use-stories.ts:350).
13. "Writing…" story card gives up after 10 min (use-stories.ts:303).
14. Lists capped without paging: reviews 50, inbox 20 conversations × 20 messages, credit history 20, photoshoots 50.
15. Hard-coded content: fashion model names Léa/Inès/Hugo (M/ui/photoshoot/options.ts:38-43), colour picker table (color-sheet.tsx:49-67), WhatsApp "coming soon", channel names.
16. Photoshoot POST validates the body before auth (photoshoots/route.ts:29-31).

---

## Reuse on web (don't rebuild)

- Release panel: approve / approve anyway / request changes, publish & schedule, by-hand on/off, I posted it, zip package, post rest, mark done, settle frame, cancel / posted / not-posted (W/components/workspace/release-panel.tsx:117-246,486-666).
- Media upload `POST R/media` (release-panel.tsx:331-347) — add `library=1` + `title`.
- Permissions loader (content-panels.tsx:105-109; W/shared/permissions.ts).
- Connections incl. GOOGLE_BUSINESS, INSTAGRAM, META (W/components/settings/connections-tab.tsx:31).
- Welcome flow: create brand + follow Research (W/components/welcome/welcome-flow.tsx) — extend, don't fork.
- Website normalising (W/shared/website.ts); network contract (W/lib/net.ts) already matches mobile's read-retry / no-write-retry rule.
- Draft editor's "keep the base version" pattern (W/components/workspace/draft-editor.tsx:92) — the story editor must do the same.

## Server work to do before (or with) the matching web step

| Before step | Server change |
|---|---|
| 1 | Optional: precondition on `PATCH R/assets`; require ≥1 tone |
| 2 | Photoshoot `requestId`; expose tier prices; fix credit-history labels; decide library vs results for shots |
| 3 | Refuse re-render of a version that has a video; plan gate (+ limit) on reel create/chat; `studio` flag in release requirements; accept webm/ogg audio; carry `code` in streamed errors; idempotency for create/chat |
| 4 | Report per-render outcome for `editStory`; storage CORS for the web origin; `requestId` on brief posts; return Fix-it price |
| 5 | Idempotency for inbox send and Google post; server-side plan lock for marketing (or drop it) |
| 6 | Expose "monthly plan will be skipped" reason |
| 7 | Cookie-issuing email-code / phone sign-in; decide account auto-creation; server-side onboarding record |
| 8 | Nothing until pricing is on; reuse `GET /subscription` |
