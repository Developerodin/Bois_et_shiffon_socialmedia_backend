import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { startAgentRun } from "@/server/agents/engine";
import { prisma } from "@/server/db/prisma";
import { kickRunner } from "@/server/jobs/runner";
import { createPost, LIVE_STATUSES, ownMediaKey, postAiAllowed, PublishingError } from "@/server/services/publishing";
import { signedMediaUrl } from "@/server/storage/media";
import { CONTENT_GOALS } from "@/shared";
import { contentRange, contentWindow } from "@/server/content/window";
import { personName } from "@/server/content/person-name";
import { hideRightsNames, hideRightsNote, isStoryBody, revealRightsNames, revealRightsNote } from "@/server/stories/body";
import { coverUrl, createStory, failStoryStart, itemForRequest, STORY_RENDER_JOB, STORY_START_NOTE, storyTab } from "@/server/stories/service";

/** Calendar items with their latest draft and its latest quality check. */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "brand.read");
    if (scope instanceof Response) return scope;
    // ?id= opens one post whatever its age (a link to an old post); ?from&to= the posts dated in [from, to) (the
    // calendar's month view, past months included); otherwise the calendar window.
    const q = new URL(request.url).searchParams;
    const id = q.get("id");
    const range = id ? null : contentRange(q.get("from"), q.get("to"));
    if (typeof range === "string") return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid request", status: 400, detail: range });
    // Spreading `open` after `base` replaces base.status safely (open never holds CANCELLED); ?id= of a cancelled post is a 404 on purpose.
    const base = { workspaceId: scope.workspaceId, brandId: scope.brandId, status: { not: "CANCELLED" as const } };
    const [open, recent] = contentWindow(new Date()).OR;
    // The owner joins the item read: a separate read after the rows would add a round trip for a brand with posts and no stories.
    const include = {
      opportunity: { select: { title: true } },
      // The campaign's name too, so the calendar's filter can name a campaign from an older month (ended or archived).
      campaign: { select: { id: true, name: true } },
      owner: { select: { id: true, name: true, email: true } },
      versions: { orderBy: { version: "desc" }, take: 1, include: { checks: { orderBy: { createdAt: "desc" }, take: 1 } } },
      decisions: { orderBy: { createdAt: "desc" }, take: 1, select: { verdict: true, note: true, contentVersionId: true } },
      publications: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, error: true, connectionId: true } },
    } as const;
    // Unscheduled first (a post just made in the app has no date yet), then by date.
    const orderBy: Prisma.ContentItemOrderByWithRelationInput[] = [{ scheduledFor: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }];
    // ponytail: open posts + 30 days of changes, 200 rows; past 200 open posts add from/to and filter params.
    // Both halves are read at once; open posts fill the 200 first, so a long history (undated, so sorted first) can never
    // push upcoming posts out. The recent half is read newest change first, so rows past what's left drop the oldest
    // (at most 200 read for nothing).
    // ponytail: a range reads up to 500 dated posts (about 60 days); a brand past ~8 posts a day would lose the latest days
    // (the answer says so with truncated: true).
    const RANGE_TAKE = 500;
    const where = id ? { ...base, id } : range ? { ...base, scheduledFor: { gte: range.from, lt: range.to } } : { ...base, ...open };
    const [openRows, recentRows] = await Promise.all([
      prisma.contentItem.findMany({ where, orderBy, take: range ? RANGE_TAKE : 200, include }),
      id || range ? [] : prisma.contentItem.findMany({ where: { ...base, ...recent, NOT: open }, orderBy: [{ updatedAt: "desc" }], take: 200, include }),
    ]);
    // Each half is sorted on its own; sort the whole once so the list keeps one order (undated first, then date, then creation).
    // Two undated posts give -Infinity - -Infinity = NaN, which is falsy, so `||` falls through to creation time: keep
    // the `||` (a `??` or a reordering would let NaN through and the sort would be inconsistent).
    const rows = [...openRows, ...recentRows.slice(0, 200 - openRows.length)].sort((a, b) => (a.scheduledFor?.getTime() ?? -Infinity) - (b.scheduledFor?.getTime() ?? -Infinity) || a.createdAt.getTime() - b.createdAt.getTime());
    if (id && !rows.length) return problemResponse({ type: "https://api.brandpilot/errors/not-found", title: "Post not found", status: 404 });
    // The draft's pictures (photoKeys, the first is the cover), signed for an hour: Today, Calendar and the post show them.
    // A studio reel has no photoKeys: its first scene's photo stands in as the cover.
    const photoKeys = (r: (typeof rows)[number]) => {
      const body = r.versions[0]?.body as { photoKeys?: string[]; scenes?: { photoKey?: string }[] } | undefined;
      return body?.photoKeys ?? (body?.scenes?.[0]?.photoKey ? [body.scenes[0].photoKey] : []);
    };
    // Writers already check keys (ownMediaKey); checked again here so a bad stored key is never signed.
    const photoUrls = await Promise.all(rows.map((r) => Promise.all(photoKeys(r).filter((k) => ownMediaKey(scope, k)).map((k) => signedMediaUrl(k)))));
    // Stories: their P07 tab (any partly posted or unverified attempt, not only the latest, moves one to Posted) and
    // the first rendered frame as the card.
    const storyIds = rows.filter((r) => r.channel === "INSTAGRAM_STORY").map((r) => r.id);
    // Stories whose frames are being prepared (a first save has no version until its render ends). One read of the
    // brand's in-flight renders, matched here. ponytail: fine while renders in flight are few; filter by item in SQL if not.
    // The two reads are independent: run them together.
    const [openAttempts, renders] = await Promise.all([
      storyIds.length
        ? prisma.publicationAttempt.findMany({ where: { contentItemId: { in: storyIds }, status: { in: ["PARTIAL", "PENDING_VERIFY"] } }, select: { contentItemId: true, status: true } })
        : [],
      storyIds.length
        ? prisma.job.findMany({ where: { type: STORY_RENDER_JOB, workspaceId: scope.workspaceId, brandId: scope.brandId, status: { in: ["PENDING", "RUNNING"] } }, select: { payload: true } })
        : [],
    ]);
    const rendering = new Set(renders.map((j) => (j.payload as { itemId?: unknown } | null)?.itemId));
    const story = async (r: (typeof rows)[number]) => {
      if (r.channel !== "INSTAGRAM_STORY") return {};
      const body = r.versions[0]?.body;
      return {
        tab: storyTab(r, openAttempts.filter((a) => a.contentItemId === r.id)),
        rendering: rendering.has(r.id),
        firstFrameUrl: isStoryBody(body) ? await coverUrl(scope, body.frames[0]?.renderedKey) : null,
      };
    };
    const stories = await Promise.all(rows.map(story));
    // Who confirmed a story frame's rights (in the body and the check's note) is for people who manage members, by name
    // (an older email name shows its local part); the stored version is never rewritten (packageHash covers it), only what is sent.
    const reveal = scope.perms.has("project.members.manage");
    const check = (v: (typeof rows)[number]["versions"][number]) => {
      const c = v.checks[0];
      return !c ? null : { ...c, results: reveal ? revealRightsNote(c.results) : hideRightsNote(c.results, v.body) };
    };
    return Response.json({
      ...(range && openRows.length === RANGE_TAKE ? { truncated: true } : {}),
      items: rows.map(({ versions, decisions, publications, owner, ...i }, n) => ({
        ...i,
        // Named as the owners list names them, never the email itself.
        owner: owner ? { id: owner.id, name: personName(owner, { reveal }) } : null,
        ...stories[n],
        // The last publish went wrong: "FAILED" (back to Approved, reason in publishError) or "CHECK" (may have posted).
        publishIssue: publications[0]?.status === "PENDING_VERIFY" ? "CHECK" : publications[0]?.status === "FAILED" && i.status === "APPROVED" ? "FAILED" : null,
        publishError: publications[0]?.status === "FAILED" || publications[0]?.status === "PENDING_VERIFY" ? publications[0].error : null,
        // The account the post is scheduled to or went out on (the web names it from its connections list, e.g. a
        // Facebook Post's Page); null when its last attempt was cancelled or failed, or it has none.
        publishConnectionId: publications[0] && (LIVE_STATUSES as readonly string[]).includes(publications[0].status) ? publications[0].connectionId : null,
        latest: versions[0]
          ? {
              version: versions[0].version,
              body: reveal ? revealRightsNames(versions[0].body) : hideRightsNames(versions[0].body),
              createdAt: versions[0].createdAt,
              byPerson: versions[0].createdBy !== "agent",
              photoUrls: photoUrls[n],
              check: check(versions[0]),
              // The approver's last word on this exact draft (e.g. the changes they asked for).
              review: decisions[0]?.contentVersionId === versions[0].id ? { verdict: decisions[0].verdict, note: decisions[0].note } : null,
            }
          : null,
      })),
    });
  } catch (error) {
    return fromAccessError(error);
  }
}

// Queued work runs after the response (kickRunner); give it room to finish.
export const maxDuration = 300;

const NewPostInput = z.object({
  channel: z.enum(["INSTAGRAM_POST", "INSTAGRAM_CAROUSEL"]),
  goal: z.enum(CONTENT_GOALS),
  product: z.object({ title: z.string().trim().min(1).max(200), photoKey: z.string().min(1).max(300) }),
  direction: z.string().max(500).optional(),
  requestId: z.string().uuid().optional(),
  // An instant with its offset, as a scheduled publish's runAt: the web sends the browser's local time as ISO.
  scheduledFor: z.string().datetime({ offset: true }).optional(),
});

// A new story (P07): paid, once per requestId (a uuid the app makes when the person taps).
const NewStoryInput = z.object({
  channel: z.literal("INSTAGRAM_STORY"),
  goal: z.enum(CONTENT_GOALS),
  productId: z.string().min(1).max(100),
  direction: z.string().max(500).optional(),
  requestId: z.string().uuid(),
});

/** A new post or story from the app (P06/P07): the Creator writes it now, then Quality checks it. */
export async function POST(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const json = await request.json().catch(() => null);
    const isStory = (json as { channel?: unknown } | null)?.channel === "INSTAGRAM_STORY";
    const parsed = isStory ? NewStoryInput.safeParse(json) : NewPostInput.safeParse(json);
    if (!parsed.success) return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid request", status: 400, detail: parsed.error.issues[0]?.message });
    const scope = await authorizeBrandRoute(request, context.params, "content.create");
    if (scope instanceof Response) return scope;
    // A retried request gets its post or story back without touching the rate limit.
    const again = "requestId" in parsed.data && parsed.data.requestId
      ? await itemForRequest(scope, parsed.data.requestId, { channel: parsed.data.channel === "INSTAGRAM_STORY" ? "INSTAGRAM_STORY" : ["INSTAGRAM_POST", "INSTAGRAM_CAROUSEL"] })
      : null;
    if (again) return Response.json({ id: again.id });
    if (!(await postAiAllowed(scope.workspaceId))) return problemResponse({ type: "https://api.brandpilot/errors/limit", title: "Too many posts written today. Try again tomorrow.", status: 429 });
    if (parsed.data.channel === "INSTAGRAM_STORY") {
      const story = await createStory(scope, parsed.data);
      // A repeat of a request already taken: the same story, no second run.
      if (story.repeated) return Response.json({ id: story.id });
      try {
        await startAgentRun({ workspaceId: scope.workspaceId, brandId: scope.brandId, agentKey: "creator", trigger: "event", input: { itemId: story.id }, prepaidChargeId: story.chargeId });
      } catch (e) {
        await failStoryStart(scope, story.id, story.chargeId);
        throw new PublishingError(STORY_START_NOTE, 502, "story.writeStart");
      }
      kickRunner();
      return Response.json({ id: story.id }, { status: 201 });
    }
    const { scheduledFor, ...post } = parsed.data;
    const { item, repeated } = await createPost({ ...scope, ...post, ...(scheduledFor ? { scheduledFor: new Date(scheduledFor) } : {}) });
    // A repeat that raced past the check above: the same post, no second run.
    if (repeated) return Response.json({ id: item.id });
    await startAgentRun({ workspaceId: scope.workspaceId, brandId: scope.brandId, agentKey: "creator", trigger: "event", input: { itemId: item.id } }).catch(() => null);
    kickRunner();
    return Response.json({ id: item.id }, { status: 201 });
  } catch (error) {
    if (error instanceof PublishingError) return problemResponse({ type: "https://api.brandpilot/errors/publishing", title: error.message, status: error.status, detail: error.message, code: error.code, ...error.data });
    return fromAccessError(error);
  }
}
