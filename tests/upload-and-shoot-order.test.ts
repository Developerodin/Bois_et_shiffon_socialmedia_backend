import { beforeEach, describe, expect, it, vi } from "vitest";

const { authorize, hit } = vi.hoisted(() => ({
  authorize: vi.fn(async (): Promise<Response | { userId: string; workspaceId: string; brandId: string }> => new Response(null, { status: 403 })),
  hit: vi.fn(async () => ({ allowed: true, count: 1 })),
}));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: authorize }));
vi.mock("@/server/auth/rate-limit", () => ({ hitRateLimit: hit }));

import { POST as upload } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/media/route";
import { POST as shoot } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/photoshoots/route";

const params = Promise.resolve({ workspaceId: "w1", brandId: "b1" });
const scope = { userId: "u1", workspaceId: "w1", brandId: "b1" };
beforeEach(() => vi.clearAllMocks());

describe("photoshoot start", () => {
  it("answers an unauthorized caller 403 before it reads or checks the body", async () => {
    const json = vi.fn();
    const request = new Request("http://x", { method: "POST", body: "not json" });
    request.json = json;
    const res = await shoot(request, { params });
    expect(res.status).toBe(403);
    expect(json).not.toHaveBeenCalled();
  });
});

describe("media upload size", () => {
  const send = (headers: Record<string, string>) => upload(new Request("http://x", { method: "POST", headers }), { params });

  it("answers 411 when the request has no Content-Length, so a chunked body is never buffered", async () => {
    authorize.mockResolvedValueOnce(scope);
    expect((await send({})).status).toBe(411);
  });

  it("still answers 413 for a declared size over the limit", async () => {
    authorize.mockResolvedValueOnce(scope);
    expect((await send({ "content-length": String(5 * 1024 * 1024) })).status).toBe(413);
  });
});
