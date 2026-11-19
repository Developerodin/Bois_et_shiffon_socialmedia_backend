import { describe, expect, it } from "vitest";
import { captionCues } from "@/server/reels/captions";
import { joinSeconds } from "@/server/reels/plan";
import { PRESENTER_MODEL } from "@/server/reels/router";

describe("joinSeconds", () => {
  it("is what the join trims each clip to: voice length, the presenter minimum, at most the clip", () => {
    expect(joinSeconds({ voiceSeconds: [3.2, 1.0, 20], models: ["kling-3-std", PRESENTER_MODEL, "kling-3-std"], clipSeconds: [5, 5, 10] })).toEqual([4, 4, 10]);
  });
});

describe("captionCues", () => {
  it("gives one cue per scene over its span, and a silent scene takes its time without a cue", () => {
    expect(captionCues([{ voiceText: "Hello there" }, { voiceText: "  " }, { voiceText: "Bye" }], [4, 3, 5])).toEqual([
      { start: 0, end: 4, text: "Hello there" },
      { start: 7, end: 12, text: "Bye" },
    ]);
  });

  it("gives no cues for no scenes", () => {
    expect(captionCues([], [])).toEqual([]);
  });
});
