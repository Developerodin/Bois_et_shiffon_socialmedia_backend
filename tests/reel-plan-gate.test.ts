import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  requirePlan: vi.fn(),
  limit: vi.fn(),
  claim: vi.fn(),
  drop: vi.fn(),
  write: vi.fn(),
  item: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
}));
vi.mock("@/server/services/subscriptions", async (orig) => ({ ...(await orig<object>()), requirePlan: m.requirePlan }));
vi.mock("@/server/auth/rate-limit", async (orig) => ({ ...(await orig<object>()), hitRateLimit: m.limit }));
vi.mock("@/server/db/transient", () => ({ claimTransient: m.claim, dropTransient: m.drop }));
vi.mock("@/server/reels/agents", () => ({ writePlan: m.write, directScenes: vi.fn() }));
vi.mock("@/server/content/knowledge", () => ({ brandKnowledge: vi.fn(async () => ({ text: "" })), productPhotos: vi.fn(async () => [{ key: "w1/b1/p.jpg", title: "P" }]) }));
vi.mock("@/server/db/prisma", () => ({ prisma: { contentItem: m.item, opportunity: { findFirst: vi.fn() } } }));
vi.mock("@/server/reels/presenters", () => ({ donePresenter: vi.fn() }));
vi.mock("@/server/reels/ownership", () => ({ planOwnershipProblems: vi.fn(async () => []) }));
vi.mock("@/server/reels/recordings", () => ({ settleRecordings: vi.fn() }));
vi.mock("@/server/reels/render", async (orig) => ({ ...(await orig<object>()), renderView: vi.fn(), renderFailure: vi.fn() }));

import { chatPlan, createReel, editPlan } from "@/server/reels/service";
import { PlanRequiredError } from "@/server/services/subscriptions";

const scope = { workspaceId: "w1", brandId: "b1", userId: "u1" };
const RID = "6f1c2c1e-6a43-4c1b-9a3e-2f1d5b7c8a90";
const WROTE = new Error("scriptwriter ran");

beforeEach(() => {
  vi.clearAllMocks();
  m.requirePlan.mockResolvedValue(undefined);
  m.limit.mockResolvedValue({ allowed: true, count: 1 });
  m.claim.mockResolvedValue(true);
  m.drop.mockResolvedValue(undefined);
  m.write.mockRejectedValue(WROTE);
  m.item.findUnique.mockResolvedValue(null);
  m.item.findFirst.mockResolvedValue({ id: "i1", brief: {}, versions: [] });
});

describe("reel planning gate", () => {
  it("needs a plan before the scriptwriter runs", async () => {
    m.requirePlan.mockRejectedValue(new PlanRequiredError());
    await expect(createReel(scope, { prompt: "x" })).rejects.toBeInstanceOf(PlanRequiredError);
    await expect(chatPlan(scope, "i1", { version: 1, message: "x" })).rejects.toBeInstanceOf(PlanRequiredError);
    expect(m.write).not.toHaveBeenCalled();
  });

  it("caps scriptwriter runs per brand per hour", async () => {
    m.limit.mockResolvedValue({ allowed: false, count: 21 });
    await expect(createReel(scope, { prompt: "x" })).rejects.toMatchObject({ status: 429 });
    await expect(chatPlan(scope, "i1", { version: 1, message: "x" })).rejects.toMatchObject({ status: 429 });
    expect(m.write).not.toHaveBeenCalled();
    expect(m.limit.mock.calls[0].slice(1)).toEqual([20, 3_600_000]);
    expect(m.limit.mock.calls[0][0]).toMatch(/^reel-plan:brand:/);
  });

  it("checks the plan on edits but doesn't count them", async () => {
    m.requirePlan.mockRejectedValue(new PlanRequiredError());
    await expect(editPlan(scope, "i1", { version: 1, plan: {} as never })).rejects.toBeInstanceOf(PlanRequiredError);
    expect(m.limit).not.toHaveBeenCalled();
  });

  it("runs once per request id: a repeat while planning is a 409", async () => {
    m.claim.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const first = createReel(scope, { prompt: "x", requestId: RID });
    const second = createReel(scope, { prompt: "x", requestId: RID });
    await expect(first).rejects.toBe(WROTE);
    await expect(second).rejects.toMatchObject({ status: 409, code: "reel.stillPlanning" });
    expect(m.write).toHaveBeenCalledTimes(1);
    expect(m.claim.mock.calls[0]).toEqual([`reel-plan:${RID}`, expect.anything(), 360_000]);
    expect(m.drop).toHaveBeenCalledWith(`reel-plan:${RID}`);
  });

  it("returns the stored plan for a finished request id, without the scriptwriter", async () => {
    m.item.findUnique.mockResolvedValue({ id: RID, workspaceId: "w1", brandId: "b1", studio: true });
    const scene = { photoKey: "w1/b1/0b4b2c1e-6a1d-4f7e-9a40-0c6f2d8e1a11.jpg", shot: "Wide", direction: "Slow push in", onScreenText: "Acacia", voiceText: "un deux trois quatre cinq" };
    const body = { title: "Bunting", presenter: "none", template: "spotlight", voice: "fr-1", scenes: [scene, scene], caption: "Une table.", hashtags: ["#bois"] };
    m.item.findFirst.mockResolvedValue({ id: RID, brief: { reelChat: [{ role: "user", text: "x", at: "" }, { role: "assistant", text: "Here it is", at: "" }] }, versions: [{ version: 2, body }] });
    const r = await createReel(scope, { prompt: "x", requestId: RID });
    expect(r).toMatchObject({ id: RID, version: 2, reply: "Here it is", plan: { title: "Bunting" } });
    expect(r.price).toEqual(expect.any(Number));
    expect(m.write).not.toHaveBeenCalled();
    expect(m.claim).not.toHaveBeenCalled();
  });

  it("refuses another brand's request id", async () => {
    m.item.findUnique.mockResolvedValue({ id: RID, workspaceId: "w2", brandId: "b9", studio: true });
    await expect(createReel(scope, { prompt: "x", requestId: RID })).rejects.toMatchObject({ status: 409, code: "request.idTaken" });
    expect(m.write).not.toHaveBeenCalled();
  });
});
