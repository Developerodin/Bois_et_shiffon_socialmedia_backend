import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/request-user", () => ({ requestUserId: vi.fn(async () => "u1") }));
vi.mock("@/server/auth/access", async (orig) => ({ ...(await orig<object>()), requireWorkspaceMember: vi.fn(async () => undefined) }));
vi.mock("@/server/services/subscriptions", async (orig) => ({ ...(await orig<object>()), activePlan: vi.fn(async () => null) }));

import { GET } from "@/app/api/v1/workspaces/[workspaceId]/subscription/route";
import { CREDIT_COSTS } from "@/server/services/credits";

describe("subscription answer", () => {
  it("carries each action's credit cost and the agents that run free, beside the existing fields", async () => {
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ workspaceId: "w1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prices).toEqual(CREDIT_COSTS);
    expect(body.freeAgents).toEqual(["quality"]);
    expect(body.plan).toBeNull();
    expect(Array.isArray(body.plans)).toBe(true);
  });
});
