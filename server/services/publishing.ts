import { createHash } from "node:crypto";
import { aiDisclosureLine, needsAiDisclosure } from "@/server/reels/plan";
import type { ApprovalVerdict, ContentChannel, IntegrationProvider, Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { instagramPermalink, instagramPublishingLimit, PUBLISHERS, PublishRefused } from "@/server/integrations/publishers";
import { enqueueJob, holdsLease, type Lease } from "@/server/jobs/queue";
import { accessToken, markReconnect, ReconnectNeeded } from "@/server/services/connections";
import { CAPTION_LIMITS, CHANNEL_TEXT_MAX, safeHttpUrl } from "@/shared";
import { brandMemberPerms, hasOtherApprover, isClientMember, requirePermission } from "@/server/auth/permissions";
import { rolePermissions, type PermissionKey } from "@/server/auth/permissions.catalog";
import { linkedProducts } from "@/server/catalog/linked";
import { gateIssues, linkedIds, ProductOverride, snapshotOf } from "@/server/content/product-checks";
import { campaignsById } from "@/server/catalog/campaigns";
import { campaignKind, isWithdrawn, offerIssues, offerSnapshotOf, wallTime } from "@/server/content/offer-checks";
import { liveOfferFor, productIdsForPhoto } from "@/server/content/knowledge";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { listProjectPeople } from "@/server/services/project-members";
import { personName, TEAM_MEMBER } from "@/server/content/person-name";
import { signedMediaUrl } from "@/server/storage/media";
import type { StoryBody } from "@/server/stories/body";
import { attemptOutcome, expiredFrames, type FrameProgress, nextFramesToPublish, publishingLimitRoom, settleStoryFrame, unconfirmedMessage, withFrame } from "@/server/stories/publish";

/**
 * Approval → publishing (design §6 "sealed package", DEC-015/016). Rules:
 * - An approval binds to one ContentVersion and the sha256 of exactly what will be posted.
 *   A newer draft voids it; publishing re-checks at the moment of posting.
 * - Decisions are append-only. The author of a draft can't approve it, unless nobody else in the workspace can (decide).
 * - One live attempt per (version, account). A platform refusal is FAILED (retry allowed); a
 *   timeout or 5xx is PENDING_VERIFY and is never retried blindly: a person checks the account.
 */
export const PUBLISH_JOB = "content.publish";

export class PublishingError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    /** Stable string clients can switch on; story refusals always carry one. */ readonly code?: string,
    /** Extra fields for the problem JSON (e.g. `expiredFrames`), so apps needn't parse the message. */ readonly data?: Record<string, number | string | boolean>,
  ) {
    super(message);
  }
}

type Body = { hook?: string; caption?: string; hashtags?: string[]; pinTitle?: string; altText?: string; pinLink?: string; aiDisclosure?: boolean; presenter?: string; voice?: string; language?: string };

const CHANNEL_PROVIDER: Record<ContentChannel, IntegrationProvider | null> = {
  FACEBOOK_POST: "META",
  INSTAGRAM_POST: "INSTAGRAM",
  THREADS_POST: "THREADS",
  PINTEREST_PIN: "PINTEREST",
  INSTAGRAM_CAROUSEL: "INSTAGRAM",
  INSTAGRAM_REEL: "INSTAGRAM",
  INSTAGRAM_STORY: "INSTAGRAM",
  // No publishing API yet: planned, then posted by hand (registerManualPost).
  LINKEDIN_POST: null,
  X_POST: null,
};
// How many images each channel takes [min, max]; Reels take a video instead.
const IMAGES: Record<ContentChannel, [number, number]> = {
  INSTAGRAM_POST: [1, 1],
  PINTEREST_PIN: [1, 1],
  INSTAGRAM_CAROUSEL: [2, 10],
  FACEBOOK_POST: [0, 1],
  THREADS_POST: [0, 1],
  INSTAGRAM_REEL: [0, 0],
  INSTAGRAM_STORY: [0, 0], // frames, not images: see publishRequirements
  LINKEDIN_POST: [0, 1],
  X_POST: [0, 1],
};
const TEXT_LIMIT: Partial<Record<ContentChannel, number>> = CHANNEL_TEXT_MAX;
const LIVE: Prisma.EnumPublicationStatusFilter = { in: ["SCHEDULED", "PUBLISHING", "PUBLISHED", "PENDING_VERIFY", "PARTIAL"] };

export function publishRequirements(channel: ContentChannel) {
  const [minImages, maxImages] = IMAGES[channel];
  const base = { provider: CHANNEL_PROVIDER[channel], needsImage: minImages > 0, minImages, maxImages, needsVideo: channel === "INSTAGRAM_REEL", needsBoard: channel === "PINTEREST_PIN" };
  return channel === "INSTAGRAM_STORY" ? { ...base, frames: [3, 5] as [number, number] } : base;
}

/** Where the post's media lives: our private uploads (signed at posting time) and/or public links. */
type Target = { boardId: string | null; imageUrl?: string | null; media?: string[]; links?: string[]; videoUrl?: string | null; videoKey?: string | null };
/**
 * A story attempt posts the frames of its sealed version (no media in the target). `progress`: every frame this
 * attempt or an earlier one of the same story posted, and the one in flight (see server/stories/publish.ts).
 * `errorCode`: the stable code of the attempt's refusal, for the apps.
 */
type StoryTarget = { story: true; frames: number; progress: FrameProgress; errorCode?: string };
export const storyTargetOf = (t: unknown): StoryTarget | null => (t && typeof t === "object" && (t as StoryTarget).story === true && Array.isArray((t as StoryTarget).progress) ? (t as StoryTarget) : null);
export const postedCount = (progress: FrameProgress) => progress.filter((f) => f.state === "published").length;

/** The story's frames as approved, refused unless every one has its rendered file. Nothing is sent before this holds. */
function readyFrames(body: unknown) {
  const frames = (body as Partial<StoryBody> | null)?.frames ?? [];
  if (!frames.length || frames.some((f) => !f.renderedKey)) {
    throw new PublishingError("Every frame needs its finished picture or clip before the story can go out. Nothing was posted.", 409, "story.framesNotReady");
  }
  return frames as (StoryBody["frames"][number] & { renderedKey: string })[];
}
const BUSINESS_ONLY = "Instagram only lets business accounts post stories this way. Post it by hand, or switch the account to Business.";
// ponytail: Graph's wording for a non-business account isn't documented for stories; matched loosely, checked on the first live run.
const NOT_BUSINESS = /business|professional account|creator account/i;

/**
 * The posted text. A reel made with an AI presenter or a cloned voice always says so, in its own language (it can't be
 * edited out). Versions saved before the flag existed are judged from their plan.
 */
export function postText(body: Body) {
  const ai = body.aiDisclosure ?? needsAiDisclosure(body);
  return [body.caption?.trim(), ai ? aiDisclosureLine(body.language) : "", body.hashtags?.length ? body.hashtags.join(" ") : ""].filter(Boolean).join("\n\n");
}

export function packageHash(item: { id: string; channel: string }, version: { id: string; body: unknown }) {
  return createHash("sha256").update(JSON.stringify([item.id, item.channel, version.id, version.body])).digest("hex");
}

export async function loadItem(scope: { workspaceId: string; brandId: string }, itemId: string, db: Prisma.TransactionClient = prisma) {
  const item = await db.contentItem.findFirst({
    where: { id: itemId, workspaceId: scope.workspaceId, brandId: scope.brandId },
    include: { versions: { orderBy: { version: "desc" }, take: 1, include: { checks: { orderBy: { createdAt: "desc" }, take: 1 } } } },
  });
  if (!item) throw new PublishingError("Post not found", 404);
  return { item, latest: item.versions[0] ?? null };
}

/** The approval that currently lets this post go out, or null. */
export async function currentApproval(itemId: string, latest: { id: string; body: unknown } | null, channel: string, db: Prisma.TransactionClient = prisma) {
  if (!latest) return null;
  const last = await db.approvalDecision.findFirst({ where: { contentItemId: itemId }, orderBy: { createdAt: "desc" } });
  const ok = last?.verdict === "APPROVED" && last.contentVersionId === latest.id && last.packageHash === packageHash({ id: itemId, channel }, latest);
  return ok ? last : null;
}

/** `at`: the moment the post would go out (decide: later of now and scheduledFor; schedule: runAt; publish: now). */
type Loaded = { latest: { body: unknown; checks: { results: unknown }[] } | null; approval: { productOverride: unknown } | null; at: Date };
/**
 * The gate (approval, scheduling, publishing, the post view): every issue on the version's linked products, each with
 * its name, then its offer's issues; `refuses` ones stop the post. The approval's productOverride covers the
 * `overridable` ones (availability, an ended offer). The price and offer snapshots are read from the latest check's
 * rows (`snapshotOf`, `offerSnapshotOf`). The offer is the one that check judged; no offer row raises nothing.
 */
export async function productGate(db: Prisma.TransactionClient, scope: { workspaceId: string; brandId: string }, loaded: Loaded) {
  return (await gateWithLinks(db, scope, loaded)).issues;
}
/** `productGate` plus the linked products and campaigns it read (releaseState names overrides from them; `campaignIds`: more to read). */
async function gateWithLinks(db: Prisma.TransactionClient, scope: { workspaceId: string; brandId: string }, loaded: Loaded, campaignIds: (string | null)[] = []) {
  const ids = linkedIds(loaded.latest?.body);
  const results = loaded.latest?.checks[0]?.results;
  const offer = offerSnapshotOf(results);
  const parsed = ProductOverride.safeParse(loaded.approval?.productOverride);
  const override = parsed.success ? parsed.data : null;
  // Offer posts often link no product (whole-catalogue and category offers): their issues don't need any.
  const [linked, { campaigns, timeZone }] = await Promise.all([ids.length ? linkedProducts(db, scope, ids) : [], campaignsById(db, scope, [offer?.campaignId, ...campaignIds])]);
  const offers = offer ? offerIssues(campaigns.get(offer.campaignId), offer, override, loaded.at, timeZone) : [];
  const byId = new Map(linked.map((l) => [l.id, l]));
  const products = gateIssues(linked, snapshotOf(results), override).map((i) => ({ ...i, name: byId.get(i.productId)!.name, state: byId.get(i.productId)!.state }));
  return { issues: [...products, ...offers], linked, campaigns, timeZone };
}

// Callers queue on the per-post lock; allow for a slow database link before giving up.
export const TX = { maxWait: 10_000, timeout: 20_000 };
/** Per-row lock for the transaction: posts (people and agents alike) and tasks. */
export const lockRow = (tx: Prisma.TransactionClient, kind: "content" | "task", id: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${kind}:${id}`}))`;
/**
 * lockRow for many ids in ONE round trip, taken in the order given (callers pass ids sorted the way the other
 * multi-row lockers do, so two of them can't deadlock). WITH ORDINALITY + OFFSET 0 keep that order in the plan.
 */
export const lockRows = (tx: Prisma.TransactionClient, kind: "content" | "task", ids: string[]) =>
  tx.$queryRaw`SELECT count(pg_advisory_xact_lock(hashtext(${kind} || ':' || u.id))) FROM (SELECT id FROM unnest(${ids}::text[]) WITH ORDINALITY AS u(id, n) ORDER BY n OFFSET 0) u`;
/** Per-post lock shared by people (edit, approve, publish) and agents (Creator, Quality). */
export const lock = (tx: Prisma.TransactionClient, itemId: string) => lockRow(tx, "content", itemId);

export type DraftInput = { hook: string; caption: string; hashtags: string[]; slides: string[]; script: string[]; pinTitle: string; altText: string; photoKeys?: string[]; pinLink?: string };

export const APP_GOALS = { newArrival: "awareness", productFeature: "saves", specialOffer: "sales" } as const;
/**
 * Writing and checking posts from the app is free (event runs), so cap it per workspace per day.
 * ponytail: one flat cap shared by create, edit and re-generate; per-plan allowances come with billing.
 */
export async function postAiAllowed(workspaceId: string) {
  return (await hitRateLimit(`post-ai:${workspaceId}`, 60, 86_400_000)).allowed;
}

export type NewPost = { channel: "INSTAGRAM_POST" | "INSTAGRAM_CAROUSEL"; goal: keyof typeof APP_GOALS; product: { title: string; photoKey: string }; direction?: string; requestId?: string };

/**
 * The post or story already made for this request id in this brand, if it still exists. Posts and stories share one
 * request-id space per brand; `channel` narrows it (a story lookup never finds a post's id, and the other way round).
 * ponytail: brief->requestId is a JSON-path match with no index, so it scans the brand's posts of that channel; fine
 * per brand. Store requestId in a column with a (brandId, requestId) unique index if a brand gets tens of thousands.
 */
export async function itemForRequest(scope: { workspaceId: string; brandId: string }, requestId: string, opts: { channel?: ContentChannel | ContentChannel[] } = {}, db: Prisma.TransactionClient | typeof prisma = prisma) {
  const { channel } = opts;
  return db.contentItem.findFirst({
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId, ...(channel ? { channel: Array.isArray(channel) ? { in: channel } : channel } : {}), brief: { path: ["requestId"], equals: requestId } },
    select: { id: true },
  });
}

/** One lock per (brand, request id) for new posts and stories alike, so two requests with one id at once make one item. */
export const requestLockKey = (scope: { workspaceId: string; brandId: string }, requestId: string) => `content-request:${scope.workspaceId}:${scope.brandId}:${requestId}`;

/**
 * A post the person asks for in the app (P06): its brief is what they chose, so it skips the Brief writer;
 * the caller starts the Creator on it. Unscheduled until they pick a slot (P05).
 * With a requestId (the web sends one), a repeat gets the same post back (`repeated`) and the caller starts no second run.
 * A post deleted since is gone: its requestId then makes a new one. Without a requestId nothing is looked up (the app's old behaviour).
 */
export async function createPost(input: { workspaceId: string; brandId: string; userId: string } & NewPost): Promise<{ item: { id: string }; repeated: boolean }> {
  if (!ownMediaKey(input, input.product.photoKey)) throw new PublishingError("Unknown image", 400);
  const direction = input.direction?.trim() || null;
  const productIds = await productIdsForPhoto(input.workspaceId, input.brandId, input.product.photoKey);
  // A special offer links the live offer covering the photo's product, so the Creator gets its facts.
  const campaignId = input.goal === "specialOffer" ? await liveOfferFor(input, productIds) : null;
  return prisma.$transaction(async (tx) => {
    if (input.requestId) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${requestLockKey(input, input.requestId)}))`;
      const existing = await itemForRequest(input, input.requestId, { channel: ["INSTAGRAM_POST", "INSTAGRAM_CAROUSEL"] }, tx);
      if (existing) return { item: existing, repeated: true };
    }
    const item = await tx.contentItem.create({
      data: {
        workspaceId: input.workspaceId, brandId: input.brandId, title: input.product.title, channel: input.channel, status: "BRIEF_READY", productIds, campaignId, ownerId: input.userId,
        brief: { goal: APP_GOALS[input.goal], products: [input.product.title], keyMessage: direction ?? "", angle: input.goal, photoKeys: [input.product.photoKey], ...(input.requestId ? { requestId: input.requestId } : {}) },
      },
    });
    await tx.auditEvent.create({
      data: { workspaceId: input.workspaceId, brandId: input.brandId, actorUserId: input.userId, action: "content.create", entityType: "ContentItem", entityId: item.id, metadata: { channel: input.channel, goal: input.goal, ...(input.requestId ? { requestId: input.requestId } : {}) } },
    });
    return { item, repeated: false };
  }, TX);
}

/**
 * The people a post can be given to: everyone with brand.read on the brand (workspace roles and project grants), once each.
 * Names only, never emails: the list is open to anyone who can create posts. `reveal` (the caller holds
 * project.members.manage): nameless people by their email's local part; else "A team member", "A team member (2)", …
 * so the picker can tell them apart. Client reviewers review the work, they don't own it: their grants are left out.
 * `key` (default brand.read): the permission a person must hold on the brand, e.g. tasks.read for task names (one more
 * read of the workspace roles holding it). `includeClients`: keep client-reviewer grants that hold `key`.
 * ponytail: reads every member of the workspace; fine for small teams.
 */
export async function brandOwners(
  scope: { workspaceId: string; brandId: string },
  { reveal = false, key = "brand.read", includeClients = false }: { reveal?: boolean; key?: PermissionKey; includeClients?: boolean } = {},
) {
  const [{ viaWorkspace, people }, roles] = await Promise.all([
    listProjectPeople(scope.workspaceId, scope.brandId),
    // listProjectPeople's workspace list is already the brand.read holders; another key, or telling clients apart, needs the roles.
    key === "brand.read" && !includeClients
      ? null
      : prisma.workspaceMember.findMany({ where: { workspaceId: scope.workspaceId }, select: { userId: true, roleRef: { select: { isSystem: true, slug: true, permissions: true } } } }),
  ]);
  const roleOf = new Map((roles ?? []).map((r) => [r.userId, r.roleRef ? rolePermissions(r.roleRef) : []]));
  const viaRole = key === "brand.read" ? null : new Set([...roleOf].filter(([, perms]) => perms.includes(key)).map(([userId]) => userId));
  // With includeClients, each person says whether they are a client here (isClientMember).
  const clients = new Set(includeClients ? people.filter((g) => isClientMember(g.client, roleOf.get(g.userId) ?? [])).map((g) => g.userId) : []);
  const byId = new Map<string, { id: string; name: string; named: boolean }>();
  // Project roles are free-form: a grant counts only when its role holds `key`. Disabled and deleted people never do.
  const reach = [
    ...viaWorkspace.filter((p) => !viaRole || viaRole.has(p.userId)),
    ...people.filter((g) => g.role.permissions.includes(key) && (includeClients || !g.client)),
  ].filter((p) => p.active);
  for (const p of reach) {
    const named = !!p.name?.trim();
    const seen = byId.get(p.userId);
    // The same person on both lists: keep a real name over the fallback.
    if (!seen || (!seen.named && named)) byId.set(p.userId, { id: p.userId, name: personName(p, { reveal }), named });
  }
  let nameless = 0;
  return [...byId.values()].map(({ id, name, named }): { id: string; name: string; client?: boolean } => {
    const client = includeClients ? { client: clients.has(id) } : {};
    if (named || reveal) return { id, name, ...client };
    nameless++;
    return { id, name: nameless === 1 ? TEAM_MEMBER : `${TEAM_MEMBER} (${nameless})`, ...client };
  });
}

/** Give a post to someone with access to the brand, or to nobody (null). An unknown user and one without access get the same 400. */
export async function setOwner(scope: { workspaceId: string; brandId: string; userId: string }, itemId: string, userId: string | null) {
  // ponytail: checked outside the transaction, so removing the member in the same instant can still let one assignment through; a lock on membership if that matters.
  // brand.read through the workspace role or a project grant that is not the client-reviewer role, and the person is active.
  if (userId && !(await brandMemberPerms(prisma, scope, userId, "brand.read"))) {
    throw new PublishingError("Pick someone who works on this brand.", 400, "owner.invalid");
  }
  await prisma.$transaction(async (tx) => {
    await lock(tx, itemId);
    const item = await tx.contentItem.findFirst({ where: { id: itemId, workspaceId: scope.workspaceId, brandId: scope.brandId }, select: { id: true, ownerId: true } });
    if (!item) throw new PublishingError("Post not found", 404);
    if (item.ownerId === userId) return;
    await tx.contentItem.update({ where: { id: item.id }, data: { ownerId: userId } });
    await tx.auditEvent.create({
      data: { workspaceId: scope.workspaceId, brandId: scope.brandId, actorUserId: scope.userId, action: "content.owner", entityType: "ContentItem", entityId: item.id, metadata: { from: item.ownerId, to: userId } },
    });
  }, TX);
}

/** A picture this brand owns: one of its uploads (uuid.jpg|png) or Research's product photos, never another brand's file. */
export const ownMediaKey = (scope: { workspaceId: string; brandId: string }, key: string) => {
  const prefix = `${scope.workspaceId}/${scope.brandId}/`;
  return key.startsWith(prefix) && /^[A-Za-z0-9][A-Za-z0-9._-]*\.(jpg|png)$/.test(key.slice(prefix.length)) && !key.includes("..");
};
// A person can edit until the post is handed to a platform; a scheduled post must be cancelled first.
export const EDITABLE = ["PLANNED", "BRIEF_READY", "DRAFT_REVIEW", "AWAITING_APPROVAL", "APPROVED", "REJECTED", "BLOCKED"];

/** A pin's destination as the person typed it: https only, no credentials, at most 2000 characters; kept as URL.href. Null when it isn't one. */
export function cleanPinLink(raw: string): string | null {
  const t = raw.trim();
  if (t.length > 2000) return null;
  const u = safeHttpUrl(t);
  return u && u.protocol === "https:" && !u.username && !u.password ? u.href : null;
}

/** Where a pin leads: its own link (re-checked, since the body is JSON anyone with edit rights could have shaped), else the brand's website. */
export function pinDestination(pinLink: unknown, websiteUrl: string | null | undefined): string | null {
  return (typeof pinLink === "string" ? cleanPinLink(pinLink) : null) ?? safeHttpUrl(websiteUrl)?.href ?? null;
}

/**
 * A person saves a draft: always a new immutable version (any approval of the old one stops
 * holding), back to draft review for the Quality check. The editor can't approve it themselves when someone else can.
 * `version` is the one they edited (0 when writing the first draft); a newer one means they'd overwrite it.
 */
export async function saveDraft(input: { workspaceId: string; brandId: string; userId: string; itemId: string; version: number; body: DraftInput }) {
  const body: DraftInput = {
    hook: input.body.hook.trim(),
    caption: input.body.caption.trim(),
    hashtags: [...new Set(input.body.hashtags.map((h) => h.trim().replace(/^#*/, "")).filter(Boolean).map((h) => `#${h}`))],
    slides: input.body.slides.map((s) => s.trim()).filter(Boolean),
    script: input.body.script.map((s) => s.trim()).filter(Boolean),
    pinTitle: input.body.pinTitle.trim(),
    altText: input.body.altText.trim(),
    ...(input.body.pinLink?.trim() ? { pinLink: input.body.pinLink.trim() } : {}),
    ...(input.body.photoKeys === undefined ? {} : { photoKeys: [...new Set(input.body.photoKeys)] }),
  };
  if (!body.caption) throw new PublishingError("The caption can't be empty", 400);
  if (body.photoKeys?.some((k) => !ownMediaKey(input, k))) throw new PublishingError("Unknown image", 400);
  if (body.pinLink !== undefined) {
    const href = cleanPinLink(body.pinLink);
    if (!href) throw new PublishingError("The pin's link must be a full https:// address (no password in it, 2000 characters at most).", 400);
    body.pinLink = href;
  }
  return prisma.$transaction(async (tx) => {
    await lock(tx, input.itemId);
    const { item, latest } = await loadItem(input, input.itemId, tx);
    // A story version is only ever made by createStoryVersion, after its frames are rendered (server/stories/service.ts).
    if (item.channel === "INSTAGRAM_STORY") throw new PublishingError("Stories are saved with editStory", 400, "story.useEditStory");
    if ((latest?.version ?? 0) !== input.version) throw new PublishingError("Someone saved a newer draft while you were editing. Copy your changes, reload and try again.", 409, "draft.changed");
    if (item.status === "SCHEDULED") throw new PublishingError("This post is scheduled. Cancel it first, then edit.");
    if (!EDITABLE.includes(item.status)) throw new PublishingError("A published post can't be edited");
    // A studio reel's plan is its scenes: hook and script follow them whatever was sent, and the caption keeps the plan's
    // limits (plan.ts), or the new version would stop parsing as a plan and the reel page would lose it.
    const scenes = (latest?.body as { scenes?: { onScreenText?: string; voiceText: string }[] } | undefined)?.scenes;
    if (item.studio && scenes) {
      const { hashtagsMax, hashtagLengthMax, captionMax } = CAPTION_LIMITS;
      if (body.hashtags.length > hashtagsMax) throw new PublishingError(`A reel takes at most ${hashtagsMax} hashtags.`, 400);
      if (body.hashtags.some((h) => h.length > hashtagLengthMax)) throw new PublishingError(`A hashtag takes at most ${hashtagLengthMax} characters.`, 400);
      if (body.caption.length > captionMax) throw new PublishingError(`The caption is over ${captionMax} characters.`, 400);
      body.hook = scenes[0]?.onScreenText ?? "";
      body.script = scenes.map((s) => s.voiceText);
    }
    // An emptied link field (sent as "") takes the link off; one left out keeps what the version had.
    const merged: Record<string, unknown> = { ...((latest?.body as object | undefined) ?? { productIds: item.productIds }), ...body };
    if (input.body.pinLink !== undefined && !body.pinLink) delete merged.pinLink;
    if (latest && JSON.stringify(merged) === JSON.stringify(latest.body)) throw new PublishingError("Nothing changed", 400);
    // Fields the editor doesn't show (a studio reel's scenes and video, the linked products) carry over to the new
    // version; the first one takes the products the brief linked.
    const version = await tx.contentVersion.create({
      data: { contentItemId: item.id, version: (latest?.version ?? 0) + 1, body: merged as Prisma.InputJsonValue, createdBy: input.userId },
    });
    await tx.contentItem.update({ where: { id: item.id }, data: { status: "DRAFT_REVIEW" } });
    await tx.auditEvent.create({
      data: {
        workspaceId: input.workspaceId, brandId: input.brandId, actorUserId: input.userId,
        action: "content.edit", entityType: "ContentItem", entityId: item.id, metadata: { version: version.version, from: item.status },
      },
    });
    return version;
  }, TX);
}

export async function decide(input: {
  workspaceId: string;
  brandId: string;
  userId: string;
  itemId: string;
  version: number; // the version the approver was looking at
  verdict: ApprovalVerdict;
  note?: string;
  /** "Approve anyway": approve past the overridable issues there are now, product availability and ended offers (needs rules.approve and a note). */
  override?: boolean;
  /** CHANGES_REQUESTED: the Creator may link another product instead. */
  switchProducts?: boolean;
  /**
   * Decided as the client (the route's `clientReviewer`): kept on the decision (the writer labels a client's note,
   * examples skip a client's approvals, the apps say "by client"), and limits what they can send back.
   */
  byClient: boolean;
  /**
   * Runs once the decision is known to be possible (a send-back: also within the send-back limits), before
   * anything is written: the route spends the workspace's post-AI allowance here, so a made-up id or a send-back that
   * can't happen spends nothing. Throw to refuse.
   */
  beforeWrite?: (item: { studio: boolean }) => Promise<void>;
}) {
  const note = input.note?.trim() || null;
  if (input.verdict !== "APPROVED" && !note) throw new PublishingError("Say what needs to change", 400);
  if (input.override && input.verdict !== "APPROVED") throw new PublishingError("Only an approval can override product issues", 400);
  if (input.override && (!note || note.length > 500)) throw new PublishingError("Say why it can go out anyway (500 characters at most)", 400);
  if (input.switchProducts && input.verdict !== "CHANGES_REQUESTED") throw new PublishingError("Only a request for changes can ask for another product", 400);
  // Checked here, not only in the route: reels and future callers call decide too.
  if (input.override) await requirePermission(input.workspaceId, input.userId, "rules.approve", input.brandId);
  // Checked first outside the transaction (and again inside it): a missing post or a decision that can't happen spends
  // no send-back or AI allowance.
  const pre = await loadItem(input, input.itemId);
  const preLatest = await assertDecidable(pre.item, pre.latest, input);
  // Whether someone else could approve, for self-approval below: read outside the transaction (it reads every member),
  // and only when it matters, someone approving their own draft. The version number is checked again inside, so the
  // draft (and its author) is the same one.
  const ownDraft = input.verdict === "APPROVED" && preLatest.createdBy === input.userId && !pre.item.studio;
  const otherApprover = ownDraft ? await hasOtherApprover(input.workspaceId, input.brandId, input.userId) : false;
  // Each send-back starts a free rewrite: capped per brand for its clients (so they can't use up the workspace's post-AI
  // allowance), then per person, so one reviewer can't loop the writer. One after the other: a send-back refused by the
  // first cap spends nothing from the second.
  if (input.verdict === "CHANGES_REQUESTED") {
    if (input.byClient && !(await hitRateLimit(`client-send-back:${input.workspaceId}:${input.brandId}`, 20, 86_400_000)).allowed) {
      throw new PublishingError("This project's clients have sent back a lot of posts today. Try again tomorrow.", 429);
    }
    if (!(await hitRateLimit(`send-back:${input.userId}`, 30, 3_600_000)).allowed) {
      throw new PublishingError("You've sent back a lot of posts this hour. Try again later.", 429);
    }
  }
  await input.beforeWrite?.(pre.item);
  const { byClient } = input;
  return prisma.$transaction(async (tx) => {
    await lock(tx, input.itemId);
    const { item, latest: loaded } = await loadItem(input, input.itemId, tx);
    const latest = await assertDecidable(item, loaded, input, tx);
    let productOverride: ProductOverride | undefined;
    if (input.verdict === "APPROVED") {
      if (latest.checks[0]?.overall === "BLOCKER" || !latest.checks[0]) throw new PublishingError("The quality check must pass before approval");
      // Studio reels are made and sent by the same person (owner's call, 2026-10-30). Other posts need a second
      // person, unless there is nobody else who can approve (a one-person business, owner's call 2026-11-02).
      if (latest.createdBy === input.userId && !item.studio && otherApprover) {
        throw new PublishingError("You wrote this draft, so someone else has to approve it", 403);
      }
      // Judged as if there were no override: only the latest decision counts, so an override lists every
      // overridable issue there is now (already covered or new) at its current state. At the post's own time: an
      // ended override is given only once the offer has ended by then.
      const at = new Date(Math.max(Date.now(), item.scheduledFor?.getTime() ?? 0));
      const issues = await productGate(tx, input, { latest, approval: null, at });
      if (input.override) {
        const products = issues.flatMap((i) => (i.overridable && i.kind !== "offer" ? [i] : []));
        const offers = issues.flatMap((i) => (i.overridable && i.kind === "offer" ? [i.campaignId] : []));
        if (!products.length && !offers.length) throw new PublishingError("There's nothing to approve anyway", 400);
        productOverride = ProductOverride.parse({
          productIds: products.map((i) => i.productId), states: Object.fromEntries(products.map((i) => [i.productId, i.state])), ...(offers.length ? { offers } : {}),
        });
      }
      const refused = issues.find((i) => i.refuses && !(productOverride && i.overridable));
      if (refused) throw new PublishingError(refused.message);
    }
    const decision = await tx.approvalDecision.create({
      data: {
        workspaceId: input.workspaceId,
        brandId: input.brandId,
        contentItemId: item.id,
        contentVersionId: latest.id,
        packageHash: packageHash(item, latest),
        verdict: input.verdict,
        note,
        userId: input.userId,
        ...(productOverride ? { productOverride } : {}),
        switchProducts: Boolean(input.switchProducts),
        byClient,
      },
    });
    const status = input.verdict === "APPROVED" ? "APPROVED" : input.verdict === "REJECTED" ? "REJECTED" : "DRAFT_REVIEW";
    // Leaving APPROVED ends a story's Post by hand (only stories ever set byHand).
    await tx.contentItem.update({ where: { id: item.id }, data: { status, ...(item.byHand && status !== "APPROVED" ? { byHand: false } : {}) } });
    await tx.auditEvent.create({
      data: {
        workspaceId: input.workspaceId, brandId: input.brandId, actorUserId: input.userId,
        action: `content.${input.verdict.toLowerCase()}`, entityType: "ContentItem", entityId: item.id,
        metadata: { version: latest.version, packageHash: decision.packageHash },
      },
    });
    if (productOverride) {
      await tx.auditEvent.create({
        data: {
          workspaceId: input.workspaceId, brandId: input.brandId, actorUserId: input.userId,
          action: "approval.product_override", entityType: "ContentItem", entityId: item.id,
          metadata: { versionId: latest.id, productIds: productOverride.productIds, states: productOverride.states, offers: productOverride.offers, note },
        },
      });
    }
    return decision;
  }, TX);
}

/** The latest version, if the decision can be made on it now; else the reason it can't. */
async function assertDecidable<V extends { id: string; version: number; body: unknown }>(
  item: { id: string; status: string; channel: string },
  latest: V | null,
  input: { version: number; verdict: ApprovalVerdict; override?: boolean; userId: string; byClient: boolean },
  db: Prisma.TransactionClient = prisma,
) {
  if (!latest || latest.version !== input.version) throw new PublishingError("A newer draft exists. Review the latest version.");
  // An approved, not yet scheduled post can still be approved anyway or sent back (a product sold out since),
  // as long as its approval holds. A client sends back only what they approved themselves, not the team's approval.
  const afterApproval = item.status === "APPROVED" && (input.override || input.verdict === "CHANGES_REQUESTED");
  if (afterApproval) {
    const approval = await currentApproval(item.id, latest, item.channel, db);
    if (!approval) throw new PublishingError("The approval no longer holds. Review the latest version.");
    if (input.byClient && !(approval.byClient && approval.userId === input.userId)) throw new PublishingError("This post was approved by the team. Ask them to reopen it.", 409);
  }
  if (item.status !== "AWAITING_APPROVAL" && !afterApproval) throw new PublishingError("This post isn't waiting for approval");
  return latest;
}

export async function schedulePublication(input: {
  workspaceId: string;
  brandId: string;
  userId: string;
  itemId: string;
  version: number;
  connectionId: string;
  boardId?: string;
  imageUrl?: string; // a public link (one-image channels)
  imageLinks?: string[];
  mediaKeys?: string[]; // files uploaded to this brand's media storage
  videoUrl?: string;
  runAt?: Date; // omitted = now
}) {
  const runAt = input.runAt ?? new Date();
  if (runAt.getTime() < Date.now() - 60_000) throw new PublishingError("Pick a time in the future", 400);
  const attempt = await prisma.$transaction(async (tx) => {
    await lock(tx, input.itemId);
    const { item, latest } = await loadItem(input, input.itemId, tx);
    if (!latest || latest.version !== input.version) throw new PublishingError("A newer draft exists. It needs approval first.");
    const approval = await currentApproval(item.id, latest, item.channel, tx);
    if (item.status === "SCHEDULED") throw new PublishingError("Already scheduled. Cancel it first to change the time or account.");
    if (item.status === "PUBLISHED") throw new PublishingError("Already published");
    if (!approval || item.status !== "APPROVED") throw new PublishingError("Only an approved version can be published");
    const refused = (await productGate(tx, input, { latest, approval, at: runAt })).find((i) => i.refuses);
    if (refused) throw new PublishingError(refused.message);

    const req = publishRequirements(item.channel);
    if (!req.provider) throw new PublishingError("This format can't be published automatically yet. Export it and post it in the app.", 400);
    const conn = await tx.integrationConnection.findFirst({
      where: { id: input.connectionId, brandId: input.brandId, provider: req.provider, status: "ACTIVE" },
    });
    if (!conn) throw new PublishingError("Choose a connected account for this channel", 400);
    const story = item.channel === "INSTAGRAM_STORY";
    let target: Target | StoryTarget;
    if (story) {
      if (input.boardId || input.imageUrl?.trim() || input.imageLinks?.length || input.mediaKeys?.length || input.videoUrl?.trim()) throw new PublishingError("A story posts its own frames", 400, "story.ownFrames");
      target = { story: true, frames: readyFrames(latest.body).length, progress: [] };
    } else {
      const https = (u: string) => {
        const h = safeHttpUrl(u.trim())?.href;
        return h?.startsWith("https://") ? h : null;
      };
      const rawLinks = [...(input.imageLinks ?? []), ...(input.imageUrl?.trim() ? [input.imageUrl] : [])].filter((u) => u.trim());
      const links = rawLinks.map(https);
      if (links.some((l) => !l)) throw new PublishingError("Image links must be public https:// addresses", 400);
      const media = input.mediaKeys ?? [];
      if (media.some((k) => !ownMediaKey(input, k))) throw new PublishingError("Unknown image", 400);
      // A draft that names its pictures (photoKeys) posts those: the approval covered them, not other files.
      const approvedPhotos = (latest.body as { photoKeys?: string[] }).photoKeys;
      if (approvedPhotos && media.some((k) => !approvedPhotos.includes(k))) throw new PublishingError("Post the photos on the approved draft, or edit the post first", 400);
      const count = media.length + links.length;
      if (count < req.minImages) throw new PublishingError(req.minImages === 1 ? "This channel needs an image" : `A carousel needs at least ${req.minImages} images`, 400);
      if (count > req.maxImages) throw new PublishingError(req.maxImages === 0 ? "Reels take a video, not images" : `This channel takes at most ${req.maxImages} image${req.maxImages === 1 ? "" : "s"}`, 400);
      if (req.provider === "INSTAGRAM" && media.some((k) => !/\.jpe?g$/i.test(k))) throw new PublishingError("Instagram only accepts JPEG photos. Upload a .jpg instead.", 400);
      // A studio reel posts the video that was approved, from our storage, signed at posting time.
      const videoKey = item.studio ? ((latest.body as { videoKey?: string }).videoKey ?? null) : null;
      if (item.studio && input.videoUrl?.trim()) throw new PublishingError("This reel posts its own video", 400);
      if (item.studio && !videoKey) throw new PublishingError("This reel has no video yet", 400);
      const videoUrl = input.videoUrl?.trim() ? https(input.videoUrl) : null;
      if (input.videoUrl?.trim() && !videoUrl) throw new PublishingError("The video link must be a public https:// address", 400);
      if (req.needsVideo && !videoUrl && !videoKey) throw new PublishingError("A Reel needs a video link", 400);
      const imageUrl = links[0] ?? null;
      if (req.needsBoard && !input.boardId) throw new PublishingError("Choose a board", 400);
      const limit = TEXT_LIMIT[item.channel];
      if (limit && postText(latest.body as Body).length > limit) throw new PublishingError(`The text is over this channel's ${limit}-character limit`, 400);
      target = { boardId: input.boardId ?? null, imageUrl, media, links: links as string[], videoUrl, videoKey } satisfies Target;
    }

    const live = await tx.publicationAttempt.findFirst({ where: { contentVersionId: latest.id, connectionId: conn.id, status: LIVE } });
    if (live?.status === "PARTIAL") throw new PublishingError("Part of this story is already posted. Post the rest or mark it done.", 409, "story.partlyPosted");
    if (live) throw new PublishingError(live.status === "PUBLISHED" ? "Already published to this account" : "Already scheduled for this account");

    const a = await tx.publicationAttempt.create({
      data: {
        workspaceId: input.workspaceId, brandId: input.brandId, contentItemId: item.id, contentVersionId: latest.id,
        packageHash: approval.packageHash, connectionId: conn.id, provider: conn.provider,
        target, runAt, createdByUserId: input.userId,
      },
    });
    // Scheduling a story ends its Post by hand.
    await tx.contentItem.update({ where: { id: item.id }, data: { status: "SCHEDULED", scheduledFor: runAt, ...(story ? { byHand: false } : {}) } });
    await enqueueJob({ type: PUBLISH_JOB, workspaceId: input.workspaceId, brandId: input.brandId, payload: { attemptId: a.id }, runAt, maxAttempts: 1, idempotencyKey: `publish:${a.id}` }, tx);
    return a;
  }, TX);
  return attempt;
}

/** beforePublish stopped the post before the platform's final call: nothing was sent. */
class PublishStopped extends Error {}

/** Job handler. Never throws: a retry could double-post, so every outcome is recorded instead. */
export async function executePublication(payload: unknown, lease?: Lease) {
  const { attemptId } = payload as { attemptId: string };
  const claimed = await prisma.publicationAttempt.updateMany({ where: { id: attemptId, status: "SCHEDULED" }, data: { status: "PUBLISHING" } });
  if (claimed.count !== 1) return; // cancelled, or already handled
  const a = await prisma.publicationAttempt.findUniqueOrThrow({ where: { id: attemptId } });
  let overrideUsed = false;
  type ItemStatus = "PUBLISHED" | "APPROVED" | "SCHEDULED" | "AWAITING_APPROVAL";
  // Only while still PUBLISHING: a slow worker must not overwrite PENDING_VERIFY or a person's settle (then reschedule).
  const finish = (status: "PUBLISHED" | "FAILED" | "PENDING_VERIFY", data: Prisma.PublicationAttemptUpdateManyMutationInput, itemStatus: ItemStatus) =>
    prisma.$transaction(async (tx) => {
      const { count } = await tx.publicationAttempt.updateMany({ where: { id: a.id, status: "PUBLISHING" }, data: { status, ...data } });
      if (count !== 1) return;
      await tx.contentItem.update({ where: { id: a.contentItemId }, data: { status: itemStatus } });
      await tx.auditEvent.create({
        data: { workspaceId: a.workspaceId, brandId: a.brandId, actorUserId: a.createdByUserId, action: `content.publish.${status.toLowerCase()}`, entityType: "PublicationAttempt", entityId: a.id, metadata: { provider: a.provider, overrideUsed } },
      });
    }, TX);
  // A story records its frames as it goes. Its every write needs the attempt still PUBLISHING: once the lost-job
  // handler has settled it, a worker that is somehow still running can neither post another frame nor overwrite that.
  const storyT = storyTargetOf(a.target);
  let progress: FrameProgress = storyT?.progress ?? [];
  const finishStory = (status: "PUBLISHED" | "PARTIAL" | "FAILED" | "PENDING_VERIFY", data: Prisma.PublicationAttemptUpdateManyMutationInput, itemStatus: ItemStatus, errorCode?: string) =>
    prisma.$transaction(async (tx) => {
      const { errorCode: _old, ...rest } = storyT!;
      const target = { ...rest, progress, ...(errorCode ? { errorCode } : {}) };
      const { count } = await tx.publicationAttempt.updateMany({ where: { id: a.id, status: "PUBLISHING" }, data: { status, ...data, target } });
      if (count !== 1) return;
      await tx.contentItem.update({ where: { id: a.contentItemId }, data: { status: itemStatus } });
      await tx.auditEvent.create({
        data: {
          workspaceId: a.workspaceId, brandId: a.brandId, actorUserId: a.createdByUserId, action: `content.publish.${status.toLowerCase()}`, entityType: "PublicationAttempt", entityId: a.id,
          metadata: { provider: a.provider, overrideUsed, posted: postedCount(progress), total: storyT!.frames },
        },
      });
    }, TX);
  /**
   * Stopped before anything new was sent. A story attempt carrying frames posted earlier (Post the rest) stays PARTIAL
   * and its item SCHEDULED, so Post the rest and Mark as done stay available; otherwise it is a plain FAILED.
   */
  const fail = (error: string, itemStatus: ItemStatus, errorCode?: string) =>
    !storyT ? finish("FAILED", { error }, itemStatus)
    : postedCount(progress) ? finishStory("PARTIAL", { error: `${postedCount(progress)} of ${storyT.frames} frames are posted. ${error}` }, "SCHEDULED", errorCode)
    : finishStory("FAILED", { error }, itemStatus, errorCode);

  // Re-check the seal at the moment of posting: an edit after scheduling voids the approval.
  const { item, latest } = await loadItem(a, a.contentItemId);
  const approval = await currentApproval(item.id, latest, item.channel);
  if (!latest || latest.id !== a.contentVersionId || approval?.packageHash !== a.packageHash) {
    await fail("The draft changed after approval. Approve the new version, then publish again.", "AWAITING_APPROVAL");
    return;
  }
  overrideUsed = approval.productOverride !== null;
  // Products and the offer are checked again at the moment of posting (stock, prices, an offer that ended or changed).
  // Nothing has been sent, so a refusal or an error here is a plain FAILED, never PENDING_VERIFY.
  let refusal: string | null;
  try {
    const refused = (await productGate(prisma, a, { latest, approval, at: new Date() })).find((i) => i.refuses);
    refusal = refused ? `${refused.message.replace(/\.$/, "")}. Nothing was posted.` : null;
  } catch {
    refusal = "Couldn't check the linked products. Nothing was posted. Try again.";
  }
  if (refusal) {
    await fail(refusal, "APPROVED");
    return;
  }
  const conn = await prisma.integrationConnection.findFirst({ where: { id: a.connectionId, status: "ACTIVE" } });
  const publisher = PUBLISHERS[a.provider];
  if (!conn?.encryptedCredentials || !publisher) {
    await fail("The account was disconnected or needs reconnecting. Reconnect it in Settings → Connections, then publish again.", "APPROVED");
    return;
  }
  // Refresh an expiring token before posting. Nothing has been sent yet, so any failure here is safe to retry.
  let token: string;
  try {
    token = await accessToken(conn);
  } catch (e) {
    const error = e instanceof ReconnectNeeded
      ? `${conn.displayName}'s access expired. Reconnect it in Settings → Connections, then publish again.`
      : "Couldn't reach the platform to refresh the account's access. Nothing was posted. Try again.";
    await fail(error, "APPROVED");
    return;
  }
  if (storyT) {
    await publishStory();
    return;
  }
  const body = latest.body as Body;
  const target = a.target as Target;
  const profile = await prisma.brandProfile.findFirst({ where: { brandId: a.brandId }, select: { websiteUrl: true } });
  // Immediately before the platform's irreversible call, the CAS a story makes per frame (save): this attempt must
  // still be PUBLISHING and this runner must still hold its job. Otherwise it was declared lost while the containers
  // processed (releaseState after 10 minutes, onPublishJobLost after a lost lease), and a person may already have said
  // "it didn't post" and booked it again: posting now would post it twice. The CAS also moves updatedAt, so
  // releaseState's 10 minutes start over for the one call left (30 s timeout). The lease must have a minute to spare,
  // longer than that call. A check that fails, or throws (a pool timeout), stops before anything is sent.
  const beforePublish = async () => {
    const live = await prisma.$transaction(async (tx) =>
      (!lease || (await holdsLease(tx, lease, 60))) && (await tx.publicationAttempt.updateMany({ where: { id: a.id, status: "PUBLISHING" }, data: { updatedAt: new Date() } })).count === 1)
      .catch(() => false);
    if (!live) throw new PublishStopped();
  };
  try {
    // Uploads are private: the platform gets a link valid for an hour, made at the moment of posting.
    const images = [...(await Promise.all((target.media ?? []).map((k) => signedMediaUrl(k, 3600)))), ...(target.links ?? (target.imageUrl ? [target.imageUrl] : []))];
    const res = await publisher(
      { text: postText(body), title: body.pinTitle || body.hook || item.title, altText: body.altText ?? "", link: pinDestination(body.pinLink, profile?.websiteUrl), imageUrl: images[0] ?? null, imageUrls: images, videoUrl: target.videoKey ? await signedMediaUrl(target.videoKey, 3600) : (target.videoUrl ?? null), boardId: target.boardId, beforePublish },
      { id: conn.externalAccountId, token },
    );
    await finish("PUBLISHED", { externalId: res.externalId, externalUrl: safeHttpUrl(res.externalUrl)?.href ?? null, publishedAt: new Date(), error: null }, "PUBLISHED");
  } catch (e) {
    // Nothing was sent. Still PUBLISHING (a lease that is late or lost, or a database error): FAILED, back to APPROVED,
    // so it isn't left for releaseState to call "check the account". Already settled or declared lost: the CAS in
    // finish leaves that as it is.
    if (e instanceof PublishStopped) return void (await finish("FAILED", { error: "Publishing stopped before posting. Nothing was posted. Try again." }, "APPROVED"));
    const msg = e instanceof Error ? e.message.slice(0, 300) : "Unknown error";
    if (e instanceof PublishRefused) {
      // The platform no longer accepts this token: say so on the account, not just on this post.
      if (/^401 |access token|OAuthException/i.test(msg)) await markReconnect(conn.id, `The platform rejected the access (${msg.slice(0, 120)}). Reconnect ${conn.displayName}.`);
      await finish("FAILED", { error: msg }, "APPROVED");
    }
    else await finish("PENDING_VERIFY", { error: `We couldn't confirm whether it posted (${msg}). Check the account before trying again.` }, "SCHEDULED");
  }

  /**
   * Instagram story (spec "Going out"): the account's daily limit must have room for every frame still to post, then
   * the publisher makes every container (nothing public) and publishes them in order, frame by frame. A frame is
   * recorded "publishing" before its publish call and "published" with its media id after it, so whatever stops us,
   * we know which frames are out and the one we can't be sure of.
   */
  async function publishStory() {
    const st = storyT!;
    let frames: ReturnType<typeof readyFrames>;
    let todo: number[];
    try {
      frames = readyFrames(latest!.body);
      if (frames.length !== st.frames) throw new PublishingError("The story's frames changed. Nothing was posted.", 409, "story.framesNotReady");
      todo = nextFramesToPublish(st.frames, progress);
    } catch (e) {
      await fail(e instanceof Error ? e.message : "The frames aren't ready. Nothing was posted.", "APPROVED", e instanceof PublishingError ? e.code : "story.unconfirmed");
      return;
    }
    const account = { id: conn!.externalAccountId, token };
    let room: number;
    let duration: number;
    try {
      const limit = await instagramPublishingLimit(account);
      room = publishingLimitRoom(limit);
      duration = limit.config.quota_duration;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (e instanceof PublishRefused && NOT_BUSINESS.test(msg)) await fail(BUSINESS_ONLY, "APPROVED", "story.businessOnly");
      else await fail("Couldn't read Instagram's daily limit. Nothing was posted. Try again.", "APPROVED", "story.limitUnknown");
      return;
    }
    if (room < todo.length) {
      // A rolling 24 h window, and Instagram doesn't say when each use drops out: after one full window there is room.
      const after = new Date(Date.now() + duration * 1000).toISOString().slice(0, 16).replace("T", " ");
      await fail(`Instagram's daily limit leaves room for ${room} of ${todo.length} frames. Try after ${after} UTC.`, "APPROVED", "story.dailyLimit");
      return;
    }
    const save = async (next: FrameProgress) => {
      const { count } = await prisma.publicationAttempt.updateMany({ where: { id: a.id, status: "PUBLISHING" }, data: { target: { ...st, progress: next } } });
      if (count !== 1) throw new Error("Publishing was stopped");
    };
    try {
      // Signed just before the containers are made (all at once), valid an hour.
      const urls = await Promise.all(frames.map((f, i) => (todo.includes(i) ? signedMediaUrl(f.renderedKey, 3600) : "")));
      const res = await publisher!(
        {
          text: "", title: item.title, altText: "", link: null, imageUrl: null, imageUrls: [], videoUrl: null, boardId: null,
          story: {
            frames: frames.map((f, i) => ({ url: urls[i], kind: /\.mp4$/i.test(f.renderedKey) ? "video" : "photo" })),
            skip: frames.map((_, i) => i).filter((i) => !todo.includes(i)),
            // Kept in memory only once stored: if storing fails, the publish call isn't made.
            onPublishing: async (i) => {
              const next = withFrame(progress, i, { state: "publishing" });
              await save(next);
              progress = next;
            },
            // It is out whether or not storing works: kept in memory first.
            onPublished: async (i, mediaId) => {
              progress = withFrame(progress, i, { state: "published", mediaId, at: new Date().toISOString() });
              await save(progress);
            },
          },
        },
        account,
      );
      if (attemptOutcome(st.frames, progress) !== "PUBLISHED") throw new Error("Not every frame was posted");
      // Both describe frame 1: its link comes with the result when this attempt posted it, else it is asked for.
      const first = progress.find((f) => f.i === 0)?.mediaId ?? res.externalId;
      const link = res.externalId === first ? res.externalUrl : await instagramPermalink(first, account).catch(() => null);
      await finishStory("PUBLISHED", { externalId: first, externalUrl: safeHttpUrl(link)?.href ?? null, publishedAt: new Date(), error: null }, "PUBLISHED");
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 300) : "Unknown error";
      if (e instanceof PublishRefused && /^401 |access token|OAuthException/i.test(msg)) await markReconnect(conn!.id, `The platform rejected the access (${msg.slice(0, 120)}). Reconnect ${conn!.displayName}.`);
      const inFlight = progress.find((f) => f.state === "publishing");
      // A publish call whose answer we didn't get: that frame may be out. A person checks it (settleFrame).
      if (inFlight && !(e instanceof PublishRefused)) {
        await finishStory("PENDING_VERIFY", { error: unconfirmedMessage(progress) }, "SCHEDULED");
        return;
      }
      // Instagram refused that frame's publish: it isn't out.
      if (inFlight) progress = withFrame(progress, inFlight.i, { state: "not-posted" });
      const posted = postedCount(progress);
      if (!posted && e instanceof PublishRefused && NOT_BUSINESS.test(msg)) await fail(BUSINESS_ONLY, "APPROVED", "story.businessOnly");
      else await fail(posted ? `The next frame wasn't posted (${msg}).` : msg, "APPROVED", posted ? "story.partlyPosted" : "story.refused");
    }
  }
}

/**
 * The publish job died mid-run (timeout, crash) or lost its lease, and won't be retried: whatever is still PUBLISHING
 * may or may not have posted, so a person checks the account. A runner still going finds this at its beforePublish
 * (or its next story frame) and stops.
 * A job that died before it claimed its attempt left it SCHEDULED, with no job left to run it: nothing was sent, so it
 * fails like a refusal before posting (a story with frames already out goes back to PARTIAL).
 */
export async function onPublishJobLost(payload: unknown) {
  const { attemptId } = payload as { attemptId: string };
  const a = await prisma.publicationAttempt.findFirst({ where: { id: attemptId, status: { in: ["SCHEDULED", "PUBLISHING"] } } });
  if (a?.status === "SCHEDULED") return publishNeverStarted(a);
  if (storyTargetOf(a?.target)) return storyJobLost(attemptId);
  await prisma.publicationAttempt.updateMany({
    where: { id: attemptId, status: "PUBLISHING" },
    data: { status: "PENDING_VERIFY", error: "Publishing stopped midway. Check the account before trying again." },
  });
}

async function publishNeverStarted(a: Prisma.PublicationAttemptGetPayload<object>) {
  const st = storyTargetOf(a.target);
  const posted = st ? postedCount(st.progress) : 0;
  const error = "Publishing didn't start. Nothing was posted. Publish it again.";
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.publicationAttempt.updateMany({
      where: { id: a.id, status: "SCHEDULED" },
      data: posted ? { status: "PARTIAL", error: `${posted} of ${st!.frames} frames are posted. Posting the rest didn't start.` } : { status: "FAILED", error },
    });
    if (count !== 1) return;
    if (!posted) await tx.contentItem.update({ where: { id: a.contentItemId }, data: { status: "APPROVED" } });
    await tx.auditEvent.create({
      data: { workspaceId: a.workspaceId, brandId: a.brandId, actorUserId: a.createdByUserId, action: `content.publish.${posted ? "partial" : "failed"}`, entityType: "PublicationAttempt", entityId: a.id, metadata: { provider: a.provider, lost: true, started: false } },
    });
  }, TX);
}

/**
 * A story's job stopped mid-run. A frame recorded "publishing" may be out: PENDING_VERIFY naming it. Without one, no
 * publish call was in flight (each is recorded first, and every later write needs the attempt still PUBLISHING), so the
 * frames recorded are exactly what's out: PUBLISHED, PARTIAL, or FAILED when none are.
 * The row is locked and read inside the transaction, and the status written from that same read: a worker that is
 * somehow still running waits on the lock to store its next frame, then finds the attempt no longer PUBLISHING.
 */
async function storyJobLost(attemptId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "PublicationAttempt" WHERE "id" = ${attemptId} FOR UPDATE`;
    const a = await tx.publicationAttempt.findFirst({ where: { id: attemptId, status: "PUBLISHING" } });
    const st = storyTargetOf(a?.target);
    if (!a || !st) return;
    const unsure = st.progress.some((f) => f.state === "publishing");
    const posted = postedCount(st.progress);
    const outcome = attemptOutcome(st.frames, st.progress);
    const status = unsure ? "PENDING_VERIFY" : outcome;
    const error = unsure ? unconfirmedMessage(st.progress) : outcome === "PUBLISHED" ? null : `Publishing stopped midway. ${posted ? `${posted} of ${st.frames} frames are posted.` : "Nothing was posted."}`;
    const done = status === "PUBLISHED" ? { publishedAt: new Date(), externalId: st.progress.find((f) => f.i === 0)?.mediaId ?? null, externalUrl: null } : {};
    const { count } = await tx.publicationAttempt.updateMany({ where: { id: a.id, status: "PUBLISHING" }, data: { status, error, ...done } });
    if (count !== 1) return;
    await tx.contentItem.update({ where: { id: a.contentItemId }, data: { status: status === "FAILED" ? "APPROVED" : status === "PUBLISHED" ? "PUBLISHED" : "SCHEDULED" } });
    await tx.auditEvent.create({
      data: { workspaceId: a.workspaceId, brandId: a.brandId, actorUserId: a.createdByUserId, action: `content.publish.${status.toLowerCase()}`, entityType: "PublicationAttempt", entityId: a.id, metadata: { lost: true, posted, total: st.frames } },
    });
  }, TX);
}

/** Cancel a scheduled post, or settle a PENDING_VERIFY one after someone looked at the account. */
export async function settlePublication(input: {
  workspaceId: string;
  brandId: string;
  userId: string;
  attemptId: string;
  action: "cancel" | "posted" | "not-posted";
  url?: string;
  /** When given, the attempt must belong to this content item (the one in the URL). */
  itemId?: string;
}) {
  const from = input.action === "cancel" ? "SCHEDULED" : "PENDING_VERIFY";
  const to = input.action === "posted" ? "PUBLISHED" : input.action === "cancel" ? "CANCELLED" : "FAILED";
  const a = await prisma.publicationAttempt.findFirst({
    where: { id: input.attemptId, workspaceId: input.workspaceId, brandId: input.brandId, ...(input.itemId ? { contentItemId: input.itemId } : {}) },
  });
  if (!a) throw new PublishingError("Not found", 404);
  const st = storyTargetOf(a.target);
  // A story is settled frame by frame (settleFrame): "it didn't post" could otherwise let posted frames go out again.
  if (st && input.action !== "cancel") throw new PublishingError("Say whether the unconfirmed frame appeared", 409, "story.settleFrame");
  // Cancelling Post the rest goes back to the partly posted story, not to an approved one that could post every frame again.
  if (st && postedCount(st.progress)) {
    const { count } = await prisma.publicationAttempt.updateMany({ where: { id: a.id, status: "SCHEDULED" }, data: { status: "PARTIAL" } });
    if (count !== 1) throw new PublishingError("It's no longer scheduled");
    await prisma.auditEvent.create({
      data: { workspaceId: a.workspaceId, brandId: a.brandId, actorUserId: input.userId, action: "content.publish.cancel", entityType: "PublicationAttempt", entityId: a.id, metadata: { posted: postedCount(st.progress), total: st.frames } },
    });
    return;
  }
  const externalUrl = input.url ? safeHttpUrl(input.url)?.href ?? null : null;
  const { count } = await prisma.publicationAttempt.updateMany({
    where: { id: a.id, status: from },
    data: { status: to, ...(to === "PUBLISHED" ? { publishedAt: new Date(), externalUrl, error: null } : {}), ...(to === "FAILED" ? { error: "Checked: it didn't post. You can publish again." } : {}) },
  });
  if (count !== 1) throw new PublishingError(input.action === "cancel" ? "It's no longer scheduled" : "This was already settled");
  await prisma.contentItem.update({ where: { id: a.contentItemId }, data: { status: to === "PUBLISHED" ? "PUBLISHED" : "APPROVED" } });
  await prisma.auditEvent.create({
    data: { workspaceId: a.workspaceId, brandId: a.brandId, actorUserId: input.userId, action: `content.publish.${input.action}`, entityType: "PublicationAttempt", entityId: a.id, metadata: {} },
  });
}

type AttemptRef = { workspaceId: string; brandId: string; userId: string; itemId: string; attemptId: string };

/** The item's story attempt, scoped to the brand and the item; 404 otherwise. Call under the item's lock. */
async function storyAttempt(tx: Prisma.TransactionClient, input: AttemptRef) {
  const a = await tx.publicationAttempt.findFirst({ where: { id: input.attemptId, workspaceId: input.workspaceId, brandId: input.brandId, contentItemId: input.itemId } });
  const st = storyTargetOf(a?.target);
  if (!a || !st) throw new PublishingError("Not found", 404);
  return { a, st };
}
const audit = (tx: Prisma.TransactionClient, input: AttemptRef, action: string, entityId: string, metadata: Prisma.InputJsonValue) =>
  tx.auditEvent.create({ data: { workspaceId: input.workspaceId, brandId: input.brandId, actorUserId: input.userId, action, entityType: "PublicationAttempt", entityId, metadata } });

/**
 * A person looked at the account: did the unconfirmed frame (0-based) appear? The attempt becomes PUBLISHED when that
 * was the last frame missing, PARTIAL when some are out, FAILED (item back to APPROVED) when none are.
 */
export async function settleFrame(input: AttemptRef & { frame: number; appeared: boolean }) {
  return prisma.$transaction(async (tx) => {
    await lock(tx, input.itemId);
    const { a, st } = await storyAttempt(tx, input);
    if (a.status !== "PENDING_VERIFY" || !st.progress.some((f) => f.i === input.frame && f.state === "publishing")) {
      throw new PublishingError("This frame was already settled. Reload the story.", 409, "story.alreadyHandled");
    }
    const progress = settleStoryFrame(st.progress, input.frame, input.appeared);
    const status = attemptOutcome(st.frames, progress);
    const posted = postedCount(progress);
    const { count } = await tx.publicationAttempt.updateMany({
      where: { id: a.id, status: "PENDING_VERIFY" },
      data: {
        status, target: { ...st, progress },
        // Frame 1's id; its link isn't known here (no token), so none rather than another frame's.
        ...(status === "PUBLISHED" ? { publishedAt: new Date(), externalId: progress.find((f) => f.i === 0)?.mediaId ?? a.externalId, externalUrl: null, error: null } : {}),
        ...(status === "PARTIAL" ? { error: `${posted} of ${st.frames} frames are posted.` } : {}),
        ...(status === "FAILED" ? { error: "Checked: it didn't post. You can publish again." } : {}),
      },
    });
    if (count !== 1) throw new PublishingError("This frame was already settled. Reload the story.", 409, "story.alreadyHandled");
    await tx.contentItem.update({ where: { id: a.contentItemId }, data: { status: status === "PUBLISHED" ? "PUBLISHED" : status === "PARTIAL" ? "SCHEDULED" : "APPROVED" } });
    await audit(tx, input, "content.publish.settle-frame", a.id, { frame: input.frame + 1, appeared: input.appeared, posted, total: st.frames });
  }, TX);
}

/**
 * Post the rest of a partly posted story: a new attempt carrying the frames that are out, which posts only the others
 * after the usual seal and product gate (executePublication). One PARTIAL attempt makes at most one: the first call
 * moves it to CANCELLED, so a second tap gets `story.alreadyHandled`. Frames over 24 h old have expired on Instagram:
 * the person confirms first.
 */
export async function postRest(input: AttemptRef & { confirm?: boolean }) {
  return prisma.$transaction(async (tx) => {
    await lock(tx, input.itemId);
    const { a, st } = await storyAttempt(tx, input);
    if (a.status !== "PARTIAL") throw new PublishingError("This was already handled. Reload the story.", 409, "story.alreadyHandled");
    const expired = expiredFrames(st.progress, new Date());
    if (expired > 0 && !input.confirm) {
      const left = st.frames - postedCount(st.progress);
      throw new PublishingError(`${expired === 1 ? "Frame 1 has" : `Frames 1–${expired} have`} expired. Posting the rest makes a story of ${left} frame${left === 1 ? "" : "s"}.`, 409, "story.expiredConfirm", { expiredFrames: expired, remainingFrames: left });
    }
    const { count } = await tx.publicationAttempt.updateMany({ where: { id: a.id, status: "PARTIAL" }, data: { status: "CANCELLED" } });
    if (count !== 1) throw new PublishingError("This was already handled. Reload the story.", 409, "story.alreadyHandled");
    const progress = st.progress.filter((f) => f.state === "published");
    const runAt = new Date();
    const next = await tx.publicationAttempt.create({
      data: {
        workspaceId: a.workspaceId, brandId: a.brandId, contentItemId: a.contentItemId, contentVersionId: a.contentVersionId, packageHash: a.packageHash,
        connectionId: a.connectionId, provider: a.provider, target: { story: true, frames: st.frames, progress } satisfies StoryTarget, runAt, createdByUserId: input.userId,
      },
    });
    await enqueueJob({ type: PUBLISH_JOB, workspaceId: a.workspaceId, brandId: a.brandId, payload: { attemptId: next.id }, runAt, maxAttempts: 1, idempotencyKey: `publish:${next.id}` }, tx);
    await audit(tx, input, "content.publish.post-rest", next.id, { from: a.id, posted: progress.length, total: st.frames, expired });
    return next;
  }, TX);
}

/** Leave a partly posted story as it is: the item counts as published, and the audit says how many frames went out. */
export async function markDone(input: AttemptRef) {
  return prisma.$transaction(async (tx) => {
    await lock(tx, input.itemId);
    const { a, st } = await storyAttempt(tx, input);
    const { count } = await tx.publicationAttempt.updateMany({ where: { id: a.id, status: "PARTIAL" }, data: { status: "CANCELLED" } });
    if (count !== 1) throw new PublishingError("This was already handled. Reload the story.", 409, "story.alreadyHandled");
    await tx.contentItem.update({ where: { id: a.contentItemId }, data: { status: "PUBLISHED" } });
    await audit(tx, input, "content.publish.partial-done", a.id, { posted: postedCount(st.progress), total: st.frames });
  }, TX);
}

/** Everything the post view needs: history, whether approval still holds, and where it can go. */
/**
 * `perms`: the caller's brand permissions. Someone without a name shows as their email's local part to people who
 * manage the project, else as "A team member"; the accounts to publish to go only to people who publish.
 */
export async function releaseState(scope: { workspaceId: string; brandId: string }, itemId: string, perms: ReadonlySet<string>) {
  const { item, latest } = await loadItem(scope, itemId);
  const [decisions, attempts, approval] = await Promise.all([
    prisma.approvalDecision.findMany({ where: { contentItemId: item.id }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.publicationAttempt.findMany({ where: { contentItemId: item.id }, orderBy: { createdAt: "desc" }, take: 20 }),
    currentApproval(item.id, latest, item.channel),
  ]);
  // A worker that died leaves PUBLISHING; after 10 min without a write, treat it as an unknown outcome. The job's lease
  // reclaim (onPublishJobLost) usually gets there first; this covers a queue nobody drains. A live publish can take
  // longer than 10 min (a slow reel polls its container for up to ~28 min), so this can catch one still running: its
  // beforePublish CAS then finds PENDING_VERIFY and it posts nothing, and the person checks the account and sees
  // nothing there. Safe, at the price of publishing that one again. ponytail: raise the 10 min if that happens often.
  for (const a of attempts) {
    if (a.status === "PUBLISHING" && Date.now() - a.updatedAt.getTime() > 10 * 60_000) {
      if (storyTargetOf(a.target)) {
        // A story is settled from its recorded frames (storyJobLost); read back what that decided.
        await storyJobLost(a.id);
        Object.assign(a, (await prisma.publicationAttempt.findFirst({ where: { id: a.id } })) ?? {});
        continue;
      }
      await prisma.publicationAttempt.updateMany({ where: { id: a.id, status: "PUBLISHING" }, data: { status: "PENDING_VERIFY", error: "Publishing stopped midway. Check the account before trying again." } });
      a.status = "PENDING_VERIFY";
    }
  }
  // Issues only matter while the post can still be approved, scheduled or published. Judged when it would go out:
  // the scheduled run, else as decide does.
  const gated = ["AWAITING_APPROVAL", "APPROVED", "SCHEDULED"].includes(item.status);
  const runAt = item.status === "SCHEDULED" ? attempts.find((a) => a.status === "SCHEDULED")?.runAt : undefined;
  const at = runAt ?? new Date(Math.max(Date.now(), item.scheduledFor?.getTime() ?? 0));
  const overrides = new Map(decisions.flatMap((d) => { const o = ProductOverride.safeParse(d.productOverride); return o.success ? [[d.id, o.data] as const] : []; }));
  const campaignIds = [item.campaignId, ...[...overrides.values()].flatMap((o) => o.offers ?? [])];
  const { issues: productIssues, linked, campaigns, timeZone } = gated
    ? await gateWithLinks(prisma, scope, { latest, approval, at }, campaignIds)
    : { issues: [], linked: [], ...(await campaignsById(prisma, scope, campaignIds)) };
  const req = publishRequirements(item.channel);
  const accounts = req.provider
    ? await prisma.integrationConnection.findMany({ where: { brandId: item.brandId, provider: req.provider, status: "ACTIVE" }, select: { id: true, displayName: true } })
    : [];
  const userIds = [...new Set([...decisions.map((d) => d.userId), ...attempts.map((a) => a.createdByUserId)])];
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } });
  // "approved anyway: <names>": the products each override listed, named as linkedProducts names them, then its ended offers.
  const productNames = new Map(linked.map((l) => [l.id, l.name]));
  const missing = [...new Set([...overrides.values()].flatMap((o) => o.productIds))].filter((id) => !productNames.has(id));
  for (const l of missing.length ? await linkedProducts(prisma, scope, missing) : []) productNames.set(l.id, l.name);
  const reveal = perms.has("project.members.manage");
  const who = (id: string) => {
    const u = users.find((x) => x.id === id);
    return u ? personName(u, { reveal }) : "Someone";
  };
  const accountName = new Map(accounts.map((a) => [a.id, a.displayName]));
  const overrideNames = (o: ProductOverride) => [...o.productIds.map((id) => productNames.get(id) ?? id), ...(o.offers ?? []).map((id) => `${campaigns.get(id)?.name ?? "an offer"} (offer ended)`)];
  const c = item.campaignId ? campaigns.get(item.campaignId) : undefined;
  return {
    latestVersion: latest?.version ?? null,
    byHand: item.byHand,
    postUrl: item.postUrl,
    scheduledFor: item.scheduledFor,
    approvedVersionId: approval?.contentVersionId ?? null,
    approvalValid: Boolean(approval),
    requirements: { ...req, studio: item.studio },
    // Where it can go: for people who publish (attempts below still name their account).
    accounts: perms.has("publish.execute") ? accounts : [],
    // An earlier approval of the same package (before an "approve anyway") still holds too.
    decisions: decisions.map((d) => ({
      id: d.id, verdict: d.verdict, note: d.note, by: who(d.userId), byClient: d.byClient, at: d.createdAt, current: d.verdict === "APPROVED" && d.packageHash === approval?.packageHash,
      version: d.contentVersionId === latest?.id ? latest.version : null, override: overrides.has(d.id) ? overrideNames(overrides.get(d.id)!) : null,
    })),
    attempts: attempts.map((a) => {
      // A story attempt also says which frames are out (0-based `i`), how many there are, and its refusal's code.
      const st = storyTargetOf(a.target);
      const story = st ? { frames: st.frames, progress: st.progress, code: st.errorCode ?? null } : {};
      return { id: a.id, status: a.status, provider: a.provider, account: accountName.get(a.connectionId) ?? "Disconnected account", runAt: a.runAt, publishedAt: a.publishedAt, externalUrl: a.externalUrl, error: a.error, by: who(a.createdByUserId), ...story };
    }),
    productIssues,
    // The post's campaign in brand time (`ends` null: a standing priority); null when it has none.
    campaign: c
      ? {
          kind: campaignKind(c), name: c.name, offer: c.offer, discountPercent: c.discountPercent, code: c.code,
          starts: wallTime(c.startsAt, timeZone), ends: c.endsAt ? wallTime(c.endsAt, timeZone) : null, timeZone, withdrawn: isWithdrawn(c),
        }
      : null,
  };
}
