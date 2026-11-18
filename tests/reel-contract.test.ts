import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import { MODEL_IDS } from "@/server/reels/router";
import type { ReelPlan as Z } from "@/server/reels/plan";
import { answeredTurn, isReelIdea, REEL_SCHEDULABLE, REEL_SENDABLE, reelStage, VIDEO_MODEL_NAMES, type ChatTurn, type ContentStatus, type ReelPlan as SharedReelPlan } from "@/shared";

const summary = (render: { step: "VOICE" | "CLIPS" | "JOIN" | "DONE" | "FAILED" } | null, videoUrl: string | null) =>
  reelStage({ render: render && { ...render, attempt: 1, failure: null }, videoUrl });

describe("reelStage", () => {
  it("is draft with no render and no video", () => expect(summary(null, null)).toBe("draft"));
  it("is processing while a step runs, even with an older video", () => expect(summary({ step: "CLIPS" }, "v.mp4")).toBe("processing"));
  it("is ready when done with a video", () => expect(summary({ step: "DONE" }, "v.mp4")).toBe("ready"));
  it("is failed when failed with no video", () => expect(summary({ step: "FAILED" }, null)).toBe("failed"));
  it("is ready when failed but an older video exists", () => expect(summary({ step: "FAILED" }, "v.mp4")).toBe("ready"));
});

describe("isReelIdea", () => {
  it("accepts a recommended reel idea", () => expect(isReelIdea({ channels: ["INSTAGRAM_REEL"], decision: "RECOMMEND" })).toBe(true));
  it("rejects a REJECT decision", () => expect(isReelIdea({ channels: ["INSTAGRAM_REEL"], decision: "REJECT" })).toBe(false));
  it("rejects other channels", () => expect(isReelIdea({ channels: ["INSTAGRAM_POST"], decision: "RECOMMEND" })).toBe(false));
});

describe("status lists and model names", () => {
  it("match the phone's lists", () => {
    expect([...REEL_SENDABLE]).toEqual(["AWAITING_APPROVAL", "APPROVED", "SCHEDULED", "PUBLISHED"]);
    expect([...REEL_SCHEDULABLE]).toEqual(["AWAITING_APPROVAL", "APPROVED"]);
  });
  it("name every video model a scene can use (the presenter model is not one)", () => expect(Object.keys(VIDEO_MODEL_NAMES).sort()).toEqual([...MODEL_IDS].sort()));
});

describe("answeredTurn", () => {
  const at = "2026-11-18T00:00:00Z";
  const user = (text: string, requestId?: string): ChatTurn => ({ role: "user", text, at, requestId });
  const bot = (text: string): ChatTurn => ({ role: "assistant", text, at });
  it("returns the reply that follows the turn", () => expect(answeredTurn([user("a", "r1"), bot("done")], "r1")).toBe("done"));
  it("is null when the turn is last", () => expect(answeredTurn([bot("hi"), user("a", "r1")], "r1")).toBeNull());
  it("is null for an unknown id", () => expect(answeredTurn([user("a", "r1"), bot("done")], "r2")).toBeNull());
  it("is null when another user turn follows", () => expect(answeredTurn([user("a", "r1"), user("b", "r2"), bot("done")], "r1")).toBeNull());
  it("finds the turn at the end of a 40-turn chat", () => {
    const chat = [...Array.from({ length: 38 }, (_, i) => (i % 2 ? bot("x") : user("y"))), user("last", "r9"), bot("answer")];
    expect(chat).toHaveLength(40);
    expect(answeredTurn(chat, "r9")).toBe("answer");
  });
});

describe("the zod ReelPlan and the shared type", () => {
  it("differ only in the scene model", () => {
    type ZP = z.infer<typeof import("@/server/reels/plan").ReelPlan>;
    expectTypeOf<Omit<ZP["scenes"][number], "model">>().toEqualTypeOf<Omit<SharedReelPlan["scenes"][number], "model">>();
    expectTypeOf<Omit<ZP, "scenes">>().toEqualTypeOf<Omit<SharedReelPlan, "scenes">>();
    expectTypeOf<Z>().toMatchTypeOf<SharedReelPlan>();
  });
});

describe("ContentStatus", () => {
  it("covers every database value", () => {
    const _all = (s: import("@prisma/client").ContentStatus): ContentStatus => s;
    expect(typeof _all).toBe("function");
  });
});
