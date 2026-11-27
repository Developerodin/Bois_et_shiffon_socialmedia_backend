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
