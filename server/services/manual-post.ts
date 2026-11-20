import type { ContentChannel } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { checkStoryLink } from "@/server/stories/by-hand";
import { currentApproval, lock, productGate, PublishingError, TX } from "@/server/services/publishing";

const MAX_LINK = 300;
const NAME = "[A-Za-z0-9._-]{1,100}";
const ID = "[A-Za-z0-9_-]{1,100}";

/**
 * The one place that says which addresses count as a post's link: https only, no login details or port, a host from the
 * channel's list, a path of the channel's own post shape. Every pattern is anchored and has no nested repeats.
 */
const LINKS: Partial<Record<ContentChannel, { host: RegExp; path: RegExp; hint: string }>> = {
  INSTAGRAM_POST: { host: /^(www\.)?instagram\.com$/, path: new RegExp(`^/(reel|reels|p)/${ID}/?$`), hint: "instagram.com/p/…" },
  INSTAGRAM_CAROUSEL: { host: /^(www\.)?instagram\.com$/, path: new RegExp(`^/(reel|reels|p)/${ID}/?$`), hint: "instagram.com/p/…" },
  INSTAGRAM_REEL: { host: /^(www\.)?instagram\.com$/, path: new RegExp(`^/(reel|reels|p)/${ID}/?$`), hint: "instagram.com/reel/…" },
  FACEBOOK_POST: {
    host: /^(www\.|m\.)?facebook\.com$/,
    path: new RegExp(`^/(${NAME}/(posts|videos|photos|reels)/${ID}|share/[pvr]/${ID}|reel/[0-9]{5,25})/?$`),
    hint: "facebook.com/<page>/posts/…",
  },
  PINTEREST_PIN: { host: /^((www|[a-z]{2})\.)?pinterest\.com$|^pin\.it$/, path: /^(\/pin\/[A-Za-z0-9_-]{1,100}\/?|\/[A-Za-z0-9]{3,20})$/, hint: "pinterest.com/pin/…" },
  THREADS_POST: { host: /^(www\.)?threads\.(net|com)$/, path: new RegExp(`^/(@${NAME}/post/${ID}|t/${ID})/?$`), hint: "threads.net/@…/post/…" },
};

/** The normalised link (`origin + pathname`, nothing after) for a post's channel, or null when it isn't a post link there. */
export function postLinkFor(channel: ContentChannel, url: string): string | null {
  const rule = LINKS[channel];
  if (!rule || url.length > MAX_LINK) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port || !rule.host.test(u.hostname) || !rule.path.test(u.pathname)) return null;
  // Pinterest's short links (pin.it/abc) have their own path shape; pinterest.com needs /pin/.
  if (u.hostname === "pin.it" ? u.pathname.startsWith("/pin/") : channel === "PINTEREST_PIN" && !u.pathname.startsWith("/pin/")) return null;
  return u.origin + u.pathname;
}

/**
 * Someone posted an approved post by hand and says so. Any channel: it must still be approved with its approval holding,
 * no attempt may be live, and (except a studio reel, approved when downloaded) no product or offer issue may refuse it.
 * The link is optional, except a studio reel's (its results are followed from it). A story's is checked by checkStoryLink.
 */
export async function registerManualPost(scope: { workspaceId: string; brandId: string; userId: string }, itemId: string, url: string | undefined) {
  const raw = url?.trim();
  // A story's link is checked against the brand's Instagram account before the transaction: it reads with the global
  // client, which must never wait inside a transaction holding the pool's connection. A post's channel never changes.
  const storyLink = raw && (await prisma.contentItem.findFirst({ where: { id: itemId, workspaceId: scope.workspaceId, brandId: scope.brandId }, select: { channel: true } }))?.channel === "INSTAGRAM_STORY"
    ? await checkStoryLink(scope, raw)
    : undefined;
  await prisma.$transaction(async (tx) => {
    await lock(tx, itemId);
    const item = await tx.contentItem.findFirst({
      where: { id: itemId, workspaceId: scope.workspaceId, brandId: scope.brandId },
      include: { versions: { orderBy: { version: "desc" }, take: 1, include: { checks: { orderBy: { createdAt: "desc" }, take: 1 } } } },
    });
    if (!item) throw new PublishingError("Post not found", 404);
    const story = item.channel === "INSTAGRAM_STORY";
    const code = (c: string) => (story ? c : undefined);
    const noun = story ? "story" : item.studio ? "reel" : "post";
    let link: string | undefined;
    if (story) link = storyLink;
    else if (raw) {
      link = postLinkFor(item.channel, raw) ?? undefined;
      if (!link) throw new PublishingError(`Paste the link of the post itself (${LINKS[item.channel]?.hint ?? "its address"})`, 400);
    } else if (item.studio) throw new PublishingError("Paste the link of the Instagram post (instagram.com/reel/…)", 400);
    if (item.status === "SCHEDULED") throw new PublishingError(`This ${noun} is scheduled to post by itself. Cancel that first.`, 409, code("story.cancelScheduledFirst"));
    if (item.status !== "APPROVED") throw new PublishingError(item.studio ? "Download the reel first, then add its link." : `Approve the ${noun} first.`, 409, code("story.notApproved"));
    const latest = item.versions[0] ?? null;
    const approval = await currentApproval(item.id, latest, item.channel, tx);
    if (!approval) throw new PublishingError("The approval no longer holds. Review the latest version.", 409, code("story.notApproved"));
    // A studio reel is approved by downloading it; a product going out of stock later doesn't undo a post already made.
    if (!item.studio) {
      const refused = (await productGate(tx, scope, { latest, approval, at: new Date() })).find((i) => i.refuses);
      if (refused) throw new PublishingError(refused.message, 409, code("story.gate"));
    }
    const live = await tx.publicationAttempt.findFirst({ where: { contentItemId: item.id, status: { in: ["SCHEDULED", "PUBLISHING", "PENDING_VERIFY", "PARTIAL"] } }, select: { id: true } });
    if (live) throw new PublishingError(`This ${noun} is being posted or its result is still unconfirmed. Settle that first.`, 409, code("story.cancelScheduledFirst"));
    await tx.contentItem.update({ where: { id: itemId }, data: { status: "PUBLISHED", byHand: false, ...(link ? { postUrl: link } : {}) } });
    await tx.auditEvent.create({
      data: { workspaceId: scope.workspaceId, brandId: scope.brandId, actorUserId: scope.userId, action: "content.publish.manual", entityType: "ContentItem", entityId: itemId, metadata: story ? { kind: "story", ...(link ? { url: link } : {}) } : { channel: item.channel, ...(link ? { url: link } : {}) } },
    });
  }, TX);
}
