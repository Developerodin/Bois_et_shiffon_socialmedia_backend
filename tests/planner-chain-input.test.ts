import { describe, expect, it } from "vitest";
import { runInput } from "@/server/agents/chain";

describe("a person's Planner start runs the posts chain", () => {
  it("turns the chain on when the request doesn't say", () => {
    expect(runInput("planner", undefined)).toEqual({ chain: true });
    expect(runInput("planner", {})).toEqual({ chain: true });
    expect(runInput("planner", { channels: ["PINTEREST_PIN"] })).toEqual({ chain: true, channels: ["PINTEREST_PIN"] });
  });

  it("keeps what the phone sends and an explicit chain: false", () => {
    expect(runInput("planner", { chain: true })).toEqual({ chain: true });
    expect(runInput("planner", { chain: false })).toEqual({ chain: false });
  });

  it("leaves other agents and bad input as sent", () => {
    expect(runInput("scout", undefined)).toBeUndefined();
    expect(runInput("brief", {})).toEqual({});
    expect(runInput("planner", "x")).toBe("x");
  });
});
