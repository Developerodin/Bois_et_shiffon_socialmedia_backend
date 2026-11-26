import type { DateRange, PostChannel, PostInsightDto } from "@/shared";
import { prisma } from "@/server/db/prisma";

/** The longest `?from&to` insights/posts accepts. */
export const POSTS_MAX_DAYS = 90;
/** ponytail: posts returned per request; a brand publishing more than this in 90 days sees its top ones by reach. */
export const MAX_POSTS = 500;
type Row = {
  attemptId: string; contentItemId: string; title: string; channel: PostChannel; publishedAt: Date; final: boolean;
  readAt: Date | null; views: number | null; reach: number | null; likes: number | null; comments: number | null;
  shares: number | null; saves: number | null; interactions: number | null; navigation: number | null;
};

/**
 * The brand's Instagram, Facebook and Threads posts published in the brand-local range, each with its latest read,
 * most reach first. The range's bounds are the brand's local midnights as instants. `stories`: Instagram stories too
 * (the Posts tab; read once, so final once read); the weekly digest's top posts leave them out.
 * ponytail: a story still PARTIAL (some frames never posted) has no publishedAt, so it isn't listed.
 */
export async function postsWithMetrics(scope: { workspaceId: string; brandId: string }, range: DateRange, now = new Date(), opts: { stories?: boolean } = {}): Promise<PostInsightDto[]> {
  const rows = await prisma.$queryRaw<Row[]>`
    WITH bp AS (SELECT COALESCE((SELECT "timeZone" FROM "BrandProfile" WHERE "workspaceId" = ${scope.workspaceId} AND "brandId" = ${scope.brandId} LIMIT 1), 'UTC') AS tz)
    SELECT a.id AS "attemptId", a."contentItemId", c.title, c.channel::text AS channel, a."publishedAt",
      (a."publishedAt" < (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC') - interval '30 days' OR (c.channel = 'INSTAGRAM_STORY' AND m."readAt" IS NOT NULL)) AS final,
      m."readAt", m.views, m.reach, m.likes, m.comments, m.shares, m.saves, m.interactions, m.navigation
    FROM "PublicationAttempt" a
    CROSS JOIN bp
    JOIN "ContentItem" c ON c.id = a."contentItemId" AND c."workspaceId" = a."workspaceId" AND c."brandId" = a."brandId"
    LEFT JOIN LATERAL (
      SELECT pm."readAt", pm.views, pm.reach, pm.likes, pm.comments, pm.shares, pm.saves, pm.interactions, pm.navigation
      FROM "PostMetric" pm WHERE pm."publicationAttemptId" = a.id AND pm."brandId" = a."brandId"
      ORDER BY pm.day DESC LIMIT 1
    ) m ON true
    WHERE a."workspaceId" = ${scope.workspaceId} AND a."brandId" = ${scope.brandId} AND a.status = 'PUBLISHED'
      AND a.provider IN ('INSTAGRAM', 'META', 'THREADS') AND (${!!opts.stories} OR c.channel <> 'INSTAGRAM_STORY')
      AND a."publishedAt" >= ((${range.from}::date)::timestamp AT TIME ZONE bp.tz) AT TIME ZONE 'UTC'
      AND a."publishedAt" < ((${range.to}::date + 1)::timestamp AT TIME ZONE bp.tz) AT TIME ZONE 'UTC'
    ORDER BY m.reach DESC NULLS LAST, a."publishedAt" DESC
    LIMIT ${MAX_POSTS}`;
  return rows.map((r) => ({
    attemptId: r.attemptId,
    contentItemId: r.contentItemId,
    title: r.title || null,
    channel: r.channel,
    publishedAt: r.publishedAt.toISOString(),
    metrics: r.readAt
      ? { views: r.views, reach: r.reach, likes: r.likes, comments: r.comments, shares: r.shares, saves: r.saves, interactions: r.interactions, navigation: r.navigation }
      : null,
    readAt: r.readAt ? r.readAt.toISOString() : null,
    final: r.final,
  }));
}
