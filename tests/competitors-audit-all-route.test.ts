import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ authorize: vi.fn(), queue: vi.fn(), kick: vi.fn(), limit: vi.fn() }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: m.authorize }));
vi.mock("@/server/services/competitor-audits", () => ({ queueAuditAll: m.queue }));
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
  m.queue.mockResolvedValue({ queued: ["c1"], skipped: [{ id: "c2", reason: "not-tracked" }] });
});

describe("POST /competitors/audit-all", () => {
  it("needs agents.run, as a single audit does, and starts nothing without it", async () => {
    m.authorize.mockRejectedValue(new AccessDeniedError("Missing permission agents.run"));
    const res = await post({ competitorIds: ["c1"], pressId: "press-0001" });
    expect(res.status).toBe(403);
    expect(m.authorize).toHaveBeenCalledWith(expect.any(Request), params, "agents.run");
    expect(m.queue).not.toHaveBeenCalled();
  });

  it("queues the given ids in order for the job and answers without starting a run itself", async () => {
    const res = await post({ competitorIds: ["c1", "c2"], pressId: "press-0001" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: ["c1"], skipped: [{ id: "c2", reason: "not-tracked" }] });
    expect(m.queue).toHaveBeenCalledWith({ userId: "u1", workspaceId: "w1", brandId: "b1", competitorIds: ["c1", "c2"], pressId: "press-0001" });
    // The runner picks the job up after the response.
    expect(m.kick).toHaveBeenCalledTimes(1);
  });

  it("doesn't kick the runner when nothing was queued", async () => {
    m.queue.mockResolvedValue({ queued: [], skipped: [{ id: "c9", reason: "not-tracked" }] });
    const res = await post({ competitorIds: ["c9"], pressId: "press-0002" });
    expect(res.status).toBe(200);
    expect(m.kick).not.toHaveBeenCalled();
  });

  it("refuses an empty list, a missing press id and a rate-limited caller without queuing anything", async () => {
    expect((await post({ competitorIds: [], pressId: "press-0001" })).status).toBe(422);
    expect((await post({ competitorIds: ["c1"] })).status).toBe(422);
    m.limit.mockResolvedValue({ allowed: false });
    expect((await post({ competitorIds: ["c1"], pressId: "press-0001" })).status).toBe(429);
    expect(m.queue).not.toHaveBeenCalled();
  });
});
