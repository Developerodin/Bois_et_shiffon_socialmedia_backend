import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ perms: new Set<string>(["analytics.read"]), brandId: "pm-a" }));
vi.mock("@/server/api/brand-route", async () => {
  const { AccessDeniedError } = await import("@/server/auth/errors");
  return {
    authorizeBrandRoute: vi.fn(async (_r: Request, _p: unknown, key: string) => {
      if (!auth.perms.has(key)) throw new AccessDeniedError(`Missing permission ${key}`);
      return { userId: "u1", workspaceId: ws, brandId: auth.brandId, perms: auth.perms, clientReviewer: false };
    }),
  };
});
const client = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/server/data/post-metrics", async (orig) => ({ ...(await orig<object>()), readPostMetrics: client.read }));
vi.mock("@/server/services/connections", async (orig) => ({ ...(await orig<object>()), accessToken: vi.fn(async () => "tok") }));

import { prisma } from "@/server/db/prisma";
import { duePosts, ensurePostMetricSources, pruneFinal, syncPostMetrics, upsertMetrics } from "@/server/data/post-metric-sync";
import type { ConnectionToRead } from "@/server/data/post-metrics";
import { GET } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/insights/posts/route";

/** Post metrics against Postgres: the due-post decay, the per-day upsert, the day-30 prune and the read route. */
let ws: string;
let user: string;
const DAY = 86_400_000;
const now = new Date("2026-11-23T06:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const metrics = (reach: number) => ({ views: reach * 2, reach, likes: 1, comments: null, shares: 0, saves: null, interactions: 1 });

async function brand(id: string) {
  await prisma.brand.create({ data: { id, workspaceId: ws, slug: id, displayName: id } });
  await prisma.brandProfile.create({ data: { workspaceId: ws, brandId: id, websiteUrl: `https://${id}.test`, timeZone: "Europe/Paris" } });
  await prisma.integrationConnection.create({
    data: { id: `${id}-ig`, workspaceId: ws, brandId: id, provider: "INSTAGRAM", externalAccountId: id, displayName: id, scopes: [], status: "ACTIVE", credentialKeyVersion: 1, connectedByUserId: user },
  });
}
let n = 0;
async function post(brandId: string, publishedAt: Date, extra: { channel?: "INSTAGRAM_POST" | "INSTAGRAM_STORY"; provider?: "INSTAGRAM" | "META"; externalId?: string; title?: string } = {}) {
  const id = `${brandId}-p${++n}`;
  const item = await prisma.contentItem.create({ data: { workspaceId: ws, brandId, title: extra.title ?? id, channel: extra.channel ?? "INSTAGRAM_POST" } });
  await prisma.publicationAttempt.create({
    data: {
      id, workspaceId: ws, brandId, contentItemId: item.id, contentVersionId: `${id}-v`, packageHash: "h", connectionId: `${brandId}-ig`,
      provider: extra.provider ?? "INSTAGRAM", target: {}, status: "PUBLISHED", runAt: publishedAt, publishedAt, externalId: extra.externalId ?? `ext-${n}`, createdByUserId: user,
    },
  });
  return id;
}
const read = (attemptId: string, readAt: Date, reach = 10) =>
  prisma.postMetric.create({ data: { workspaceId: ws, brandId: "pm-a", publicationAttemptId: attemptId, day: new Date(readAt.toISOString().slice(0, 10)), readAt, ...metrics(reach) } });

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-post-metrics" } })).id;
  user = (await prisma.user.create({ data: { email: "u@post-metrics.test", name: "u" } })).id;
  await brand("pm-a");
  await brand("pm-b");
});
beforeEach(async () => {
  await prisma.postMetric.deleteMany({});
  await prisma.publicationAttempt.deleteMany({});
  await prisma.dataSource.deleteMany({});
  client.read.mockReset();
  auth.perms = new Set(["analytics.read"]);
  auth.brandId = "pm-a";
});

describe("duePosts", () => {
  it("applies the decay at its boundaries, oldest read first, never stories, bare Facebook ids or another brand's posts", async () => {
    const fresh = await post("pm-a", ago(2)); // never read
    const day3ReadToday = await post("pm-a", ago(3));
    await read(day3ReadToday, ago(0.5));
    const day5ReadYesterday = await post("pm-a", ago(5));
    await read(day5ReadYesterday, ago(1));
    const day10Read2DaysAgo = await post("pm-a", ago(10));
    await read(day10Read2DaysAgo, ago(2)); // every 3 days: not yet
    const day10Read3DaysAgo = await post("pm-a", ago(10.5));
    await read(day10Read3DaysAgo, ago(3));
    const day20Read6DaysAgo = await post("pm-a", ago(20));
    await read(day20Read6DaysAgo, ago(6)); // weekly: not yet
    const day20Read7DaysAgo = await post("pm-a", ago(21));
    await read(day20Read7DaysAgo, ago(7));
    await post("pm-a", ago(30.1)); // past day 30, never read: never
    await post("pm-a", ago(1), { channel: "INSTAGRAM_STORY" });
    await post("pm-a", ago(1), { provider: "META", externalId: "123" });
    const fbPost = await post("pm-a", ago(1), { provider: "META", externalId: "1_2" });
    await post("pm-b", ago(1));

    const due = (await duePosts({ workspaceId: ws, brandId: "pm-a" }, now)).map((d) => d.id);
    expect(due.slice(0, 2).sort()).toEqual([fbPost, fresh].sort()); // never read first
    expect(due.slice(2)).toEqual([day20Read7DaysAgo, day10Read3DaysAgo, day5ReadYesterday]);
  });
});

describe("syncPostMetrics", () => {
  it("writes one row per post per brand-local day, however often it runs, and only for the brand's posts", async () => {
    const a = await post("pm-a", ago(2));
    const b = await post("pm-b", ago(2));
    client.read.mockImplementation(async (conns: ConnectionToRead[]) =>
      conns.map((c) => ({ connectionId: c.connectionId, provider: c.provider, stopped: null, unread: [], posts: c.posts.map((p) => ({ attemptId: p.attemptId, ok: true, metrics: metrics(5) })) })));
    const source = { workspaceId: ws, brandId: "pm-a" } as never;
    // 23:30 UTC is the next day in Paris.
    const late = new Date("2026-11-22T23:30:00Z");
    expect(await syncPostMetrics({ source }, late)).toEqual({ count: 1, reason: null });
    // The same brand-local day again: the row is replaced, not added.
    await upsertMetrics({ workspaceId: ws, brandId: "pm-a" }, "2026-11-23", now, [{ attemptId: a, metrics: metrics(9) }]);
    const rows = await prisma.postMetric.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ publicationAttemptId: a, brandId: "pm-a", reach: 9, comments: null, day: new Date("2026-11-23T00:00:00Z") });
    const asked = client.read.mock.calls.flatMap(([conns]) => (conns as ConnectionToRead[]).flatMap((c) => c.posts.map((p) => p.attemptId)));
    expect(asked).not.toContain(b);
  });

  it("a rate limit on a connection is the run's reason and keeps what was read", async () => {
    const a = await post("pm-a", ago(2));
    client.read.mockResolvedValue([{ connectionId: "pm-a-ig", provider: "INSTAGRAM", stopped: "rate_limited", unread: [], posts: [{ attemptId: a, ok: true, metrics: metrics(3) }] }]);
    expect(await syncPostMetrics({ source: { workspaceId: ws, brandId: "pm-a" } as never }, now)).toEqual({ count: 1, reason: "rate-limited" });
  });

  it("a refused token marks that connection only, and the run still saves the others", async () => {
    const a = await post("pm-a", ago(2));
    client.read.mockResolvedValue([
      { connectionId: "pm-a-ig", provider: "INSTAGRAM", stopped: "reconnect", unread: [a], posts: [] },
    ]);
    expect(await syncPostMetrics({ source: { workspaceId: ws, brandId: "pm-a" } as never }, now)).toEqual({ count: 0, reason: null });
    expect((await prisma.integrationConnection.findUniqueOrThrow({ where: { id: "pm-a-ig" } })).status).toBe("ERROR");
    expect((await prisma.integrationConnection.findUniqueOrThrow({ where: { id: "pm-b-ig" } })).status).toBe("ACTIVE");
    await prisma.integrationConnection.update({ where: { id: "pm-a-ig" }, data: { status: "ACTIVE", lastError: null } });
  });
});

describe("pruneFinal", () => {
  it("past day 30 keeps only the final row; younger posts keep every row", async () => {
    const old = await post("pm-a", ago(40));
    for (const d of [39, 30, 15]) await read(old, ago(d));
    const young = await post("pm-a", ago(20));
    for (const d of [19, 12]) await read(young, ago(d));
    await pruneFinal({ workspaceId: ws, brandId: "pm-a" }, now);
    const left = await prisma.postMetric.findMany({ orderBy: { day: "asc" } });
    expect(left.filter((r) => r.publicationAttemptId === old).map((r) => r.readAt)).toEqual([ago(15)]);
    expect(left.filter((r) => r.publicationAttemptId === young)).toHaveLength(2);
  });
});

describe("ensurePostMetricSources", () => {
  it("one POST_METRICS source per brand with published posts, created once", async () => {
    await post("pm-a", ago(1));
    await post("pm-a", ago(2));
    expect(await ensurePostMetricSources()).toBe(1);
    expect(await ensurePostMetricSources()).toBe(0);
    expect(await prisma.dataSource.findMany({ select: { brandId: true, kind: true, externalId: true, connectionId: true } }))
      .toEqual([{ brandId: "pm-a", kind: "POST_METRICS", externalId: "", connectionId: null }]);
  });
});

describe("GET insights/posts", () => {
  const get = (q: string) => GET(new Request(`http://x/insights/posts?${q}`), { params: Promise.resolve({ workspaceId: ws, brandId: "pm-a" }) });

  it("needs analytics.read", async () => {
    auth.perms = new Set(["brand.read"]);
    expect((await get("from=2026-11-01&to=2026-11-23")).status).toBe(403);
  });

  it("rejects a bad or too long range", async () => {
    expect((await get("from=2026-11-23&to=2026-11-01")).status).toBe(400);
    expect((await get("from=2026-01-01&to=2026-11-23")).status).toBe(400);
    expect((await get("from=x&to=2026-11-23")).status).toBe(400);
  });

  it("the brand's posts in range with their latest read, most reach first, never another brand's", async () => {
    const low = await post("pm-a", new Date("2026-11-10T10:00:00Z"), { title: "Low" });
    await read(low, new Date("2026-11-11T10:00:00Z"), 50);
    await read(low, new Date("2026-11-12T10:00:00Z"), 60); // latest wins
    const high = await post("pm-a", new Date("2026-11-15T10:00:00Z"), { title: "High" });
    await read(high, new Date("2026-11-16T10:00:00Z"), 500);
    const unread = await post("pm-a", new Date("2026-11-20T10:00:00Z"));
    await post("pm-a", new Date("2026-10-01T10:00:00Z")); // out of range
    await post("pm-b", new Date("2026-11-15T10:00:00Z"));
    const res = await get("from=2026-11-01&to=2026-11-23");
    expect(res.status).toBe(200);
    const { posts } = await res.json();
    expect(posts.map((p: { attemptId: string }) => p.attemptId)).toEqual([high, low, unread]);
    expect(posts[1]).toMatchObject({ title: "Low", channel: "INSTAGRAM_POST", metrics: { reach: 60, comments: null }, readAt: "2026-11-12T10:00:00.000Z", final: false });
    expect(posts[2]).toMatchObject({ metrics: null, readAt: null });
  });

  it("a post published 23:30 UTC on the 31st belongs to the 1st in Paris", async () => {
    const p = await post("pm-a", new Date("2026-10-31T23:30:00Z"));
    const { posts } = await (await get("from=2026-11-01&to=2026-11-01")).json();
    expect(posts.map((x: { attemptId: string }) => x.attemptId)).toEqual([p]);
  });
});
