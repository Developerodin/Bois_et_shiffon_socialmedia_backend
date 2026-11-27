import { ContentChannel } from "@prisma/client";
import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { prisma } from "@/server/db/prisma";
import { OPEN_STATUSES, STATUS_GROUPS } from "@/shared";

/** A dated post that can still go out: open, and not blocked. */
const UPCOMING = OPEN_STATUSES.filter((s) => s !== "BLOCKED");

/**
 * Per channel, for the Social & Content landing (web /social): how many posts wait for approval and the next planned
 * post (dated from now, open, not blocked), with its status so a dated draft reads differently from a scheduled post.
 * Every channel is listed, empty ones with 0 and null. Read straight from the table, not the calendar's 200-row
 * window, so many undated posts can't hide the dated ones.
 * ponytail: two reads: a groupBy, and the brand's open dated posts from now on (five columns) on the
 * (brandId, scheduledFor) index, the first per channel kept here. Fine at hundreds of future posts; past a few thousand
 * use one `DISTINCT ON (channel)` query with a (brandId, channel, scheduledFor) index.
 */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "brand.read");
    if (scope instanceof Response) return scope;
    const brand = { workspaceId: scope.workspaceId, brandId: scope.brandId };
    const now = new Date();
    const channels = Object.values(ContentChannel);
    const [awaiting, upcoming] = await Promise.all([
      prisma.contentItem.groupBy({ by: ["channel"], where: { ...brand, status: { in: [...STATUS_GROUPS.awaiting] } }, _count: { _all: true } }),
      prisma.contentItem.findMany({
        where: { ...brand, status: { in: [...UPCOMING] }, scheduledFor: { gte: now } },
        orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }],
        select: { id: true, title: true, scheduledFor: true, status: true, channel: true },
      }),
    ]);
    const counts = new Map(awaiting.map((g) => [g.channel, g._count._all]));
    // Sorted by date: the first row seen per channel is its next post.
    const first = new Map<string, { id: string; title: string; scheduledFor: Date | null; status: string }>();
    for (const { channel, ...post } of upcoming) if (!first.has(channel)) first.set(channel, post);
    return Response.json({ channels: channels.map((channel) => ({ channel, awaiting: counts.get(channel) ?? 0, next: first.get(channel) ?? null })) });
  } catch (error) {
    return fromAccessError(error);
  }
}
