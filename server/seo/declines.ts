import { Prisma, type DataSource } from "@prisma/client";
import { z } from "zod";
import { urlKey, urlPath, type DateRange, type SeoAlertKind, type SeoAlertView } from "@/shared";
import { recordEpisode } from "@/server/alerts/episode";
import { PAGES_PER_DAY } from "@/server/data/search-console";
import { addDays, dayDate, dayOf, type SyncOutcome } from "@/server/data/sources";
import { prisma } from "@/server/db/prisma";
import { enqueueJob } from "@/server/jobs/queue";
import { cleanText, cleanTitle } from "@/server/text";

/**
 * Declining pages (docs/superpowers/plans/2026-11-26-seo-depth.md Task 5, Decision 10): after a Search Console source's
 * complete daily or manual sync, the `seo.declines` job compares the 28 Google days ending DECLINE_LAG_DAYS before
 * syncedThrough (the daily run re-reads only the last 3 days, so older days are final) with the 28 before, per page
 * (pages grouped by urlKey; a stored page with a query string is skipped, Decision 6), and stores what it finds in
 * SeoAlert, one row per episode, like the ads alerts (server/ads/alerts.ts; the episode step is server/alerts/episode.ts).
 *
 * Rules: CLICKS_DOWN (≥ 30 clicks before, now ≤ 60 % of that and ≥ 15 lost), POSITION_DOWN (≥ 200 impressions in both
 * windows, within the top 20 before, ≥ 3 places worse). Site-wide guard: when the site's own clicks fell ≥ 40 % too, no
 * page alerts; one SITE_DOWN instead. Cap-hit guard: on a day Google gave the full PAGES_PER_DAY rows, a page missing
 * that day may be below the cut, so it counts as that day's lowest clicks in the recent window (an upper bound) and 0
 * in the previous one (a lower bound): an alert holds whatever the hidden values were.
 *
 * Ceilings: global thresholds (per-brand settings if brands differ a lot); beyond the top-500 cut some real drops stay
 * quiet (the floor bound); seasonality only through the site-wide guard. Once per synced day: a day whose job fails all
 * attempts isn't evaluated (the next day's window covers it). The episode join is 7 days, ~5 of real slack with the lag.
 */

export const SEO_DECLINES_JOB = "seo.declines";
export const DECLINE_WINDOW_DAYS = 28;
export const DECLINE_MIN_CLICKS = 30;
export const CLICKS_DOWN_RATIO = 0.6;
export const DECLINE_MIN_LOSS = 15;
export const POSITION_MIN_IMPRESSIONS = 200;
export const POSITION_MAX_START = 20;
export const POSITION_DROP = 3;
export const SITE_DOWN_RATIO = 0.6;
export const DECLINES_PER_RUN = 20;
export const DECLINE_LAG_DAYS = 3;
/** An episode is open while its lastDay is within this many days of the source's syncedThrough; a new day this close continues it. */
export const OPEN_DAYS = 7;

/** The two 28-day windows for a source synced through `day`: recent ends DECLINE_LAG_DAYS before it, previous just before. */
export function declineWindows(day: string): { recent: DateRange; previous: DateRange } {
  const to = addDays(day, -DECLINE_LAG_DAYS);
  const from = addDays(to, -(DECLINE_WINDOW_DAYS - 1));
  const previousTo = addDays(from, -1);
  return { recent: { from, to }, previous: { from: addDays(previousTo, -(DECLINE_WINDOW_DAYS - 1)), to: previousTo } };
}

/** One stored page spelling's sums over one window; for the recent window, the capped days it has a row on. */
export type PageWindowRow = { page: string; recent: boolean; clicks: number; impressions: number; positionSum: number; cappedDays: string[] };
export type DeclineCandidate = { kind: SeoAlertKind; page: string; pageKey: string; subjectKey: string; loss: number; values: Record<string, string> };

type Sum = { clicks: number; impressions: number; positionSum: number };
const add = (a: Sum, r: Sum) => ({ clicks: a.clicks + r.clicks, impressions: a.impressions + r.impressions, positionSum: a.positionSum + r.positionSum });
const ZERO: Sum = { clicks: 0, impressions: 0, positionSum: 0 };
const hasQuery = (page: string) => {
  try {
    return new URL(page).search !== "";
  } catch {
    return true;
  }
};

/**
 * The rules over one source's two windows (pure). `site`: the SITE rows' clicks per window. `ctx.day`: syncedThrough;
 * `backfillStart`: the first day read (null or later than the previous window's first day → nothing, too few days);
 * `capFloors`: for each recent-window day with PAGES_PER_DAY page rows, that day's lowest clicks among them.
 */
export function evaluateDeclines(
  rows: PageWindowRow[],
  site: { recent: number; previous: number },
  ctx: { day: string; brandId: string; backfillStart: string | null; capFloors: Map<string, number> },
): DeclineCandidate[] {
  const w = declineWindows(ctx.day);
  if (!ctx.backfillStart || ctx.backfillStart > w.previous.from) return [];
  const range = { from: w.recent.from, to: w.recent.to, previousFrom: w.previous.from, previousTo: w.previous.to };

  // The site fell as much as a page would have to: not page problems. One SITE_DOWN (above the noise floors) or nothing.
  if (site.previous > 0 && site.recent <= site.previous * SITE_DOWN_RATIO) {
    const loss = site.previous - site.recent;
    if (site.previous < DECLINE_MIN_CLICKS || loss < DECLINE_MIN_LOSS) return [];
    return [{
      kind: "SITE_DOWN", page: "", pageKey: "", subjectKey: `SITE_DOWN:${ctx.brandId}`, loss,
      values: { now: String(site.recent), before: String(site.previous), ...range },
    }];
  }

  type Page = { recent: Sum; previous: Sum; present: Set<string>; spellings: Map<string, number> };
  const pages = new Map<string, Page>();
  for (const r of rows) {
    if (hasQuery(r.page)) continue;
    const key = urlKey(r.page);
    if (!key) continue;
    const p = pages.get(key) ?? { recent: ZERO, previous: ZERO, present: new Set<string>(), spellings: new Map<string, number>() };
    if (r.recent) {
      p.recent = add(p.recent, r);
      for (const d of r.cappedDays) p.present.add(d);
    } else p.previous = add(p.previous, r);
    p.spellings.set(r.page, (p.spellings.get(r.page) ?? 0) + r.clicks);
    pages.set(key, p);
  }

  const out: DeclineCandidate[] = [];
  for (const [pageKey, p] of pages) {
    // The page as shown: its most-clicked spelling.
    const page = [...p.spellings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
    let hidden = 0;
    for (const [day, floor] of ctx.capFloors) if (!p.present.has(day)) hidden += floor;
    const now = p.recent.clicks + hidden;
    const before = p.previous.clicks;
    const loss = before - now;
    if (before >= DECLINE_MIN_CLICKS && now <= before * CLICKS_DOWN_RATIO && loss >= DECLINE_MIN_LOSS) {
      out.push({
        kind: "CLICKS_DOWN", page, pageKey, subjectKey: `CLICKS_DOWN:${ctx.brandId}:${pageKey}`, loss,
        values: { now: String(now), before: String(before), ...range, ...(hidden > 0 && { nowAtMost: "true" }) },
      });
    }
    if (p.recent.impressions >= POSITION_MIN_IMPRESSIONS && p.previous.impressions >= POSITION_MIN_IMPRESSIONS) {
      const posBefore = p.previous.positionSum / p.previous.impressions;
      const posNow = p.recent.positionSum / p.recent.impressions;
      if (posBefore <= POSITION_MAX_START && posNow - posBefore >= POSITION_DROP) {
        out.push({
          kind: "POSITION_DOWN", page, pageKey, subjectKey: `POSITION_DOWN:${ctx.brandId}:${pageKey}`, loss: Math.max(0, p.previous.clicks - p.recent.clicks),
          values: { now: posNow.toFixed(1), before: posBefore.toFixed(1), clicksNow: String(p.recent.clicks), clicksBefore: String(p.previous.clicks), ...range },
        });
      }
    }
  }
  // At most DECLINES_PER_RUN, biggest click loss first.
  return out.sort((a, b) => b.loss - a.loss || a.subjectKey.localeCompare(b.subjectKey)).slice(0, DECLINES_PER_RUN);
}

type AlertFields = { kind: SeoAlertKind; pageKey: string; values: unknown };
const pathOf = (pageKey: string) => (pageKey ? urlPath(`https://${pageKey}`) : null);
const percentDown = (now: number, before: number) => (before ? Math.round((1 - now / before) * 100) : 0);

/**
 * One English line per alert, for the Search tab, the bell, the digest and the chat. The page is shown by its path,
 * through cleanTitle (Google's text: one line, no control or bidi characters); the figures are our own numbers.
 */
export function seoAlertText(a: AlertFields): string {
  const v = (a.values ?? {}) as Record<string, string>;
  const now = Number(v.now);
  const before = Number(v.before);
  const path = cleanTitle(pathOf(a.pageKey) ?? "");
  switch (a.kind) {
    case "CLICKS_DOWN":
      return `Clicks down ${percentDown(now, before)}% on ${path}: ${v.nowAtMost === "true" ? "at most " : ""}${now} in the 28 days to ${v.to} vs ${before} the 28 days before`;
    case "POSITION_DOWN":
      return `Average position on ${path} fell from ${v.before} to ${v.now} in the 28 days to ${v.to}`;
    case "SITE_DOWN":
      return `Search clicks down ${percentDown(now, before)}% across the site: ${now} in the 28 days to ${v.to} vs ${before} the 28 days before`;
  }
}

/** Is the alert open for a source synced through `syncedThrough`? */
export const isOpen = (lastDay: string, syncedThrough: string | null) => !!syncedThrough && lastDay >= addDays(syncedThrough, -OPEN_DAYS);

/** The page's URL as the server rebuilds it from its key (never Google's raw text): safe as a link. */
export const seoAlertUrl = (pageKey: string) => (pageKey ? `https://${pageKey}` : null);

type AlertRow = AlertFields & { id: string; firstDay: Date; lastDay: Date };
export function seoAlertView(a: AlertRow, syncedThrough: string | null): SeoAlertView {
  const lastDay = dayOf(a.lastDay);
  const path = pathOf(a.pageKey);
  return {
    id: a.id,
    kind: a.kind,
    url: seoAlertUrl(a.pageKey),
    path: path === null ? null : cleanText(path, 300),
    firstDay: dayOf(a.firstDay),
    lastDay,
    open: isOpen(lastDay, syncedThrough),
    text: seoAlertText(a),
    values: (a.values ?? {}) as Record<string, string>,
  };
}

/** The brand's chosen Search Console source (not OFF): its site and how far it is synced. */
async function liveSource(scope: { workspaceId: string; brandId: string }) {
  const s = await prisma.dataSource.findFirst({
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId, kind: "SEARCH_CONSOLE", status: { not: "OFF" } },
    select: { externalId: true, syncedThrough: true },
  });
  return s ? { siteUrl: s.externalId, syncedThrough: dayOf(s.syncedThrough) } : null;
}

/**
 * The brand's decline alerts, newest episode first, at most `limit`, and how many more. `open`: the chosen site's open
 * ones (the Search tab, the chat; index (brandId, lastDay)). `createdFrom/createdBefore`: raised in that window (the
 * digest's week; index (brandId, createdAt)).
 */
export async function listSeoAlerts(
  scope: { workspaceId: string; brandId: string },
  by: { open: true } | { createdFrom: Date; createdBefore: Date },
  limit: number,
): Promise<{ alerts: SeoAlertView[]; more: number }> {
  const source = await liveSource(scope);
  if ("open" in by && !source?.syncedThrough) return { alerts: [], more: 0 };
  const where: Prisma.SeoAlertWhereInput = {
    workspaceId: scope.workspaceId,
    brandId: scope.brandId,
    ...("open" in by
      ? { siteUrl: source!.siteUrl, lastDay: { gte: dayDate(addDays(source!.syncedThrough!, -OPEN_DAYS)) } }
      : { createdAt: { gte: by.createdFrom, lt: by.createdBefore } }),
  };
  const [rows, count] = await Promise.all([
    prisma.seoAlert.findMany({
      where,
      orderBy: [{ firstDay: "desc" }, { id: "asc" }],
      take: limit,
      select: { id: true, kind: true, pageKey: true, firstDay: true, lastDay: true, values: true },
    }),
    prisma.seoAlert.count({ where }),
  ]);
  return { alerts: rows.map((r) => seoAlertView(r, source?.syncedThrough ?? null)), more: Math.max(0, count - rows.length) };
}

/** One page's decline alerts of the last year (the URL history page), newest first, at most 20 (index (brandId, pageKey)). */
export async function pageSeoAlerts(scope: { workspaceId: string; brandId: string }, pageKey: string): Promise<SeoAlertView[]> {
  const [source, rows] = await Promise.all([
    liveSource(scope),
    prisma.seoAlert.findMany({
      where: { workspaceId: scope.workspaceId, brandId: scope.brandId, pageKey, lastDay: { gte: new Date(Date.now() - 366 * 86_400_000) } },
      orderBy: [{ firstDay: "desc" }, { id: "asc" }],
      take: 20,
      select: { id: true, kind: true, pageKey: true, firstDay: true, lastDay: true, values: true },
    }),
  ]);
  return rows.map((r) => seoAlertView(r, source?.syncedThrough ?? null));
}

// ---- the job -------------------------------------------------------------------------------------------------------

/**
 * SEARCH_CONSOLE's afterRun hook (sources.ts runs it after a complete daily or manual run only). Queues the evaluation
 * only when the run read up to its own window's end, as the ads alerts do. Keyed by source and day, so the daily run
 * and Sync now evaluate a day once.
 */
export async function enqueueSeoDeclines(source: DataSource, outcome: SyncOutcome, syncedThrough: string | null) {
  if (!outcome.window || syncedThrough !== outcome.window.to) return;
  await enqueueJob({
    type: SEO_DECLINES_JOB,
    workspaceId: source.workspaceId,
    brandId: source.brandId,
    payload: { workspaceId: source.workspaceId, brandId: source.brandId, dataSourceId: source.id, day: syncedThrough },
    idempotencyKey: runKeyOf(source.id, syncedThrough),
    maxAttempts: 3,
  });
}

const runKeyOf = (sourceId: string, day: string) => `seo-declines:${sourceId}:${day}`;
const Payload = z.object({ workspaceId: z.string(), brandId: z.string(), dataSourceId: z.string(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
type Settings = { backfill?: { start?: string }; declinesSeenFor?: string };

/**
 * Job handler. Re-reads the source by id AND the payload's workspace and brand, kind SEARCH_CONSOLE and not OFF, so a
 * payload naming another brand's source finds nothing. Reads the two windows' PAGE rows grouped by page and window, the
 * SITE clicks and the capped days' floors, evaluates, and stores every candidate in one transaction (≤ 21 rows).
 */
export async function runSeoDeclines(payload: unknown) {
  const p = Payload.parse(payload);
  const source = await prisma.dataSource.findFirst({
    where: { id: p.dataSourceId, workspaceId: p.workspaceId, brandId: p.brandId, kind: "SEARCH_CONSOLE", status: { not: "OFF" } },
  });
  if (!source || !source.syncedThrough || dayOf(source.syncedThrough) < p.day) return;
  const settings = (source.settings ?? {}) as Settings;
  const w = declineWindows(p.day);
  const backfillStart = settings.backfill?.start ?? null;
  if (!backfillStart || backfillStart > w.previous.from) return;
  const scope = { workspaceId: source.workspaceId, brandId: source.brandId };
  const siteUrl = source.externalId;
  // No workspaceId filter on SearchDay: the source was found by workspace and brand, and (brandId, siteUrl, dimension,
  // day) then answers from the INCLUDE index (as server/data/search-read.ts).
  const floors = await prisma.$queryRaw<{ day: string; floor: number }[]>`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, min(clicks)::int AS floor FROM "SearchDay"
    WHERE "brandId" = ${scope.brandId} AND "siteUrl" = ${siteUrl} AND dimension = 'PAGE'
      AND day BETWEEN ${dayDate(w.recent.from)}::date AND ${dayDate(w.recent.to)}::date
    GROUP BY day HAVING count(*) >= ${PAGES_PER_DAY}`;
  const capped = floors.map((f) => f.day);
  const [rows, siteRows] = await Promise.all([
    prisma.$queryRaw<PageWindowRow[]>`
      SELECT page, (day >= ${dayDate(w.recent.from)}::date) AS recent, sum(clicks)::int AS clicks,
        sum(impressions)::int AS impressions, sum("positionSum")::float8 AS "positionSum",
        COALESCE(array_agg(to_char(day, 'YYYY-MM-DD')) FILTER (WHERE to_char(day, 'YYYY-MM-DD') = ANY(${capped}::text[])), '{}') AS "cappedDays"
      FROM "SearchDay"
      WHERE "brandId" = ${scope.brandId} AND "siteUrl" = ${siteUrl} AND dimension = 'PAGE'
        AND day BETWEEN ${dayDate(w.previous.from)}::date AND ${dayDate(w.recent.to)}::date
      GROUP BY page, 2`,
    prisma.$queryRaw<{ recent: boolean; clicks: number }[]>`
      SELECT (day >= ${dayDate(w.recent.from)}::date) AS recent, sum(clicks)::int AS clicks FROM "SearchDay"
      WHERE "brandId" = ${scope.brandId} AND "siteUrl" = ${siteUrl} AND dimension = 'SITE'
        AND day BETWEEN ${dayDate(w.previous.from)}::date AND ${dayDate(w.recent.to)}::date
      GROUP BY 1`,
  ]);
  const site = { recent: siteRows.find((r) => r.recent)?.clicks ?? 0, previous: siteRows.find((r) => !r.recent)?.clicks ?? 0 };
  const candidates = evaluateDeclines(rows, site, {
    day: p.day, brandId: scope.brandId, backfillStart, capFloors: new Map(floors.map((f) => [f.day, f.floor])),
  });
  const runKey = runKeyOf(source.id, p.day);
  await prisma.$transaction(async (tx) => {
    for (const c of candidates) {
      await recordEpisode(tx, {
        table: "SeoAlert",
        scope,
        subjectKey: c.subjectKey,
        day: w.recent.to,
        values: c.values,
        join: { before: OPEN_DAYS, after: 1 },
        insert: async (t) => (await t.seoAlert.createManyAndReturn({
          data: [{
            ...scope, kind: c.kind, siteUrl, page: c.page.slice(0, 2_000), pageKey: c.pageKey, runKey,
            firstDay: dayDate(w.recent.to), lastDay: dayDate(w.recent.to), values: c.values, subjectKey: c.subjectKey,
            dedupeKey: `${c.subjectKey}:${w.recent.to}`,
          }],
          skipDuplicates: true,
          select: { id: true },
        }))[0],
      });
    }
  });
}
