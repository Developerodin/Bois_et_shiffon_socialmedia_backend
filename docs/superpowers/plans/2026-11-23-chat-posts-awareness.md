# Chat assistant: knows the posts, where things are, and offers the right agents (option A)

Date: 2026-11-23. Repo: server only (chat prompt + tools); web only for a tool label. Branch `chat-posts` in server and web.

## Why
An owner connected Pinterest and asked the assistant "what are the next Pinterest posts?", then "make the posts",
"publish", "where". It failed each time: no tool reads posts, `startAgent`'s description names only research/seo/geo so
it never offers the content agents, and the prompt has no map of the app. Option B (saving chat drafts as posts) is
parked by the owner.

## Facts from the code
- Posts are `ContentItem` (channel incl. `PINTEREST_PIN`, status PLANNED…PUBLISHED/CANCELLED, `scheduledFor`, title).
  The calendar API (`content/route.ts` GET) needs only `brand.read`, excludes CANCELLED.
- The New post dialog offers Instagram single photo / carousel only. Pinterest posts come only from the agents:
  Scout (ideas) → person shortlists on the Content calendar → Planner (dated posts; `chain: true` runs Brief → Creator
  → Quality). Approve, then Publish now / Schedule, happen on the post (release panel).
- `startAgent` already accepts every non-internal agent key; it only offers a Start button (input `{}`).

## Tasks

### Task 1 (server): `listPosts` chat tool
`server/chat/tools.ts`: `listPosts({ channel?: ContentChannel, status?: "upcoming" | "awaiting-approval" | "published", limit? 1..20 default 10 })`.
- Permission `brand.read` (same as the calendar API); denied() otherwise.
- Query scoped `{ workspaceId, brandId }`, never CANCELLED.
  - upcoming (default): status not in PUBLISHED/REVIEWED/REJECTED/CANCELLED, `scheduledFor >= now` or null; order
    scheduledFor asc nulls last.
  - awaiting-approval: status AWAITING_APPROVAL; order scheduledFor asc nulls last.
  - published: status PUBLISHED/REVIEWED, newest scheduledFor first.
- Returns `{ posts: [{ title, channel, status, scheduledFor ISO|null }], more: boolean }` (take limit+1). Titles only;
  no captions, ids or links (keeps tokens low; content is data, the prompt already says ignore instructions in data).
- Unit tests in tests/chat-product-tools.test.ts style: scoping, permission denied, each status filter's where/order,
  channel filter, `more`.

### Task 2 (server): `startAgent` description
Name the content chain: "scout = find post ideas; planner = turn shortlisted ideas into dated posts (then brief,
creator and quality draft them)". Behaviour unchanged.

### Task 3 (server): prompt — what the app can do and where
Add a short static "Where things are in the app" block to `chatSystemPrompt` (static so the OpenAI prompt cache holds),
bump `CHAT_PROMPT_VERSION` to 5:
- Posts and their dates: Content calendar (sidebar Wave, or More › Content calendar). Open a post to edit, approve, then
  Publish now or Schedule. People with publish rights do that; you can't.
- New post (top bar +, or on the calendar): Instagram single photo or carousel only. Pinterest, Facebook and other
  channels come from the agents: Scout finds ideas, shortlist them on the Content calendar, Planner makes dated posts.
- Connections: connect Instagram, Facebook, Pinterest, Threads.
- Use listPosts before saying what is planned or scheduled.
Update the "You cannot publish…" line to point at that block.

### Task 4 (web): tool label
`chat-pane.tsx` TOOL_LABEL: `listPosts` → "Checked your posts" (or "Checked your Pinterest posts" when channel is
PINTEREST_PIN: generic `Checked your <channel label> posts` from the existing channel labels if one exists in web).

## Verification
server typecheck + unit tests; web typecheck, lint, unit tests. Manual: ask the assistant the four questions from the
owner's chat on a brand with Pinterest posts.

## Not doing
- Option B (save drafts as posts) — owner parked it.
- Pinterest-only planning (Planner chooses channels itself).

## Four-lens review (2026-11-23) — changes folded in (these override the tasks above where they differ)
Task 1 `listPosts`:
- Reuse `OPEN_STATUSES` / `STATUS_GROUPS` from `shared/content-status.ts`; no hand-written status lists.
- "upcoming" = every open post, overdue ones included (no `scheduledFor >= now` filter); each post gets `overdue: true`
  when its date has passed. Order scheduledFor asc nulls last, then id (stable `take: limit+1`).
- "published" = PUBLISHED/REVIEWED (both shown as Published), scheduledFor desc nulls last, then id.
- Result: `{ now, timeZone, posts: [{ title, channel, status, when, overdue? }], byStatus: {status: count}, more }`.
  `when` is pre-formatted in the brand time zone (`Brand.timeZone`, fallback the app's default), so the model quotes it.
  `byStatus` lets the model tell drafts from approved from scheduled.
- Titles: strip newlines/control chars, cap 100 chars. Not ids, captions or links.
- Input: `channel: z.nativeEnum(ContentChannel)`, `status` small stable enum; add the "may only widen" comment. Update
  the chatTools doc comment to list posts.
- Ceiling comment: `ponytail:` index (brandId, status, scheduledFor) if a brand reaches ~100k posts; today
  `[workspaceId, brandId, status]` serves it.
Task 2 `startAgent` description: scout = find post ideas; planner = turn SHORTLISTED ideas into dated post slots (it does
  nothing without shortlisted ideas; the Start button runs the Planner alone, Brief writer and Creator are separate runs).
  Web StartAgent stays as is.
Task 3 prompt (static, under ~150 words, no per-request text; CHAT_PROMPT_VERSION "5"):
- Settings › Connections (not "Connections"); stories and reels are made in Create › Studio / Reels when enabled; LinkedIn
  and X are posted by hand. Say "Content calendar" without guessing paths that aren't verified.
- Add "post titles" to the untrusted-data line. "If listPosts is empty, say so; never invent posts." When `more`, say
  there are more on the Content calendar.
- Rewrite the "You cannot publish…" line once: you cannot publish, approve or spend; people do that on the post.
Task 4 web: `CHANNEL_LABEL` from `@/lib/post-labels`; `Checked your ${label} posts` only when the label exists, else
  "Checked your posts".
Tests (add): CANCELLED never returned; overdue flagged and included; `more` false at limit, true at limit+1; scope from
  session ignores input ids; no id/caption/link keys; injection-like title is sanitised; role without brand.read denied;
  other brand's posts absent; empty brand → `{posts: [], more: false}`; CHAT_PROMPT_VERSION === "5"; chatTools still
  has no publish/approve/write tool.
Not doing (noted): switching web search off after listPosts (low risk: startAgent is only a button); web StartAgent
  `chain: true`.
