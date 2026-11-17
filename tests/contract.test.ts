import { describe, expect, it } from "vitest";
import { CLONE_PASSAGES, clonePassage, isInsufficientCredits, isPlanRequired } from "@/shared";

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
});
