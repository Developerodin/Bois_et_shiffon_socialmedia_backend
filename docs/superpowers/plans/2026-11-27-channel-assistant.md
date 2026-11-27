# Channel-aware assistant (Channels brief, section 6)

## What exists
- Web `components/shell/assistant-panel.tsx`: starter cards per nav page (`BY_PAGE`, else `GENERAL`), shown only while the
  thread is empty; passes `page` (a `CHAT_PAGES` id) and `pageLabel` to `ChatPane`.
- Web `components/workspace/chat-pane.tsx`: the "Context: <pageLabel>" chip; sends `{ id, message, page }` (page read
  through a ref, so a page switch never remounts the session).
- Server `server/chat/prompt.ts`: `ChatBody.page` (unknown → dropped), `withPage` saves a whitelisted page in the user
  message's metadata, `withPageNotes` turns it into a note before the message every turn (system prompt untouched, so
  OpenAI's cached prefix holds).
- A channel calendar is `/calendar?cf_channel=<meta | instagram | ContentChannel>`; web `filterFromSearch` whitelists it.

## Changes (all additive)
Server
1. `shared/chat-pages.ts`: `CHAT_CHANNELS` (cf_channel value → name for the model) + `isChatChannel`. Synced to web.
2. `ChatBody.channel`: same shape as `page` (string ≤ 40, anything bad dropped, never refused).
3. `withPage(m, page, channel?)`: saves `channel` only when it is a `CHAT_CHANNELS` key and page is `calendar`.
4. `pageNote(page, channel?)`: with a channel, names "<channel> calendar" and its `ContentChannel` values (channelsOf) so
   the model can pass them to listPosts; without one the note is byte-identical to today's.
5. `listPosts`: a pin's planned board name (through cleanTitle) as `board`, only when set, so "Organize content by
   board" has data.

Web
1. `lib/assistant-suggestions.ts` (pure): `suggestionsFor(page, channel)` (moved GENERAL/BY_PAGE + one list per channel
   family: Meta, Instagram incl. its single formats, Facebook, Pinterest, LinkedIn, X, Threads), `chatChannel(page,
   search)` and `contextLabel(page, channel)`.
2. Assistant panel reads the search params (wrapped in Suspense in the shell layout, as the sidebar is), passes
   `channel` and the label "<Channel> calendar" to ChatPane.
3. ChatPane carries `channel` through a ref like `page`, and the request body via a pure `chatRequestBody`. Channel is
   never in a component key, so switching channel keeps the conversation.

## Decisions
- Starter cards still show only on an empty thread (the panel looks as today); with a conversation open, the chip and
  the request change, not the history.
- The asks are prompts the real assistant answers (listPosts, documents, products), not canned replies.

## Failure modes
- Unknown / tampered cf_channel: web drops it (filterFromSearch), server drops it (isChatChannel) → plain page note.
- No channel (any other page, or older web): request has no `channel`, note unchanged, cards unchanged.
- Older server with newer web: the extra key is stripped by zod; the chip changes, answers aren't channel-aware.
- Channel switched mid-reply: the ref is read when a message is sent, so the in-flight reply keeps the channel it was
  asked from and the next message carries the new one; nothing remounts.
- Saved history: each message keeps the channel it was sent from, so notes rebuild identically every turn.
- Ceiling: listPosts takes one channel per call, so for Meta (5 channels) the model makes several calls or lists all
  and filters; widen it to a channel list if that proves slow.
