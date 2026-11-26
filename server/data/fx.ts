import { Prisma } from "@prisma/client";
import { isEcbCurrency } from "@/shared";
import { prisma } from "@/server/db/prisma";
import { parseSheet } from "@/server/catalog/import-file";
import { BodyTooLarge, cappedText } from "@/server/integrations/capped-text";
import { enqueueJob } from "@/server/jobs/queue";
import { addDays } from "@/server/data/sources";

/**
 * ECB euro reference rates (plan 2026-11-26-phase-2-followup, Task 1), so ad spend and shop sales in different
 * currencies can be compared. One global table (FxRate: 1 EUR = perEur units, per TARGET working day), filled once a
 * day by the `fx.sync` job for the currencies in use; screens convert through rateTable and say that they did.
 *
 * Rule for a day: the latest ECB rate on or before it (the ECB publishes no rate on weekends and TARGET holidays). A
 * rate more than STALE_DAYS older than the day it serves is still used, flagged `stale` so the figure can say "uses a
 * rate from <day>". Cross rates go through EUR: X → Y = amount / perEur[X] × perEur[Y].
 */
export const FX_SYNC_JOB = "fx.sync";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** 3 years of a currency's rates is ~270 KB of CSV; 1 MB is far above anything real. */
const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 15_000;
export const STALE_DAYS = 7;
/** How far back a currency's rates are ever fetched. */
const BACKFILL_YEARS = 3;
/** A forward read starts this many days before the newest rate held, so a corrected publication is picked up. */
const OVERLAP_DAYS = 7;
/** Days of a currency with no rate held yet that the forward read covers; older ones come through the back-fill. */
const FIRST_DAYS = 14;
/** rateTable loads this much before `from`, so a range starting after a long weekend still finds its rate. */
const LOOKBACK_DAYS = 14;
/** OBS_VALUE: positive, fits Decimal(18, 6) (12 integer digits); more decimals are rounded by Postgres. */
const RATE = /^\d{1,12}(\.\d+)?$/;

export type EcbRate = { day: string; perEur: string };

/**
 * One currency's daily rates from the ECB data API, `from`..`to` inclusive ("YYYY-MM-DD"). The URL is built only from
 * ECB_CURRENCIES and the given server-made days (anything else throws before a request). 404 and an empty 200 (both
 * mean "no rate published in that window": the API answers a weekend-only window with an empty 200, seen live
 * 2026-11-26) are no rows. Other statuses, a body over 1 MB, or an unreadable body throw fixed texts; the body is
 * never logged. Rows with a bad day or a non-positive or non-numeric value are dropped.
 */
export async function fetchEcbRates(currency: string, from: string, to: string, fetchFn: typeof fetch = fetch): Promise<EcbRate[]> {
  if (!isEcbCurrency(currency)) throw new Error("fx: not an ECB currency");
  if (!DAY.test(from) || !DAY.test(to)) throw new Error("fx: bad day");
  const url = `https://data-api.ecb.europa.eu/service/data/EXR/D.${currency}.EUR.SP00.A?startPeriod=${from}&endPeriod=${to}&format=csvdata`;
  const res = await fetchFn(url, { redirect: "error", headers: { accept: "text/csv" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) {
    await res.body?.cancel();
    return [];
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new Error(`fx: ECB answered ${res.status}`);
  }
  let text: string;
  try {
    text = await cappedText(res, MAX_BYTES);
  } catch (e) {
    throw e instanceof BodyTooLarge ? new Error("fx: ECB answer too large") : e;
  }
  if (!text.trim()) return [];
  const sheet = parseSheet(new TextEncoder().encode(text));
  if ("error" in sheet) throw new Error("fx: ECB answer unreadable");
  const dayCol = sheet.headers.indexOf("TIME_PERIOD");
  const valueCol = sheet.headers.indexOf("OBS_VALUE");
  if (dayCol < 0 || valueCol < 0) throw new Error("fx: ECB answer unreadable");
  const rows: EcbRate[] = [];
  for (const r of sheet.rows) {
    const day = r[dayCol] ?? "";
    const value = r[valueCol] ?? "";
    if (!DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)) || !RATE.test(value) || !(Number(value) > 0)) continue;
    rows.push({ day, perEur: value });
  }
  return rows;
}

/** Saves a currency's rates; a rerun of the same window writes the same rows (a corrected rate overwrites). */
export async function saveRates(currency: string, rates: EcbRate[]) {
  if (!rates.length || !isEcbCurrency(currency)) return 0;
  return prisma.$executeRaw`
    INSERT INTO "FxRate" ("currency", "day", "perEur")
    SELECT ${currency}, r.day, r.per_eur FROM jsonb_to_recordset(${JSON.stringify(rates.map((x) => ({ day: x.day, per_eur: x.perEur })))}::jsonb) AS r(day date, per_eur numeric)
    ON CONFLICT ("currency", "day") DO UPDATE SET "perEur" = EXCLUDED."perEur"`;
}

/** Daily sweep step: queues the day's one fx.sync job (no network here). Not a data.% job, so outside the data cap. */
export function enqueueFxSync(now = new Date()) {
  return enqueueJob({ type: FX_SYNC_JOB, payload: {}, idempotencyKey: `fx:${now.toISOString().slice(0, 10)}`, maxAttempts: 3 });
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The non-EUR ECB currencies in use, each with the brands using it: Meta ad accounts' currencies
 * (DataSource.settings.currency), ad budgets' currencies, and per brand the currencies of its orders processed in the last 60 days (the
 * (brandId, processedAt) index). A currency outside ECB_CURRENCIES is skipped, never fetched.
 */
export async function currenciesInUse(now = new Date()) {
  const use = new Map<string, Set<string>>();
  const add = (currency: unknown, brandId: string) => {
    if (!isEcbCurrency(currency)) return;
    if (!use.has(currency)) use.set(currency, new Set());
    use.get(currency)!.add(brandId);
  };
  const sources = await prisma.dataSource.findMany({
    where: { kind: { in: ["META_ADS", "SHOPIFY_ORDERS"] }, status: { not: "OFF" } },
    select: { kind: true, brandId: true, settings: true },
  });
  const since = new Date(now.getTime() - 60 * 86_400_000);
  for (const s of sources) {
    if (s.kind === "META_ADS") add((s.settings as { currency?: unknown } | null)?.currency, s.brandId);
  }
  // Budgets carry their own currency (a budget-only one still needs rates for pacing). A small table: read whole.
  for (const b of await prisma.adBudget.findMany({ distinct: ["brandId", "currency"], select: { brandId: true, currency: true } })) add(b.currency, b.brandId);
  for (const brandId of new Set(sources.filter((s) => s.kind === "SHOPIFY_ORDERS").map((s) => s.brandId))) {
    const rows = await prisma.$queryRaw<{ currency: string }[]>`
      SELECT DISTINCT "currency" FROM "ShopOrder" WHERE "brandId" = ${brandId} AND "processedAt" > ${since}`;
    for (const r of rows) add(r.currency, brandId);
  }
  return use;
}

/** The oldest day any of `brandIds` has ad spend or an order in `currency`, or null. */
async function oldestUse(currency: string, brandIds: Iterable<string>) {
  let oldest: string | null = null;
  for (const brandId of brandIds) {
    const [ad] = await prisma.$queryRaw<{ d: Date | null }[]>`SELECT min("day") AS d FROM "AdDay" WHERE "brandId" = ${brandId} AND "currency" = ${currency}`;
    const [order] = await prisma.$queryRaw<{ d: Date | null }[]>`SELECT min("processedAt") AS d FROM "ShopOrder" WHERE "brandId" = ${brandId} AND "currency" = ${currency}`;
    for (const d of [ad?.d, order?.d]) if (d && (oldest === null || dayOf(d) < oldest)) oldest = dayOf(d);
  }
  return oldest;
}

/**
 * fx.sync: for each currency in use, reads forward from (newest rate held − 7 days) to today; and back-fills when
 * some brand has spend or orders older than the oldest rate held (at most BACKFILL_YEARS back), for one currency per
 * run so a day's job stays short (the next run takes the next). One currency failing is logged and skips only it.
 * ponytail: one request per currency per day (~30 at most), sequential.
 */
export async function syncFxRates(now = new Date(), fetchFn: typeof fetch = fetch) {
  const today = dayOf(now);
  const floor = addDays(today, -365 * BACKFILL_YEARS);
  const use = await currenciesInUse(now);
  let backfilled = false;
  for (const [currency, brands] of [...use].sort(([a], [b]) => a.localeCompare(b))) {
    try {
      const [held] = await prisma.$queryRaw<{ min: Date | null; max: Date | null }[]>`
        SELECT min("day") AS min, max("day") AS max FROM "FxRate" WHERE "currency" = ${currency}`;
      const from = held?.max ? addDays(dayOf(held.max), -OVERLAP_DAYS) : addDays(today, -FIRST_DAYS);
      await saveRates(currency, await fetchEcbRates(currency, from, today, fetchFn));
      if (backfilled) continue;
      const oldestHeld = held?.min ? dayOf(held.min) : from;
      const oldest = await oldestUse(currency, brands);
      if (oldest === null) continue;
      // Days older than the cap aren't converted; a week of slack so the cap's own start isn't re-asked every day.
      const target = oldest > addDays(floor, OVERLAP_DAYS) ? oldest : addDays(floor, OVERLAP_DAYS);
      if (target >= oldestHeld) continue;
      // From a week before the oldest day in use, so that day (a Monday, say) has the Friday before it.
      const start = addDays(target, -OVERLAP_DAYS);
      backfilled = true;
      await saveRates(currency, await fetchEcbRates(currency, start, addDays(oldestHeld, -1), fetchFn));
    } catch (e) {
      console.warn("[fx] rates not read", currency, e instanceof Error ? e.message : "error");
    }
  }
}

/** The fx.sync job handler (payload {}). */
export const runFxSync = () => syncFxRates();

export type Converted = { amount: Prisma.Decimal; rateDay: string | null; stale: boolean };
type Point = { day: string; perEur: Prisma.Decimal };

/**
 * The rates of `currencies` for days `from`..`to`, loaded in one query (from LOOKBACK_DAYS before `from`), and a
 * `convert` over them. convert gives null when a rate is missing (no figure, never a guess); same currency gives the
 * amount unchanged. `rateDay` is the oldest rate used (null when none was needed); `stale` when it is more than
 * STALE_DAYS older than the day.
 * ponytail: loaded per request; ~250 rows per currency per year, so years × ~30 currencies stays small.
 */
export async function rateTable(currencies: Iterable<string>, from: string, to: string) {
  const wanted = [...new Set(currencies)].filter(isEcbCurrency);
  const rows = wanted.length
    ? await prisma.fxRate.findMany({
        where: { currency: { in: wanted }, day: { gte: new Date(`${addDays(from, -LOOKBACK_DAYS)}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } },
        orderBy: [{ currency: "asc" }, { day: "asc" }],
      })
    : [];
  const byCurrency = new Map<string, Point[]>();
  for (const r of rows) {
    if (!byCurrency.has(r.currency)) byCurrency.set(r.currency, []);
    byCurrency.get(r.currency)!.push({ day: dayOf(r.day), perEur: r.perEur });
  }
  /** The latest rate on or before `day`: EUR is 1 with no day. */
  const rateOn = (currency: string, day: string): Point | { day: null; perEur: Prisma.Decimal } | null => {
    if (currency === "EUR") return { day: null, perEur: new Prisma.Decimal(1) };
    const points = byCurrency.get(currency);
    if (!points) return null;
    let lo = 0;
    let hi = points.length - 1;
    let found: Point | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].day <= day) {
        found = points[mid];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };
  return {
    convert(amount: Prisma.Decimal.Value, fromCur: string, toCur: string, day: string): Converted | null {
      const value = new Prisma.Decimal(amount);
      if (fromCur === toCur) return { amount: value, rateDay: null, stale: false };
      const a = rateOn(fromCur, day);
      const b = rateOn(toCur, day);
      if (!a || !b) return null;
      const used = [a.day, b.day].filter((d): d is string => d !== null).sort();
      const rateDay = used[0] ?? null;
      const stale = rateDay !== null && Date.parse(`${day}T00:00:00Z`) - Date.parse(`${rateDay}T00:00:00Z`) > STALE_DAYS * 86_400_000;
      return { amount: value.div(a.perEur).mul(b.perEur), rateDay, stale };
    },
  };
}
