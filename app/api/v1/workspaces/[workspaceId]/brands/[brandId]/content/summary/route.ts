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
 * ponytail: one groupBy plus one findFirst per channel (9) on the (brandId, scheduledFor) index; no channel index, so
 * each walks the brand's future dated posts in date order. Fine at hundreds; past that add (brandId, channel, scheduledFor).
 */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "brand.read");
    if (scope instanceof Response) return scope;
    const brand = { workspaceId: scope.workspaceId, brandId: scope.brandId };
    const now = new Date();
    const channels = Object.values(ContentChannel);
    const [awaiting, next] = await Promise.all([
      prisma.contentItem.groupBy({ by: ["channel"], where: { ...brand, status: { in: [...STATUS_GROUPS.awaiting] } }, _count: { _all: true } }),
      Promise.all(
        channels.map((channel) =>
          prisma.contentItem.findFirst({
            where: { ...brand, channel, status: { in: [...UPCOMING] }, scheduledFor: { gte: now } },
            orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }],
            select: { id: true, title: true, scheduledFor: true, status: true },
          }),
        ),
      ),
    ]);
    const counts = new Map(awaiting.map((g) => [g.channel, g._count._all]));
    return Response.json({ channels: channels.map((channel, n) => ({ channel, awaiting: counts.get(channel) ?? 0, next: next[n] })) });
  } catch (error) {
    return fromAccessError(error);
  }
}
