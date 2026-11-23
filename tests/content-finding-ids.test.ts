import { describe, expect, it } from "vitest";
import { contentFindingIds } from "@/server/agents/definitions/geo";
import { slugify } from "@/server/services/slug";

describe("slugify", () => {
  it("drops accents, lower-cases, and turns other characters into single dashes", () => {
    expect(slugify("Bois & Chiffons — Été", { max: 48, fallback: "brand" })).toBe("bois-chiffons-ete");
  });

  it("caps the length and falls back when nothing is left", () => {
    expect(slugify("a".repeat(80), { max: 60, fallback: "x" })).toHaveLength(60);
    expect(slugify("¿¡!", { max: 60, fallback: "brand" })).toBe("brand");
  });
});

describe("contentFindingIds", () => {
  it("names each finding from its title", () => {
    expect(contentFindingIds(["Missing FAQ section", "Pages sans réponses claires"])).toEqual(["content-missing-faq-section", "content-pages-sans-reponses-claires"]);
  });

  it("suffixes a repeated title within one report", () => {
    expect(contentFindingIds(["Missing FAQ", "missing faq!", "Missing FAQ"])).toEqual(["content-missing-faq", "content-missing-faq-2", "content-missing-faq-3"]);
  });

  it("caps the slug at 60 characters without a trailing dash", () => {
    const [id] = contentFindingIds([`${"word ".repeat(12)}tail`]);
    expect(id!.length).toBeLessThanOrEqual("content-".length + 60);
    expect(id).not.toMatch(/-$/);
  });

  it("an empty title is content-untitled", () => {
    expect(contentFindingIds(["", "  "])).toEqual(["content-untitled", "content-untitled-2"]);
  });

  it("never all digits, which would read as an old positional id", () => {
    expect(contentFindingIds(["2026", "1"])).toEqual(["content-untitled", "content-untitled-2"]);
  });
});
