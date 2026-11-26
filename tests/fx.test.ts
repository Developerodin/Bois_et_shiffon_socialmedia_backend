import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ rows: [] as { currency: string; day: Date; perEur: unknown }[], findMany: vi.fn() }));
vi.mock("@/server/db/prisma", () => ({ prisma: { fxRate: { findMany: db.findMany } } }));
const queue = vi.hoisted(() => ({ enqueueJob: vi.fn() }));
vi.mock("@/server/jobs/queue", () => queue);

import { ECB_CURRENCIES } from "@/shared";
import { enqueueFxSync, fetchEcbRates, FX_SYNC_JOB, rateTable } from "@/server/data/fx";

const HEADER = "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS,TITLE_COMPL";
const line = (day: string, value: string) => `EXR.D.INR.EUR.SP00.A,D,INR,EUR,SP00,A,${day},${value},A,"ECB reference exchange rate, Indian rupee/Euro, 2.15 pm (C.E.T.)"`;
const csv = (...lines: string[]) => [HEADER, ...lines].join("\r\n");
const answer = (body: string | ReadableStream, status = 200) => vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () => new Response(body, { status }));

describe("fetchEcbRates", () => {
  it("CSV parsed to rows (quoted fields with commas included)", async () => {
    const f = answer(csv(line("2026-11-02", "106.4505"), line("2026-11-03", "105.9155")));
    expect(await fetchEcbRates("INR", "2026-11-01", "2026-11-03", f)).toEqual([
      { day: "2026-11-02", perEur: "106.4505" },
      { day: "2026-11-03", perEur: "105.9155" },
    ]);
  });

  it("zero or malformed OBS_VALUE dropped, and bad days", async () => {
    const f = answer(csv(line("2026-11-02", "0"), line("2026-11-03", "abc"), line("2026-11-04", "-1.2"), line("2026-11-05", ""),
      line("2026-13-45", "1.1"), line("2026-11-06", "1e3"), line("2026-11-07", "1.5")));
    expect(await fetchEcbRates("INR", "2026-11-01", "2026-11-07", f)).toEqual([{ day: "2026-11-07", perEur: "1.5" }]);
  });

  it("404 → no rows; an empty 200 (a weekend-only window, as the API answers it) → no rows", async () => {
    expect(await fetchEcbRates("INR", "2026-11-21", "2026-11-22", answer("No results found.", 404))).toEqual([]);
    expect(await fetchEcbRates("INR", "2026-11-21", "2026-11-22", answer(""))).toEqual([]);
  });

  it("other statuses throw a fixed text without the body", async () => {
    const e = await fetchEcbRates("INR", "2026-11-01", "2026-11-02", answer("secret upstream text", 500)).catch((x: Error) => x);
    expect(String(e)).toContain("ECB answered 500");
    expect(String(e)).not.toContain("secret");
  });

  it("body over 1 MB stops while streaming", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(256 * 1024).fill(65);
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled > 100) c.close();
        else c.enqueue(chunk);
      },
    });
    const e = await fetchEcbRates("INR", "2026-11-01", "2026-11-02", answer(body)).catch((x: Error) => x);
    expect(String(e)).toContain("too large");
    expect(pulled).toBeLessThan(10);
  });

  it("URL built only from ECB_CURRENCIES and server dates", async () => {
    const f = answer(csv());
    await fetchEcbRates("USD", "2026-01-01", "2026-01-31", f);
    expect(f.mock.calls[0][0]).toBe("https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?startPeriod=2026-01-01&endPeriod=2026-01-31&format=csvdata");
    expect(f.mock.calls[0][1]).toMatchObject({ redirect: "error" });
    for (const [cur, from] of [["EUR", "2026-01-01"], ["XYZ", "2026-01-01"], ["USD/../x", "2026-01-01"], ["USD", "2026-01-01&x=1"]]) {
      await expect(fetchEcbRates(cur, from, "2026-01-31", f)).rejects.toThrow();
    }
    expect(f).toHaveBeenCalledTimes(1);
    expect(ECB_CURRENCIES).not.toContain("EUR");
  });
});

describe("rateTable", () => {
  const rate = (currency: string, day: string, perEur: string) => ({ currency, day: new Date(`${day}T00:00:00Z`), perEur: new Prisma.Decimal(perEur) });
  beforeEach(() => {
    db.findMany.mockReset();
    db.findMany.mockImplementation(async () => db.rows);
    db.rows = [
      rate("INR", "2026-11-06", "100"), // Friday
      rate("INR", "2026-11-09", "102"),
      rate("USD", "2026-11-06", "1.25"),
      rate("USD", "2026-11-09", "1.2"),
    ];
  });

  it("weekend uses Friday's rate", async () => {
    const t = await rateTable(["INR"], "2026-11-07", "2026-11-08");
    expect(t.convert("200", "INR", "EUR", "2026-11-08")).toMatchObject({ rateDay: "2026-11-06", stale: false });
    expect(t.convert("200", "INR", "EUR", "2026-11-08")!.amount.toString()).toBe("2");
  });

  it("INR→EUR→USD cross rate", async () => {
    const t = await rateTable(["INR", "USD"], "2026-11-09", "2026-11-09");
    // 1020 INR / 102 = 10 EUR; × 1.2 = 12 USD
    expect(t.convert("1020", "INR", "USD", "2026-11-09")!.amount.toString()).toBe("12");
  });

  it("EUR is 1 and never queried", async () => {
    const t = await rateTable(["EUR", "USD"], "2026-11-09", "2026-11-09");
    expect(db.findMany.mock.calls[0][0].where.currency.in).toEqual(["USD"]);
    expect(t.convert("10", "EUR", "USD", "2026-11-09")).toMatchObject({ rateDay: "2026-11-09" });
    expect(t.convert("10", "EUR", "USD", "2026-11-09")!.amount.toString()).toBe("12");
    expect(t.convert("10", "EUR", "EUR", "2026-11-09")).toMatchObject({ rateDay: null, stale: false });
  });

  it("loads from 14 days before the range, one query", async () => {
    await rateTable(["INR", "USD"], "2026-11-20", "2026-11-30");
    expect(db.findMany).toHaveBeenCalledTimes(1);
    expect(db.findMany.mock.calls[0][0].where.day.gte.toISOString().slice(0, 10)).toBe("2026-11-06");
  });

  it("stale after 7 days", async () => {
    const t = await rateTable(["INR"], "2026-11-16", "2026-11-17");
    expect(t.convert("1", "INR", "EUR", "2026-11-16")).toMatchObject({ rateDay: "2026-11-09", stale: false });
    expect(t.convert("1", "INR", "EUR", "2026-11-17")).toMatchObject({ rateDay: "2026-11-09", stale: true });
  });

  it("no rate → null; same currency → unchanged", async () => {
    const t = await rateTable(["INR", "GBP"], "2026-11-09", "2026-11-09");
    expect(t.convert("1", "GBP", "EUR", "2026-11-09")).toBeNull();
    expect(t.convert("1", "INR", "EUR", "2026-11-01")).toBeNull();
    expect(t.convert("1", "XYZ", "EUR", "2026-11-09")).toBeNull();
    expect(t.convert("7.5", "XYZ", "XYZ", "2026-11-09")!.amount.toString()).toBe("7.5");
  });
});

describe("enqueueFxSync", () => {
  it("queues one fx.sync job per UTC day, outside the data cap", async () => {
    await enqueueFxSync(new Date("2026-11-26T03:00:00Z"));
    expect(queue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({ type: FX_SYNC_JOB, idempotencyKey: "fx:2026-11-26" }));
    expect(FX_SYNC_JOB.startsWith("data.")).toBe(false);
  });
});
