import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  shoot: { findUnique: vi.fn(), create: vi.fn() },
  spend: vi.fn(),
  refund: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock("@/server/db/prisma", () => ({ prisma: { photoShoot: m.shoot } }));
vi.mock("@/server/services/credits", () => ({ spendCredits: m.spend, refundCharge: m.refund }));
vi.mock("@/server/services/subscriptions", () => ({ requirePlan: vi.fn(async () => {}) }));
vi.mock("@/server/jobs/queue", () => ({ enqueueJob: m.enqueue }));
vi.mock("@/server/storage/media", () => ({ mediaKey: vi.fn(), putMedia: vi.fn(), signedMediaUrl: vi.fn() }));
vi.mock("@/server/reels/higgsfield", () => ({ fetchResult: vi.fn(), higgsfield: {} }));
vi.mock("sharp", () => ({ default: Object.assign(vi.fn(), { concurrency: vi.fn(), cache: vi.fn() }) }));

import { createShoot } from "@/server/photoshoot/shoot";

const scope = { workspaceId: "w1", brandId: "b1", userId: "u1" };
const req = { kind: "product", tier: "base", sourceKey: "w1/b1/a.jpg", ratio: "4:5", scene: "studio", brief: "" } as const;
const RID = "6f1c2c1e-6a43-4c1b-9a3e-2f1d5b7c8a90";
const p2002 = Object.assign(new Error("unique"), { code: "P2002" });

beforeEach(() => {
  vi.clearAllMocks();
  m.spend.mockResolvedValue(RID);
  m.enqueue.mockResolvedValue({});
  m.shoot.findUnique.mockResolvedValue(null);
  m.shoot.create.mockImplementation(async ({ data }: { data: object }) => data);
});

describe("photoshoot request ids", () => {
  it("uses the request id as the shoot id and the charge ref", async () => {
    const { shoot, repeated } = await createShoot(scope, req, RID);
    expect(repeated).toBe(false);
    expect(shoot.id).toBe(RID);
    expect(m.spend.mock.calls[0][0]).toMatchObject({ refId: RID });
  });

  it("returns the first shoot on a repeat, without charging", async () => {
    m.shoot.findUnique.mockResolvedValue({ id: RID, workspaceId: "w1", brandId: "b1" });
    const { shoot, repeated } = await createShoot(scope, req, RID);
    expect(repeated).toBe(true);
    expect(shoot.id).toBe(RID);
    expect(m.spend).not.toHaveBeenCalled();
    expect(m.shoot.create).not.toHaveBeenCalled();
  });

  it("never hands back or charges for another workspace's shoot", async () => {
    m.shoot.findUnique.mockResolvedValue({ id: RID, workspaceId: "w2", brandId: "b9" });
    await expect(createShoot(scope, req, RID)).rejects.toMatchObject({ status: 409, code: "request.idTaken" });
    expect(m.spend).not.toHaveBeenCalled();
  });

  it("losing a create race returns the winner and keeps its charge", async () => {
    m.shoot.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: RID, workspaceId: "w1", brandId: "b1" });
    m.shoot.create.mockRejectedValue(p2002);
    const { repeated } = await createShoot(scope, req, RID);
    expect(repeated).toBe(true);
    expect(m.refund).not.toHaveBeenCalled();
  });

  it("works as before without a request id", async () => {
    const { shoot, repeated } = await createShoot(scope, req);
    expect(repeated).toBe(false);
    expect(shoot.id).not.toBe(RID);
    expect(m.shoot.findUnique).not.toHaveBeenCalled();
  });
});
