# Channel composer (channel work, batch 2)

> Written 2026-11-27 against server `main` 57f32cb and web `main` d8d14d5. Branch `channel-batch2` in both repos
> (worktrees C:\Users\INTEL\Desktop\sma-chan2\{server,web}). No mobile change. Follows HANDOVER "Next steps" item 5
> ("Later passes: channel-specific composer") and batch 1 (planned Pinterest board, Facebook Page on cards).

**Goal:** New post, opened from a channel's calendar, starts on that channel and offers only what the server can make
and publish (or, for LinkedIn and X, plan for posting by hand). From the plain calendar, the top bar and Home, it
offers every channel.

## Decisions

1. **Who writes the text.** Instagram post and carousel stay as today: a product photo, a goal and a direction, then
   the Creator drafts it. Facebook, Pinterest, Threads, LinkedIn and X are **written by the person** in New post (the
   fields the brief asks for: text, pin title / description / link, the X counter). No second "AI or by hand" mode is
   built; a written post that the check blocks can still be rewritten by the Creator as any edited draft can.
2. **One composer.** `web components/workspace/new-post-dialog.tsx` grows a channel choice and the written fields; no
   second dialog. Reel and story are choices that hand off instead of creating:
   - **Reel**: "Reels are planned in Reels" with a link to `/reels` when the `reels` flag is on, else it says Reels
     aren't on for this workspace.
   - **Story**: "Stories are made in the mobile app" (the web has no story maker; its editor already says so).
3. **Server: additive.** `POST content` keeps `NewPostInput` exactly as it is (Instagram post/carousel with `product`).
   A body whose channel is one of the written channels is parsed by a new `WrittenPostInput`:
   `{ channel, text, pinTitle?, pinLink?, photoKeys?, requestId?, scheduledFor? }`. Old clients are unaffected.
   A written post is created with its first version in one transaction (status `DRAFT_REVIEW`, version 1 by the
   person, `brief: { written: true, requestId? }`), then the Quality check starts, as after an edit. No `BRIEF_READY`
   item is ever left behind for the Creator to write over. Same daily cap (`postAiAllowed`), same idempotency
   (`requestId`), same `scheduledFor` rule as `createPost`. Linked products come from the photo (`productIdsForPhoto`).
4. **One set of limits.** `IMAGES` moves from `publishing.ts` to `shared/content-limits.ts` as `CHANNEL_IMAGES`
   (publishing imports it). `cleanPinLink` moves to `shared/` (publishing re-exports it). A pure
   `writtenPostProblem(channel, { text, pinTitle, pinLink, photos })` in `shared/` is used by `createWrittenPost`
   (a 400 with its message) and by the dialog, with `captionMaxFor(channel)` (the draft editor's `CAPTION_MAX`, lifted). Text limits:
   Facebook 2,200 (rules' default), Threads 500, LinkedIn 3,000, X 280 (`CHANNEL_TEXT_MAX`), pin description 500,
   pin title 100. Images: Pinterest exactly 1; Facebook, Threads, LinkedIn, X 0–1. So each offers **one** optional image
   (Pinterest: required), not a multi-picker.
5. **Draft normalisation reused.** `saveDraft`'s body clean-up (trim, hashtags, pin link, own photos) becomes
   `cleanDraft`, used by `saveDraft` and the written create.
6. **Idempotency across channels.** `itemForRequest`'s channel narrowing in the route and `createPost` reads one
   constant, `NEW_POST_CHANNELS` (Instagram post/carousel + the written channels), so a retried written post never
   makes a second one.
7. **Pinterest board.** Boards are listed only per post today (`GET content/[id]`, one Pinterest call per account,
   publishers only). The composer doesn't list boards; the post opens in the side peek right after it is made, where
   batch 1's Planned board picker (`planBoard`) is. No new endpoint.
8. **Creator photo cap.** The Creator caps Threads at 0 photos, but Threads publishes one image (publishers.ts). Its cap
   reads `CHANNEL_IMAGES` so a rewrite keeps the person's Threads image.
9. **Preset mapping (web).** A pure `composeChoices(filter)` in `lib/new-post.ts`: no filter → every choice; `meta` →
   Facebook + the Instagram formats; `instagram` → the Instagram formats; one channel → that one. It replaces
   `NEW_POST_CHANNELS` (web) and the channel header's "New post makes an Instagram post or carousel" line.
10. **LinkedIn and X** say "Published by hand" in the dialog: planned and approved here, posted by a person, then
    marked posted (`registerManualPost`, unchanged).
11. **Written posts' brief.** The post view's Brief says "None: written by hand in New post." instead of "The Brief
    writer hasn't written the brief yet" when `brief.written`.
12. **Publishing with the draft's pictures (found while building).** The web publish form started empty, so a written
    Facebook or Threads post's image would have been dropped when published from the web (min 0 images), and an upload
    on a draft that names its pictures is refused. The form now starts with the draft's pictures (removable), as the
    phone and auto-publish already do.

## Skipped

- Facebook with several images: the server publishes one (`IMAGES.FACEBOOK_POST = [0,1]`, `/photos` with one url).
- Choosing a Pinterest board inside New post (decision 7).
- Writing an Instagram post by hand in New post (the brief says "as today").

## Tasks

1. Shared: `CHANNEL_IMAGES`, `captionMaxFor`, `cleanPinLink`, `writtenPostProblem`, `NEW_POST_CHANNELS`; publishing
   and the Creator read them. Sync to web by hand (no mobile write).
2. Server: `cleanDraft`, `createWrittenPost`, `WrittenPostInput` in `POST content`; unit tests (old payload still
   parses, each channel's limits, idempotency, version + Quality start).
3. Web: `lib/new-post.ts` + tests; the dialog's channel choice, written fields, hand-offs; callers pass the channel
   filter and `reelsOn`; header line removed; brief line.

**Ceilings / notes:** written posts count toward the shared 60-a-day AI cap (the Quality run). The Creator's cap
change also lets an existing Threads draft keep one photo on a rewrite. Mobile's copy of `shared/` is not updated on
this branch (no mobile change): run `npm run sync:shared` after merging. Not browser-checked.

**Migrations:** none (`plannedBoard*` exist; nothing new is stored in a column).
