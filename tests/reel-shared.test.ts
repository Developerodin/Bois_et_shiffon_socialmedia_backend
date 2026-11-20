import { beforeEach, describe, expect, it, vi } from "vitest";

// One fake database shared by the services under test; each test sets what it needs.
const db = vi.hoisted(() => {
  const fn = () => vi.fn();
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    contentItem: { findFirst: fn(), update: fn(), findMany: fn() },
    contentVersion: { create: fn() },
    approvalDecision: { create: fn(), findFirst: fn() },
    auditEvent: { create: fn() },
    creditEntry: { aggregate: fn(), create: fn(), createMany: fn(), findFirst: fn() },
    integrationConnection: { findFirst: fn() },
    publicationAttempt: { findFirst: fn(), create: fn() },
  };
  return { tx, prisma: { ...tx, $transaction: vi.fn(async (f: (t: typeof tx) => unknown) => f(tx)) } };
});
vi.mock("@/server/db/prisma", () => ({ prisma: db.prisma }));
vi.mock("@/server/jobs/queue", () => ({ enqueueJob: vi.fn(async () => ({})) }));
const approvers = vi.hoisted(() => ({ other: true }));
vi.mock("@/server/auth/permissions", () => ({ hasOtherApprover: vi.fn(async () => approvers.other), isClientReviewer: vi.fn(async () => false) }));

import { hasOtherApprover } from "@/server/auth/permissions";
import { creatorAgent } from "@/server/agents/definitions/creator";
import { briefAgent } from "@/server/agents/definitions/brief";
import { qualityAgent } from "@/server/agents/definitions/quality";
import { checkDraft } from "@/server/content/rules";
import { spendCredits } from "@/server/services/credits";
import { decide, saveDraft, schedulePublication } from "@/server/services/publishing";
import { wordCount } from "@/shared";

const scope = { workspaceId: "w1", brandId: "b1" };
const item = (over: object = {}) => ({ id: "i1", ...scope, channel: "INSTAGRAM_REEL", status: "AWAITING_APPROVAL", studio: true, ...over });
const version = (over: object = {}) => ({ id: "v1", version: 3, createdBy: "u1", body: { caption: "a", hashtags: [], script: ["x", "y"] }, checks: [{ overall: "PASS" }], ...over });
const withLatest = (i: object, v: object) => db.tx.contentItem.findFirst.mockResolvedValue({ ...i, versions: [v] });

beforeEach(() => {
  vi.clearAllMocks();
  // Queued once-values would leak between tests (clearAllMocks keeps them).
  db.tx.creditEntry.findFirst.mockReset();
  db.tx.creditEntry.create.mockReset();
  db.tx.creditEntry.createMany.mockResolvedValue({ count: 0 });
  db.tx.creditEntry.aggregate.mockResolvedValue({ _sum: { delta: 100 } });
});

describe("credits for reels", () => {
  it("spend with refId is idempotent", async () => {
    db.tx.creditEntry.findFirst.mockResolvedValue({ id: "c1", refId: "v1:1", delta: -40 });
    await expect(spendCredits({ ...scope, amount: 40, reason: "reel-render", refId: "v1:1" })).resolves.toBe("v1:1");
    expect(db.tx.creditEntry.create).not.toHaveBeenCalled();
  });

  it("a double tap that waited on the lock finds the first charge instead of failing on balance", async () => {
    db.tx.creditEntry.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "c1", refId: "v1:1", delta: -40 });
    db.tx.creditEntry.aggregate.mockResolvedValue({ _sum: { delta: 10 } }); // after the first tap's charge
    await expect(spendCredits({ ...scope, amount: 40, reason: "reel-render", refId: "v1:1" })).resolves.toBe("v1:1");
    expect(db.tx.creditEntry.create).not.toHaveBeenCalled();
  });

  it("unlimited workspaces: a concurrent duplicate charge isn't an error", async () => {
    vi.stubEnv("UNLIMITED_CREDIT_WORKSPACES", "w1");
    db.tx.creditEntry.findFirst.mockResolvedValue(null);
    db.tx.creditEntry.create.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    await expect(spendCredits({ ...scope, amount: 40, reason: "reel-render", refId: "v1:1" })).resolves.toBe("v1:1");
    vi.unstubAllEnvs();
  });

  it("different attempt refIds both charge", async () => {
    db.tx.creditEntry.findFirst.mockResolvedValue(null);
    await spendCredits({ ...scope, amount: 40, reason: "reel-render", refId: "v1:1" });
    await spendCredits({ ...scope, amount: 40, reason: "reel-render", refId: "v1:2" });
    expect(db.tx.creditEntry.create).toHaveBeenCalledTimes(2);
    expect(db.tx.creditEntry.create.mock.calls[1][0].data).toMatchObject({ delta: -40, refId: "v1:2" });
  });
});

describe("studio reels in the publishing flow", () => {
  it("saveDraft keeps reel fields", async () => {
    withLatest(item({ status: "AWAITING_APPROVAL" }), version({ body: { caption: "a", hashtags: [], scenes: [{ voiceText: "x" }], videoKey: "w1/b1/x.mp4" } }));
    db.tx.contentVersion.create.mockImplementation(async (a: { data: object }) => a.data);
    const body = { hook: "", caption: "b", hashtags: [], slides: [], script: [], pinTitle: "", altText: "" };
    await saveDraft({ ...scope, userId: "u1", itemId: "i1", version: 3, body });
    expect(db.tx.contentVersion.create.mock.calls[0][0].data.body).toMatchObject({ caption: "b", scenes: [{ voiceText: "x" }], videoKey: "w1/b1/x.mp4" });
  });

  describe("saveDraft on a studio reel follows its plan", () => {
    const planBody = { caption: "a", hashtags: [], hook: "Hi", script: ["x", "y"], scenes: [{ onScreenText: "Hi", voiceText: "x" }, { onScreenText: "", voiceText: "y" }] };
    const sent = (over: object = {}) => ({ hook: "evil", caption: "b", hashtags: [], slides: [], script: ["z"], pinTitle: "", altText: "", ...over });
    const save = (body: object, version = 3) => saveDraft({ ...scope, userId: "u1", itemId: "i1", version, body: body as never });
    const created = () => db.tx.contentVersion.create.mock.calls[0][0].data.body;
    beforeEach(() => { db.tx.contentVersion.create.mockImplementation(async (a: { data: object }) => a.data); });

    it("takes hook and script from the scenes", async () => {
      withLatest(item(), version({ body: planBody }));
      await save(sent());
      expect(created()).toMatchObject({ hook: "Hi", script: ["x", "y"], caption: "b" });
    });

    it("leaves a post's sent hook and script alone", async () => {
      withLatest(item({ channel: "INSTAGRAM_POST", studio: false }), version({ body: planBody }));
      await save(sent());
      expect(created()).toMatchObject({ hook: "evil", script: ["z"] });
    });

    const six = ["#a", "#b", "#c", "#d", "#e", "#f"];
    it("a studio reel takes at most 5 hashtags", async () => {
      withLatest(item(), version({ body: planBody }));
      await expect(save(sent({ hashtags: six }))).rejects.toMatchObject({ status: 400, message: "A reel takes at most 5 hashtags." });
      expect(db.tx.contentVersion.create).not.toHaveBeenCalled();
      withLatest(item({ channel: "INSTAGRAM_POST", studio: false }), version({ body: planBody }));
      await save(sent({ hashtags: six }));
      expect(created().hashtags).toHaveLength(6);
    });

    it("a studio reel's hashtag is at most 100 characters with its #", async () => {
      withLatest(item(), version({ body: planBody }));
      await expect(save(sent({ hashtags: ["a".repeat(100)] }))).rejects.toMatchObject({ status: 400, message: "A hashtag takes at most 100 characters." });
      expect(db.tx.contentVersion.create).not.toHaveBeenCalled();
      await save(sent({ hashtags: ["a".repeat(99)] }));
      expect(created().hashtags).toEqual([`#${"a".repeat(99)}`]);
    });

    it("a studio reel's caption is at most 2200 characters", async () => {
      withLatest(item(), version({ body: planBody }));
      await expect(save(sent({ caption: "a".repeat(2201) }))).rejects.toMatchObject({ status: 400, message: "The caption is over 2200 characters." });
      expect(db.tx.contentVersion.create).not.toHaveBeenCalled();
      await save(sent({ caption: "a".repeat(2200) }));
      expect(created().caption).toHaveLength(2200);
    });

    it("a stale version is a draft.changed 409", async () => {
      withLatest(item(), version({ body: planBody }));
      await expect(save(sent(), 2)).rejects.toMatchObject({ status: 409, code: "draft.changed" });
    });
  });

  it("studio author may approve", async () => {
    withLatest(item(), version());
    db.tx.approvalDecision.create.mockResolvedValue({ packageHash: "h" });
    await expect(decide({ ...scope, userId: "u1", itemId: "i1", version: 3, verdict: "APPROVED" })).resolves.toBeTruthy();
  });

  it("non-studio author still may not", async () => {
    withLatest(item({ channel: "INSTAGRAM_POST", studio: false }), version());
    await expect(decide({ ...scope, userId: "u1", itemId: "i1", version: 3, verdict: "APPROVED" })).rejects.toThrow(/someone else/);
  });

  it("non-studio author may when nobody else can approve", async () => {
    approvers.other = false;
    withLatest(item({ channel: "INSTAGRAM_POST", studio: false }), version());
    db.tx.approvalDecision.create.mockResolvedValue({ packageHash: "h" });
    await expect(decide({ ...scope, userId: "u1", itemId: "i1", version: 3, verdict: "APPROVED" })).resolves.toBeTruthy();
    approvers.other = true;
  });

  it("reads the other approvers only when someone approves their own non-studio draft", async () => {
    db.tx.approvalDecision.create.mockResolvedValue({ packageHash: "h" });
    vi.mocked(hasOtherApprover).mockClear();
    withLatest(item({ channel: "INSTAGRAM_POST", studio: false }), version({ createdBy: "agent" }));
    await decide({ ...scope, userId: "u1", itemId: "i1", version: 3, verdict: "APPROVED" });
    withLatest(item(), version());
    await decide({ ...scope, userId: "u1", itemId: "i1", version: 3, verdict: "APPROVED" });
    expect(hasOtherApprover).not.toHaveBeenCalled();
    withLatest(item({ channel: "INSTAGRAM_POST", studio: false }), version());
    await expect(decide({ ...scope, userId: "u1", itemId: "i1", version: 3, verdict: "APPROVED" })).rejects.toThrow(/someone else/);
    expect(hasOtherApprover).toHaveBeenCalledTimes(1);
  });

  it("studio reel schedules with videoKey not client url", async () => {
    const v = version({ body: { caption: "a", hashtags: [], script: ["x", "y"], videoKey: "w1/b1/r.mp4" } });
    withLatest(item({ status: "APPROVED" }), v);
    const { packageHash } = await import("@/server/services/publishing");
    db.tx.approvalDecision.findFirst.mockResolvedValue({ verdict: "APPROVED", contentVersionId: "v1", packageHash: packageHash({ id: "i1", channel: "INSTAGRAM_REEL" }, v) });
    db.tx.integrationConnection.findFirst.mockResolvedValue({ id: "c1", provider: "INSTAGRAM" });
    db.tx.publicationAttempt.findFirst.mockResolvedValue(null);
    db.tx.publicationAttempt.create.mockImplementation(async (a: { data: object }) => ({ ...a.data, runAt: new Date() }));
    await expect(schedulePublication({ ...scope, userId: "u1", itemId: "i1", version: 3, connectionId: "c1", videoUrl: "https://evil.example/x.mp4" })).rejects.toThrow(/video/i);
    await schedulePublication({ ...scope, userId: "u1", itemId: "i1", version: 3, connectionId: "c1" });
    expect(db.tx.publicationAttempt.create.mock.calls[0][0].data.target).toMatchObject({ videoKey: "w1/b1/r.mp4", videoUrl: null });
  });
});

describe("posts publish their approved photos", () => {
  it("refuses other files of the brand than the draft's photoKeys", async () => {
    const v = version({ createdBy: "agent", body: { caption: "a", hashtags: [], photoKeys: ["w1/b1/product-1.jpg"] } });
    withLatest(item({ channel: "INSTAGRAM_POST", status: "APPROVED", studio: false }), v);
    const { packageHash } = await import("@/server/services/publishing");
    db.tx.approvalDecision.findFirst.mockResolvedValue({ verdict: "APPROVED", contentVersionId: "v1", packageHash: packageHash({ id: "i1", channel: "INSTAGRAM_POST" }, v) });
    db.tx.integrationConnection.findFirst.mockResolvedValue({ id: "c1", provider: "INSTAGRAM" });
    db.tx.publicationAttempt.findFirst.mockResolvedValue(null);
    db.tx.publicationAttempt.create.mockImplementation(async (a: { data: object }) => ({ ...a.data, runAt: new Date() }));
    await expect(schedulePublication({ ...scope, userId: "u1", itemId: "i1", version: 3, connectionId: "c1", mediaKeys: ["w1/b1/other.jpg"] })).rejects.toThrow(/approved draft/);
    await schedulePublication({ ...scope, userId: "u1", itemId: "i1", version: 3, connectionId: "c1", mediaKeys: ["w1/b1/product-1.jpg"] });
    expect(db.tx.publicationAttempt.create.mock.calls[0][0].data.target).toMatchObject({ media: ["w1/b1/product-1.jpg"] });
  });
});

describe("reel checks and agents", () => {
  it("rendered reel carries an unresolved visual check", () => {
    const r = checkDraft("INSTAGRAM_REEL", { hook: "h", caption: "Une table en acacia.", hashtags: ["#bois"], script: ["a", "b"], videoKey: "k" });
    expect(r).toContainEqual(expect.objectContaining({ check: "Visual check", status: "warn" }));
  });

  const ctx = { brand: { ...scope }, log: vi.fn() } as never;
  it("creator and brief writer skip studio items", async () => {
    db.tx.contentItem.findMany.mockResolvedValue([]);
    await creatorAgent.run(ctx, {}).catch(() => null);
    await briefAgent.run(ctx, {}).catch(() => null);
    for (const call of db.tx.contentItem.findMany.mock.calls) expect(call[0].where).toMatchObject({ studio: false });
  });

  it("quality can check one named item", async () => {
    expect(qualityAgent.inputSchema.safeParse({ itemId: "i1" }).success).toBe(true);
    db.tx.contentItem.findMany.mockResolvedValue([]);
    await qualityAgent.run({ ...(ctx as object), input: { itemId: "i1" } } as never, { itemId: "i1" }).catch(() => null);
    expect(db.tx.contentItem.findMany.mock.calls[0][0].where).toMatchObject({ id: "i1" });
  });
});

describe("shared word count", () => {
  it("counts words across spaces and new lines, and none in an empty text", () => {
    expect(wordCount("  a  b\nc ")).toBe(3);
    expect(wordCount("")).toBe(0);
  });
});
