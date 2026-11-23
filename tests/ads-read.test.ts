import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { previousRange, totalsOf } from "@/server/data/ads-read";
import { parseRange } from "@/shared";

describe("parseRange", () => {
  it("takes real YYYY-MM-DD days, from ≤ to, within the cap (both ends counted)", () => {
    expect(parseRange("2026-11-01", "2026-11-30")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(parseRange("2026-11-01", "2026-11-01")).toEqual({ from: "2026-11-01", to: "2026-11-01" });
    expect(parseRange("2025-01-01", "2026-01-01", 366)).not.toBeNull();
    expect(parseRange("2025-01-01", "2026-01-02", 366)).toBeNull();
    expect(parseRange("2026-01-01", "2026-03-31")).toEqual({ from: "2026-01-01", to: "2026-03-31" }); // 90
    expect(parseRange("2026-01-01", "2026-04-01")).toBeNull();
    for (const [f, t] of [[null, "2026-11-01"], ["2026-11-02", "2026-11-01"], ["2026-02-30", "2026-03-01"], ["2026-1-1", "2026-01-02"], ["2026-11-01T00:00", "2026-11-02"], ["../x", "2026-11-02"]]) {
      expect(parseRange(f, t), `${f} ${t}`).toBeNull();
    }
  });
});

describe("totalsOf", () => {
  const D = (v: string) => new Prisma.Decimal(v);
  it("ROAS to 2 places and cost per purchase; null when spend or purchases are zero", () => {
    expect(totalsOf("EUR", D("15.5"), 3, D("50"))).toEqual({ currency: "EUR", spend: "15.50", purchases: 3, purchaseValue: "50.00", roas: 3.23, costPerPurchase: "5.17" });
    expect(totalsOf("EUR", D("0"), 2, D("10"))).toMatchObject({ roas: null, costPerPurchase: "0.00" });
    expect(totalsOf("INR", D("12.30"), 0, D("0"))).toMatchObject({ spend: "12.30", roas: 0, costPerPurchase: null });
  });
});

describe("previousRange", () => {
  it("is the same number of days right before", () => {
    expect(previousRange({ from: "2026-11-01", to: "2026-11-30" })).toEqual({ from: "2026-10-02", to: "2026-10-31" });
    expect(previousRange({ from: "2026-03-01", to: "2026-03-01" })).toEqual({ from: "2026-02-28", to: "2026-02-28" });
  });
});
