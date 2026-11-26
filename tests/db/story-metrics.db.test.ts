import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/jobs/runner", () => ({ kickRunner: vi.fn() }));

import { prisma } from "@/server/db/prisma";
import { encryptCredentials } from "@/server/crypto/credentials";
import { claimNextJob } from "@/server/jobs/queue";
import { DATA_SYNC_JOB } from "@/server/data/sources";
import { duePosts } from "@/server/data/post-metric-sync";
import { enqueueMissedStoryReads, enqueueStoryRead, runStoryRead, STORY_READ_JOB } from "@/server/data/story-metrics";
import { onPublishJobLost, settleFrame } from "@/server/services/publishing";

/** Instagram story numbers against Postgres: when the read is queued (every settle path and the sweep) and what it writes. */
const TOKEN = "IGQ-secret-token-123";
let ws: string;
let user: string;
const B = "sm-a";
const H = 3_600_000;
type Frame = { i: number; state: string; mediaId?: string; at?: string };
const frame = (i: number, at: number): Frame => ({ i, state: "published", at: new Date(at).toISOString(), mediaId: `1790000000000${i}` });

let n = 0;
async function story(frames: Frame[], extra: { status?: "PUBLISHED" | "PARTIAL" | "PUBLISHING" | "PENDING_VERIFY" | "FAILED"; brandId?: string; connectionId?: string; total?: number } = {}) {
  const brandId = extra.brandId ?? B;
  const id = `${brandId}-s${++n}`;
  const item = await prisma.contentItem.create({ data: { workspaceId: ws, brandId, title: id, channel: "INSTAGRAM_STORY", status: "SCHEDULED" } });
  await prisma.publicationAttempt.create({
    data: {
      id, workspaceId: ws, brandId, contentItemId: item.id, contentVersionId: `${id}-v`, packageHash: "h", connectionId: extra.connectionId ?? `${brandId}-ig`,
      provider: "INSTAGRAM", target: { story: true, frames: extra.total ?? frames.length, progress: frames }, status: extra.status ?? "PUBLISHED",
      runAt: new Date(), publishedAt: extra.status && extra.status !== "PUBLISHED" ? null : new Date(), externalId: frames[0]?.mediaId ?? null, createdByUserId: user,
    },
  });
  return { id, itemId: item.id };
}
const jobOf = (id: string) => prisma.job.findUnique({ where: { idempotencyKey: `story:${id}` } });
const insights = (n: number) => ({ data: ["reach", "views", "replies", "shares", "total_interactions", "navigation"].map((name, i) => ({ name, total_value: { value: n + i } })) });
const payload = (id: string, brandId = B) => ({ attemptId: id, workspaceId: ws, brandId });

beforeAll(async () => {
  // A real stored token (no expiry: accessToken returns it as is), so the read goes through the real accessToken.
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-story-metrics" } })).id;
  user = (await prisma.user.create({ data: { email: "u@story-metrics.test", name: "u" } })).id;
  for (const id of [B, "sm-b"]) {
    await prisma.brand.create({ data: { id, workspaceId: ws, slug: id, displayName: id } });
    await prisma.brandProfile.create({ data: { workspaceId: ws, brandId: id, websiteUrl: `https://${id}.test`, timeZone: "UTC" } });
    await prisma.integrationConnection.create({
      data: { id: `${id}-ig`, workspaceId: ws, brandId: id, provider: "INSTAGRAM", externalAccountId: id, displayName: id, scopes: [], status: "ACTIVE", credentialKeyVersion: 1, connectedByUserId: user, encryptedCredentials: encryptCredentials({ accessToken: TOKEN }, 1) },
    });
  }
});
beforeEach(async () => {
  await prisma.postMetric.deleteMany({});
  await prisma.publicationAttempt.deleteMany({});
  await prisma.job.deleteMany({});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("queueing the read", () => {
  it("queued at first frame + 20 h within ± 15 min, once; not for a story over 24 h old or one that failed", async () => {
    const first = Date.now() - 2 * H;
    const s = await story([frame(1, first + 60_000), frame(0, first)]);
    await enqueueStoryRead(s.id);
    await enqueueStoryRead(s.id);
    const job = await jobOf(s.id);
    expect(job).toMatchObject({ type: STORY_READ_JOB, payload: payload(s.id) });
    expect(Math.abs(job!.runAt.getTime() - (first + 20 * H))).toBeLessThanOrEqual(15 * 60_000);
    expect(await prisma.job.count()).toBe(1);

    const old = await story([frame(0, Date.now() - 25 * H)]);
    const failed = await story([frame(0, Date.now() - H)], { status: "FAILED" });
    expect(await enqueueStoryRead(old.id)).toBeNull();
    expect(await enqueueStoryRead(failed.id)).toBeNull();
  });

  it("from the lost-job and person-check paths (through enqueueStoryRead)", async () => {
    const t = Date.now() - H;
    const lost = await story([frame(0, t), frame(1, t)], { status: "PUBLISHING" });
    await onPublishJobLost({ attemptId: lost.id });
    expect((await prisma.publicationAttempt.findUnique({ where: { id: lost.id } }))!.status).toBe("PUBLISHED");
    expect(await jobOf(lost.id)).not.toBeNull();

    const checked = await story([frame(0, t), { i: 1, state: "publishing" }], { status: "PENDING_VERIFY", total: 2 });
    await settleFrame({ workspaceId: ws, brandId: B, userId: user, itemId: checked.itemId, attemptId: checked.id, frame: 1, appeared: true });
    expect((await prisma.publicationAttempt.findUnique({ where: { id: checked.id } }))!.status).toBe("PUBLISHED");
    expect(await jobOf(checked.id)).not.toBeNull();
  });

  it("the sweep queues a missed story once; one older than 23 h never", async () => {
    const missed = await story([frame(0, Date.now() - 5 * H)]);
    const old = await story([frame(0, Date.now() - 23.5 * H)]);
    expect(await enqueueMissedStoryReads()).toBe(1);
    expect(await enqueueMissedStoryReads()).toBe(0);
    expect(await jobOf(missed.id)).not.toBeNull();
    expect(await jobOf(old.id)).toBeNull();
  });

  it("story.read isn't counted in the data cap; a story is never in duePosts", async () => {
    const live = new Date(Date.now() + 60_000);
    for (const i of [1, 2]) await prisma.job.create({ data: { type: DATA_SYNC_JOB, payload: {}, status: "RUNNING", leasedUntil: live, idempotencyKey: `running-${i}` } });
    await prisma.job.create({ data: { type: DATA_SYNC_JOB, payload: {}, runAt: new Date(Date.now() - 2000), idempotencyKey: "data-waiting" } });
    const s = await story([frame(0, Date.now() - 21 * H)]);
    await enqueueStoryRead(s.id);
    expect((await claimNextJob("w1"))?.type).toBe(STORY_READ_JOB);
    expect(await duePosts({ workspaceId: ws, brandId: B }, new Date())).toEqual([]);
  });
});

describe("story.read", () => {
  it("sums the frames, reach is the highest frame's; replies in comments, navigation kept; token only in a header", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = Date.now() - 20 * H;
    // Frame 2 has no media id (confirmed by hand), frame 3's id isn't digits: both skipped. Frame 4 is already gone.
    const s = await story([frame(0, t), frame(1, t), { i: 2, state: "published", at: new Date(t).toISOString() }, { ...frame(3, t), mediaId: "../me?x=1" }, frame(4, t)]);
    const answers = [new Response(JSON.stringify(insights(10))), new Response(JSON.stringify(insights(100))), new Response(JSON.stringify({ error: { code: 100, error_subcode: 33, message: "gone" } }), { status: 400 })];
    const f = vi.fn<(u: string, i?: RequestInit) => Promise<Response>>(async () => answers.shift()!);
    vi.stubGlobal("fetch", f);
    await runStoryRead(payload(s.id));
    expect(f).toHaveBeenCalledTimes(3);
    const urls = f.mock.calls.map((c) => String(c[0]));
    expect(urls.every((u) => /\/1790000000000[014]\/insights\?metric=reach,views,replies,shares,total_interactions,navigation$/.test(u))).toBe(true);
    expect(JSON.stringify([urls, warn.mock.calls])).not.toContain(TOKEN);
    expect((f.mock.calls[0][1]!.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    const [m] = await prisma.postMetric.findMany({ where: { publicationAttemptId: s.id } });
    // reach 10 and 100 → 100; views 11 + 101; replies 12 + 102; shares 13 + 103; interactions 14 + 104; navigation 15 + 105
    expect(m).toMatchObject({ reach: 100, views: 112, comments: 114, shares: 116, interactions: 118, navigation: 120, likes: null, saves: null });
  });

  it("another brand's attempt id, or an attempt whose connection is another brand's → no-op", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const s = await story([frame(0, Date.now() - 20 * H)]);
    await runStoryRead(payload(s.id, "sm-b"));
    const crossed = await story([frame(0, Date.now() - 20 * H)], { connectionId: "sm-b-ig" });
    await runStoryRead(payload(crossed.id));
    expect(f).not.toHaveBeenCalled();
    expect(await prisma.postMetric.count()).toBe(0);
  });

  it("a missing insights permission writes nothing and leaves the connection alone", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: 10, message: "(#10) Application does not have permission" } }), { status: 403 })));
    const s = await story([frame(0, Date.now() - 20 * H)]);
    await runStoryRead(payload(s.id));
    expect(await prisma.postMetric.count()).toBe(0);
    expect((await prisma.integrationConnection.findUnique({ where: { id: `${B}-ig` } }))!.status).toBe("ACTIVE");
  });
});
