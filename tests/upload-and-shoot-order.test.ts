import { beforeEach, describe, expect, it, vi } from "vitest";

const { authorize, hit } = vi.hoisted(() => ({
  authorize: vi.fn(async (): Promise<Response | { userId: string; workspaceId: string; brandId: string }> => new Response(null, { status: 403 })),
  hit: vi.fn(async () => ({ allowed: true, count: 1 })),
}));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: authorize }));
vi.mock("@/server/auth/rate-limit", () => ({ hitRateLimit: hit }));
vi.mock("@/server/storage/media", async (orig) => ({
  ...(await orig<object>()),
  putMedia: vi.fn(async () => undefined),
  signedMediaUrl: vi.fn(async (key: string) => `https://s/${key}`),
}));

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

  it("accepts a valid upload that declares its Content-Length", async () => {
    authorize.mockResolvedValueOnce(scope);
    const form = new FormData();
    form.append("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "a.png", { type: "image/png" }));
    // A Node Request built with a FormData body has no Content-Length, so encode it first and set the header by hand.
    const encoded = new Request("http://x", { method: "POST", body: form });
    const body = await encoded.arrayBuffer();
    const headers = { "content-type": encoded.headers.get("content-type")!, "content-length": String(body.byteLength) };
    const res = await upload(new Request("http://x", { method: "POST", headers, body }), { params });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ key: expect.stringMatching(/\.png$/), previewUrl: expect.stringMatching(/^https:\/\/s\//) });
  });

  it("still answers 413 for a declared size over the limit", async () => {
    authorize.mockResolvedValueOnce(scope);
    expect((await send({ "content-length": String(5 * 1024 * 1024) })).status).toBe(413);
  });
});
