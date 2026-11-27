import type { IntegrationConnection } from "@prisma/client";
import type { AnalyticsChannel, ChannelAnalyticsDto, ChannelDayDto, ChannelPostDto } from "@/shared";
import { prisma } from "@/server/db/prisma";
import { GRAPH, IG_GRAPH, THREADS_GRAPH } from "@/server/integrations/providers";
import { accessToken, markReconnect, ReconnectNeeded } from "@/server/services/connections";
import { classify, insights, readPostMetrics, refusedMetric, send, type Answer } from "./post-metrics";

/**
 * A channel's own account numbers, read live from Meta for the channel's calendar: the Instagram account (Instagram
 * Login token, graph.instagram.com) or the Facebook Page (page token, graph.facebook.com). Account summary, period
 * totals, daily series, new followers, and for Instagram its top countries and latest posts (posted through the app
 * or not). Pure reading in `readChannelAnalytics` (fetch injectable); `channelAnalytics` adds the connection, token
 * and cache.
 *
 * Rules (same as post-metrics.ts): the token rides in the Authorization header, never a URL; URLs, provider error text
 * and Meta's own (localized) metric titles are never logged or returned. A metric refused with error 100 is dropped
 * and the call retried without it (that number is null). Instagram's "not enough viewers" and any other refusal → null.
 * A timeout (15 s per call) or rate limit → null and `partial`. 190 / 401 → the connection is marked "Needs reconnect".
 * Facebook per-post numbers need pages_read_user_content (app review), so only Instagram lists posts.
 *
 * Pinterest (api.pinterest.com/v5, user_accounts:read + pins:read) and Threads (graph.threads.net, threads_basic +
 * threads_manage_insights) follow the same rules: 401 → reconnect, 429 → partial, any other refusal → null. Pinterest's
 * errors are `{ code, message }` at the top level, so only the HTTP status classifies them.
 */

type Fetch = typeof fetch;
const DAY_MS = 86_400_000;
export const MAX_DAYS = 30; // Instagram refuses a since/until span over 30 days; follower_count keeps 30 days only.
export const DEFAULT_DAYS = 28;
export const POST_LIMIT = 12;
/** Posts' insight reads stop being started this long into a request; the rest come back without numbers. */
const POSTS_MS = 20_000;

const IG_TOTALS: Record<string, string> = {
  reach: "reach", views: "views", accounts_engaged: "accountsEngaged", total_interactions: "interactions", likes: "likes",
  comments: "comments", shares: "shares", saves: "saves", profile_links_taps: "linkTaps",
};
const FB_METRICS = ["page_media_view", "page_post_engagements", "page_daily_follows_unique", "page_views_total"];
export const PINTEREST_API = "https://api.pinterest.com/v5";
const PIN_TOTALS: Record<string, string> = { IMPRESSION: "impressions", SAVE: "saves", PIN_CLICK: "pinClicks", OUTBOUND_CLICK: "outboundClicks", ENGAGEMENT: "engagements" };
/** Pinterest's top pins asked for: the most seen over the period. */
const TOP_PINS = 5;
/** Threads' totals (views is a daily series, the rest total_value); followers_count refuses since/until, so it's asked alone. */
const THREADS_TOTALS: Record<string, string> = { likes: "likes", replies: "comments", reposts: "shares", quotes: "quotes" };

type Series = { name?: string; values?: { value?: unknown; end_time?: string }[] }[];
type Read = { body: ChannelAnalyticsDto; reconnect: boolean };
export type ReadInput = { channel: AnalyticsChannel; token: string; pageId: string; name: string; days: number; now?: Date; fetch?: Fetch };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The whole UTC days before today: [since, until) in unix seconds, and their first and last day. */
export function period(days: number, now: Date) {
  const until = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const since = until - days * DAY_MS;
  return { since: since / 1000, until: until / 1000, from: ymd(since), to: ymd(until - DAY_MS) };
}

/**
 * A daily series by day. Facebook stamps a day with its end (`end_time` 07:00/08:00 UTC the next day, Pacific
 * midnight), so its day is the one before. Instagram is taken to stamp it with that same day's 07:00/08:00 UTC:
 * inferred from one live read on 2026-11-27 (since=Oct 30 gave a first end_time of Oct 30 on Instagram, Oct 31 on
 * Facebook, and 28 values each); compare a day against Instagram's own Insights to confirm.
 */
function series(data: unknown, name: string, stampsEnd: boolean): ChannelDayDto[] {
  const s = ((Array.isArray(data) ? data : []) as Series).find((x) => x.name === name);
  return (s?.values ?? [])
    .filter((v) => typeof v.end_time === "string" && !Number.isNaN(Date.parse(v.end_time)))
    .map((v) => ({ day: ymd(Date.parse(v.end_time!) - (stampsEnd ? DAY_MS : 0)), value: num(v.value) }));
}
/** A series' sum; null when it has no number at all. */
const total = (days: ChannelDayDto[]) => (days.some((d) => d.value !== null) ? days.reduce((a, d) => a + (d.value ?? 0), 0) : null);

/** Instagram follower_demographics by country, most first, top 5; null without a breakdown. */
function countries(data: unknown): { country: string; followers: number }[] | null {
  type Demo = { total_value?: { breakdowns?: { results?: { dimension_values?: unknown[]; value?: unknown }[] }[] } }[];
  const results = ((Array.isArray(data) ? data : []) as Demo)[0]?.total_value?.breakdowns?.[0]?.results;
  if (!Array.isArray(results)) return null;
  return results
    .map((r) => ({ country: String(r.dimension_values?.[0] ?? ""), followers: num(r.value) ?? 0 }))
    .filter((r) => r.country)
    .sort((a, b) => b.followers - a.followers)
    .slice(0, 5);
}

export async function readChannelAnalytics(input: ReadInput): Promise<Read> {
  const f = input.fetch ?? fetch;
  const now = input.now ?? new Date();
  const w = period(input.days, now);
  let partial = false;
  let reconnect = false;
  const headers = { authorization: `Bearer ${input.token}` };
  const host = { instagram: IG_GRAPH, facebook: GRAPH, pinterest: PINTEREST_API, threads: THREADS_GRAPH }[input.channel];

  /** Notes how a failed answer counts: a timeout or rate limit makes the answer partial; 190 / 401 needs reconnect. */
  const note = (a: Answer) => {
    const r = a.status === 0 ? "timeout" : classify(a.status, a.body);
    if (r === "reconnect") reconnect = true;
    else if (r === "timeout" || r === "rate_limited") partial = true;
  };
  /** A GET's body, or null (noted) when it failed. */
  const get = async (path: string): Promise<Record<string, unknown> | null> => {
    const a = await send(f, `${host}${path}`, { headers });
    if (a.status !== 0 && classify(a.status, a.body) === null && a.body && typeof a.body === "object") return a.body as Record<string, unknown>;
    note(a);
    return null;
  };
  /** An insights call's `data`; a metric refused with error 100 is dropped and the call sent again without it. */
  const metrics = async (url: (m: string[]) => string, wanted: string[]): Promise<unknown[] | null> => {
    const m = [...wanted];
    while (m.length) {
      const a = await send(f, `${host}${url(m)}`, { headers });
      if (a.status !== 0 && classify(a.status, a.body) === null) return ((a.body as { data?: unknown[] } | null)?.data ?? []) as unknown[];
      const refused = refusedMetric(a, m);
      if (!refused) {
        note(a);
        return null;
      }
      m.splice(m.indexOf(refused), 1);
      console.warn(`[channel-analytics] ${input.channel} dropped metric ${refused}`);
    }
    return null;
  };
  const range = `since=${w.since}&until=${w.until}`;
  const base = { channel: input.channel, state: "ok" as const, days: input.days, from: w.from, to: w.to, readAt: now.toISOString() };

  if (input.channel === "pinterest") {
    // Pinterest takes calendar days (UTC), both ends inclusive; recent days come back with data_status other than READY.
    const dates = `start_date=${w.from}&end_date=${w.to}`;
    const [acct, data, top] = await Promise.all([
      get("/user_account"),
      get(`/user_account/analytics?${dates}&metric_types=${Object.keys(PIN_TOTALS).join(",")}`),
      get(`/user_account/analytics/top_pins?${dates}&sort_by=IMPRESSION&num_of_pins=${TOP_PINS}`),
    ]);
    type Day = { date?: unknown; data_status?: unknown; metrics?: Record<string, unknown> };
    const all = (data?.all ?? null) as { daily_metrics?: unknown; summary_metrics?: Record<string, unknown> } | null;
    const pinDays = (Array.isArray(all?.daily_metrics) ? all.daily_metrics : []) as Day[];
    const daySeries = (metric: string): ChannelDayDto[] =>
      pinDays
        .filter((d) => typeof d.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.date))
        .map((d) => ({ day: d.date as string, value: d.data_status === "READY" ? num(d.metrics?.[metric]) : null }));
    const summary = all?.summary_metrics;
    type Pin = { pin_id?: unknown; metrics?: Record<string, unknown> };
    const pins = ((Array.isArray(top?.pins) ? top.pins : []) as Pin[]).filter((p) => typeof p.pin_id === "string" && /^\d+$/.test(p.pin_id));
    const monthlyViews = num(acct?.monthly_views);
    return {
      reconnect,
      body: {
        ...base,
        account: { name: typeof acct?.username === "string" ? `@${acct.username}` : input.name, followers: num(acct?.follower_count), posts: num(acct?.pin_count) },
        totals: { ...Object.fromEntries(Object.entries(PIN_TOTALS).map(([metric, key]) => [key, num(summary?.[metric])])), ...(monthlyViews !== null && { monthlyViews }) },
        daily: daySeries("IMPRESSION"),
        dailyEngagements: daySeries("ENGAGEMENT"),
        followersDaily: [],
        countries: null,
        // Pins carry only their id and numbers here (no title, image or date): one more read per pin isn't worth it.
        posts: top
          ? pins.map((p) => ({
              id: p.pin_id as string, mediaType: null, productType: null, postedAt: null, caption: null, permalink: `https://www.pinterest.com/pin/${p.pin_id}/`, thumbnailUrl: null,
              metrics: { views: num(p.metrics?.IMPRESSION), reach: null, likes: null, comments: null, shares: null, saves: num(p.metrics?.SAVE), interactions: num(p.metrics?.ENGAGEMENT), navigation: null },
            }))
          : null,
        partial,
      },
    };
  }

  if (input.channel === "threads") {
    const [acct, data, followers] = await Promise.all([
      get("/me?fields=username"),
      metrics((m) => `/me/threads_insights?metric=${m.join(",")}&${range}`, ["views", ...Object.keys(THREADS_TOTALS)]),
      metrics(() => "/me/threads_insights?metric=followers_count", ["followers_count"]),
    ]);
    const t = insights(data);
    // Threads stamps a day like Instagram is taken to (that day's Pacific midnight); not yet checked against a live read.
    const views = series(data, "views", false);
    return {
      reconnect,
      body: {
        ...base,
        account: { name: typeof acct?.username === "string" ? `@${acct.username}` : input.name, followers: insights(followers).get("followers_count") ?? null, posts: null },
        totals: { views: total(views), ...Object.fromEntries(Object.entries(THREADS_TOTALS).map(([metric, key]) => [key, t.get(metric) ?? null])) },
        daily: views,
        dailyEngagements: null,
        followersDaily: [],
        countries: null,
        posts: null,
        partial,
      },
    };
  }

  if (input.channel === "facebook") {
    const page = encodeURIComponent(input.pageId);
    const [acct, data] = await Promise.all([
      get(`/${page}?fields=name,followers_count,fan_count`),
      metrics((m) => `/${page}/insights?metric=${m.join(",")}&period=day&${range}`, FB_METRICS),
    ]);
    const views = series(data, "page_media_view", true);
    const engagements = series(data, "page_post_engagements", true);
    const follows = series(data, "page_daily_follows_unique", true);
    return {
      reconnect,
      body: {
        ...base,
        account: { name: typeof acct?.name === "string" ? acct.name : input.name, followers: num(acct?.followers_count) ?? num(acct?.fan_count), posts: null },
        totals: { reach: null, views: total(views), engagements: total(engagements), pageViews: total(series(data, "page_views_total", true)), newFollowers: total(follows) },
        daily: views,
        dailyEngagements: engagements,
        followersDaily: follows,
        countries: null,
        posts: null,
        partial,
      },
    };
  }

  const [acct, totalsData, reachData, followData, demoData, media] = await Promise.all([
    get("/me?fields=user_id,username,followers_count,follows_count,media_count"),
    metrics((m) => `/me/insights?metric=${m.join(",")}&period=day&metric_type=total_value&${range}`, Object.keys(IG_TOTALS)),
    metrics(() => `/me/insights?metric=reach&period=day&${range}`, ["reach"]),
    metrics(() => `/me/insights?metric=follower_count&period=day&${range}`, ["follower_count"]),
    metrics(() => "/me/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&timeframe=this_month&breakdown=country", ["follower_demographics"]),
    get(`/me/media?fields=id,media_type,media_product_type,timestamp,caption,permalink,media_url,thumbnail_url&limit=${POST_LIMIT}`),
  ]);
  const t = insights(totalsData);
  const followersDaily = series(followData, "follower_count", false);
  // New followers are follower_count's days added up (gross follows, not net of unfollows): follows_and_unfollows read
  // live gave no plain total_value, so it isn't asked for.
  const totals = { ...Object.fromEntries(Object.entries(IG_TOTALS).map(([metric, key]) => [key, t.get(metric) ?? null])), newFollowers: total(followersDaily) };

  type Media = { id?: unknown; media_type?: unknown; media_product_type?: unknown; timestamp?: unknown; caption?: unknown; permalink?: unknown; media_url?: unknown; thumbnail_url?: unknown };
  const items = ((Array.isArray(media?.data) ? media.data : []) as Media[]).filter((m) => typeof m.id === "string").slice(0, POST_LIMIT);
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const https = (v: unknown) => (str(v)?.startsWith("https://") ? (v as string) : null);
  // A video's media_url is the video itself, so only its thumbnail_url is a picture; for anything else media_url is.
  const thumbnail = (m: Media) => https(m.thumbnail_url) ?? (m.media_type === "VIDEO" ? null : https(m.media_url));
  // One read per post, side by side: a metric one post type refuses is dropped for that post only.
  const stopAt = Date.now() + POSTS_MS;
  const reads = await Promise.all(
    items.map((m) => readPostMetrics([{ connectionId: "channel-analytics", provider: "INSTAGRAM", token: input.token, posts: [{ attemptId: m.id as string, postId: m.id as string }] }], { fetch: f, stop: () => Date.now() > stopAt })),
  );
  const posts: ChannelPostDto[] = items.map((m, i) => {
    const r = reads[i][0];
    if (r.stoppedReason === "reconnect") reconnect = true;
    else if (r.stoppedReason) partial = true;
    const p = r.posts[0];
    // No answer at all (a timeout or the network): this post's numbers are missing this time.
    if (p && !p.ok && p.reason === "failed" && p.code === null) partial = true;
    return {
      id: m.id as string,
      mediaType: str(m.media_type),
      productType: str(m.media_product_type),
      postedAt: str(m.timestamp) && !Number.isNaN(Date.parse(m.timestamp as string)) ? new Date(m.timestamp as string).toISOString() : null,
      caption: str(m.caption)?.slice(0, 140) ?? null,
      permalink: https(m.permalink),
      thumbnailUrl: thumbnail(m),
      metrics: p?.ok ? { ...p.metrics, navigation: null } : null,
    };
  });

  return {
    reconnect,
    body: {
      ...base,
      account: { name: typeof acct?.username === "string" ? `@${acct.username}` : input.name, followers: num(acct?.followers_count), posts: num(acct?.media_count) },
      totals,
      daily: series(reachData, "reach", false),
      dailyEngagements: null,
      followersDaily,
      countries: demoData ? countries(demoData) : null,
      posts: media ? posts : null,
      partial,
    },
  };
}

/** An answer with nothing read: no account, or its access gone. */
export function emptyAnswer(channel: AnalyticsChannel, state: "not_connected" | "reconnect", days: number, now = new Date()): ChannelAnalyticsDto {
  const w = period(days, now);
  return { channel, state, account: null, days, from: w.from, to: w.to, totals: {}, daily: [], dailyEngagements: null, followersDaily: [], countries: null, posts: null, partial: false, readAt: now.toISOString() };
}

const PROVIDER = { instagram: "INSTAGRAM", facebook: "META", pinterest: "PINTEREST", threads: "THREADS" } as const;
const TTL_MS = 15 * 60_000;
/**
 * ponytail: per-process cache by connection and days, so opening a calendar again doesn't cost ~18 Meta calls. Lost on
 * restart and not shared between processes: fine for one server; several instances would each read once per 15 min
 * (move it to Redis or a table then). A partial or reconnect answer is never cached. Requests for the same key while
 * one is reading share it.
 */
const cache = new Map<string, { at: number; ttl: number; answer: Promise<ChannelAnalyticsDto> }>();
/** A partial answer (a rate limit, a timeout) is kept briefly, so a struggling account isn't asked again on every view. */
const PARTIAL_TTL_MS = 2 * 60_000;
const CACHE_MAX = 500;

/**
 * The brand's account for `channel` and its numbers over the last `days` whole UTC days. A Facebook login stores one
 * connection per granted Page: the earliest connected active one is read (ponytail: a brand with several Pages sees
 * only that one; add a Page picker if that ever matters).
 */
export async function channelAnalytics(scope: { workspaceId: string; brandId: string }, channel: AnalyticsChannel, days: number, now = new Date()): Promise<ChannelAnalyticsDto> {
  const conns = await prisma.integrationConnection.findMany({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId, provider: PROVIDER[channel], status: { in: ["ACTIVE", "ERROR"] } }, orderBy: { createdAt: "asc" } });
  const conn = conns.find((c) => c.status === "ACTIVE");
  if (!conn) return emptyAnswer(channel, conns.length ? "reconnect" : "not_connected", days, now);
  const key = `${conn.id}:${days}`;
  const hit = cache.get(key);
  if (hit && now.getTime() - hit.at < hit.ttl) return hit.answer;
  if (cache.size >= CACHE_MAX) for (const [k, v] of cache) if (now.getTime() - v.at >= v.ttl) cache.delete(k);
  const answer = read(conn, channel, days, now);
  const entry = { at: now.getTime(), ttl: TTL_MS, answer };
  cache.set(key, entry);
  answer.then(
    (a) => {
      if (cache.get(key) !== entry) return;
      if (a.state !== "ok") cache.delete(key);
      else if (a.partial) entry.ttl = PARTIAL_TTL_MS;
    },
    () => cache.get(key)?.answer === answer && cache.delete(key),
  );
  return answer;
}

async function read(conn: IntegrationConnection, channel: AnalyticsChannel, days: number, now: Date): Promise<ChannelAnalyticsDto> {
  let token: string;
  try {
    token = await accessToken(conn);
  } catch (e) {
    if (e instanceof ReconnectNeeded) return emptyAnswer(channel, "reconnect", days, now);
    throw e;
  }
  const r = await readChannelAnalytics({ channel, token, pageId: conn.externalAccountId, name: conn.displayName, days, now });
  if (r.reconnect) {
    await markReconnect(conn.id, `Access expired. Reconnect ${conn.displayName}.`);
    return emptyAnswer(channel, "reconnect", days, now);
  }
  return r.body;
}

