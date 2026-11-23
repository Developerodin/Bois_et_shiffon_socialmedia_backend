import { GRAPH, IG_GRAPH, THREADS_GRAPH } from "@/server/integrations/providers";
import type { SyncStop } from "@/server/data/sync-stop";

/**
 * Reads lifetime insights for published Instagram, Facebook and Threads posts. Pure: no database, no token refresh;
 * the caller (the data.sync job) picks the due posts, groups them by connection, gets each token with
 * `accessToken(conn)` and stores what comes back.
 *
 * Rules:
 * - One fixed metric list per provider. When the platform refuses one metric (error 100 naming it), that metric is
 *   dropped for the rest of the connection's run (logged once), the refused posts are retried once without it, and the
 *   other metrics are saved (the dropped one is null). A refusal that names no metric fails the post visibly
 *   (`reason: "failed", code: 100`). Update the lists when Meta retires a metric.
 * - Facebook goes through Graph batch requests, at most 50 posts per call. Instagram (graph.instagram.com; batch
 *   there is unverified) and Threads (no batch endpoint) get one GET per post, in order. The token always rides in
 *   a header or the POST body, never in a URL.
 * - None of these calls is paged. Should one ever be, build the next page from the `after` cursor; never follow
 *   `paging.next` (it carries the token). URLs are never logged and error text is never the provider's.
 * - 190 / HTTP 401 → the connection stops with "reconnect"; a rate limit stops it with "rate_limited" and the posts
 *   not reached are listed in `unread` for the next run. A missing insights permission is a "permission" reason, never
 *   a throw, so it can't touch publishing or the connection's status. One connection stopping never stops the others.
 * - Facebook insights need the page-scoped post id ("pageId_postId"): see `hasFacebookPostId`.
 */

export type MetricsProvider = "INSTAGRAM" | "META" | "THREADS";

export type PostMetrics = {
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  interactions: number | null;
};

export type PostToRead = { attemptId: string; postId: string };
export type ConnectionToRead = { connectionId: string; provider: MetricsProvider; token: string; posts: PostToRead[] };

export type PostReason = "permission" | "not_found" | "failed";

export type PostRead =
  | { attemptId: string; ok: true; metrics: PostMetrics }
  | { attemptId: string; ok: false; reason: PostReason; code: number | null };

export type ConnectionRead = {
  connectionId: string;
  provider: MetricsProvider;
  posts: PostRead[];
  /** Why the connection stopped early; absent when every post got an answer. */
  stoppedReason?: SyncStop;
  /** Attempt ids not read this run (after a stop). */
  unread: string[];
};

// Checked against the Graph v23 / Threads v1.0 docs on 2026-11-23. Facebook's post_impressions* were retired in
// 2025; post_media_view / post_total_media_view_unique replace them.
export const IG_METRICS = ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions"] as const;
export const FB_METRICS = ["post_media_view", "post_total_media_view_unique"] as const;
const fbFields = (metrics: readonly string[]) =>
  `insights.metric(${metrics.join(",")}),reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares`;
export const FB_FIELDS = fbFields(FB_METRICS);
export const THREADS_METRICS = ["views", "likes", "replies", "reposts", "quotes", "shares"] as const;
const METRICS: Record<MetricsProvider, readonly string[]> = { INSTAGRAM: IG_METRICS, META: FB_METRICS, THREADS: THREADS_METRICS };

/**
 * Facebook insights only answer for a page-scoped post id ("pageId_postId"). Photo posts published before the
 * publisher kept `post_id` stored the bare photo id, so this rule skips them (they never get numbers).
 */
export const hasFacebookPostId = (externalId: string) => externalId.includes("_");

export const BATCH_SIZE = 50;
const TIMEOUT_MS = 15_000;

type Fetch = typeof fetch;
type Stop = () => boolean;
type GraphError = { code?: number; error_subcode?: number; message?: string };
type Insight = { name: string; values?: { value?: unknown }[]; total_value?: { value?: unknown } };
type Answer = { status: number; body: unknown };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const sum = (...xs: (number | null)[]) => (xs.every((x) => x !== null) ? xs.reduce<number>((a, x) => a + x!, 0) : null);

function insights(data: unknown): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const i of (Array.isArray(data) ? data : []) as Insight[]) out.set(i.name, num(i.total_value?.value ?? i.values?.[0]?.value));
  return out;
}

const metricsFrom: Record<MetricsProvider, (body: Record<string, unknown>) => PostMetrics> = {
  INSTAGRAM(body) {
    const m = insights(body.data);
    const g = (k: string) => m.get(k) ?? null;
    return { views: g("views"), reach: g("reach"), likes: g("likes"), comments: g("comments"), shares: g("shares"), saves: g("saved"), interactions: g("total_interactions") };
  },
  META(body) {
    const m = insights((body.insights as { data?: unknown } | undefined)?.data);
    const summary = (k: string) => num((body[k] as { summary?: { total_count?: unknown } } | undefined)?.summary?.total_count);
    const likes = summary("reactions");
    const comments = summary("comments");
    // Facebook leaves `shares` out when a post has none.
    const shares = body.shares === undefined ? 0 : num((body.shares as { count?: unknown }).count);
    return { views: m.get("post_media_view") ?? null, reach: m.get("post_total_media_view_unique") ?? null, likes, comments, shares, saves: null, interactions: sum(likes, comments, shares) };
  },
  THREADS(body) {
    const m = insights(body.data);
    const g = (k: string) => m.get(k) ?? null;
    const likes = g("likes"), replies = g("replies");
    // Reposts and quotes spread a thread like shares do; PostMetric has one shares column.
    const shares = sum(g("reposts"), g("quotes"), g("shares"));
    return { views: g("views"), reach: null, likes, comments: replies, shares, saves: null, interactions: sum(likes, replies, shares) };
  },
};

function classify(status: number, body: unknown): PostReason | "reconnect" | "rate_limited" | null {
  const e = (body as { error?: GraphError } | null)?.error;
  if (status < 400 && !e) return null;
  const code = e?.code;
  if (status === 401 || code === 190 || code === 102) return "reconnect";
  if (status === 429 || code === 4 || code === 17 || code === 32 || code === 613 || (code !== undefined && code >= 80001 && code <= 80014)) return "rate_limited";
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299) || status === 403) return "permission";
  if (code === 100 && e?.error_subcode === 33) return "not_found";
  return "failed";
}
const codeOf = (body: unknown) => num((body as { error?: GraphError } | null)?.error?.code);

/** The metric an error 100 refuses, by its `metric[i]` index or else by name; null when it names none we asked for. */
function refusedMetric(a: Answer | null | undefined, metrics: string[]): string | null {
  const e = (a?.body as { error?: GraphError } | null)?.error;
  if (e?.code !== 100 || e.error_subcode === 33 || metrics.length < 2) return null;
  const msg = String(e.message ?? "");
  const i = /metric\[(\d+)\]/.exec(msg);
  if (i) return metrics[Number(i[1])] ?? null;
  return [...metrics].sort((x, y) => y.length - x.length).find((m) => msg.includes(m)) ?? null;
}

/** One HTTP call; never throws (network, timeout, bad JSON → status 0). */
async function send(f: Fetch, url: string, init?: RequestInit): Promise<Answer> {
  try {
    const res = await f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}

/** The answers for one chunk, in order: a Graph batch for Facebook, one GET per post for Instagram and Threads. */
async function readChunk(f: Fetch, c: ConnectionToRead, chunk: PostToRead[], metrics: string[], stop: Stop): Promise<Answer | (Answer | null)[]> {
  if (c.provider !== "META") {
    const host = c.provider === "INSTAGRAM" ? IG_GRAPH : THREADS_GRAPH;
    const out: Answer[] = [];
    for (const p of chunk) {
      if (stop()) break; // the rest stay unread ("capped")
      const a = await send(f, `${host}/${encodeURIComponent(p.postId)}/insights?metric=${metrics.join(",")}`, { headers: { authorization: `Bearer ${c.token}` } });
      out.push(a);
      const r = classify(a.status, a.body);
      if (r === "reconnect" || r === "rate_limited" || a.status === 0) break; // the rest stay unread
    }
    return out;
  }
  // The token goes in the POST body, never in a URL.
  const body = new URLSearchParams({
    access_token: c.token,
    include_headers: "false",
    batch: JSON.stringify(chunk.map((p) => ({ method: "GET", relative_url: `${encodeURIComponent(p.postId)}?fields=${fbFields(metrics)}` }))),
  });
  const res = await send(f, GRAPH, { method: "POST", body });
  if (res.status !== 200 || !Array.isArray(res.body)) return res; // the whole batch failed
  return (res.body as ({ code?: number; body?: string } | null)[]).map((item) => {
    if (!item || typeof item.code !== "number") return null; // Graph timed this one out
    let parsed: unknown = null;
    try { parsed = JSON.parse(item.body ?? "null"); } catch { /* unreadable → error */ }
    return { status: item.code, body: parsed };
  });
}

async function readConnection(f: Fetch, c: ConnectionToRead, stop: Stop): Promise<ConnectionRead> {
  const out: ConnectionRead = { connectionId: c.connectionId, provider: c.provider, posts: [], unread: [] };
  const metrics = [...METRICS[c.provider]];
  for (let i = 0; i < c.posts.length; i += BATCH_SIZE) {
    const chunk = c.posts.slice(i, i + BATCH_SIZE);
    if (stop()) {
      out.stoppedReason = "capped";
      out.unread = c.posts.slice(i).map((p) => p.attemptId);
      break;
    }
    const answers = await readChunk(f, c, chunk, metrics, stop);
    if (!Array.isArray(answers)) {
      const r = answers.status === 0 ? "failed" : classify(answers.status, answers.body);
      out.stoppedReason = r === "not_found" || r === null ? "failed" : r;
      out.unread = c.posts.slice(i).map((p) => p.attemptId);
      break;
    }
    // A refused metric is dropped for the rest of this run, and the posts it failed are read once more without it.
    const refused = chunk.map((_, j) => j).filter((j) => refusedMetric(answers[j], metrics));
    if (refused.length) {
      // Names first: a `metric[i]` index points into the list as it was sent.
      for (const m of new Set(refused.map((j) => refusedMetric(answers[j], metrics)!))) {
        metrics.splice(metrics.indexOf(m), 1);
        console.warn(`[post-metrics] ${c.provider} ${c.connectionId} dropped metric ${m}`);
      }
      const again = await readChunk(f, c, refused.map((j) => chunk[j]), metrics, stop);
      refused.forEach((j, k) => (answers[j] = Array.isArray(again) ? again[k] : again));
    }
    chunk.forEach((p, j) => {
      const a = answers[j];
      if (a === undefined) return out.unread.push(p.attemptId); // Threads stopped before this one
      if (a === null || a.status === 0) return out.posts.push({ attemptId: p.attemptId, ok: false, reason: "failed", code: null });
      const r = classify(a.status, a.body);
      if (r === null && a.body && typeof a.body === "object") return out.posts.push({ attemptId: p.attemptId, ok: true, metrics: metricsFrom[c.provider](a.body as Record<string, unknown>) });
      if (r === "reconnect" || r === "rate_limited") {
        out.stoppedReason ??= r;
        return out.unread.push(p.attemptId);
      }
      out.posts.push({ attemptId: p.attemptId, ok: false, reason: r ?? "failed", code: codeOf(a.body) });
    });
    // A GET loop stopped early: on the run's time cap, or on a network failure.
    if (!out.stoppedReason && out.unread.length) out.stoppedReason = stop() ? "capped" : "failed";
    if (out.stoppedReason) {
      out.unread.push(...c.posts.slice(i + BATCH_SIZE).map((p) => p.attemptId));
      break;
    }
  }
  const failed = out.posts.filter((p) => !p.ok).length;
  // One line per connection, ids and reasons only: no URL, no token, no provider text.
  if (out.stoppedReason || failed) console.warn(`[post-metrics] ${c.provider} ${c.connectionId} stopped=${out.stoppedReason ?? "no"} failed=${failed} unread=${out.unread.length}`);
  return out;
}

/**
 * Reads every connection's posts, one connection after another; a stop on one never stops the others. `opts.stop`
 * (the run's deadline or time cap) is checked before each call: once true, what is left is unread with "capped".
 */
export async function readPostMetrics(connections: ConnectionToRead[], opts: { fetch?: Fetch; stop?: Stop } = {}): Promise<ConnectionRead[]> {
  const f = opts.fetch ?? fetch;
  const stop = opts.stop ?? (() => false);
  const out: ConnectionRead[] = [];
  for (const c of connections) out.push(await readConnection(f, c, stop));
  return out;
}
