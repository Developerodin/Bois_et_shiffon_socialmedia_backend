import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { accessToken, markReconnect, ReconnectNeeded } from "@/server/services/connections";
import { readPostMetrics, type ConnectionToRead, type MetricsProvider, type PostMetrics } from "./post-metrics";
import { brandTimeZone, registerSync, stopReason, zoneToday, type SyncContext, type SyncOutcome } from "./sources";
import type { SyncStop } from "./sync-stop";

/**
 * The POST_METRICS runner (plan Task 4b): one source per brand, connection null, so each due post's own connection is
 * loaded here (same brand, ACTIVE). Picks due posts in SQL with the decay below, reads them with post-metrics.ts and
 * upserts one PostMetric row per post per brand-local day, so a repeated run on the same day rewrites the same row.
 * Posts past day 30 keep only their final row.
 */

/** Read again every `every` days while the post is younger than `before` days; never after the last band. */
export const DECAY = [{ before: 7, every: 1 }, { before: 14, every: 3 }, { before: 30, every: 7 }] as const;
const LAST_DAY = DECAY[DECAY.length - 1].before;
/** ponytail: due posts read per brand per run. Oldest read first, so a brand over this catches up the next days. */
export const DUE_LIMIT = 500;
const PRUNE_BATCH = 1000;
const PRUNE_ROUNDS = 10;
/** Reading stops this long into a run (below the job's 240 s deadline) and writes what it read ("capped"). */
const READ_MS = 150_000;
/** Instagram and Threads cost one GET per post: at most this many per connection per run; the rest go next run. */
export const PER_POST_LIMIT = 200;

/** `now` as the naive UTC timestamp Prisma's timestamp(3) columns hold. */
const utc = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/**
 * The decay as SQL over attempt `a` and its last read `m."readAt"`: younger than day 30, and never read or last read
 * at least its band's interval ago (6 h of slack, so a run a little earlier than yesterday's still counts the day).
 */
export function dueSql(now: Date) {
  const age = Prisma.sql`(${utc(now)} - a."publishedAt")`;
  const every = Prisma.join(DECAY.map((d) => Prisma.sql`WHEN ${age} < make_interval(days => ${d.before}::int) THEN ${d.every}::int`), " ");
  // The plain publishedAt bound lets the index seek; the age CASE below then picks the band.
  return Prisma.sql`a."publishedAt" <= ${utc(now)} AND a."publishedAt" > ${utc(now)} - make_interval(days => ${LAST_DAY}::int)
    AND (m."readAt" IS NULL OR m."readAt" <= ${utc(now)} - make_interval(days => CASE ${every} END) + interval '6 hours')`;
}

type Due = { id: string; connectionId: string; provider: MetricsProvider; externalId: string };

/** The brand's posts due a read, oldest read first (never read before anything). Stories have no lasting numbers. */
export function duePosts(scope: { workspaceId: string; brandId: string }, now: Date, limit = DUE_LIMIT) {
  return prisma.$queryRaw<Due[]>`
    SELECT a.id, a."connectionId", a.provider::text AS provider, a."externalId"
    FROM "PublicationAttempt" a
    JOIN "ContentItem" c ON c.id = a."contentItemId"
    JOIN "IntegrationConnection" ic ON ic.id = a."connectionId" AND ic."workspaceId" = a."workspaceId" AND ic."brandId" = a."brandId" AND ic.status = 'ACTIVE'
    LEFT JOIN LATERAL (SELECT max(pm."readAt") AS "readAt" FROM "PostMetric" pm WHERE pm."publicationAttemptId" = a.id) m ON true
    WHERE a."workspaceId" = ${scope.workspaceId} AND a."brandId" = ${scope.brandId}
      AND a.status = 'PUBLISHED' AND a.provider IN ('INSTAGRAM', 'META', 'THREADS') AND c.channel <> 'INSTAGRAM_STORY'
      AND a."externalId" IS NOT NULL
      -- A Facebook page post id is "<pageId>_<postId>"; a bare photo id has no post insights.
      -- Same rule as hasFacebookPostId in post-metrics.ts.
      AND (a.provider <> 'META' OR strpos(a."externalId", '_') > 0)
      AND ${dueSql(now)}
    ORDER BY m."readAt" ASC NULLS FIRST, a."publishedAt" ASC
    LIMIT ${limit}`;
}

/** One row per post per day: a second read the same day replaces the first. */
export async function upsertMetrics(scope: { workspaceId: string; brandId: string }, day: string, readAt: Date, rows: { attemptId: string; metrics: PostMetrics }[]) {
  if (!rows.length) return 0;
  const col = (k: keyof PostMetrics) => rows.map((r) => r.metrics[k]);
  return prisma.$executeRaw`
    INSERT INTO "PostMetric" (id, "workspaceId", "brandId", "publicationAttemptId", day, "readAt", reach, views, likes, comments, shares, saves, interactions)
    SELECT u.id, ${scope.workspaceId}, ${scope.brandId}, u.aid, ${day}::date, ${utc(readAt)}, u.reach, u.views, u.likes, u.comments, u.shares, u.saves, u.interactions
    FROM unnest(${rows.map(() => randomUUID())}::text[], ${rows.map((r) => r.attemptId)}::text[], ${col("reach")}::int[], ${col("views")}::int[],
      ${col("likes")}::int[], ${col("comments")}::int[], ${col("shares")}::int[], ${col("saves")}::int[], ${col("interactions")}::int[])
      AS u(id, aid, reach, views, likes, comments, shares, saves, interactions)
    ON CONFLICT ("publicationAttemptId", day) DO UPDATE SET "readAt" = EXCLUDED."readAt", reach = EXCLUDED.reach, views = EXCLUDED.views,
      likes = EXCLUDED.likes, comments = EXCLUDED.comments, shares = EXCLUDED.shares, saves = EXCLUDED.saves, interactions = EXCLUDED.interactions`;
}

/**
 * Posts past day 30 keep only their final (latest-day) row; earlier rows go in batches.
 * ponytail: at most PRUNE_ROUNDS × PRUNE_BATCH rows a run; the rest go on the next day's run.
 */
export async function pruneFinal(scope: { workspaceId: string; brandId: string }, now: Date) {
  let total = 0;
  for (let i = 0; i < PRUNE_ROUNDS; i++) {
    const n = await prisma.$executeRaw`
      DELETE FROM "PostMetric" WHERE id IN (
        SELECT pm.id FROM "PostMetric" pm JOIN "PublicationAttempt" a ON a.id = pm."publicationAttemptId"
        WHERE pm."workspaceId" = ${scope.workspaceId} AND pm."brandId" = ${scope.brandId}
          AND a."publishedAt" < ${utc(now)} - make_interval(days => ${LAST_DAY}::int)
          -- Only attempts that crossed day 30 lately: older ones were pruned on the runs since.
          AND a."publishedAt" >= ${utc(now)} - make_interval(days => ${LAST_DAY + 10}::int)
          AND pm.day < (SELECT max(f.day) FROM "PostMetric" f WHERE f."publicationAttemptId" = pm."publicationAttemptId")
        LIMIT ${PRUNE_BATCH})`;
    total += n;
    if (n < PRUNE_BATCH) break;
  }
  return total;
}

const WORST: SyncStop[] = ["permission", "missing_scope", "rate_limited", "capped", "failed"];
/**
 * The worst stop across connections, as the run's reason (a reconnect skips that connection's posts only). One
 * connection failing is partial for the brand (the others were written), so it counts as capped, not a throw.
 */
function outcomeReason(stops: SyncStop[]): SyncOutcome["reason"] {
  const worst = WORST.find((s) => stops.includes(s));
  return stopReason(worst === "failed" ? "capped" : worst);
}

export async function syncPostMetrics(ctx: Pick<SyncContext, "source"> & { signal?: AbortSignal }, now = new Date()): Promise<SyncOutcome> {
  const scope = { workspaceId: ctx.source.workspaceId, brandId: ctx.source.brandId };
  const due = await duePosts(scope, now);
  const byConnection = new Map<string, Due[]>();
  for (const d of due) byConnection.set(d.connectionId, [...(byConnection.get(d.connectionId) ?? []), d]);

  const connections = await prisma.integrationConnection.findMany({ where: { id: { in: [...byConnection.keys()] }, ...scope, status: "ACTIVE" } });
  const toRead: ConnectionToRead[] = [];
  const stops: SyncStop[] = [];
  for (const conn of connections) {
    let token: string;
    try {
      token = await accessToken(conn);
    } catch (e) {
      if (!(e instanceof ReconnectNeeded)) throw e;
      console.warn("[post-metrics] connection needs reconnecting; its posts skipped", conn.id);
      continue;
    }
    const due = byConnection.get(conn.id)!;
    const posts = due[0].provider === "META" ? due : due.slice(0, PER_POST_LIMIT);
    if (posts.length < due.length) stops.push("capped");
    toRead.push({ connectionId: conn.id, provider: posts[0].provider, token, posts: posts.map((p) => ({ attemptId: p.id, postId: p.externalId })) });
  }

  const stopAt = Date.now() + READ_MS;
  const results = toRead.length ? await readPostMetrics(toRead, { stop: () => !!ctx.signal?.aborted || Date.now() > stopAt }) : [];
  const rows: { attemptId: string; metrics: PostMetrics }[] = [];
  for (const r of results) {
    const stop = r.stoppedReason;
    // A refused token (190 / 401) is the connection's own state: Connections shows it; the other connections go on.
    if (stop === "reconnect") {
      const conn = connections.find((c) => c.id === r.connectionId);
      if (conn) await markReconnect(conn.id, `Access expired. Reconnect ${conn.displayName}.`);
    } else if (stop) stops.push(stop);
    for (const p of r.posts) {
      if (p.ok) rows.push({ attemptId: p.attemptId, metrics: p.metrics });
      else if (p.reason === "permission") stops.push("permission");
    }
  }

  const count = await upsertMetrics(scope, zoneToday(await brandTimeZone(scope), now), now, rows);
  await pruneFinal(scope, now);
  return { count, reason: outcomeReason(stops) };
}

registerSync("POST_METRICS", (ctx) => syncPostMetrics(ctx));

/**
 * Daily sweep step, before the data step queues runs: one POST_METRICS source per brand that has a post published to
 * Instagram, Facebook or Threads. Creates missing ones only; an existing (or switched-off) source is left as it is.
 * ponytail: one grouped scan of published attempts (index brandId, status, publishedAt); fine to tens of thousands.
 */
export async function ensurePostMetricSources() {
  const brands = await prisma.publicationAttempt.groupBy({
    by: ["workspaceId", "brandId"],
    where: { status: "PUBLISHED", provider: { in: ["INSTAGRAM", "META", "THREADS"] } },
  });
  if (!brands.length) return 0;
  const { count } = await prisma.dataSource.createMany({
    data: brands.map((b) => ({ workspaceId: b.workspaceId, brandId: b.brandId, kind: "POST_METRICS" as const, externalId: "" })),
    skipDuplicates: true,
  });
  return count;
}
