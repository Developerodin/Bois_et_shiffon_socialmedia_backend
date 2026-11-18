import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/prisma", () => ({ prisma: {} }));

import { streamPlan } from "@/server/reels/service";

describe("streamPlan", () => {
  it("keeps running and saving after the reader goes away", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const saved = vi.fn();
    const stringify = vi.spyOn(JSON, "stringify");
    const response = streamPlan(async (emit) => {
      emit({ type: "stage", stage: "one" } as never);
      await gate;
      stringify.mockClear();
      emit({ type: "stage", stage: "two" } as never);
      const serialised = stringify.mock.calls.length;
      saved(serialised);
      return "plan";
    });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    release();
    await vi.waitFor(() => expect(saved).toHaveBeenCalled());
    // The emit after the cancel serialised nothing.
    expect(saved).toHaveBeenCalledWith(0);
    stringify.mockRestore();
  });
});
