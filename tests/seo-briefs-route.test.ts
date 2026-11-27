import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ perms: new Set<string>(), write: vi.fn() }));
vi.mock("@/server/db/prisma", () => ({ prisma: {} }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: async () => ({ userId: "u1", workspaceId: "w1", brandId: "b1", perms: m.perms }) }));
vi.mock("@/server/seo/briefs", async (orig) => ({ ...(await orig<object>()), writeSeoBrief: m.write }));

import { POST } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/seo/briefs/route";

const call = (body: unknown) =>
  POST(new Request("http://x/seo/briefs", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ workspaceId: "w1", brandId: "b1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  m.write.mockResolvedValue({ taskId: "t1", existed: false, kind: "website" });
});

describe("POST seo/briefs", () => {
  it("needs analytics.read beside tasks.manage: 403 without it, nothing written", async () => {
    m.perms = new Set(["tasks.manage"]);
    expect((await call({ from: "declines", alertIds: ["a"] })).status).toBe(403);
    expect(m.write).not.toHaveBeenCalled();
  });

  it("400 on a bad body; 201 for a new task, 200 when the brief went into an open one", async () => {
    m.perms = new Set(["tasks.manage", "analytics.read"]);
    expect((await call({ from: "declines", alertIds: [] })).status).toBe(400);
    expect((await call({ from: "declines", alertIds: ["a"] })).status).toBe(201);
    m.write.mockResolvedValue({ taskId: "t1", existed: true, kind: "content" });
    const res = await call({ from: "finding", reportId: "r", findingId: "f" });
    expect([res.status, await res.json()]).toEqual([200, { taskId: "t1", existed: true, kind: "content" }]);
  });
});
