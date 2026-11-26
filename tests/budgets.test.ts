import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/prisma", () => ({ prisma: {} }));

import { BudgetBody, MonthSchema } from "@/server/data/budgets";

const month = (delta: number) => {
  const d = new Date();
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1));
  return m.toISOString().slice(0, 7);
};
const body = (extra: object = {}) => ({ platform: "META", month: month(0), amount: "1500.00", currency: "EUR", ...extra });

describe("budget input", () => {
  it("month: YYYY-MM from 24 months back to 12 ahead, else refused (one schema for GET and PUT)", () => {
    for (const ok of [month(0), month(-24), month(12)]) expect(MonthSchema.safeParse(ok).success).toBe(true);
    for (const bad of ["2026-13", "2026-00", "2026-1", month(-25), month(13), "", null]) expect(MonthSchema.safeParse(bad).success).toBe(false);
  });

  it("amount: a decimal string ≥ 0, at most 2 decimals and 12 digits; 1e13, 0.001 and negatives refused", () => {
    expect(BudgetBody.safeParse(body()).success).toBe(true);
    expect(BudgetBody.safeParse(body({ amount: "0" })).success).toBe(true);
    for (const amount of ["1e13", "0.001", "-5", "10000000000000", "", 12]) expect(BudgetBody.safeParse(body({ amount })).success).toBe(false);
  });

  it("currency: ECB currencies or EUR only; JPY takes no decimals", () => {
    expect(BudgetBody.safeParse(body({ currency: "INR" })).success).toBe(true);
    expect(BudgetBody.safeParse(body({ currency: "ZZZ" })).success).toBe(false);
    expect(BudgetBody.safeParse(body({ currency: "JPY", amount: "10.5" })).success).toBe(false);
    expect(BudgetBody.safeParse(body({ currency: "JPY", amount: "10" })).success).toBe(true);
    expect(BudgetBody.safeParse(body({ platform: "TIKTOK" })).success).toBe(false);
  });
});
