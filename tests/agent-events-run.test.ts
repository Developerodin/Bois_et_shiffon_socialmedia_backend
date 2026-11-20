import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ agentEvent: { findMany: vi.fn(async (_a: { where: object; orderBy: object; take: number }) => [] as unknown[]) } }));
vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: async () => ({ userId: "u1", workspaceId: "w1", brandId: "b1", perms: new Set(["agents.read"]) }) }));

import { GET } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/agent-events/route";

const call = (qs: string) => GET(new Request(`http://x/agent-events${qs}`), { params: Promise.resolve({ workspaceId: "w1", brandId: "b1" }) });

beforeEach(() => vi.clearAllMocks());

describe("GET /agent-events?runId", () => {
  it("reads one run's events, oldest first, up to 200, scoped to the brand, ignoring a cursor", async () => {
    db.agentEvent.findMany.mockResolvedValue([{ id: 5, runId: "run_1-a", agentKey: "creator", createdAt: new Date("2026-11-20T10:00:00Z"), level: "INFO", message: "m", entityType: "ContentItem", entityId: "c1" }]);
    const res = await call("?runId=run_1-a&after=3&limit=5");
    expect(db.agentEvent.findMany).toHaveBeenCalledTimes(1);
    expect(db.agentEvent.findMany).toHaveBeenCalledWith({ where: { workspaceId: "w1", brandId: "b1", runId: "run_1-a" }, orderBy: { id: "asc" }, take: 200 });
    expect((await res.json()).events[0]).toEqual({ id: "5", runId: "run_1-a", agentKey: "creator", createdAt: "2026-11-20T10:00:00.000Z", level: "INFO", message: "m", entityType: "ContentItem", entityId: "c1" });
  });

  it("refuses a runId that is too long or has other characters, with a 400", async () => {
    for (const bad of ["a".repeat(41), "a b", "a%2Fb", "a;b", "é", ""]) {
      expect((await call(`?runId=${encodeURIComponent(bad)}`)).status).toBe(400);
    }
    expect(db.agentEvent.findMany).not.toHaveBeenCalled();
  });

  it("accepts 40 characters, and without runId reads as before", async () => {
    expect((await call(`?runId=${"a".repeat(40)}`)).status).toBe(200);
    db.agentEvent.findMany.mockClear();
    await call("?after=7");
    expect(db.agentEvent.findMany).toHaveBeenCalledWith({ where: { workspaceId: "w1", brandId: "b1", id: { gt: 7 } }, orderBy: { id: "asc" }, take: 100 });
  });
});
