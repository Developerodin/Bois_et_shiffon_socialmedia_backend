// Shapes recorded live 2026-11-27 (graph.instagram.com / graph.facebook.com v23), numbers made up.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readChannelAnalytics, type ReadInput } from "@/server/data/channel-analytics";

const TOKEN = "IGAA-secret-token-123";
const NOW = new Date("2026-11-27T10:00:00Z");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
// Meta's titles come back in the account's language; they must never reach the answer.
const LOCAL = ["पहुँच", "हिंदी विवरण", "शीर्षक", "दर्शक"];
const titled = (name: string, extra: object) => ({ name, period: "day", title: LOCAL[0], description: LOCAL[1], ...extra, id: `1/insights/${name}/day` });
const days = (vals: number[], firstStamp: string) =>
  vals.map((value, i) => ({ value, end_time: new Date(Date.parse(firstStamp) + i * 86_400_000).toISOString().replace(".000Z", "+0000") }));
const tooFew = () => json(400, { error: { message: "(#10) Not enough viewers for the media to show insights", code: 10, error_subcode: 2108006 } });
const refused = (i: number) => json(400, { error: { message: `(#100) metric[${i}] must be one of the following values: reach, views`, code: 100 } });

/** A fake Graph keyed by path and metric; `override` answers first. */
function graph(override: (url: URL) => Response | null = () => null) {
  return vi.fn(async (u: string) => {
    const url = new URL(u);
    const o = override(url);
    if (o) return o;
    const metric = url.searchParams.get("metric");
    const p = url.pathname.replace(/^\/v[\d.]+/, "");
    if (p === "/me") return json(200, { user_id: "1", username: "shop", followers_count: 2714, media_count: 238 });
    if (p === "/me/media") {
      return json(200, {
        data: [{ id: "m1", media_type: "IMAGE", media_product_type: "FEED", timestamp: "2026-11-25T05:11:44+0000", caption: "Hello", permalink: "https://www.instagram.com/p/x/" }],
        paging: { next: `https://graph.instagram.com/next?access_token=${TOKEN}` },
      });
    }
    if (p === "/m1/insights") {
      return json(200, { data: ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions"].map((name, i) => ({ name, period: "lifetime", title: LOCAL[2], values: [{ value: 10 + i }] })) });
    }
    if (metric === "follower_demographics") {
      const results = ([["RS", 4], ["FR", 1938], ["DE", 22], ["US", 211], ["GB", 141], ["IN", 68]] as const).map(([c, v]) => ({ dimension_values: [c], value: v }));
      return json(200, { data: [{ name: "follower_demographics", title: LOCAL[3], total_value: { breakdowns: [{ dimension_keys: ["country"], results }] } }] });
    }
    if (metric === "reach") return json(200, { data: [titled("reach", { values: days([100, 200], "2026-10-30T07:00:00Z") })] });
    if (metric === "follower_count") return json(200, { data: [titled("follower_count", { values: days([3, 4], "2026-10-30T07:00:00Z") })] });
    if (url.searchParams.get("metric_type") === "total_value") return json(200, { data: metric!.split(",").map((name, i) => titled(name, { total_value: { value: 1000 + i } })) });
    if (p === "/123") return json(200, { name: "Shop Page", followers_count: 2313, fan_count: 2313 });
    if (p === "/123/insights") return json(200, { data: metric!.split(",").map((name) => titled(name, { values: days([5, 7], "2026-10-31T07:00:00Z") })) });
    return json(404, { error: { code: 803, message: "unknown" } });
  });
}
const input = (f: ReturnType<typeof graph>, o: Partial<ReadInput> = {}): ReadInput => ({
  channel: "instagram", token: TOKEN, pageId: "123", name: "@fallback", days: 28, now: NOW, fetch: f as unknown as typeof fetch, ...o,
});

afterEach(() => vi.restoreAllMocks());

describe("readChannelAnalytics", () => {
  it("reads an Instagram account: totals, daily reach by day, new followers, top 5 countries, posts; no Meta titles, no token", async () => {
    const f = graph();
    const { body, reconnect } = await readChannelAnalytics(input(f));
    expect(reconnect).toBe(false);
    expect(body.partial).toBe(false);
    expect(body).toMatchObject({ state: "ok", from: "2026-10-30", to: "2026-11-26", account: { name: "@shop", followers: 2714, posts: 238 } });
    expect(body.totals).toMatchObject({ reach: 1000, views: 1001, accountsEngaged: 1002, linkTaps: 1008, newFollowers: 7 });
    // Instagram stamps a day with that day's Pacific midnight.
    expect(body.daily).toEqual([{ day: "2026-10-30", value: 100 }, { day: "2026-10-31", value: 200 }]);
    expect(body.countries).toEqual([
      { country: "FR", followers: 1938 }, { country: "US", followers: 211 }, { country: "GB", followers: 141 }, { country: "IN", followers: 68 }, { country: "DE", followers: 22 },
    ]);
    expect(body.posts).toEqual([{
      id: "m1", mediaType: "IMAGE", productType: "FEED", postedAt: "2026-11-25T05:11:44.000Z", caption: "Hello", permalink: "https://www.instagram.com/p/x/",
      metrics: { views: 10, reach: 11, likes: 12, comments: 13, shares: 14, saves: 15, interactions: 16, navigation: null },
    }]);
    const text = JSON.stringify(body);
    for (const t of LOCAL) expect(text).not.toContain(t);
    expect(text).not.toContain(TOKEN);
    for (const [url, init] of f.mock.calls as unknown as [string, RequestInit][]) {
      expect(url).not.toContain(TOKEN);
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    }
    // The 28 whole UTC days before today: Oct 30 00:00 to Nov 27 00:00.
    expect(f.mock.calls.some(([u]) => String(u).includes("since=1793318400&until=1795737600"))).toBe(true);
  });

  it("drops a refused metric (error 100) and keeps the others", async () => {
    const f = graph((url) => (url.searchParams.get("metric_type") === "total_value" && url.searchParams.get("metric")!.startsWith("reach,views,accounts_engaged") ? refused(2) : null));
    const { body } = await readChannelAnalytics(input(f));
    expect(body.totals.accountsEngaged).toBeNull();
    expect(body.totals.reach).toBe(1000);
    expect(body.totals.views).toBe(1001);
    expect(body.partial).toBe(false);
  });

  it("gives null numbers when Instagram has too few viewers, without failing the rest", async () => {
    const f = graph((url) => (url.searchParams.get("metric") === "follower_demographics" || url.pathname.endsWith("/m1/insights") ? tooFew() : null));
    const { body, reconnect } = await readChannelAnalytics(input(f));
    expect(reconnect).toBe(false);
    expect(body.countries).toBeNull();
    expect(body.posts![0].metrics).toEqual({ views: null, reach: null, likes: null, comments: null, shares: null, saves: null, interactions: null, navigation: null });
    expect(body.account?.followers).toBe(2714);
  });

  it("marks the answer partial when a read times out", async () => {
    const f = graph((url) => {
      if (url.searchParams.get("metric") === "reach") throw new DOMException("timed out", "TimeoutError");
      return null;
    });
    const { body } = await readChannelAnalytics(input(f));
    expect(body.partial).toBe(true);
    expect(body.daily).toEqual([]);
    expect(body.totals.reach).toBe(1000);
  });

  it("asks for a reconnect on an expired token (190)", async () => {
    const f = graph((url) => (url.pathname.endsWith("/me") ? json(400, { error: { code: 190, message: "expired" } }) : null));
    expect((await readChannelAnalytics(input(f))).reconnect).toBe(true);
  });

  it("reads a Facebook Page: followers, daily media views and engagements, no reach, no posts", async () => {
    const f = graph();
    const { body } = await readChannelAnalytics(input(f, { channel: "facebook", token: "EAAB-page" }));
    expect(body.account).toEqual({ name: "Shop Page", followers: 2313, posts: null });
    // Facebook stamps a day with its end: Oct 31 07:00 UTC is Oct 30.
    expect(body.daily).toEqual([{ day: "2026-10-30", value: 5 }, { day: "2026-10-31", value: 7 }]);
    expect(body.totals).toEqual({ reach: null, views: 12, engagements: 12, pageViews: 12, newFollowers: 12 });
    expect(body.posts).toBeNull();
    expect(body.countries).toBeNull();
    expect(f.mock.calls.every(([u]) => String(u).startsWith("https://graph.facebook.com/v23.0/123"))).toBe(true);
  });
});

describe("readChannelAnalytics: Pinterest", () => {
  const pinterest = (override: (url: URL) => Response | null = () => null) =>
    vi.fn(async (u: string) => {
      const url = new URL(u);
      const o = override(url);
      if (o) return o;
      if (url.pathname === "/v5/user_account") return json(200, { username: "shop", follower_count: 412, pin_count: 96, monthly_views: 15000 });
      if (url.pathname === "/v5/user_account/analytics") {
        const day = (date: string, data_status: string, n: number) => ({ date, data_status, metrics: { IMPRESSION: n, SAVE: 1, PIN_CLICK: 2, OUTBOUND_CLICK: 3, ENGAGEMENT: n / 10 } });
        return json(200, {
          all: {
            daily_metrics: [day("2026-11-24", "READY", 100), day("2026-11-25", "READY", 200), day("2026-11-26", "PROCESSING", 50)],
            summary_metrics: { IMPRESSION: 350, SAVE: 3, PIN_CLICK: 6, OUTBOUND_CLICK: 9, ENGAGEMENT: 35 },
          },
        });
      }
      if (url.pathname === "/v5/user_account/analytics/top_pins") {
        return json(200, { pins: [{ pin_id: "987", metrics: { IMPRESSION: 120, SAVE: 4, ENGAGEMENT: 9, PIN_CLICK: 2 }, data_status: {} }, { pin_id: "../x", metrics: {} }], sort_by: "IMPRESSION" });
      }
      return json(404, { code: 404, message: "not found" });
    });

  it("reads the account, summary totals, daily impressions and engagements (unfinished days null) and top pins", async () => {
    const f = pinterest();
    const { body, reconnect } = await readChannelAnalytics(input(f, { channel: "pinterest", token: "pina_secret" }));
    expect(reconnect).toBe(false);
    expect(body.partial).toBe(false);
    expect(body.account).toEqual({ name: "@shop", followers: 412, posts: 96 });
    expect(body.totals).toEqual({ impressions: 350, saves: 3, pinClicks: 6, outboundClicks: 9, engagements: 35, monthlyViews: 15000 });
    expect(body.daily).toEqual([{ day: "2026-11-24", value: 100 }, { day: "2026-11-25", value: 200 }, { day: "2026-11-26", value: null }]);
    expect(body.dailyEngagements).toEqual([{ day: "2026-11-24", value: 10 }, { day: "2026-11-25", value: 20 }, { day: "2026-11-26", value: null }]);
    expect(body.followersDaily).toEqual([]);
    expect(body.countries).toBeNull();
    expect(body.posts).toEqual([{
      id: "987", mediaType: null, productType: null, postedAt: null, caption: null, permalink: "https://www.pinterest.com/pin/987/",
      metrics: { views: 120, reach: null, likes: null, comments: null, shares: null, saves: 4, interactions: 9, navigation: null },
    }]);
    const urls = f.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes("start_date=2026-10-30&end_date=2026-11-26") && u.includes("metric_types=IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK,ENGAGEMENT"))).toBe(true);
    for (const [url, init] of f.mock.calls as unknown as [string, RequestInit][]) {
      expect(url.startsWith("https://api.pinterest.com/v5/")).toBe(true);
      expect(url).not.toContain("pina_secret");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer pina_secret");
    }
  });

  it("asks for a reconnect on 401", async () => {
    const f = pinterest((url) => (url.pathname === "/v5/user_account" ? json(401, { code: 2, message: "Authentication failed." }) : null));
    expect((await readChannelAnalytics(input(f, { channel: "pinterest" }))).reconnect).toBe(true);
  });

  it("gives null numbers, partial, on a rate limit; a refused analytics read (not a business account) just nulls", async () => {
    const limited = pinterest((url) => (url.pathname === "/v5/user_account/analytics" ? json(429, { code: 8, message: "rate limited" }) : null));
    const a = (await readChannelAnalytics(input(limited, { channel: "pinterest" }))).body;
    expect(a.partial).toBe(true);
    expect(a.totals.impressions).toBeNull();
    expect(a.daily).toEqual([]);
    const refusedRead = pinterest((url) => (url.pathname.startsWith("/v5/user_account/analytics") ? json(403, { code: 1, message: "no" }) : null));
    const b = await readChannelAnalytics(input(refusedRead, { channel: "pinterest" }));
    expect(b.reconnect).toBe(false);
    expect(b.body.partial).toBe(false);
    expect(b.body.posts).toBeNull();
    expect(b.body.account?.followers).toBe(412);
  });
});

describe("readChannelAnalytics: Threads", () => {
  const threads = (override: (url: URL) => Response | null = () => null) =>
    vi.fn(async (u: string) => {
      const url = new URL(u);
      const o = override(url);
      if (o) return o;
      const metric = url.searchParams.get("metric");
      if (url.pathname === "/v1.0/me") return json(200, { id: "1", username: "shop" });
      if (metric === "followers_count") return json(200, { data: [{ name: "followers_count", period: "day", title: LOCAL[0], total_value: { value: 57 } }] });
      if (url.pathname === "/v1.0/me/threads_insights") {
        return json(200, {
          data: metric!.split(",").map((name, i) =>
            name === "views" ? titled("views", { values: days([30, 40], "2026-10-30T07:00:00Z") }) : { name, period: "day", title: LOCAL[2], total_value: { value: i } }),
        });
      }
      return json(404, { error: { code: 803, message: "unknown" } });
    });

  it("reads the account, views per day and totals (replies as comments, reposts as shares)", async () => {
    const f = threads();
    const { body, reconnect } = await readChannelAnalytics(input(f, { channel: "threads", token: "THAA-secret" }));
    expect(reconnect).toBe(false);
    expect(body.account).toEqual({ name: "@shop", followers: 57, posts: null });
    expect(body.totals).toEqual({ views: 70, likes: 1, comments: 2, shares: 3, quotes: 4 });
    expect(body.daily).toEqual([{ day: "2026-10-30", value: 30 }, { day: "2026-10-31", value: 40 }]);
    expect(body).toMatchObject({ dailyEngagements: null, followersDaily: [], countries: null, posts: null, partial: false });
    expect(JSON.stringify(body)).not.toContain(LOCAL[0]);
    const urls = f.mock.calls.map(([u]) => String(u));
    expect(urls.every((u) => u.startsWith("https://graph.threads.net/v1.0/") && !u.includes("THAA-secret"))).toBe(true);
    // followers_count refuses since/until.
    expect(urls.find((u) => u.includes("followers_count"))).not.toContain("since=");
    expect(urls.some((u) => u.includes("metric=views,likes,replies,reposts,quotes&since=1793318400&until=1795737600"))).toBe(true);
  });

  it("drops a refused metric and asks for a reconnect on an expired token", async () => {
    const f = threads((url) => (url.searchParams.get("metric")?.startsWith("views,likes,replies,reposts,quotes") ? refused(4) : null));
    const { body } = await readChannelAnalytics(input(f, { channel: "threads" }));
    expect(body.totals).toEqual({ views: 70, likes: 1, comments: 2, shares: 3, quotes: null });
    const g = threads((url) => (url.pathname === "/v1.0/me" ? json(400, { error: { code: 190, message: "expired" } }) : null));
    expect((await readChannelAnalytics(input(g, { channel: "threads" }))).reconnect).toBe(true);
  });
});
