import { describe, expect, it } from "vitest";
import { CLONE_PASSAGES, clonePassage } from "@/shared/contract/clone-passages";
import { HUES, isInsufficientCredits, isPlanRequired, libraryPhotos, nearestHue, normalizeHex, shade, siteLabel, TONE_GROUPS, TONES, type BrandAssetsView } from "@/shared";

describe("shared contract", () => {
  it("tells the two paywall refusals apart", () => {
    expect(isPlanRequired({ planRequired: true, title: "x" })).toBe(true);
    expect(isPlanRequired({ insufficientCredits: true, balance: 0, needed: 1 })).toBe(false);
    expect(isInsufficientCredits({ insufficientCredits: true, balance: 0, needed: 1 })).toBe(true);
    expect(isInsufficientCredits({ planRequired: true, title: "x" })).toBe(false);
    expect(isPlanRequired(null)).toBe(false);
  });

  it("has a clone passage per phone locale, English by default", () => {
    expect(Object.keys(CLONE_PASSAGES)).toHaveLength(24);
    expect(clonePassage("xx").lang).toBe("en");
    expect(clonePassage("fr")).toEqual({ lang: "fr", text: CLONE_PASSAGES.fr });
    for (const [lang, text] of Object.entries(CLONE_PASSAGES)) {
      const sentences = text.split(/(?<=[.!?。！？।])\s*/).filter(Boolean);
      expect(sentences.length, lang).toBeGreaterThanOrEqual(2);
    }
  });

  it("groups the tones without losing or reordering any", () => {
    expect(TONE_GROUPS.flatMap((g) => g.tones)).toEqual([...TONES]);
    expect(TONE_GROUPS[0].tones).toEqual(["Warm", "Playful", "Bold", "Calm", "Romantic", "Edgy"]);
    expect(TONE_GROUPS[2].tones[0]).toBe("Luxurious");
  });

  it("normalises hex colours", () => {
    expect(normalizeHex("7c6754")).toBe("#7C6754");
    expect(normalizeHex("#abc")).toBe("#AABBCC");
    expect(normalizeHex("#12345")).toBeNull();
    expect(normalizeHex(" #fff ")).toBe("#FFFFFF");
  });

  it("shades a colour lighter, and leaves one already at the limit", () => {
    const lighter = shade("#7C6754", 8);
    expect(lighter).not.toBe("#7C6754");
    expect(parseInt(lighter.slice(1, 3), 16)).toBeGreaterThan(0x7c);
    expect(shade("#F5F5F5", 8)).toBe("#F5F5F5");
  });

  it("finds the nearest picker hue", () => {
    expect(HUES[nearestHue("#808080")].key).toBe("grey");
    expect(HUES[nearestHue("#3366CC")].key).toBe("blue");
    expect(nearestHue(null)).toBe(0);
  });

  it("splits the photo library into website photos and uploads", () => {
    const view = {
      assets: { products: [{ title: "Chair", kind: "Furniture", url: "u", image: { key: "k1", url: "s1" } }, { title: "Bare", kind: null, url: "u2", image: null }] },
      uploads: [{ title: "Photo", addedAt: "2026-01-01", image: { key: "k2", url: "s2" } }],
    } as unknown as BrandAssetsView;
    expect(libraryPhotos(view)).toEqual({
      website: [{ key: "k1", url: "s1", title: "Chair", kind: "Furniture" }],
      uploads: [{ key: "k2", url: "s2", title: "Photo", kind: null }],
    });
    expect(libraryPhotos(null)).toEqual({ website: [], uploads: [] });
  });

  it("writes a website as people say it", () => {
    expect(siteLabel("https://www.boisetchiffons.fr/")).toBe("boisetchiffons.fr");
    expect(siteLabel(null)).toBeNull();
  });
});
