import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { PhotoShoot } from "@prisma/client";
import type { z } from "zod";
import { ShootRequest, shootView } from "@/server/photoshoot/shoot";
import { signedMediaUrl } from "@/server/storage/media";
import { TIERS } from "@/server/photoshoot/tiers";
import { SHOOT_CREDITS, SHOOT_TIER_IDS, type ShootRequest as SharedShootRequest } from "@/shared";

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
    const view = await shootView(row);
    expect(view.shots).toEqual([
      { key: "k1", url: "https://s/k1", downloadUrl: "https://s/k1?dl=photoshoot-abcdef12-1.jpg" },
      { key: "k2", url: "https://s/k2", downloadUrl: "https://s/k2?dl=photoshoot-abcdef12-2.jpg" },
    ]);
    expect(signedMediaUrl).toHaveBeenCalledWith("k1", 3600, "photoshoot-abcdef12-1.jpg");
  });
});
