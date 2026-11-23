import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/prisma", () => ({ prisma: {} }));

import { DECAY, dueSql } from "@/server/data/post-metric-sync";
import { refreshDue } from "@/server/data/post-metrics";

/** The decay the due-posts SQL is built from; the db test runs the same SQL against real rows. */
describe("dueSql", () => {
  const now = new Date("2026-11-23T06:00:00Z");

  it("reads daily to day 7, every 3 days to day 14, weekly to day 30, then never", () => {
    expect(DECAY).toEqual([{ before: 7, every: 1 }, { before: 14, every: 3 }, { before: 30, every: 7 }]);
    const sql = dueSql(now);
    const ints = sql.values.filter((v) => typeof v === "number");
    // The day-30 cut-off, then each CASE band (before, every) in order.
    expect(ints).toEqual([30, 7, 1, 14, 3, 30, 7]);
    expect(sql.sql).toMatch(/CASE WHEN [^]*THEN [^]*WHEN [^]*THEN [^]*WHEN [^]*THEN [^]*END/);
    expect(sql.sql).toContain(`m."readAt" IS NULL OR`);
  });

  it("matches the client's refreshDue at each boundary", () => {
    const at = (days: number) => new Date(now.getTime() - days * 86_400_000);
    // A never-read post is due until day 30.
    expect(refreshDue(at(29.9), null, now)).toBe(true);
    expect(refreshDue(at(30), null, now)).toBe(false);
    // Each band's interval, with 6 h of slack.
    for (const { before, every } of DECAY) {
      const age = before - 0.5;
      expect(refreshDue(at(age), at(every - 0.25), now)).toBe(true);
      expect(refreshDue(at(age), at(every - 0.3), now)).toBe(false);
    }
  });
});
