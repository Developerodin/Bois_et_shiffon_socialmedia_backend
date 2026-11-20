import { describe, expect, it } from "vitest";
import { inNextWeek, OPEN_STATUSES, STATUS_GROUPS } from "@/shared";

describe("content status groups", () => {
  it("lists the open statuses exactly", () => {
    expect([...OPEN_STATUSES]).toEqual(["PLANNED", "BRIEF_READY", "DRAFT_REVIEW", "AWAITING_APPROVAL", "APPROVED", "SCHEDULED", "BLOCKED"]);
  });

  it("keeps the groups disjoint", () => {
    const all = Object.values(STATUS_GROUPS).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it("counts a date from now up to, not including, seven days ahead", () => {
    const now = new Date("2026-11-20T10:00:00Z");
    expect(inNextWeek(now, now)).toBe(true);
    expect(inNextWeek("2026-11-27T09:59:59Z", now)).toBe(true);
    expect(inNextWeek(new Date("2026-11-27T10:00:00Z"), now)).toBe(false);
    expect(inNextWeek(null, now)).toBe(false);
  });
});
