import { z } from "zod";
import { prisma } from "@/server/db/prisma";
import { enqueueJob } from "@/server/jobs/queue";
import { accessToken } from "@/server/services/connections";
import { ReconnectNeeded } from "@/server/services/reconnect-needed";
import { storyTargetOf } from "@/server/services/publishing";
import { readPostMetrics, STORY_METRICS, type PostMetrics } from "./post-metrics";
import { upsertMetrics } from "./post-metric-sync";
import { brandTimeZone, spreadSecs, zoneToday } from "./sources";

/**
 * Instagram story numbers (plan 2026-11-26-phase-2-followup, Task 5). A story's frames disappear 24 h after they are
 * posted, so each story is read once, 20 h after its first frame (± 15 min, spread by attempt id), leaving 4 h of
 * slack. Its own job type `story.read`: a few seconds long and outside the two-runner data cap, so it never waits
 * behind 4-minute syncs; it never touches the POST_METRICS source, so a story's permission error can't put that
 * source in ERROR. Story numbers follow analytics.read like post numbers (client reviewers see them; owner, 2026-11-26).
 *
 * Ceiling: a worker down through the 20–24 h window, or frames posted after the read (Post the rest more than 20 h
 * later), leave no numbers, and nothing later can recover them. story.read jobs share the worker's
 * WORKER_CONCURRENCY slots with every other job type: a queue that stays full for 4 h would miss the window.
 */
export const STORY_READ_JOB = "story.read";
const READ_AFTER_MS = 20 * 3_600_000;
/** ± this around READ_AFTER_MS, from the attempt id, so stories posted at once don't read at once. */
const SPREAD_MS = 15 * 60_000;
/** The sweep catches stories whose first frame is at most this old (its read must still fit before 24 h). */
const CATCH_UP_MS = 23 * 3_600_000;
const MAX_FRAMES = 20;
/** Graph media ids are digits; anything else is never put in a URL. */
const MEDIA_ID = /^\d{1,30}$/;

type Frame = { i: number; mediaId: string };

/** The frames posted with a usable media id (a frame confirmed by a person has none), at most MAX_FRAMES. */
function readableFrames(target: unknown): Frame[] {
  const st = storyTargetOf(target);
  if (!st) return [];
  return st.progress
    .flatMap((f) => (f.state === "published" && typeof f.mediaId === "string" && MEDIA_ID.test(f.mediaId) ? [{ i: f.i, mediaId: f.mediaId }] : []))
    .slice(0, MAX_FRAMES);
}
/** When the story's first posted frame went out (frames confirmed by hand count too: they start the 24 h as well). */
function firstFrameAt(target: unknown): number | null {
  const st = storyTargetOf(target);
  const times = (st?.progress ?? []).filter((f) => f.state === "published" && f.at).map((f) => Date.parse(f.at!)).filter((t) => !Number.isNaN(t));
  return times.length ? Math.min(...times) : null;
}

/** When to read: first frame + 20 h, moved by up to ± 15 min from the attempt id; never in the past. */
export function storyReadAt(attemptId: string, firstAt: number, now = Date.now()) {
  const offset = ((spreadSecs(attemptId) * 1000) % (2 * SPREAD_MS)) - SPREAD_MS;
  return new Date(Math.max(now, firstAt + READ_AFTER_MS + offset));
}

/**
 * Queues the story's one read (key `story:<attemptId>`, so every settle path and the sweep can call it). Only for an
 * Instagram story attempt that is PUBLISHED or PARTIAL with a frame posted under 24 h ago. Never throws: a failed
 * enqueue is logged and left to the daily sweep.
 */
export async function enqueueStoryRead(attemptId: string, now = Date.now()) {
  try {
    const a = await prisma.publicationAttempt.findUnique({ where: { id: attemptId }, select: { id: true, workspaceId: true, brandId: true, provider: true, status: true, target: true } });
    if (!a || a.provider !== "INSTAGRAM" || (a.status !== "PUBLISHED" && a.status !== "PARTIAL")) return null;
    const first = firstFrameAt(a.target);
    if (first === null || now - first >= 24 * 3_600_000) return null;
    return await enqueueJob({
      type: STORY_READ_JOB,
      workspaceId: a.workspaceId,
      brandId: a.brandId,
      payload: { attemptId: a.id, workspaceId: a.workspaceId, brandId: a.brandId },
      runAt: storyReadAt(a.id, first, now),
      maxAttempts: 2,
      idempotencyKey: `story:${a.id}`,
    });
  } catch (e) {
    console.error("[story-metrics] couldn't queue the story read; the daily sweep tries again", attemptId, e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Daily sweep step: Instagram stories whose first frame went out 0–23 h ago and have no story.read job (exact key
 * match on the unique index) get one, at max(now, first frame + 20 h). The publish paths are the main way; the sweep
 * runs once a day, so it only catches what they missed within that window.
 * ponytail: scans attempts updated in the last day (no partial index; the query runs once a day). Past ~1M attempts
 * add a plain index on ("updatedAt") in a migration (never CONCURRENTLY inside one).
 */
export async function enqueueMissedStoryReads(now = new Date()) {
  const since = new Date(now.getTime() - 24 * 3_600_000);
  const rows = await prisma.$queryRaw<{ id: string; target: unknown }[]>`
    SELECT a.id, a.target FROM "PublicationAttempt" a
    JOIN "ContentItem" c ON c.id = a."contentItemId" AND c."workspaceId" = a."workspaceId" AND c."brandId" = a."brandId"
    WHERE a.status IN ('PUBLISHED', 'PARTIAL') AND a.provider = 'INSTAGRAM' AND c.channel = 'INSTAGRAM_STORY'
      AND a."updatedAt" >= (${since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      AND NOT EXISTS (SELECT 1 FROM "Job" j WHERE j."idempotencyKey" = 'story:' || a.id)`;
  let queued = 0;
  for (const r of rows) {
    const first = firstFrameAt(r.target);
    if (first === null || now.getTime() - first > CATCH_UP_MS) continue;
    if (await enqueueStoryRead(r.id, now.getTime())) queued++;
  }
  return queued;
}

const Payload = z.object({ attemptId: z.string(), workspaceId: z.string(), brandId: z.string() });
const total = (xs: (number | null | undefined)[]) => {
  const known = xs.filter((x): x is number => typeof x === "number");
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
};

/**
 * story.read: reads every frame with a media id (one GET each on graph.instagram.com, token in a header), sums the
 * frames' views, replies, shares, interactions and navigation, and takes the highest frame's reach (people overlap),
 * as one PostMetric row. A frame already gone is skipped and the others saved. Loaded by id and the payload's
 * workspace and brand, its connection by the same: any mismatch is a no-op.
 */
export async function runStoryRead(payload: unknown) {
  const p = Payload.parse(payload);
  const a = await prisma.publicationAttempt.findFirst({
    where: { id: p.attemptId, workspaceId: p.workspaceId, brandId: p.brandId, provider: "INSTAGRAM", status: { in: ["PUBLISHED", "PARTIAL"] }, item: { channel: "INSTAGRAM_STORY" } },
    select: { id: true, workspaceId: true, brandId: true, connectionId: true, target: true },
  });
  if (!a) return void console.warn("[story-metrics] no such story attempt for this brand; nothing read", p.attemptId);
  const conn = await prisma.integrationConnection.findFirst({ where: { id: a.connectionId, workspaceId: a.workspaceId, brandId: a.brandId, provider: "INSTAGRAM", status: "ACTIVE" } });
  if (!conn) return void console.warn("[story-metrics] the story's connection is gone or another brand's; nothing read", a.id);
  const frames = readableFrames(a.target);
  if (!frames.length) return;
  let token: string;
  try {
    token = await accessToken(conn);
  } catch (e) {
    if (e instanceof ReconnectNeeded) return void console.warn("[story-metrics] connection needs reconnecting; story not read", a.id);
    throw e;
  }
  const [read] = await readPostMetrics([{ connectionId: conn.id, provider: "INSTAGRAM", token, metrics: STORY_METRICS, posts: frames.map((f) => ({ attemptId: `${a.id}:${f.i}`, postId: f.mediaId })) }]);
  const ok = read.posts.flatMap((r) => (r.ok ? [r.metrics] : []));
  const refused = read.posts.filter((r) => !r.ok && r.reason === "permission").length;
  // Logged with the provider and ids only; the connection and the POST_METRICS source are left alone.
  if (refused || read.stoppedReason) console.warn("[story-metrics] INSTAGRAM story read incomplete", a.id, `permission=${refused}`, `stopped=${read.stoppedReason ?? "no"}`);
  if (!ok.length) return;
  const metrics: PostMetrics = {
    views: total(ok.map((m) => m.views)),
    reach: ok.reduce<number | null>((max, m) => (m.reach === null ? max : Math.max(max ?? 0, m.reach)), null),
    likes: null,
    comments: total(ok.map((m) => m.comments)),
    shares: total(ok.map((m) => m.shares)),
    saves: null,
    interactions: total(ok.map((m) => m.interactions)),
    navigation: total(ok.map((m) => m.navigation)),
  };
  const scope = { workspaceId: a.workspaceId, brandId: a.brandId };
  const now = new Date();
  await upsertMetrics(scope, zoneToday(await brandTimeZone(scope), now), now, [{ attemptId: a.id, metrics }]);
}
