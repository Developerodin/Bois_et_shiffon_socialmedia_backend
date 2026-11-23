import { describe, expect, it } from "vitest";
import { metrics, parsePagesQuery, parseSearchRange, previousRange } from "@/server/data/search-read";

const q = (s: string) => new URLSearchParams(s);

describe("parseSearchRange", () => {
  it("accepts up to 90 inclusive days", () => {
    expect(parseSearchRange(q("from=2026-08-01&to=2026-10-29"))).toEqual({ from: "2026-08-01", to: "2026-10-29" });
    expect(parseSearchRange(q("from=2026-11-01&to=2026-11-01"))).toEqual({ from: "2026-11-01", to: "2026-11-01" });
  });
  it("refuses 91 days, a reversed range, a missing or impossible day", () => {
    expect(parseSearchRange(q("from=2026-08-01&to=2026-10-30"))).toBeNull();
    expect(parseSearchRange(q("from=2026-11-02&to=2026-11-01"))).toBeNull();
    expect(parseSearchRange(q("from=2026-11-01"))).toBeNull();
    expect(parseSearchRange(q("from=2026-02-30&to=2026-03-01"))).toBeNull();
  });
});

describe("previousRange", () => {
  it("is the equal-length range just before", () => {
    expect(previousRange({ from: "2026-11-01", to: "2026-11-07" })).toEqual({ from: "2026-10-25", to: "2026-10-31" });
  });
});

describe("metrics", () => {
  it("position is positionSum / impressions (impression-weighted), ctr clicks / impressions", () => {
    // Two days: position 2 at 100 impressions, position 10 at 300 → (200 + 3000) / 400 = 8
    expect(metrics({ clicks: 20, impressions: 400, positionSum: 3200 })).toEqual({ clicks: 20, impressions: 400, ctr: 0.05, position: 8 });
  });
  it("no impressions: ctr and position are null, not NaN", () => {
    expect(metrics({ clicks: null, impressions: null, positionSum: null })).toEqual({ clicks: 0, impressions: 0, ctr: null, position: null });
  });
});

describe("parsePagesQuery", () => {
  it("defaults to clicks from the start", () => {
    expect(parsePagesQuery(q(""))).toEqual({ sort: "clicks", offset: 0 });
  });
  it("refuses an unknown sort, a cursor from another sort and a forged cursor", () => {
    const cursor = Buffer.from("clicks:50").toString("base64url");
    expect(parsePagesQuery(q(`sort=clicks&cursor=${cursor}`))).toEqual({ sort: "clicks", offset: 50 });
    expect(parsePagesQuery(q("sort=position"))).toBeNull();
    expect(parsePagesQuery(q(`sort=impressions&cursor=${cursor}`))).toBeNull();
    expect(parsePagesQuery(q("cursor=nonsense"))).toBeNull();
  });
});
