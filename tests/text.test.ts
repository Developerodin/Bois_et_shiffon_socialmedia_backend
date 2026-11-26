import { describe, expect, it } from "vitest";
import { cleanText, cleanTitle } from "@/server/text";

describe("cleanText", () => {
  it("keeps a long URL whole when the limit allows it", () => {
    const url = "https://x.com/" + "a".repeat(1_500 - 14);
    expect(url).toHaveLength(1_500);
    expect(cleanText(url, 2_000)).toBe(url);
  });

  it("strips bidi, zero-width and control characters and cuts at the limit", () => {
    expect(cleanText("a\u202eb\u200bc\nd\u2066e", 100)).toBe("a b c d e");
    expect(cleanText("abcdef", 3)).toBe("abc");
  });

  it("matches cleanTitle at 100 characters", () => {
    const t = "x".repeat(150);
    expect(cleanText(t, 100)).toBe(cleanTitle(t));
  });
});
