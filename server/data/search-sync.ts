import type { DataSource, IntegrationConnection, Prisma } from "@prisma/client";
import { SEARCH_CONSOLE_ZONE, type SearchSitesDto } from "@/shared";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { prisma } from "@/server/db/prisma";
import { fetchSearchWindow, listSites, SearchConsoleError, type SearchDayResult, type StopReason } from "@/server/data/search-console";
import {
  addDays, dailyWindow, enqueueSourceSync, nextBackfillWindow, registerSync, stopReason, type SyncStop, zoneToday,
} from "@/server/data/sources";
import { accessToken, ReconnectNeeded } from "@/server/services/connections";

/**
 * Search Console's side of the data sync (docs/superpowers/plans/2026-11-23-phase-2-data.md, Task 2): the SEARCH_CONSOLE
 * runner that writes SearchDay, and the site picker (GET google/sites, PUT data-sources/search-console). The client
 * (search-console.ts) only fetches; this module owns every write and every route-facing check.
 */

// ---- adapter over the client ------------------------------------------------------------------------------------
// The client's stop reasons are being renamed to SyncStop on another branch ("rate_limit" → "rate_limited", plus
// "capped"). Everything here goes through these two functions, so at merge only `toStop` changes (to `(r) => r`).

const toStop = (r: StopReason): SyncStop => r;

async function readWindow(token: string, siteUrl: string, from: string, to: string): Promise<{ days: SearchDayResult[]; stop?: SyncStop }> {
  const w = await fetchSearchWindow(token, siteUrl, from, to);
  return { days: w.days, stop: w.stoppedReason && toStop(w.stoppedReason) };
}

/** The sites the connection's Google account can read; a client stop comes back as SearchSitesStop. */
async function readSites(conn: IntegrationConnection) {
  const token = await accessToken(conn);
  try {
    return await listSites(token, conn.scopes);
  } catch (e) {
    if (e instanceof SearchConsoleError) throw new SearchSitesStop(toStop(e.reason));
    throw e;
  }
}

// ---- sync --------------------------------------------------------------------------------------------------------

/** Backfill on a new site: 90 Google days, read 30 at a time, oldest first. */
export const BACKFILL_DAYS = 90;
export const BACKFILL_WINDOW_DAYS = 30;

type SourceKey = Pick<DataSource, "workspaceId" | "brandId" | "externalId">;
const asDate = (day: string) => new Date(`${day}T00:00:00Z`);

/**
 * Replaces each given (complete) day of a site: per day and dimension, delete then insert. A repeated or overlapping
 * run writes the same rows; a page Google dropped for a day is gone. Call inside one transaction.
 */
export async function replaceDays(tx: Prisma.TransactionClient, source: SourceKey, days: SearchDayResult[]) {
  const { workspaceId, brandId, externalId: siteUrl } = source;
  let count = 0;
  for (const d of days) {
    const day = asDate(d.day);
    for (const dimension of ["SITE", "PAGE"] as const) {
      await tx.searchDay.deleteMany({ where: { brandId, siteUrl, dimension, day, workspaceId } });
    }
    const base = { workspaceId, brandId, siteUrl, day };
    // The SITE row is written even at zero: it marks the day as read.
    const rows: Prisma.SearchDayCreateManyInput[] = [
      { ...base, dimension: "SITE", page: "", ...d.site },
      ...d.pages.map((p) => ({ ...base, dimension: "PAGE" as const, page: p.page, clicks: p.clicks, impressions: p.impressions, positionSum: p.positionSum })),
    ];
    await tx.searchDay.createMany({ data: rows });
    count += rows.length;
  }
  return count;
}

/**
 * Daily and manual runs re-read Google's last 3 days (the newest ~2 are preliminary); backfill reads its window.
 * Every complete day is written in one transaction. A permission stop writes nothing; a rate-limit (or time-cap)
 * stop writes the complete days before it ("rate-limited" or "partial"); the window is incomplete, so the backfill
 * chain retries it later.
 * Reconnect and failed stops throw (stopReason), writing nothing.
 */
registerSync("SEARCH_CONSOLE", async (ctx) => {
  if (!ctx.connection) throw new ReconnectNeeded("Search Console source has no Google connection");
  const { from, to } = ctx.window ?? dailyWindow(zoneToday(SEARCH_CONSOLE_ZONE));
  const token = await accessToken(ctx.connection);
  const { days, stop } = await readWindow(token, ctx.source.externalId, from, to);
  const reason = stopReason(stop);
  if (reason === "permission") return { count: 0, reason };
  const complete = days.filter((d) => d.complete);
  // ponytail: one transaction of up to 30 days × ~500 rows; the timeout is raised for that. If it nears it, split per day.
  const count = complete.length ? await prisma.$transaction((tx) => replaceDays(tx, ctx.source, complete), { timeout: 60_000 }) : 0;
  return { count, complete: !stop && complete.length === days.length, reason };
});

// ---- site picker -------------------------------------------------------------------------------------------------

/** A picker request that can't go on, with the status and fixed text the route returns. */
export class SearchSiteError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 429 | 502 | 503, message: string) {
    super(message);
  }
}
class SearchSitesStop extends Error {
  constructor(readonly stop: SyncStop) {
    super(stop);
  }
}

type Scope = { workspaceId: string; brandId: string; userId: string };

/** Each live list call hits Google; per brand and person, shared by GET sites and PUT. */
export const PICKER_LIMIT = { limit: 20, windowMs: 60 * 60_000 };

async function liveSites(scope: Scope, connectionId: string) {
  // The connection must be this brand's Google connection; any other id is "not found", never "forbidden".
  const conn = await prisma.integrationConnection.findFirst({
    where: { id: connectionId, brandId: scope.brandId, workspaceId: scope.workspaceId, provider: "GOOGLE" },
  });
  if (!conn) throw new SearchSiteError(404, "Google connection not found");
  if (!(await hitRateLimit(`google-sites:${scope.brandId}:${scope.userId}`, PICKER_LIMIT.limit, PICKER_LIMIT.windowMs)).allowed) {
    throw new SearchSiteError(429, "Google sites were loaded too often. Try again later.");
  }
  try {
    return { conn, sites: await readSites(conn) };
  } catch (e) {
    if (e instanceof ReconnectNeeded) throw new SearchSiteError(409, "Reconnect Google to allow Search Console.");
    if (!(e instanceof SearchSitesStop)) throw e;
    if (e.stop === "reconnect" || e.stop === "missing_scope") throw new SearchSiteError(409, "Reconnect Google to allow Search Console.");
    if (e.stop === "rate_limited") throw new SearchSiteError(503, "Search Console is busy. Try again later.");
    if (e.stop === "permission") throw new SearchSiteError(409, "This Google account can't read Search Console. Reconnect it and allow access.");
    throw new SearchSiteError(502, "Search Console didn't answer. Try again later.");
  }
}

/** GET google/sites: the verified sites of this Google connection, and the brand's chosen site if any. */
export async function listSearchSites(scope: Scope, connectionId: string): Promise<SearchSitesDto> {
  const { sites } = await liveSites(scope, connectionId);
  const chosen = await prisma.dataSource.findFirst({
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId, kind: "SEARCH_CONSOLE", status: { not: "OFF" } },
    select: { externalId: true },
  });
  return { sites: sites.map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel })), chosen: chosen?.externalId ?? null };
}

/**
 * PUT data-sources/search-console: the site must be in the connection's live list. Upserts the brand's source for it
 * (re-picking the same site bumps updatedAt, so its backfill re-runs), switches any other site's source OFF (its rows
 * are kept and read by siteUrl), and queues the first backfill window. The caller kicks the runner.
 * ponytail: two people picking different sites in the same instant can leave both on; the next pick settles it.
 */
export async function chooseSearchSite(scope: Scope, body: { connectionId: string; siteUrl: string }, now = new Date()) {
  const { conn, sites } = await liveSites(scope, body.connectionId);
  if (!sites.some((s) => s.siteUrl === body.siteUrl)) throw new SearchSiteError(400, "That site isn't one this Google account can read.");
  const where = { workspaceId: scope.workspaceId, brandId: scope.brandId, kind: "SEARCH_CONSOLE" as const };
  const fields = { connectionId: conn.id, label: body.siteUrl, settings: { reportsIn: SEARCH_CONSOLE_ZONE }, status: "ACTIVE" as const, syncedThrough: null };
  const source = await prisma.$transaction(async (tx) => {
    await tx.dataSource.updateMany({ where: { ...where, externalId: { not: body.siteUrl }, status: { not: "OFF" } }, data: { status: "OFF" } });
    return tx.dataSource.upsert({
      where: { brandId_kind_externalId: { brandId: scope.brandId, kind: "SEARCH_CONSOLE", externalId: body.siteUrl } },
      create: { ...where, externalId: body.siteUrl, ...fields },
      update: fields,
    });
  });
  const end = addDays(zoneToday(SEARCH_CONSOLE_ZONE, now), -1);
  const window = nextBackfillWindow(null, addDays(end, -(BACKFILL_DAYS - 1)), end, BACKFILL_WINDOW_DAYS)!;
  await enqueueSourceSync(source, "backfill", { window: { ...window, end } });
  return source;
}
