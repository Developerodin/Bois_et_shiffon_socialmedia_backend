import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/prisma", () => ({ prisma: {} }));

import { dueSql } from "@/server/data/post-metric-sync";

/** The decay the due-posts SQL is built from; the db test runs the same SQL against real rows. */
describe("dueSql", () => {
  const now = new Date("2026-11-23T06:00:00Z");

  it("reads daily to day 7, every 3 days to day 14, weekly to day 30, then never", () => {
    const sql = dueSql(now);
    const ints = sql.values.filter((v) => typeof v === "number");
    // The day-30 index bound and cut-off, then each CASE band (before, every) in order.
    expect(ints).toEqual([30, 7, 1, 14, 3, 30, 7]);
    expect(sql.sql).toMatch(/CASE WHEN [^]*THEN [^]*WHEN [^]*THEN [^]*WHEN [^]*THEN [^]*END/);
    expect(sql.sql).toContain(`m."readAt" IS NULL OR`);
  });

});
