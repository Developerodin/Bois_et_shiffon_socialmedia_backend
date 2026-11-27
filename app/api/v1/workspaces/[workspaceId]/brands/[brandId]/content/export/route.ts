import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { badExport as bad, csvResponse, exportAllowed, tooManyExports } from "@/server/api/csv-export";
import { prisma } from "@/server/db/prisma";
import { personName } from "@/server/content/person-name";
import { ContentChannel } from "@prisma/client";
import { channelSlug, channelsOf, isChannelGroup, toCsv } from "@/shared";

const DAY = 86_400_000;
// ponytail: posts past 5,000 in the range are silently dropped. Narrow ?from/?to, or say so (a "truncated" header) if
// brands get that big.
const MAX_ROWS = 5000;
const COLUMNS = ["Date", "Channel", "Status", "Title", "Owner", "Campaign", "Caption", "Post link"].map((label) => ({ key: label, label }));

/**
 * The calendar as CSV: posts scheduled in ?from..?to (default 90 days back to 90 ahead, at most 366 days), 5,000 rows,
 * cancelled posts left out. Posts with no date are not in the range, so they are not exported. ?channel= keeps one
 * channel or a channel group (meta, instagram), as the calendar's channel filter does; any other value is a 400.
 * Captions: the latest version of each post, in one query (never every version).
 */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "content.download");
    if (scope instanceof Response) return scope;
    const q = new URL(request.url).searchParams;
    const now = Date.now();
    const from = q.has("from") ? new Date(q.get("from")!) : new Date(now - 90 * DAY);
    const to = q.has("to") ? new Date(q.get("to")!) : new Date(now + 90 * DAY);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) return bad("from and to must be ISO dates, from before to");
    if (to.getTime() - from.getTime() > 366 * DAY) return bad("The range can be at most 366 days");
    const channel = q.get("channel");
    if (channel !== null && !isChannelGroup(channel) && !Object.hasOwn(ContentChannel, channel)) return bad("channel must be a channel or one of: meta, instagram");
    if (!(await exportAllowed(scope.userId))) return tooManyExports();
    const reveal = scope.perms.has("project.members.manage");
    const items = await prisma.contentItem.findMany({
      where: { workspaceId: scope.workspaceId, brandId: scope.brandId, status: { not: "CANCELLED" }, scheduledFor: { gte: from, lte: to }, ...(channel ? { channel: { in: channelsOf(channel) as ContentChannel[] } } : {}) },
      select: { id: true, title: true, channel: true, status: true, scheduledFor: true, postUrl: true, owner: { select: { name: true, email: true } }, campaign: { select: { name: true } } },
      orderBy: { scheduledFor: "asc" },
      take: MAX_ROWS,
    });
    const ids = items.map((i) => i.id);
    const captions = ids.length
      ? await prisma.$queryRaw<{ contentItemId: string; caption: string | null }[]>`
          SELECT DISTINCT ON ("contentItemId") "contentItemId", body->>'caption' AS caption
          FROM "ContentVersion" WHERE "contentItemId" = ANY(${ids})
          ORDER BY "contentItemId", version DESC`
      : [];
    const caption = new Map(captions.map((c) => [c.contentItemId, c.caption]));
    const csv = toCsv(
      COLUMNS,
      items.map((i) => ({
        Date: i.scheduledFor,
        Channel: i.channel,
        Status: i.status,
        Title: i.title,
        Owner: i.owner ? personName(i.owner, { reveal }) : "",
        Campaign: i.campaign?.name ?? "",
        Caption: caption.get(i.id) ?? "",
        "Post link": i.postUrl,
      })),
    );
    await prisma.auditEvent.create({
      data: { workspaceId: scope.workspaceId, brandId: scope.brandId, actorUserId: scope.userId, action: "content.export", entityType: "Brand", entityId: scope.brandId, metadata: { from: from.toISOString(), to: to.toISOString(), rows: items.length, ...(channel ? { channel } : {}) } },
    });
    return csvResponse(csv, `calendar-${channel ? `${channelSlug(channel)}-` : ""}${new Date(now).toISOString().slice(0, 10)}.csv`);
  } catch (error) {
    return fromAccessError(error);
  }
}
