import type { DataSource, Prisma } from "@prisma/client";
import { enqueueAdAlerts } from "@/server/ads/alerts";
import { prisma } from "@/server/db/prisma";
import { accessToken, markReconnect } from "@/server/services/connections";
import { CHUNK_DAYS, fetchAdWindow, type AdDayResult } from "./meta-ads";
import { addDays, backfillPlan, dailyWindow, enqueueBackfill, registerSync, stopReason, zoneToday, type BackfillPlan } from "./sources";

/**
 * META_ADS sync: reads an ad account's campaign days with fetchAdWindow and replaces them in AdDay.
 *
 * - Daily (and Sync now) re-reads the last ATTRIBUTION_DAYS account days: Meta keeps attributing purchases to a day
 *   for 7 days after it. Backfill walks BACKFILL_DAYS in CHUNK_DAYS windows, oldest first (sources.ts chains them).
 * - Writes: the client returns only chunks it read in full. Each chunk is one transaction: delete
 *   `WHERE brandId, platform, accountId AND day BETWEEN first AND last`, then insert. A campaign Meta stopped
 *   reporting for a day is gone; a repeated or overlapping run writes the same rows.
 * - Stops: 190 marks the connection for reconnect and stops retries; a disabled account or a missing ads_read is
 *   "permission" (the fixed text, not DISABLED_MESSAGE: lastResult.error only holds DATA_SYNC_ERRORS strings);
 *   rate limits and the time cap keep the chunks read and return a partial window.
 * - The account's currency or zone changing at Meta (or not matching what was chosen) writes nothing and throws
 *   (retried, then failed): rows of one account must stay in one currency and one zone. Choosing the account again picks up the new ones.
 */
export const ATTRIBUTION_DAYS = 7;
/** Twice the longest view (90 days), so it has a previous period from day one. */
export const BACKFILL_DAYS = 180;

/** `reportsIn`: the account's zone (the same key Search Console writes). */
export type AdSettings = { currency?: string; reportsIn?: string; backfill?: BackfillPlan };
const settingsOf = (s: DataSource) => (s.settings ?? {}) as AdSettings;

/** "act_123" → "123": the client adds the prefix itself. */
const graphId = (externalId: string) => externalId.replace(/^act_/, "");

/** Groups of consecutive days of at most CHUNK_DAYS (each a range the client read in full). */
function chunks(days: AdDayResult[]): AdDayResult[][] {
  const out: AdDayResult[][] = [];
  for (const d of [...days].sort((a, b) => a.day.localeCompare(b.day))) {
    const last = out.at(-1);
    if (last && last.length < CHUNK_DAYS && addDays(last[last.length - 1].day, 1) === d.day) last.push(d);
    else out.push([d]);
  }
  return out;
}

/** Replaces one chunk's days for this account in one transaction. Returns the rows written. */
export async function replaceAdDays(source: Pick<DataSource, "workspaceId" | "brandId" | "externalId">, currency: string, chunk: AdDayResult[]) {
  const from = new Date(`${chunk[0].day}T00:00:00Z`);
  const to = new Date(`${chunk[chunk.length - 1].day}T00:00:00Z`);
  const rows: Prisma.AdDayCreateManyInput[] = chunk.flatMap((d) =>
    d.campaigns.map((c) => ({
      workspaceId: source.workspaceId,
      brandId: source.brandId,
      platform: "META" as const,
      accountId: source.externalId,
      campaignId: c.campaignId,
      campaignName: c.name.slice(0, 500),
      day: new Date(`${d.day}T00:00:00Z`),
      currency,
      spend: c.spend,
      impressions: c.impressions,
      clicks: c.clicks,
      purchases: c.purchases,
      purchaseValue: c.purchaseValue,
    })),
  );
  await prisma.$transaction([
    prisma.adDay.deleteMany({
      where: { workspaceId: source.workspaceId, brandId: source.brandId, platform: "META", accountId: source.externalId, day: { gte: from, lte: to } },
    }),
    // Two chains writing one window insert the same rows; the later one skips them rather than hitting the unique key.
    prisma.adDay.createMany({ data: rows, skipDuplicates: true }),
  ]);
  return rows.length;
}

registerSync("META_ADS", async (ctx) => {
  const { source, connection } = ctx;
  if (!connection) throw new Error("META_ADS source without a connection");
  const settings = settingsOf(source);
  const zone = settings.reportsIn ?? "UTC";
  const window = ctx.window ?? dailyWindow(zoneToday(zone), ATTRIBUTION_DAYS);

  const token = await accessToken(connection); // ReconnectNeeded when expired: not retried
  const read = await fetchAdWindow(token, graphId(source.externalId), window.from, window.to);

  if (read.stoppedReason === "reconnect") await markReconnect(connection.id, `Access expired. Reconnect ${connection.displayName}.`);
  if (read.disabled) console.warn("[meta-ads] ad account disabled", source.brandId, source.id);
  if ((read.currency && settings.currency && read.currency !== settings.currency) || (read.timeZone && settings.reportsIn && read.timeZone !== settings.reportsIn)) {
    throw new Error("ad account currency or time zone changed at Meta");
  }
  const reason = stopReason(read.stoppedReason); // throws for reconnect and failed: nothing written

  let count = 0;
  // A permission stop (disabled account, ads_read gone) writes nothing; rate limits and the time cap keep what was read.
  if (read.currency && read.stoppedReason !== "permission") for (const chunk of chunks(read.days)) count += await replaceAdDays(source, read.currency, chunk);
  return { count, complete: !read.stoppedReason, reason, ...(ctx.window ? {} : { window }) };
}, { afterRun: enqueueAdAlerts }); // after a complete daily or manual run: the ads.alerts job (server/ads/alerts.ts)

/** The account's backfill: BACKFILL_DAYS up to yesterday in its zone, CHUNK_DAYS a window (saved as settings.backfill). */
export const adsBackfillPlan = (zone: string, now = new Date()) => backfillPlan(zoneToday(zone, now), BACKFILL_DAYS, CHUNK_DAYS);

/**
 * Queues the account's first backfill window from its saved plan; the job chains the rest. Keyed by the source's
 * updatedAt, so choosing the account again re-runs it.
 */
export function enqueueAdsBackfill(source: Pick<DataSource, "id" | "workspaceId" | "brandId" | "kind" | "updatedAt" | "settings" | "syncedThrough">) {
  const plan = settingsOf(source as DataSource).backfill;
  return plan ? enqueueBackfill(source, plan) : null;
}
