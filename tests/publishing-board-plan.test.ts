import { beforeEach, describe, expect, it, vi } from "vitest";

// A Pinterest Pin's planned board: setting it, and scheduling on another board moving it. Mock pattern:
// tests/publishing-offers.test.ts.
const db = vi.hoisted(() => {
  const d = {
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (arg: unknown): Promise<unknown> => (typeof arg === "function" ? (arg as (tx: unknown) => unknown)(d) : Promise.all(arg as unknown[]))),
    contentItem: { findFirst: vi.fn(), update: vi.fn(async () => ({})) },
    approvalDecision: { findFirst: vi.fn(), findMany: vi.fn(async (): Promise<object[]> => []) },
    auditEvent: { create: vi.fn(async () => ({})) },
    publicationAttempt: { findFirst: vi.fn(async () => null), create: vi.fn(async ({ data }: { data: object }) => ({ id: "a-new", ...data })), findMany: vi.fn(async (): Promise<object[]> => []) },
    integrationConnection: { findFirst: vi.fn(), findMany: vi.fn(async (): Promise<object[]> => []) },
    user: { findMany: vi.fn(async (): Promise<object[]> => []) },
    brand: { findFirst: vi.fn(async () => ({ profile: { timeZone: "UTC" }, campaigns: [] })) },
  };
  return d;
});

vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/catalog/linked", () => ({ linkedProducts: vi.fn(async () => []) }));
vi.mock("@/server/auth/permissions", () => ({ requirePermission: vi.fn(async () => undefined), hasOtherApprover: vi.fn(async () => true) }));
vi.mock("@/server/services/connections", () => ({ accessToken: vi.fn(), markReconnect: vi.fn(), ReconnectNeeded: class extends Error {} }));
vi.mock("@/server/jobs/queue", () => ({ enqueueJob: vi.fn() }));

import { packageHash, releaseState, schedulePublication, setPlannedBoard } from "@/server/services/publishing";

const scope = { workspaceId: "w1", brandId: "b1", userId: "u1" };
const latest = { id: "v2", version: 2, body: { caption: "Pin it", pinTitle: "Oak" }, createdBy: "writer", checks: [{ overall: "PASS", results: [] }] };
const pin = (over: object = {}) => ({ id: "i1", workspaceId: "w1", brandId: "b1", channel: "PINTEREST_PIN", status: "APPROVED", studio: false, title: "Oak", productIds: [], campaignId: null, scheduledFor: null, plannedBoardId: null, plannedBoardName: null, versions: [latest], ...over });
const updated = () => (db.contentItem.update.mock.calls.at(-1) as unknown as [{ data: Record<string, unknown> }])[0].data;
const schedule = (boardId: string, boardName?: string) =>
  schedulePublication({ ...scope, itemId: "i1", version: 2, connectionId: "conn", boardId, boardName, imageUrl: "https://x.test/a.jpg", runAt: new Date(Date.now() + 86_400_000) });

beforeEach(() => {
  vi.clearAllMocks();
  db.approvalDecision.findFirst.mockResolvedValue({ id: "d1", verdict: "APPROVED", contentVersionId: "v2", packageHash: packageHash({ id: "i1", channel: "PINTEREST_PIN" }, latest), productOverride: null });
  db.integrationConnection.findFirst.mockResolvedValue({ id: "conn", provider: "PINTEREST" });
});

describe("setPlannedBoard", () => {
  it("plans a board on a pin and audits it", async () => {
    db.contentItem.findFirst.mockResolvedValue(pin());
    await setPlannedBoard(scope, "i1", { id: "bd1", name: "Living room" });
    expect(updated()).toEqual({ plannedBoardId: "bd1", plannedBoardName: "Living room" });
    expect(db.auditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "content.board", metadata: { from: null, to: "bd1" } }) });
  });
  it("clears it", async () => {
    db.contentItem.findFirst.mockResolvedValue(pin({ plannedBoardId: "bd1", plannedBoardName: "Living room" }));
    await setPlannedBoard(scope, "i1", null);
    expect(updated()).toEqual({ plannedBoardId: null, plannedBoardName: null });
  });
  it("leaves an unchanged plan alone", async () => {
    db.contentItem.findFirst.mockResolvedValue(pin({ plannedBoardId: "bd1", plannedBoardName: "Living room" }));
    await setPlannedBoard(scope, "i1", { id: "bd1", name: "Living room" });
    expect(db.contentItem.update).not.toHaveBeenCalled();
    expect(db.auditEvent.create).not.toHaveBeenCalled();
  });
  it("refuses another channel, a scheduled pin and a missing post", async () => {
    db.contentItem.findFirst.mockResolvedValue(pin({ channel: "FACEBOOK_POST" }));
    await expect(setPlannedBoard(scope, "i1", { id: "bd1", name: "x" })).rejects.toMatchObject({ status: 400 });
    db.contentItem.findFirst.mockResolvedValue(pin({ status: "SCHEDULED" }));
    await expect(setPlannedBoard(scope, "i1", { id: "bd1", name: "x" })).rejects.toMatchObject({ status: 409 });
    db.contentItem.findFirst.mockResolvedValue(pin({ status: "PUBLISHED" }));
    await expect(setPlannedBoard(scope, "i1", null)).rejects.toMatchObject({ status: 409 });
    db.contentItem.findFirst.mockResolvedValue(null);
    await expect(setPlannedBoard(scope, "i1", null)).rejects.toMatchObject({ status: 404 });
    expect(db.contentItem.update).not.toHaveBeenCalled();
  });
  it("reads only the brand's own post", async () => {
    db.contentItem.findFirst.mockResolvedValue(pin());
    await setPlannedBoard(scope, "i1", null);
    expect(db.contentItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "i1", workspaceId: "w1", brandId: "b1" } }));
  });
});

describe("scheduling a pin and its planned board", () => {
  it("keeps the plan when scheduled on the planned board", async () => {
    db.contentItem.findFirst.mockResolvedValue(pin({ plannedBoardId: "bd1", plannedBoardName: "Living room" }));
    await schedule("bd1", "Living room");
    expect(updated()).not.toHaveProperty("plannedBoardId");
  });
  it("moves the plan to the board it is scheduled on", async () => {
    db.contentItem.findFirst.mockResolvedValue(pin({ plannedBoardId: "bd1", plannedBoardName: "Living room" }));
    await schedule("bd2", " Kitchen ");
    expect(updated()).toMatchObject({ status: "SCHEDULED", plannedBoardId: "bd2", plannedBoardName: "Kitchen" });
  });
  it("clears the plan rather than leave it wrong when no name comes with another board", async () => {
    db.contentItem.findFirst.mockResolvedValue(pin({ plannedBoardId: "bd1", plannedBoardName: "Living room" }));
    await schedule("bd2");
    expect(updated()).toMatchObject({ status: "SCHEDULED", plannedBoardId: null, plannedBoardName: null });
  });
});

describe("releaseState", () => {
  it("sends the planned board, or null", async () => {
    db.contentItem.findFirst.mockResolvedValue(pin({ plannedBoardId: "bd1", plannedBoardName: "Living room" }));
    expect((await releaseState(scope, "i1", new Set())).plannedBoard).toEqual({ id: "bd1", name: "Living room" });
    db.contentItem.findFirst.mockResolvedValue(pin());
    expect((await releaseState(scope, "i1", new Set())).plannedBoard).toBeNull();
  });
});
