import { describe, expect, it } from "vitest";
import { declineWindows, evaluateDeclines, isOpen, seoAlertText, type PageWindowRow } from "@/server/seo/declines";

const DAY = "2026-11-20";
const w = declineWindows(DAY);
const ctx = (over: Partial<Parameters<typeof evaluateDeclines>[2]> = {}) => ({ day: DAY, brandId: "b1", backfillStart: "2026-08-01", capFloors: new Map<string, number>(), ...over });
const site = { recent: 1000, previous: 1000 };
const row = (page: string, recent: boolean, clicks: number, impressions = 0, position = 5, cappedDays: string[] = []): PageWindowRow =>
  ({ page, recent, clicks, impressions, positionSum: position * impressions, cappedDays });
/** A page with `before` clicks in the previous window and `now` in the recent one. */
const page = (path: string, before: number, now: number) => [row(`https://shop.test${path}`, false, before), row(`https://shop.test${path}`, true, now)];

describe("declineWindows", () => {
  it("28 days ending 3 days before syncedThrough, and the 28 before", () => {
    expect(w).toEqual({ recent: { from: "2026-10-21", to: "2026-11-17" }, previous: { from: "2026-09-23", to: "2026-10-20" } });
  });
});

describe("CLICKS_DOWN", () => {
  it("fires at a 40% drop with ≥ 30 before and ≥ 15 lost, not just above", () => {
    expect(evaluateDeclines(page("/a", 50, 30), site, ctx()).map((c) => c.kind)).toEqual(["CLICKS_DOWN"]);
    expect(evaluateDeclines(page("/a", 50, 31), site, ctx())).toEqual([]);
  });

  it("noise floors: under 30 clicks before, or under 15 lost, says nothing", () => {
    expect(evaluateDeclines(page("/a", 29, 0), site, ctx())).toEqual([]);
    expect(evaluateDeclines(page("/a", 30, 16), site, ctx())).toEqual([]);
    expect(evaluateDeclines(page("/a", 30, 15), site, ctx()).map((c) => c.loss)).toEqual([15]);
  });

  it("sums a page's spellings (http/https, www, slash) as one page; a page with a query string is skipped", () => {
    const rows = [
      row("https://shop.test/a", false, 20), row("http://www.shop.test/a/", false, 20), row("https://shop.test/a", true, 10),
      row("https://shop.test/b?variant=1", false, 100), row("https://shop.test/b?variant=1", true, 0),
    ];
    const [c, ...rest] = evaluateDeclines(rows, site, ctx());
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ kind: "CLICKS_DOWN", pageKey: "shop.test/a", subjectKey: "CLICKS_DOWN:b1:shop.test/a", values: { now: "10", before: "40" } });
  });

  it("a page gone from the recent window counts 0 on days under the cap", () => {
    expect(evaluateDeclines([row("https://shop.test/a", false, 40)], site, ctx())[0]).toMatchObject({ values: { now: "0", before: "40" } });
  });

  it("cap floors: a page missing on capped days alerts only if the drop holds with the day's 500th-row clicks", () => {
    const floors = new Map([["2026-11-01", 5], ["2026-11-02", 5]]);
    // 40 before, 10 seen + 2 × 5 hidden at most = 20 → 50% drop, 20 lost: holds.
    const holds = [row("https://shop.test/a", false, 40), row("https://shop.test/a", true, 10)];
    expect(evaluateDeclines(holds, site, ctx({ capFloors: floors }))[0]).toMatchObject({ values: { now: "20", nowAtMost: "true" } });
    // 40 before, 20 seen + 10 hidden = 30: not a 40% drop any more.
    expect(evaluateDeclines([row("https://shop.test/a", false, 40), row("https://shop.test/a", true, 20)], site, ctx({ capFloors: floors }))).toEqual([]);
    // Present on those capped days: no floor added.
    const present = [row("https://shop.test/a", false, 40), row("https://shop.test/a", true, 10, 0, 5, ["2026-11-01", "2026-11-02"])];
    expect(evaluateDeclines(present, site, ctx({ capFloors: floors }))[0]!.values).toEqual(expect.not.objectContaining({ nowAtMost: "true" }));
  });
});

describe("POSITION_DOWN", () => {
  const pos = (before: number, after: number, impressions = 200) =>
    [row("https://shop.test/p", false, 10, impressions, before), row("https://shop.test/p", true, 10, impressions, after)];
  it("3 places worse from within the top 20, with ≥ 200 impressions in both windows", () => {
    expect(evaluateDeclines(pos(10, 13), site, ctx())[0]).toMatchObject({ kind: "POSITION_DOWN", values: { before: "10.0", now: "13.0" } });
    expect(evaluateDeclines(pos(10, 12.9), site, ctx())).toEqual([]);
    expect(evaluateDeclines(pos(21, 30), site, ctx())).toEqual([]);
    expect(evaluateDeclines(pos(10, 15, 199), site, ctx())).toEqual([]);
  });
});

describe("guards", () => {
  it("site-wide: when the site fell 40% too, one SITE_DOWN instead of page alerts", () => {
    const rows = [...page("/a", 50, 0), ...page("/b", 50, 0)];
    const out = evaluateDeclines(rows, { recent: 600, previous: 1000 }, ctx());
    expect(out.map((c) => [c.kind, c.subjectKey])).toEqual([["SITE_DOWN", "SITE_DOWN:b1"]]);
    // A tiny site's fall stays quiet, and still raises no page alerts.
    expect(evaluateDeclines(rows, { recent: 10, previous: 20 }, ctx())).toEqual([]);
  });

  it("too few read days (backfill after the previous window's start, or unknown) → nothing", () => {
    expect(evaluateDeclines(page("/a", 50, 0), site, ctx({ backfillStart: w.previous.from }))).toHaveLength(1);
    expect(evaluateDeclines(page("/a", 50, 0), site, ctx({ backfillStart: "2026-09-24" }))).toEqual([]);
    expect(evaluateDeclines(page("/a", 50, 0), site, ctx({ backfillStart: null }))).toEqual([]);
  });

  it("at most 20 a run, biggest click loss first", () => {
    const rows = Array.from({ length: 25 }, (_, i) => page(`/p${i}`, 100 + i, 0)).flat();
    const out = evaluateDeclines(rows, site, ctx());
    expect(out).toHaveLength(20);
    expect(out[0]!.pageKey).toBe("shop.test/p24");
    expect(out.at(-1)!.pageKey).toBe("shop.test/p5");
  });
});

describe("seoAlertText and isOpen", () => {
  it("one line with the cleaned path", () => {
    expect(seoAlertText({ kind: "CLICKS_DOWN", pageKey: "shop.test/products/oak-table", values: { now: "22", before: "40", to: "2026-11-20" } }))
      .toBe("Clicks down 45% on /products/oak-table: 22 in the 28 days to 2026-11-20 vs 40 the 28 days before");
    expect(seoAlertText({ kind: "CLICKS_DOWN", pageKey: "shop.test/a", values: { now: "20", before: "40", to: "2026-11-20", nowAtMost: "true" } })).toContain("at most 20");
    expect(seoAlertText({ kind: "SITE_DOWN", pageKey: "", values: { now: "600", before: "1000", to: "2026-11-20" } })).toBe(
      "Search clicks down 40% across the site: 600 in the 28 days to 2026-11-20 vs 1000 the 28 days before",
    );
    expect(seoAlertText({ kind: "POSITION_DOWN", pageKey: "shop.test/%E2%80%AEevil", values: { now: "13.0", before: "10.0", to: "2026-11-20" } })).not.toMatch(/[‮\n]/);
  });

  it("open while a new evaluation would still join it: lastDay within 7 days of the recent window's end (3 before syncedThrough)", () => {
    expect(isOpen("2026-11-10", "2026-11-20")).toBe(true);
    expect(isOpen("2026-11-09", "2026-11-20")).toBe(false);
    expect(isOpen("2026-11-20", null)).toBe(false);
  });
});
