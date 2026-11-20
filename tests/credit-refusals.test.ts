import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ run: vi.fn(), audit: vi.fn(), story: vi.fn() }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: vi.fn(async () => ({ workspaceId: "w1", brandId: "b1", userId: "u1" })) }));
vi.mock("@/server/agents/engine", async (orig) => ({ ...(await orig<object>()), startAgentRun: m.run }));
vi.mock("@/server/services/competitor-audits", () => ({ startCompetitorAudit: m.audit }));
vi.mock("@/server/jobs/runner", () => ({ kickRunner: vi.fn() }));
vi.mock("@/server/stories/service", async (orig) => ({ ...(await orig<object>()), createStory: m.story, itemForRequest: vi.fn(async () => null) }));
vi.mock("@/server/services/publishing", async (orig) => ({ ...(await orig<object>()), postAiAllowed: vi.fn(async () => true) }));

import { AgentStartError } from "@/server/agents/engine";
import { POST as RUN } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/agents/[agentKey]/runs/route";
import { POST as CREATE } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/content/route";
import { PublishingError } from "@/server/services/publishing";
import { POST as AUDIT } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/competitors/[competitorId]/audit/route";

beforeEach(() => vi.clearAllMocks());

describe("402 refusals open the paywall", () => {
  it("an agent run answers { insufficientCredits, balance, needed } and keeps the problem fields", async () => {
    m.run.mockRejectedValue(new AgentStartError("This run needs 3 credits; you have 1.", 402, { balance: 1, needed: 3 }));
    const res = await RUN(new Request("http://x", { method: "POST", body: JSON.stringify({}) }), { params: Promise.resolve({ workspaceId: "w1", brandId: "b1", agentKey: "creator" }) });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ status: 402, detail: "This run needs 3 credits; you have 1.", insufficientCredits: true, balance: 1, needed: 3 });
  });

  it("writing a new story answers the same shape and keeps the phone's code", async () => {
    m.story.mockRejectedValue(new PublishingError("Not enough credits to write a story.", 402, "story.credits", { insufficientCredits: true, balance: 2, needed: 5 }));
    const body = { channel: "INSTAGRAM_STORY", goal: "newArrival", productId: "p1", requestId: "6f1c2c1e-6a43-4c1b-9a3e-2f1d5b7c8a90" };
    const res = await CREATE(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ workspaceId: "w1", brandId: "b1" }) });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: "story.credits", insufficientCredits: true, balance: 2, needed: 5 });
  });

  it("a competitor audit answers the same shape", async () => {
    m.audit.mockResolvedValue({ status: "insufficient-credits", balance: 1, needed: 4 });
    const res = await AUDIT(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ workspaceId: "w1", brandId: "b1", competitorId: "c1" }) });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ status: 402, insufficientCredits: true, balance: 1, needed: 4 });
  });
});
