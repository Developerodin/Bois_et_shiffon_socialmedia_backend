import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import { ShootRequest } from "@/server/photoshoot/shoot";
import { TIERS } from "@/server/photoshoot/tiers";
import { SHOOT_CREDITS, SHOOT_TIER_IDS, type ShootRequest as SharedShootRequest } from "@/shared";

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
});
