import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  authorize: vi.fn(),
  hit: vi.fn(),
  upload: vi.fn(),
}));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: m.authorize }));
vi.mock("@/server/auth/rate-limit", () => ({ hitRateLimit: m.hit }));
// The route imports MAX_RECORDING_BYTES from here: keep the real one, or its size checks compare against undefined.
vi.mock("@/server/reels/recordings", async (orig) => ({ MAX_RECORDING_BYTES: (await orig<typeof import("@/server/reels/recordings")>()).MAX_RECORDING_BYTES, uploadRecording: m.upload }));

import { POST } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/reels/[contentId]/recordings/route";
import { MAX_RECORDING_BYTES } from "@/shared";

const scope = { userId: "u1", workspaceId: "w1", brandId: "b1" };
const UUID = "0b9f2c4e-7d1a-4c3b-9e8f-1a2b3c4d5e6f";

function send(contentId: string, bytes = 16) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/mp4" }), "take.m4a");
  form.append("text", "Scene one");
  return POST(new Request("http://x", { method: "POST", body: form }), { params: Promise.resolve({ workspaceId: "w1", brandId: "b1", contentId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.authorize.mockResolvedValue(scope);
  m.hit.mockResolvedValue({ allowed: true, count: 1 });
  m.upload.mockResolvedValue({ id: "r1", seconds: 4, transcript: "x", matches: true });
});

describe("recordings route", () => {
  it("refuses a take over the size limit", async () => {
    expect((await send(UUID, MAX_RECORDING_BYTES + 1)).status).toBe(413);
    expect(m.upload).not.toHaveBeenCalled();
  });

  it("recordings route accepts a UUID reel id", async () => {
    expect((await send(UUID)).status).toBe(201);
    expect(m.upload).toHaveBeenCalledWith(scope, UUID, expect.objectContaining({ text: "Scene one" }));
    expect((await send(UUID.toUpperCase())).status).toBe(201);
  });

  it("still accepts a cuid (a reel made on the phone)", async () => {
    expect((await send("ckv9x1y2z3a4b5c6d7e8")).status).toBe(201);
    expect(m.upload).toHaveBeenCalledWith(scope, "ckv9x1y2z3a4b5c6d7e8", expect.anything());
  });

  it("refuses a path-like id with 404 and counts nothing", async () => {
    expect((await send("../x")).status).toBe(404);
    expect(m.hit).not.toHaveBeenCalled();
    expect(m.upload).not.toHaveBeenCalled();
  });

  it("the reel bucket is keyed by the caller's scope", async () => {
    await send(UUID);
    const keys = m.hit.mock.calls.map((c) => c[0] as string);
    const reelKey = keys.find((k) => k.startsWith("rec:reel:"));
    expect(reelKey).toContain(scope.workspaceId);
    expect(reelKey).toContain(scope.brandId);
    expect(reelKey).toBe(`rec:reel:w1:b1:${UUID}`);
  });
});
