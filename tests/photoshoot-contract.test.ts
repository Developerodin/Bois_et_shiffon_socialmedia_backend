import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { PhotoShoot } from "@prisma/client";
import type { z } from "zod";
import { ShootRequest, shootView } from "@/server/photoshoot/shoot";
import { signedMediaUrl } from "@/server/storage/media";
import { TIERS } from "@/server/photoshoot/tiers";
import { SHOOT_CREDITS, SHOOT_TIER_IDS, shootRequestKey, shouldKeepRequestId, type ShootRequest as SharedShootRequest } from "@/shared";

vi.mock("@/server/storage/media", async (orig) => ({
  ...(await orig<object>()),
  signedMediaUrl: vi.fn(async (key: string, _ttl?: number, downloadAs?: string) => `https://s/${key}${downloadAs ? `?dl=${downloadAs}` : ""}`),
}));

describe("photoshoot contract", () => {
  it("prices the tiers as the apps show them", () => {
    expect(SHOOT_CREDITS).toEqual({ base: 4, moderate: 6, higher: 12, ultra: 24 });
    for (const id of SHOOT_TIER_IDS) expect(TIERS[id].credits).toBe(SHOOT_CREDITS[id]);
  });

  it("refuses a custom scene without a description", () => {
    expect(() => ShootRequest.parse({ kind: "product", tier: "base", sourceKey: "k", ratio: "4:5", scene: "custom", brief: "  " })).toThrow();
  });

  it("matches the shared request type", () => {
    expectTypeOf<z.output<typeof ShootRequest>>().toEqualTypeOf<SharedShootRequest>();
  });

  it("gives each shot a download link named after the shoot", async () => {
    const row = { id: "abcdef12-3456", kind: "product", tier: "base", status: "DONE", input: { sourceKey: "src" }, credits: 4, createdAt: new Date(0), outputKeys: ["k1", "k2"] } as unknown as PhotoShoot;
    const view = await shootView(row, { download: true });
    expect(view.shots).toEqual([
      { key: "k1", url: "https://s/k1", downloadUrl: "https://s/k1?dl=photoshoot-abcdef12-1.jpg" },
      { key: "k2", url: "https://s/k2", downloadUrl: "https://s/k2?dl=photoshoot-abcdef12-2.jpg" },
    ]);
    expect(signedMediaUrl).toHaveBeenCalledWith("k1", 3600, "photoshoot-abcdef12-1.jpg");
  });

  it("leaves the download links off unless asked, as in the list", async () => {
    vi.mocked(signedMediaUrl).mockClear();
    const row = { id: "abcdef12-3456", kind: "product", tier: "base", status: "DONE", input: { sourceKey: "src" }, credits: 4, createdAt: new Date(0), outputKeys: ["k1"] } as unknown as PhotoShoot;
    const view = await shootView(row);
    expect(view.shots).toEqual([{ key: "k1", url: "https://s/k1" }]);
    expect(signedMediaUrl).not.toHaveBeenCalledWith("k1", 3600, expect.anything());
  });
});

describe("press request ids", () => {
  it("keeps the id when the outcome is unknown: no answer (0) or a server error", () => {
    for (const status of [0, 500, 502, 503, 504]) expect(shouldKeepRequestId(status)).toBe(true);
    for (const status of [400, 402, 404, 409, 429]) expect(shouldKeepRequestId(status)).toBe(false);
  });

  it("keys a request the same whatever order its fields come in", () => {
    const built: SharedShootRequest = { kind: "product", tier: "base", sourceKey: "k", ratio: "1:1", scene: "studio", brief: "" };
    const stored = JSON.parse('{"brief":"","ratio":"1:1","scene":"studio","tier":"base","kind":"product","sourceKey":"k"}') as SharedShootRequest;
    expect(shootRequestKey(stored)).toBe(shootRequestKey(built));
    expect(shootRequestKey({ ...built, scene: "interior" })).not.toBe(shootRequestKey(built));
  });
});
