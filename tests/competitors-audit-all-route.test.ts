import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ authorize: vi.fn(), auditAll: vi.fn(), kick: vi.fn(), limit: vi.fn() }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: m.authorize }));
vi.mock("@/server/services/competitor-audits", () => ({ auditAllCompetitors: m.auditAll }));
vi.mock("@/server/jobs/runner", () => ({ kickRunner: m.kick }));
vi.mock("@/server/auth/rate-limit", () => ({ hitRateLimit: m.limit }));

import { POST } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/competitors/audit-all/route";
import { AccessDeniedError } from "@/server/auth/errors";

const params = Promise.resolve({ workspaceId: "w1", brandId: "b1" });
const post = (body: unknown) => POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), { params });

beforeEach(() => {
  vi.clearAllMocks();
  m.authorize.mockResolvedValue({ userId: "u1", workspaceId: "w1", brandId: "b1" });
  m.limit.mockResolvedValue({ allowed: true });
  m.auditAll.mockResolvedValue({ started: ["c1"], skipped: [{ id: "c2", reason: "credits" }], balance: 0 });
});

describe("POST /competitors/audit-all", () => {
  it("needs agents.run, as a single audit does, and starts nothing without it", async () => {
    m.authorize.mockRejectedValue(new AccessDeniedError("Missing permission agents.run"));
    const res = await post({ competitorIds: ["c1"] });
    expect(res.status).toBe(403);
    expect(m.authorize).toHaveBeenCalledWith(expect.any(Request), params, "agents.run");
    expect(m.auditAll).not.toHaveBeenCalled();
  });

  it("starts the given ids in order and kicks the runner once", async () => {
    const res = await post({ competitorIds: ["c1", "c2"] });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ started: ["c1"], skipped: [{ id: "c2", reason: "credits" }], balance: 0 });
    expect(m.auditAll).toHaveBeenCalledWith({ userId: "u1", workspaceId: "w1", brandId: "b1", competitorIds: ["c1", "c2"] });
    expect(m.kick).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty list and a rate-limited caller without starting anything", async () => {
    expect((await post({ competitorIds: [] })).status).toBe(422);
    m.limit.mockResolvedValue({ allowed: false });
    expect((await post({ competitorIds: ["c1"] })).status).toBe(429);
    expect(m.auditAll).not.toHaveBeenCalled();
  });
});
