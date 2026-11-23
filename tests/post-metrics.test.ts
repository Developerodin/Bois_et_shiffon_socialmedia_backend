// recorded 2026-11-23, Graph API v23.0 / Threads API v1.0 (shape from docs)
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPostMetrics, refreshDue, type ConnectionToRead } from "@/server/data/post-metrics";

const TOKEN = "EAAB-secret-token-123";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const item = (code: number, body: unknown) => ({ code, body: JSON.stringify(body) });
const igInsights = (n: number) => ({
  data: ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions"].map((name, i) => ({ name, period: "lifetime", values: [{ value: n + i }] })),
});
const posts = (n: number) => Array.from({ length: n }, (_, i) => ({ attemptId: `a${i}`, postId: `m${i}` }));
const conn = (o: Partial<ConnectionToRead> = {}): ConnectionToRead => ({ connectionId: "c1", provider: "INSTAGRAM", token: TOKEN, posts: posts(3), ...o });

afterEach(() => vi.restoreAllMocks());

describe("readPostMetrics", () => {
  it("reads 3 Instagram posts with one GET each, token in the header, one refused for permission", async () => {
    const replies = [
      json(200, igInsights(10)),
      json(403, { error: { message: "(#10) Application does not have permission for this action", code: 10 } }),
      json(200, igInsights(20)),
    ];
    const f = vi.fn(async () => replies.shift()!);
    const [r] = await readPostMetrics([conn()], { fetch: f as unknown as typeof fetch });
    expect(f).toHaveBeenCalledTimes(3);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://graph.instagram.com/v23.0/m0/insights?metric=views,reach,likes,comments,shares,saved,total_interactions");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(r.stoppedReason).toBeUndefined();
    expect(r.unread).toEqual([]);
    expect(r.posts[0]).toEqual({ attemptId: "a0", ok: true, metrics: { views: 10, reach: 11, likes: 12, comments: 13, shares: 14, saves: 15, interactions: 16 } });
    expect(r.posts[1]).toEqual({ attemptId: "a1", ok: false, reason: "permission", code: 10 });
    expect(r.posts[2].ok).toBe(true);
  });

  it("splits 120 Facebook posts into batches of 50", async () => {
    const f = vi.fn(async (_u: string, init?: RequestInit) => {
      const n = JSON.parse(new URLSearchParams(String(init!.body)).get("batch")!).length;
      return json(200, Array.from({ length: n }, () => item(200, { id: "p" })));
    });
    const [r] = await readPostMetrics([conn({ provider: "META", posts: posts(120) })], { fetch: f as unknown as typeof fetch });
    expect(f).toHaveBeenCalledTimes(3);
    expect(r.posts.filter((p) => p.ok)).toHaveLength(120);
  });

  it("an error 100 that names no metric fails the post visibly, no retry", async () => {
    const f = vi.fn(async () => json(400, { error: { message: "(#100) Invalid parameter", code: 100 } }));
    const [r] = await readPostMetrics([conn({ posts: posts(1) })], { fetch: f as unknown as typeof fetch });
    expect(f).toHaveBeenCalledTimes(1);
    expect(r.posts).toEqual([{ attemptId: "a0", ok: false, reason: "failed", code: 100 }]);
  });

  it("190 stops that connection with reconnect and still reads the next one", async () => {
    const f = vi.fn(async (url: string) =>
      url.startsWith("https://graph.instagram.com")
        ? json(400, { error: { message: "Error validating access token", type: "OAuthException", code: 190 } })
        : json(200, [item(200, { id: "p1", insights: { data: [{ name: "post_media_view", values: [{ value: 40 }] }, { name: "post_total_media_view_unique", values: [{ value: 30 }] }] }, reactions: { data: [], summary: { total_count: 5 } }, comments: { data: [], summary: { total_count: 2 } } })]),
    );
    const out = await readPostMetrics(
      [conn({ posts: posts(60) }), conn({ connectionId: "c2", provider: "META", posts: [{ attemptId: "f1", postId: "123_456" }] })],
      { fetch: f as unknown as typeof fetch },
    );
    expect(out[0].stoppedReason).toBe("reconnect");
    expect(out[0].unread).toHaveLength(60);
    expect(f).toHaveBeenCalledTimes(2); // no IG post after the refused one was read
    expect(out[1].stoppedReason).toBeUndefined();
    // No `shares` field means no shares on Facebook.
    expect(out[1].posts[0]).toEqual({ attemptId: "f1", ok: true, metrics: { views: 40, reach: 30, likes: 5, comments: 2, shares: 0, saves: null, interactions: 7 } });
  });

  it("a rate limit stops the connection part way and lists the rest as unread", async () => {
    let n = 0;
    const f = vi.fn(async () => {
      n++;
      return n === 1
        ? json(200, { data: [{ name: "views", values: [{ value: 9 }] }, { name: "likes", values: [{ value: 1 }] }, { name: "replies", values: [{ value: 1 }] }, { name: "reposts", values: [{ value: 0 }] }, { name: "quotes", values: [{ value: 0 }] }, { name: "shares", values: [{ value: 2 }] }] })
        : json(400, { error: { message: "Application request limit reached", code: 4 } });
    });
    const [r] = await readPostMetrics([conn({ provider: "THREADS" })], { fetch: f as unknown as typeof fetch });
    expect(f).toHaveBeenCalledTimes(2);
    expect(r.stoppedReason).toBe("rate_limited");
    expect(r.posts).toEqual([{ attemptId: "a0", ok: true, metrics: { views: 9, reach: null, likes: 1, comments: 1, shares: 2, saves: null, interactions: 4 } }]);
    expect(r.unread).toEqual(["a1", "a2"]);
  });

  it("a network failure never throws", async () => {
    const f = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const [r] = await readPostMetrics([conn()], { fetch: f as unknown as typeof fetch });
    expect(f).toHaveBeenCalledTimes(1);
    expect(r.stoppedReason).toBe("failed");
    expect(r.posts).toEqual([{ attemptId: "a0", ok: false, reason: "failed", code: null }]);
    expect(r.unread).toEqual(["a1", "a2"]);
  });

  it("the token is never in a URL, a result or a log line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = vi.fn(async () => json(400, { error: { message: `Invalid OAuth access token - Cannot parse access token ${TOKEN}`, code: 190 } }));
    const out = await readPostMetrics([conn(), conn({ connectionId: "c2", provider: "META" })], { fetch: f as unknown as typeof fetch });
    for (const [url] of f.mock.calls as unknown as [string][]) expect(url).not.toContain(TOKEN);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(warn).toHaveBeenCalled();
    for (const spy of [warn, log, error]) for (const args of spy.mock.calls) {
      const line = args.join(" ");
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain("https://");
    }
  });
});

describe("refreshDue", () => {
  const pub = new Date("2026-11-01T10:00:00Z");
  const at = (days: number, hours = 0) => new Date(pub.getTime() + days * 86_400_000 + hours * 3_600_000);
  it.each([
    // [age of now in days, last read age in days or null, due]
    [0.5, null, true],
    [3, 2, true], // daily to day 7
    [3, 2.5, false],
    [6.9, 5.95, true],
    [8, 7, false], // every 3 days to day 14
    [10, 7, true],
    [15, 14, false], // weekly to day 30
    [21, 14, true],
    [29, 28, false],
    [29.9, null, true],
    [30, 21, false], // none after
    [45, null, false],
  ] as const)("now day %s, last read day %s → %s", (now, last, due) => {
    expect(refreshDue(pub, last === null ? null : at(last), at(now))).toBe(due);
  });
  it("a daily run a little earlier than yesterday's still counts", () => expect(refreshDue(pub, at(2, 1), at(3, 0))).toBe(true));
});
