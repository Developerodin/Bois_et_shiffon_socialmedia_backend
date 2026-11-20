import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ perms: new Set(["brand.read", "content.edit"]), effective: vi.fn(async () => new Set<string>()), state: vi.fn(async () => ({ requirements: {}, accounts: [] })) }));

vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: async () => ({ userId: "u1", workspaceId: "w1", brandId: "b1", perms: m.perms, clientReviewer: false }) }));
vi.mock("@/server/auth/permissions", async (orig) => ({ ...(await orig<object>()), effectivePermissions: m.effective }));
vi.mock("@/server/db/prisma", () => ({ prisma: {} }));
vi.mock("@/server/agents/engine", () => ({ startAgentRun: vi.fn() }));
vi.mock("@/server/jobs/runner", () => ({ kickRunner: vi.fn() }));
vi.mock("@/server/services/publishing", async (orig) => ({ ...(await orig<object>()), releaseState: m.state, saveDraft: vi.fn(async () => ({ version: 2 })) }));
vi.mock("@/server/stories/service", async (orig) => ({ ...(await orig<object>()), storyView: vi.fn() }));

import { GET, POST } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/content/[contentId]/route";

const params = { params: Promise.resolve({ workspaceId: "w1", brandId: "b1", contentId: "c1" }) };

describe("content detail", () => {
  it("detail and actions don't re-read permissions", async () => {
    await GET(new Request("http://x"), params);
    expect(m.state).toHaveBeenLastCalledWith(expect.anything(), "c1", m.perms);
    await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "edit", version: 1, body: { caption: "c" } }) }), params);
    expect(m.effective).not.toHaveBeenCalled();
    expect(m.state).toHaveBeenLastCalledWith(expect.anything(), "c1", m.perms);
  });
});
