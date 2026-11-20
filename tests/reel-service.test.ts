import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  const fn = () => vi.fn();
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    contentItem: { findFirst: fn(), update: fn() },
    auditEvent: { create: fn() },
    reelRender: { findUnique: fn(), findFirst: fn() },
    approvalDecision: { findFirst: fn() },
    publicationAttempt: { findFirst: fn() },
  };
  return { tx, prisma: { ...tx, $transaction: vi.fn(async (f: (t: typeof tx) => unknown) => f(tx)) }, decide: fn(), enqueueTick: fn(), kick: fn() };
});
vi.mock("@/server/db/prisma", () => ({ prisma: m.prisma }));
vi.mock("@/server/services/publishing", async (orig) => ({ ...(await orig<object>()), decide: m.decide }));
vi.mock("@/server/storage/media", async (orig) => ({ ...(await orig<object>()), signedMediaUrl: vi.fn(async (k: string, _e?: number, name?: string) => `https://s3/${k}${name ? `#${name}` : ""}`) }));
vi.mock("@/server/reels/render", () => ({ enqueueTick: m.enqueueTick, renderView: vi.fn(async () => []) }));
vi.mock("@/server/services/credits", async (orig) => ({ ...(await orig<object>()), creditBalance: vi.fn(async () => 0) }));
vi.mock("@/server/jobs/runner", () => ({ kickRunner: m.kick }));
vi.mock("@/server/auth/rate-limit", async (orig) => ({ ...(await orig<object>()), hitRateLimit: vi.fn(async () => ({ allowed: true, count: 1 })) }));

import { POST as webhook } from "@/app/api/v1/webhooks/higgsfield/[renderId]/route";
import { PRESENTER_MODEL } from "@/server/reels/router";
import { packageHash } from "@/server/services/publishing";
import { registerPostLink, reelDetail, sendReel } from "@/server/reels/service";

const scope = { workspaceId: "w1", brandId: "b1", userId: "u1" };
const reel = (status: string, body: object = { videoKey: "w1/b1/r.mp4" }) => {
  m.tx.contentItem.findFirst.mockResolvedValue({ id: "i1", channel: "INSTAGRAM_REEL", status, studio: true, versions: [{ id: "v1", version: 3, body }] });
  // Downloading approved this version, so its approval holds.
  m.tx.approvalDecision.findFirst.mockResolvedValue({ verdict: "APPROVED", contentVersionId: "v1", packageHash: packageHash({ id: "i1", channel: "INSTAGRAM_REEL" }, { id: "v1", body }), productOverride: null });
};

beforeEach(() => {
  vi.clearAllMocks();
  m.tx.publicationAttempt.findFirst.mockResolvedValue(null);
});

describe("registerPostLink", () => {
  it("rejects a link that isn't an Instagram post", async () => {
    reel("APPROVED");
    await expect(registerPostLink(scope, "i1", "https://evil.example/reel/abc")).rejects.toThrow(/link of the post/);
  });

  it("rejects a reel that was never approved", async () => {
    reel("AWAITING_APPROVAL");
    await expect(registerPostLink(scope, "i1", "https://www.instagram.com/reel/abc/")).rejects.toThrow(/Download the reel first/);
  });

  it("rejects a reel that is scheduled to post by itself", async () => {
    reel("SCHEDULED");
    await expect(registerPostLink(scope, "i1", "https://www.instagram.com/reel/abc/")).rejects.toThrow(/scheduled/);
  });

  it("is a 404 for a post that isn't a studio reel", async () => {
    reel("APPROVED");
    m.tx.contentItem.findFirst.mockResolvedValue({ id: "i1", channel: "INSTAGRAM_POST", status: "APPROVED", studio: false, versions: [{ id: "v1", version: 3, body: {} }] });
    await expect(registerPostLink(scope, "i1", "https://www.instagram.com/p/abc/")).rejects.toMatchObject({ status: 404 });
    expect(m.tx.contentItem.update).not.toHaveBeenCalled();
  });

  it("records an approved reel's post link as published", async () => {
    reel("APPROVED");
    await registerPostLink(scope, "i1", "https://www.instagram.com/reel/abc/");
    expect(m.tx.contentItem.update).toHaveBeenCalledWith({ where: { id: "i1" }, data: { status: "PUBLISHED", byHand: false, postUrl: "https://www.instagram.com/reel/abc/" } });
  });
});

describe("sendReel", () => {
  it("approves on the first download and not again on the second", async () => {
    reel("AWAITING_APPROVAL");
    await expect(sendReel(scope, "i1", 3)).resolves.toEqual({ videoUrl: "https://s3/w1/b1/r.mp4", downloadUrl: "https://s3/w1/b1/r.mp4#reel-i1.mp4" });
    expect(m.decide).toHaveBeenCalledTimes(1);
    reel("APPROVED");
    await sendReel(scope, "i1", 3);
    expect(m.decide).toHaveBeenCalledTimes(1);
  });

  it("names the download after the first 8 characters of the reel id", async () => {
    m.tx.contentItem.findFirst.mockResolvedValue({ id: "ckv9x1y2z3a4", status: "APPROVED", studio: true, versions: [{ id: "v1", version: 3, body: { videoKey: "w1/b1/r.mp4" } }] });
    expect((await sendReel(scope, "ckv9x1y2z3a4", 3)).downloadUrl).toBe("https://s3/w1/b1/r.mp4#reel-ckv9x1y2.mp4");
  });

  it("waits for the checks before anything can be sent", async () => {
    reel("DRAFT_REVIEW");
    await expect(sendReel(scope, "i1", 3)).rejects.toThrow(/checks are still running/);
  });
});

describe("reelDetail captions", () => {
  const scene = (voiceText: string) => ({ shot: "s", direction: "d", onScreenText: "", voiceText, photoKey: "w1/b1/p.jpg" });
  const plan = (extra: object = {}) => ({ title: "T", presenter: "none", template: "", voice: "v", scenes: [scene("Hello there"), scene("  "), scene("Bye")], caption: "c", hashtags: [], ...extra });
  const outputs = { voiceSeconds: [3.2, 1, 20], models: ["kling-3-std", PRESENTER_MODEL, "kling-3-std"], clipSeconds: [5, 5, 10] };
  const latest = (version: number, body: object) => m.prisma.contentItem.findFirst.mockResolvedValue({ id: "i1", title: "T", status: "AWAITING_APPROVAL", postUrl: null, scheduledFor: null, brief: null, versions: [{ version, body, checks: [] }] });
  const cues = [{ start: 0, end: 4, text: "Hello there" }, { start: 8, end: 18, text: "Bye" }];

  it("captions come from the DONE render with the body's videoKey", async () => {
    latest(3, plan({ videoKey: "w1/b1/r.mp4" }));
    m.prisma.reelRender.findFirst.mockResolvedValue({ outputs });
    const d = await reelDetail({ workspaceId: "w1", brandId: "b1" }, "i1");
    expect(m.prisma.reelRender.findFirst).toHaveBeenCalledWith({ where: { contentItemId: "i1", videoKey: "w1/b1/r.mp4", step: "DONE" }, select: { outputs: true } });
    expect(d.captions).toEqual(cues);
  });

  it("a caption edit's version keeps its cues", async () => {
    latest(5, plan({ videoKey: "w1/b1/r.mp4", caption: "edited" }));
    m.prisma.reelRender.findFirst.mockResolvedValue({ outputs });
    expect((await reelDetail({ workspaceId: "w1", brandId: "b1" }, "i1")).captions).toEqual(cues);
  });

  it("no video, or outputs without voiceSeconds, gives null", async () => {
    latest(3, plan());
    expect((await reelDetail({ workspaceId: "w1", brandId: "b1" }, "i1")).captions).toBeNull();
    expect(m.prisma.reelRender.findFirst).not.toHaveBeenCalled();
    latest(3, plan({ videoKey: "w1/b1/r.mp4" }));
    m.prisma.reelRender.findFirst.mockResolvedValue({ outputs: { models: [] } });
    expect((await reelDetail({ workspaceId: "w1", brandId: "b1" }, "i1")).captions).toBeNull();
    m.prisma.reelRender.findFirst.mockResolvedValue(null);
    expect((await reelDetail({ workspaceId: "w1", brandId: "b1" }, "i1")).captions).toBeNull();
  });
});

describe("higgsfield webhook", () => {
  const call = (id: string, s: string) => webhook(new Request(`https://app/api/v1/webhooks/higgsfield/${id}?s=${s}`, { method: "POST", body: "{}" }), { params: Promise.resolve({ renderId: id }) });

  it("ignores a wrong secret and says nothing", async () => {
    m.tx.reelRender.findUnique.mockResolvedValue({ id: "r1abcdefghij", step: "CLIPS", webhookSecret: "a".repeat(64) });
    const res = await call("r1abcdefghij", "b".repeat(64));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(m.enqueueTick).not.toHaveBeenCalled();
  });

  it("doesn't nudge a render that is joining (the join is already running)", async () => {
    m.tx.reelRender.findUnique.mockResolvedValue({ id: "r1abcdefghij", step: "JOIN", webhookSecret: "a".repeat(64) });
    await call("r1abcdefghij", "a".repeat(64));
    expect(m.enqueueTick).not.toHaveBeenCalled();
  });

  it("nudges the render on the right secret", async () => {
    m.tx.reelRender.findUnique.mockResolvedValue({ id: "r1abcdefghij", step: "CLIPS", webhookSecret: "a".repeat(64) });
    await call("r1abcdefghij", "a".repeat(64));
    expect(m.enqueueTick).toHaveBeenCalledTimes(1);
  });
});
