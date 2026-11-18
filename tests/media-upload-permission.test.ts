import { beforeEach, describe, expect, it, vi } from "vitest";

const { authorize, sign } = vi.hoisted(() => ({
  authorize: vi.fn(async () => new Response(null, { status: 403 })),
  sign: vi.fn(async () => "https://signed"),
}));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: authorize }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: sign }));

import { POST } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/media/route";
import { signedMediaUrl } from "@/server/storage/media";

beforeEach(() => vi.clearAllMocks());

describe("media upload", () => {
  it("asks for content.create, so Creators can upload the photo they shoot", async () => {
    const params = Promise.resolve({ workspaceId: "w1", brandId: "b1" });
    const res = await POST(new Request("http://x", { method: "POST" }), { params });
    expect(res.status).toBe(403);
    expect(authorize).toHaveBeenCalledWith(expect.anything(), params, "content.create");
  });
});

describe("signedMediaUrl", () => {
  const input = () => (sign.mock.calls[0] as unknown as [unknown, { input: Record<string, unknown> }])[1].input;

  it("adds a download filename when asked", async () => {
    await signedMediaUrl("k", 3600, "a.jpg");
    expect(input().ResponseContentDisposition).toBe('attachment; filename="a.jpg"');
  });

  it("adds none otherwise", async () => {
    await signedMediaUrl("k");
    expect(input()).not.toHaveProperty("ResponseContentDisposition");
  });
});
