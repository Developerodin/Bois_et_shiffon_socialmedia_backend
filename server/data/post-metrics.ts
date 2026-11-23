import { GRAPH, IG_GRAPH, THREADS_GRAPH } from "@/server/integrations/providers";

/**
 * Reads lifetime insights for published Instagram, Facebook and Threads posts. Pure: no database, no token refresh;
 * the caller (the data.sync job) picks the due posts, groups them by connection, gets each token with
 * `accessToken(conn)` and stores what comes back.
 *
 * Rules:
 * - One fixed metric list per provider. A metric the platform refuses (error 100) fails that post visibly
 *   (`reason: "error", code: 100`); nothing drops metrics and retries. Update the list when Meta retires one.
 * - Instagram and Facebook go through Graph batch requests, at most 50 posts per call. Threads has no batch
 *   endpoint, so one GET per post, in order.
 * - None of these calls is paged. Should one ever be, build the next page from the `after` cursor; never follow
 *   `paging.next` (it carries the token). URLs are never logged and error text is never the provider's.
 * - 190 / HTTP 401 → the connection stops with "reconnect"; a rate limit stops it with "rate_limited" and the posts
 *   not reached are listed in `unread` for the next run. A missing insights permission is a "permission" reason, never
 *   a throw, so it can't touch publishing or the connection's status. One connection stopping never stops the others.
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

export type PostReason = "permission" | "not_found" | "error";
export type StopReason = "reconnect" | "rate_limited" | "permission" | "error";

export type PostRead =
  | { attemptId: string; ok: true; metrics: PostMetrics }
  | { attemptId: string; ok: false; reason: PostReason; code: number | null };

export type ConnectionRead = {
  connectionId: string;
  provider: MetricsProvider;
  posts: PostRead[];
  /** Why the connection stopped early, or null when every post got an answer. */
  stopped: StopReason | null;
  /** Attempt ids not read this run (after a stop). */
  unread: string[];
};

// Checked against the Graph v23 / Threads v1.0 docs on 2026-11-23. Facebook's post_impressions* were retired in
// 2025; post_media_view / post_total_media_view_unique replace them.
export const IG_METRICS = ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions"] as const;
export const FB_FIELDS =
  "insights.metric(post_media_view,post_total_media_view_unique),reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares";
export const THREADS_METRICS = ["views", "likes", "replies", "reposts", "quotes", "shares"] as const;

export const BATCH_SIZE = 50;
const TIMEOUT_MS = 15_000;
const DAY = 86_400_000;

type Fetch = typeof fetch;
type GraphError = { code?: number; error_subcode?: number };
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

function classify(status: number, body: unknown): PostReason | StopReason | null {
  const e = (body as { error?: GraphError } | null)?.error;
  if (status < 400 && !e) return null;
  const code = e?.code;
  if (status === 401 || code === 190 || code === 102) return "reconnect";
  if (status === 429 || code === 4 || code === 17 || code === 32 || code === 613 || (code !== undefined && code >= 80001 && code <= 80014)) return "rate_limited";
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299) || status === 403) return "permission";
  if (code === 100 && e?.error_subcode === 33) return "not_found";
  return "error";
}
const codeOf = (body: unknown) => num((body as { error?: GraphError } | null)?.error?.code);

/** One HTTP call; never throws (network, timeout, bad JSON → status 0). */
async function send(f: Fetch, url: string, init?: RequestInit): Promise<Answer> {
  try {
    const res = await f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}

/** The answers for one chunk, in order: a Graph batch for IG/FB, one GET per post for Threads. */
async function readChunk(f: Fetch, c: ConnectionToRead, chunk: PostToRead[]): Promise<Answer | (Answer | null)[]> {
  if (c.provider === "THREADS") {
    const out: Answer[] = [];
    for (const p of chunk) {
      const a = await send(f, `${THREADS_GRAPH}/${encodeURIComponent(p.postId)}/insights?metric=${THREADS_METRICS.join(",")}&access_token=${encodeURIComponent(c.token)}`);
      out.push(a);
      const r = classify(a.status, a.body);
      if (r === "reconnect" || r === "rate_limited" || a.status === 0) break; // the rest stay unread
    }
    return out;
  }
  const rel = (id: string) =>
    c.provider === "INSTAGRAM" ? `${encodeURIComponent(id)}/insights?metric=${IG_METRICS.join(",")}` : `${encodeURIComponent(id)}?fields=${FB_FIELDS}`;
  // The token goes in the POST body, never in a URL.
  const body = new URLSearchParams({
    access_token: c.token,
    include_headers: "false",
    batch: JSON.stringify(chunk.map((p) => ({ method: "GET", relative_url: rel(p.postId) }))),
  });
  const res = await send(f, c.provider === "INSTAGRAM" ? IG_GRAPH : GRAPH, { method: "POST", body });
  if (res.status !== 200 || !Array.isArray(res.body)) return res; // the whole batch failed
  return (res.body as ({ code?: number; body?: string } | null)[]).map((item) => {
    if (!item || typeof item.code !== "number") return null; // Graph timed this one out
    let parsed: unknown = null;
    try { parsed = JSON.parse(item.body ?? "null"); } catch { /* unreadable → error */ }
    return { status: item.code, body: parsed };
  });
}

async function readConnection(f: Fetch, c: ConnectionToRead): Promise<ConnectionRead> {
  const out: ConnectionRead = { connectionId: c.connectionId, provider: c.provider, posts: [], stopped: null, unread: [] };
  for (let i = 0; i < c.posts.length; i += BATCH_SIZE) {
    const chunk = c.posts.slice(i, i + BATCH_SIZE);
    const answers = await readChunk(f, c, chunk);
    if (!Array.isArray(answers)) {
      const r = answers.status === 0 ? "error" : classify(answers.status, answers.body);
      out.stopped = r === "not_found" || r === null ? "error" : r;
      out.unread = c.posts.slice(i).map((p) => p.attemptId);
      break;
    }
    chunk.forEach((p, j) => {
      const a = answers[j];
      if (a === undefined) return out.unread.push(p.attemptId); // Threads stopped before this one
      if (a === null || a.status === 0) return out.posts.push({ attemptId: p.attemptId, ok: false, reason: "error", code: null });
      const r = classify(a.status, a.body);
      if (r === null && a.body && typeof a.body === "object") return out.posts.push({ attemptId: p.attemptId, ok: true, metrics: metricsFrom[c.provider](a.body as Record<string, unknown>) });
      if (r === "reconnect" || r === "rate_limited") {
        out.stopped ??= r;
        return out.unread.push(p.attemptId);
      }
      out.posts.push({ attemptId: p.attemptId, ok: false, reason: r ?? "error", code: codeOf(a.body) });
    });
    if (!out.stopped && answers.length < chunk.length) out.stopped = "error"; // Threads stopped on a network failure
    if (out.stopped) {
      out.unread.push(...c.posts.slice(i + BATCH_SIZE).map((p) => p.attemptId));
      break;
    }
  }
  const failed = out.posts.filter((p) => !p.ok).length;
  // One line per connection, ids and reasons only: no URL, no token, no provider text.
  if (out.stopped || failed) console.warn(`[post-metrics] ${c.provider} ${c.connectionId} stopped=${out.stopped ?? "no"} failed=${failed} unread=${out.unread.length}`);
  return out;
}

/** Reads every connection's posts, one connection after another; a stop on one never stops the others. */
export async function readPostMetrics(connections: ConnectionToRead[], opts: { fetch?: Fetch } = {}): Promise<ConnectionRead[]> {
  const f = opts.fetch ?? fetch;
  const out: ConnectionRead[] = [];
  for (const c of connections) out.push(await readConnection(f, c));
  return out;
}

/**
 * Whether a post's numbers should be read again: daily until day 7, every 3 days until day 14, weekly until day 30,
 * never after (the last read is final). A never-read post under 30 days is due. 6 h of slack so a daily job that
 * runs a little earlier than yesterday still counts the day.
 */
export function refreshDue(publishedAt: Date, lastReadAt: Date | null, now: Date): boolean {
  const age = (now.getTime() - publishedAt.getTime()) / DAY;
  if (age < 0 || age >= 30) return false;
  if (!lastReadAt) return true;
  const every = age < 7 ? 1 : age < 14 ? 3 : 7;
  return now.getTime() - lastReadAt.getTime() >= every * DAY - 6 * 3_600_000;
}
