import { beforeEach, describe, expect, it, vi } from "vitest";

const { authorize, sign, hit } = vi.hoisted(() => ({
  authorize: vi.fn(async (): Promise<Response | { userId: string; workspaceId: string; brandId: string }> => new Response(null, { status: 403 })),
  hit: vi.fn(async () => ({ allowed: true, count: 1 })),
  sign: vi.fn(async () => "https://signed"),
}));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: authorize }));
vi.mock("@/server/auth/rate-limit", () => ({ hitRateLimit: hit }));
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

describe("media upload limit", () => {
  it("counts uploads per user and answers 429 past 60 an hour", async () => {
    authorize.mockResolvedValueOnce({ userId: "u1", workspaceId: "w1", brandId: "b1" });
    hit.mockResolvedValueOnce({ allowed: false, count: 61 });
    const res = await POST(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ workspaceId: "w1", brandId: "b1" }) });
    expect(res.status).toBe(429);
    expect(hit).toHaveBeenCalledWith("media-upload:u1", 60, 3_600_000);
  });
});

describe("signedMediaUrl", () => {
  const input = () => (sign.mock.calls[0] as unknown as [unknown, { input: Record<string, unknown> }])[1].input;

  it("adds a download filename when asked", async () => {
    await signedMediaUrl("k", 3600, "a.jpg");
    expect(input().ResponseContentDisposition).toBe('attachment; filename="a.jpg"');
  });

  it("refuses a download name that could break out of the header", () => {
    expect(() => signedMediaUrl("k", 3600, 'a".html')).toThrow();
  });

  it("serves a task file as an attachment with the verified type", async () => {
    await signedMediaUrl("k", 3600, "Devis-ete.pdf", "application/pdf");
    expect(input()).toMatchObject({ ResponseContentDisposition: 'attachment; filename="Devis-ete.pdf"', ResponseContentType: "application/pdf" });
  });

  it("adds none otherwise", async () => {
    await signedMediaUrl("k");
    expect(input()).not.toHaveProperty("ResponseContentDisposition");
  });
});
