import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/prisma", () => ({ prisma: {} }));

import { adAlertText, evaluateAccount, evaluatePacing, isOpen, type AccountContext, type AlertDayRow } from "@/server/ads/alerts";
import { addDays } from "@/server/data/sources";
import type { PacingDto } from "@/shared";

// S = 2026-11-25 (the account-local yesterday the sync read up to): D_spend = 11-25, D_conv = 11-22.
const S = "2026-11-25";
const d = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ctx = (extra: Partial<AccountContext> = {}): AccountContext => ({
  brandId: "b1", accountId: "act_1", currency: "EUR", day: S, backfillStart: "2026-06-01", rates: null, ...extra,
});
const row = (day: string, spend: number, purchases = 0, value = 0, campaignId = "c1", campaignName = `Campaign ${campaignId}`): AlertDayRow => ({
  campaignId, campaignName, day, spend: d(spend), purchases, purchaseValue: d(value),
});
/** One row per day from `from` to `to`, all alike. */
const days = (from: string, to: string, spend: number, purchases = 0, value = 0, campaignId = "c1") => {
  const out: AlertDayRow[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) out.push(row(day, spend, purchases, value, campaignId));
  return out;
};
const kinds = (rows: AlertDayRow[], c = ctx()) => evaluateAccount(rows, c).candidates.map((a) => `${a.kind}@${a.day}`);
/** A history where both SPEND_UP (on 11-25) and ROAS_DOWN (on 11-22) hold. */
const both = () => [
  ...days("2026-11-15", "2026-11-18", 100, 4, 300),
  ...days("2026-11-19", "2026-11-21", 100, 3, 300),
  row("2026-11-22", 100, 6, 195),
  ...days("2026-11-23", "2026-11-24", 100, 2, 200),
  row(S, 200, 2, 200),
];

describe("SPEND_UP (on D_spend = S)", () => {
  it("spend up 50% and at least €20 over the baseline average → SPEND_UP dated 11-25", () => {
    const out = evaluateAccount([...days("2026-11-18", "2026-11-24", 40), row(S, 60)], ctx());
    expect(out.candidates).toEqual([
      {
        kind: "SPEND_UP", day: S, subjectKey: "SPEND_UP:b1:act_1", accountId: "act_1", currency: "EUR",
        values: { day: S, now: "60.00", baseline: "40.00", ratio: "1.50", minEur: "20", min: "20.00" },
      },
    ]);
  });

  it("+60% but only +€12 → none", () => {
    expect(kinds([...days("2026-11-18", "2026-11-24", 20), row(S, 32)])).toEqual([]);
  });

  it("an INR account's floor is €20 converted at D_spend's rate", () => {
    const convert = vi.fn((amount: Prisma.Decimal.Value, _from: string, _to: string, day: string) => ({ amount: d(amount).mul(90), rateDay: day, stale: false }));
    const inr = ctx({ currency: "INR", rates: { convert } });
    expect(kinds([...days("2026-11-18", "2026-11-24", 3000), row(S, 4500)], inr)).toEqual([]); // +1500 < 1800
    const out = evaluateAccount([...days("2026-11-18", "2026-11-24", 3000), row(S, 5000)], inr);
    expect(out.candidates.map((a) => a.kind)).toEqual(["SPEND_UP"]);
    expect(out.candidates[0].values).toMatchObject({ min: "1800.00", rateDay: S });
    expect(convert).toHaveBeenCalledWith(20, "EUR", "INR", S);
  });

  it("a zero baseline raises nothing", () => {
    expect(kinds([row(S, 500)])).toEqual([]);
  });

  it("missing days count as 0 in the baseline", () => {
    const out = evaluateAccount([...days("2026-11-22", "2026-11-24", 70), row(S, 50)], ctx());
    expect(out.candidates.map((a) => [a.kind, a.values.baseline])).toEqual([["SPEND_UP", "30.00"]]);
  });
});

describe("ROAS_DOWN (on D_conv = S − 3)", () => {
  const roasRows = (dayPurchases = 6, dayValue = 195) => [
    ...days("2026-11-15", "2026-11-18", 100, 4, 300),
    ...days("2026-11-19", "2026-11-21", 100, 3, 300),
    row("2026-11-22", 100, dayPurchases, dayValue),
    ...days("2026-11-23", S, 100, 2, 200),
  ];

  it("ROAS −35% on 11-22 with 6 purchases and 25 in the baseline week (11-15..11-21) → ROAS_DOWN dated 11-22", () => {
    const out = evaluateAccount(roasRows(), ctx());
    expect(out.candidates).toEqual([
      expect.objectContaining({
        kind: "ROAS_DOWN", day: "2026-11-22", subjectKey: "ROAS_DOWN:b1:act_1",
        values: expect.objectContaining({ roas: "1.95", baselineRoas: "3.00", purchases: "6", baselinePurchases: "25" }),
      }),
    ]);
  });

  it("a ROAS drop only on 11-25 (yesterday) → none: the conversion rules don't look at D_spend", () => {
    const rows = [...days("2026-11-15", "2026-11-24", 100, 4, 300), row(S, 100, 6, 100)];
    expect(kinds(rows)).toEqual([]);
  });

  it("a baseline with purchases but no purchase value (ROAS 0) raises nothing", () => {
    const rows = [...days("2026-11-15", "2026-11-21", 100, 4, 0), row("2026-11-22", 100, 6, 0), ...days("2026-11-23", S, 100, 2, 0)];
    expect(kinds(rows)).toEqual([]);
  });

  it("−50% with only 3 purchases on D_conv → none", () => {
    expect(kinds(roasRows(3, 150))).toEqual([]);
  });
});

describe("NO_PURCHASES (D_conv − 2 .. D_conv)", () => {
  const steady = days("2026-11-01", S, 50, 2, 200, "steady"); // another campaign, so the account stays quiet

  it("a campaign spending with no purchases on 11-20..11-22 that bought on 11-10 → NO_PURCHASES dated 11-22", () => {
    const rows = [...steady, row("2026-11-10", 5, 1, 30, "c9", "Spring sale"), ...days("2026-11-20", "2026-11-22", 10, 0, 0, "c9")];
    const out = evaluateAccount(rows, ctx());
    expect(out.candidates).toEqual([
      {
        kind: "NO_PURCHASES", day: "2026-11-22", subjectKey: "NO_PURCHASES:b1:act_1:c9", accountId: "act_1", currency: "EUR",
        campaignId: "c9", campaignName: "Campaign c9",
        values: { day: "2026-11-22", from: "2026-11-20", spend: "30.00", minEur: "20", min: "20.00" },
      },
    ]);
  });

  it("no purchases on 11-23..11-25 only → none", () => {
    expect(kinds([...steady, row("2026-11-10", 5, 1, 30, "c9"), ...days("2026-11-23", S, 10, 0, 0, "c9")])).toEqual([]);
  });

  it("a campaign that never had a purchase (awareness) → none", () => {
    expect(kinds([...steady, ...days("2026-11-01", "2026-11-22", 10, 0, 0, "c9")])).toEqual([]);
  });

  it("a purchase only on 10-22, outside 10-23..11-19 → none", () => {
    expect(kinds([...steady, row("2026-10-22", 5, 1, 30, "c9"), ...days("2026-11-20", "2026-11-22", 10, 0, 0, "c9")])).toEqual([]);
  });

  it("only 2 days without purchases → none", () => {
    expect(kinds([...steady, row("2026-11-10", 5, 1, 30, "c9"), ...days("2026-11-21", "2026-11-22", 15, 0, 0, "c9")])).toEqual([]);
  });

  it("3-day spend of €15 → none", () => {
    expect(kinds([...steady, row("2026-11-10", 5, 1, 30, "c9"), ...days("2026-11-20", "2026-11-22", 5, 0, 0, "c9")])).toEqual([]);
  });
});

describe("exchange rates and the backfill", () => {
  const all = () => [...both(), row("2026-11-10", 5, 1, 30, "c9"), ...days("2026-11-20", "2026-11-22", 10, 0, 0, "c9")];

  it("an EUR account needs no rate table: every rule still runs", () => {
    const out = evaluateAccount(all(), ctx({ rates: null }));
    expect(out.candidates.map((a) => a.kind).sort()).toEqual(["NO_PURCHASES", "ROAS_DOWN", "SPEND_UP"]);
    expect(out.noRate).toBe(false);
  });

  it("a non-EUR account without a rate: SPEND_UP, ROAS_DOWN and NO_PURCHASES skipped, never guessed", () => {
    const out = evaluateAccount(all(), ctx({ currency: "INR", rates: { convert: () => null } }));
    expect(out).toEqual({ candidates: [], noRate: true });
    expect(evaluateAccount(all(), ctx({ currency: "INR", rates: null })).candidates).toEqual([]);
  });

  it("a backfill starting after D_spend − 7 runs no SPEND_UP; after D_conv − 7 no ROAS_DOWN", () => {
    expect(kinds(both(), ctx({ backfillStart: "2026-11-15" }))).toEqual(["SPEND_UP@2026-11-25", "ROAS_DOWN@2026-11-22"]);
    expect(kinds(both(), ctx({ backfillStart: "2026-11-16" }))).toEqual(["SPEND_UP@2026-11-25"]);
    expect(kinds(both(), ctx({ backfillStart: "2026-11-19" }))).toEqual([]);
  });
});

describe("OVER_PACE", () => {
  const ok = (through: string, ratio: number, status: "under" | "on" | "over" = "over"): PacingDto => ({
    platform: "META", state: "ok", through, spent: "500.00", expected: "400.00", ratio, status, currency: "EUR", staleRateFrom: null,
  });

  it("pacing over, through the 5th → OVER_PACE dated through, keyed by brand and month", () => {
    expect(evaluatePacing(ok("2026-11-05", 1.25), "b1")).toEqual({
      kind: "OVER_PACE", day: "2026-11-05", subjectKey: "OVER_PACE:b1:2026-11", accountId: null, currency: "EUR",
      values: { day: "2026-11-05", ratio: "1.25", spent: "500.00", expected: "400.00" },
    });
  });

  it("ratio 3.0 through the 2nd → none; on pace → none", () => {
    expect(evaluatePacing(ok("2026-11-02", 3), "b1")).toBeNull();
    expect(evaluatePacing(ok("2026-11-10", 1.05, "on"), "b1")).toBeNull();
  });

  it("no_data, no_rate or no budget → none", () => {
    expect(evaluatePacing({ platform: "META", state: "no_data" }, "b1")).toBeNull();
    expect(evaluatePacing({ platform: "META", state: "no_rate" }, "b1")).toBeNull();
    expect(evaluatePacing(undefined, "b1")).toBeNull();
  });
});

describe("text and open", () => {
  it("adAlertText strips a newline and bidi characters from the campaign name", () => {
    const name = `Spring${String.fromCharCode(10)}sale${String.fromCharCode(0x202e)}now`;
    const text = adAlertText({ kind: "NO_PURCHASES", accountId: "act_1", campaignName: name, currency: "EUR", values: { day: "2026-11-22", spend: "46.10" } });
    expect(text).toBe('Campaign "Spring sale now" spent 46.10 EUR with no purchases for 3 days to 2026-11-22 (purchases can still grow a little)');
    expect(adAlertText({ kind: "SPEND_UP", accountId: "act_123", campaignName: null, currency: "EUR", values: { day: S, now: "182.40", baseline: "111.20", ratio: "1.64" } }))
      .toBe("Ad spend up 64% on act_123: 182.40 EUR on 2026-11-25 vs 111.20 a day the week before");
    expect(adAlertText({ kind: "OVER_PACE", accountId: null, campaignName: null, currency: "EUR", values: { day: "2026-11-10", ratio: "1.24" } }))
      .toBe("Meta spend at 124% of the November budget pace");
  });

  it("SPEND_UP last seen 3 days ago is closed; NO_PURCHASES last seen 4 days ago is open; OVER_PACE while its month lasts", () => {
    const today = "2026-11-26";
    expect(isOpen("SPEND_UP", "2026-11-23", today)).toBe(false);
    expect(isOpen("SPEND_UP", "2026-11-24", today)).toBe(true);
    expect(isOpen("NO_PURCHASES", "2026-11-22", today)).toBe(true);
    expect(isOpen("ROAS_DOWN", "2026-11-20", today)).toBe(false);
    expect(isOpen("OVER_PACE", "2026-11-03", today)).toBe(true);
    expect(isOpen("OVER_PACE", "2026-10-31", "2026-11-01")).toBe(false);
  });
});
