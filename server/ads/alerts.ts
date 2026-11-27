import { Prisma, type DataSource } from "@prisma/client";
import { z } from "zod";
import type { AdAlertKind, PacingDto } from "@/shared";
import { prisma } from "@/server/db/prisma";
import { enqueueJob } from "@/server/jobs/queue";
import { D } from "@/server/data/ads-read";
import { currentMonth, listBudgets } from "@/server/data/budgets";
import { rateTable, type Converted } from "@/server/data/fx";
import type { AdSettings } from "@/server/data/meta-ads-sync";
import { addDays, dayDate, dayOf, utcToday, type SyncOutcome } from "@/server/data/sources";
import { adAlertRecipients, notifyAdAlert } from "@/server/notifications/ads";
import { recordEpisode } from "@/server/alerts/episode";
import { cleanTitle } from "@/server/text";

/**
 * Meta Ads alerts (docs/superpowers/plans/2026-11-26-chat-data-tools.md, Task 5): after an ad account's complete
 * daily or manual sync, the `ads.alerts` job checks four rules for that account and stores what it finds in AdAlert,
 * one row per episode. Spend and pacing look at S, the account-local yesterday the run read up to; ROAS and
 * zero-purchase look at S − CONV_LAG_DAYS, as Meta keeps attributing purchases for 7 days. Each rule's baseline is the
 * 7 account days before its own day; a day without AdDay rows counts as 0 (Meta returns no rows without delivery).
 *
 * Ceilings:
 * - Once per account day: if every complete run of a day fails, or the job dies after its 3 attempts, that day is
 *   never evaluated. Upgrade: evaluate every unevaluated day up to syncedThrough (store the last one in settings).
 * - NO_PURCHASES needs an earlier purchase as a stand-in for a sales objective (AdDay has no objective), so a new sales
 *   campaign that never converted isn't flagged. Upgrade: read the campaign objective from Meta into AdDay.
 * - An account currency without an ECB rate never gets the €20-floored rules (SPEND_UP, ROAS_DOWN, NO_PURCHASES);
 *   it is logged each day. Upgrade: a second rate source.
 * - OVER_PACE: when two accounts' jobs insert the month's alert at once, the loser's figures aren't written; the next
 *   day's run updates them.
 * - Thresholds are global constants; a per-brand setting is the upgrade if brands differ wildly in size.
 */

export const ADS_ALERTS_JOB = "ads.alerts";
/** ROAS_DOWN and NO_PURCHASES look at the day this many days before S: its purchases are far more complete. */
export const CONV_LAG_DAYS = 3;
/** Days in each rule's baseline, the days just before its own day. */
const BASELINE_DAYS = 7;
export const SPEND_UP_RATIO = 1.5;
/** The owner's minimum increase, in EUR, converted into the account currency at the rule's day's rate. */
export const SPEND_UP_MIN_EUR = 20;
export const ROAS_DOWN_RATIO = 0.7;
export const ROAS_MIN_PURCHASES_DAY = 5;
export const ROAS_MIN_PURCHASES_BASE = 20;
export const NO_PURCHASE_DAYS = 3;
export const NO_PURCHASE_LOOKBACK = 28;
/** One big first day of the month reads as 300 % pace: pacing alerts start once `through` is at least the 3rd. */
export const PACE_MIN_DAYS = 3;
/** An alert is open while its lastDay is at most this many days before today (UTC). OVER_PACE: its month is this month. */
export const OPEN_DAYS: Record<Exclude<AdAlertKind, "OVER_PACE">, number> = { SPEND_UP: 2, ROAS_DOWN: 5, NO_PURCHASES: 5 };
const CONVERSION_KINDS: AdAlertKind[] = ["ROAS_DOWN", "NO_PURCHASES"];
/** Days before S the job reads: the start of NO_PURCHASES' lookback (its window ends at S − CONV_LAG_DAYS). */
const READ_BACK_DAYS = CONV_LAG_DAYS + NO_PURCHASE_DAYS - 1 + NO_PURCHASE_LOOKBACK;

/** One campaign's figures for one account day. */
export type AlertDayRow = { campaignId: string; campaignName: string; day: string; spend: Prisma.Decimal; purchases: number; purchaseValue: Prisma.Decimal };
/** An alert a rule raised on its day, before it is stored. `values` are strings (Decimals as text). */
export type Candidate = {
  kind: AdAlertKind;
  day: string;
  subjectKey: string;
  accountId: string | null;
  campaignId?: string;
  campaignName?: string;
  currency: string;
  values: Record<string, string>;
};
export type AccountContext = {
  brandId: string;
  accountId: string;
  currency: string;
  /** S: the account-local day the sync read up to (D_spend). */
  day: string;
  /** settings.backfill.start: the first day read. Null (unknown) runs no rule that needs 7 read days before it. */
  backfillStart: string | null;
  /** EUR rates for the €20 floors; not needed for an EUR account. */
  rates: { convert(amount: Prisma.Decimal.Value, from: string, to: string, day: string): Converted | null } | null;
};

/**
 * The account rules over its AdDay rows (S − READ_BACK_DAYS .. S). Returns the alerts raised and, when the account currency had
 * no rate for a floor, `noRate` (those rules are skipped, never guessed).
 */
export function evaluateAccount(rows: AlertDayRow[], ctx: AccountContext): { candidates: Candidate[]; noRate: boolean } {
  const dSpend = ctx.day;
  const dConv = addDays(dSpend, -CONV_LAG_DAYS);
  const byDay = new Map<string, { spend: Prisma.Decimal; purchases: number; value: Prisma.Decimal }>();
  for (const r of rows) {
    const t = byDay.get(r.day) ?? { spend: D(0), purchases: 0, value: D(0) };
    byDay.set(r.day, { spend: t.spend.plus(r.spend), purchases: t.purchases + r.purchases, value: t.value.plus(r.purchaseValue) });
  }
  const total = (day: string) => byDay.get(day) ?? { spend: D(0), purchases: 0, value: D(0) };
  // The BASELINE_DAYS days before `day`; a day without rows counts as 0.
  const baseline = (day: string) => {
    const sum = { spend: D(0), purchases: 0, value: D(0) };
    for (let i = 1; i <= BASELINE_DAYS; i++) {
      const t = total(addDays(day, -i));
      sum.spend = sum.spend.plus(t.spend);
      sum.purchases += t.purchases;
      sum.value = sum.value.plus(t.value);
    }
    return sum;
  };
  // A baseline needs its 7 days read: the backfill must have started on or before its first day.
  const readFrom = (day: string) => ctx.backfillStart !== null && ctx.backfillStart <= addDays(day, -BASELINE_DAYS);
  // €20 in the account currency at `day`'s rate; null without a rate (the rule is then skipped).
  const floorOn = (day: string): Converted | null =>
    ctx.currency === "EUR" ? { amount: D(SPEND_UP_MIN_EUR), rateDay: null, stale: false } : (ctx.rates?.convert(SPEND_UP_MIN_EUR, "EUR", ctx.currency, day) ?? null);
  const floorValues = (f: Converted) => ({
    minEur: String(SPEND_UP_MIN_EUR),
    min: f.amount.toFixed(2),
    ...(f.rateDay ? { rateDay: f.rateDay } : {}),
    ...(f.stale ? { stale: "true" } : {}),
  });
  const base = { accountId: ctx.accountId, currency: ctx.currency };
  const out: Candidate[] = [];
  let noRate = false;

  const spendFloor = floorOn(dSpend);
  if (!spendFloor) noRate = true;
  else if (readFrom(dSpend)) {
    const now = total(dSpend).spend;
    const avg = baseline(dSpend).spend.div(BASELINE_DAYS);
    // A zero baseline (just switched on, or back from a paused week) would make every day "infinitely" up.
    if (!avg.isZero() && now.gte(avg.mul(SPEND_UP_RATIO)) && now.minus(avg).gte(spendFloor.amount)) {
      out.push({
        ...base,
        kind: "SPEND_UP",
        day: dSpend,
        subjectKey: `SPEND_UP:${ctx.brandId}:${ctx.accountId}`,
        values: { day: dSpend, now: now.toFixed(2), baseline: avg.toFixed(2), ratio: now.div(avg).toFixed(2), ...floorValues(spendFloor) },
      });
    }
  }

  const convFloor = floorOn(dConv);
  if (!convFloor) noRate = true;
  else {
    if (readFrom(dConv)) {
      const d = total(dConv);
      const b = baseline(dConv);
      if (d.purchases >= ROAS_MIN_PURCHASES_DAY && b.purchases >= ROAS_MIN_PURCHASES_BASE && d.spend.gte(convFloor.amount) && !b.spend.isZero()) {
        const roas = d.value.div(d.spend);
        const baseRoas = b.value.div(b.spend);
        // A zero baseline ROAS (purchases reported without values) can't drop: every day would raise one.
        if (baseRoas.gt(0) && roas.lte(baseRoas.mul(ROAS_DOWN_RATIO))) {
          out.push({
            ...base,
            kind: "ROAS_DOWN",
            day: dConv,
            subjectKey: `ROAS_DOWN:${ctx.brandId}:${ctx.accountId}`,
            values: {
              day: dConv, roas: roas.toFixed(2), baselineRoas: baseRoas.toFixed(2), purchases: String(d.purchases),
              baselinePurchases: String(b.purchases), spend: d.spend.toFixed(2), ...floorValues(convFloor),
            },
          });
        }
      }
    }

    // No backfill guard: a lookback starting before the backfill only finds fewer earlier purchases (raises less).
    const window = Array.from({ length: NO_PURCHASE_DAYS }, (_, i) => addDays(dConv, i - (NO_PURCHASE_DAYS - 1)));
    const lookFrom = addDays(window[0], -NO_PURCHASE_LOOKBACK);
    const byCampaign = new Map<string, AlertDayRow[]>();
    for (const r of rows) byCampaign.set(r.campaignId, [...(byCampaign.get(r.campaignId) ?? []), r]);
    for (const [campaignId, list] of byCampaign) {
      const days = window.map((day) => list.find((r) => r.day === day));
      if (!days.every((r) => r && r.spend.gt(0) && r.purchases === 0)) continue;
      const spend = days.reduce((s, r) => s.plus(r!.spend), D(0));
      if (spend.lt(convFloor.amount)) continue;
      // An earlier purchase stands in for a sales objective: awareness and traffic campaigns never buy.
      if (!list.some((r) => r.day >= lookFrom && r.day < window[0] && r.purchases > 0)) continue;
      out.push({
        ...base,
        kind: "NO_PURCHASES",
        day: dConv,
        subjectKey: `NO_PURCHASES:${ctx.brandId}:${ctx.accountId}:${campaignId}`,
        campaignId,
        campaignName: days.at(-1)!.campaignName.slice(0, 500),
        values: { day: dConv, from: window[0], spend: spend.toFixed(2), ...floorValues(convFloor) },
      });
    }
  }
  return { candidates: out, noRate };
}

/** OVER_PACE from the brand's Meta pacing (budgets.ts's own "over" rule), once `through` is at least the 3rd. */
export function evaluatePacing(pacing: PacingDto | undefined, brandId: string): Candidate | null {
  if (!pacing || pacing.state !== "ok" || pacing.status !== "over") return null;
  if (Number(pacing.through.slice(8, 10)) < PACE_MIN_DAYS) return null;
  return {
    kind: "OVER_PACE",
    day: pacing.through,
    subjectKey: `OVER_PACE:${brandId}:${pacing.through.slice(0, 7)}`,
    accountId: null,
    currency: pacing.currency,
    values: {
      day: pacing.through, ratio: String(pacing.ratio), spent: pacing.spent, expected: pacing.expected,
      ...(pacing.staleRateFrom ? { staleRateFrom: pacing.staleRateFrom } : {}),
    },
  };
}

type AlertFields = { kind: AdAlertKind; accountId: string | null; campaignName: string | null; currency: string; values: unknown };
const monthName = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleString("en", { month: "long", timeZone: "UTC" });
const percent = (v: number) => Math.round(v * 100);

/**
 * One English line per alert, for the bell, the digest email, the web digest and the chat. Every text from a person
 * or Meta (campaign name, account id) goes through cleanTitle here, so no surface can forget it and the plain-text
 * email can't be forged with a line break.
 */
export function adAlertText(a: AlertFields): string {
  const v = (a.values ?? {}) as Record<string, string>;
  const account = cleanTitle(a.accountId ?? "");
  const currency = cleanTitle(a.currency);
  switch (a.kind) {
    case "SPEND_UP":
      return `Ad spend up ${percent(Number(v.ratio) - 1)}% on ${account}: ${v.now} ${currency} on ${v.day} vs ${v.baseline} a day the week before`;
    case "ROAS_DOWN":
      return `ROAS down ${percent(1 - Number(v.roas) / Number(v.baselineRoas))}% on ${account}: ${v.roas} on ${v.day} vs ${v.baselineRoas} the week before (purchases for ${v.day} can still grow a little)`;
    case "NO_PURCHASES":
      return `Campaign "${cleanTitle(a.campaignName ?? "")}" spent ${v.spend} ${currency} with no purchases for ${NO_PURCHASE_DAYS} days to ${v.day} (purchases can still grow a little)`;
    case "OVER_PACE":
      return `Meta spend at ${percent(Number(v.ratio))}% of the ${monthName(v.day)} budget pace`;
  }
}

/** An alert as the digest and the chat read it. Server-only. */
export type AdAlertView = {
  id: string;
  kind: AdAlertKind;
  accountId: string | null;
  currency: string;
  firstDay: string;
  lastDay: string;
  open: boolean;
  text: string;
  values: Record<string, string>;
};

/** Is the alert still open on `today` (UTC "YYYY-MM-DD")? OPEN_DAYS per kind; OVER_PACE while its month lasts. */
export function isOpen(kind: AdAlertKind, lastDay: string, today: string) {
  if (kind === "OVER_PACE") return lastDay.slice(0, 7) === today.slice(0, 7);
  return lastDay >= addDays(today, -OPEN_DAYS[kind]);
}

type AlertRow = AlertFields & { id: string; firstDay: Date; lastDay: Date };
export function alertView(a: AlertRow, today = utcToday()): AdAlertView {
  const lastDay = dayOf(a.lastDay);
  return {
    id: a.id,
    kind: a.kind,
    accountId: a.accountId,
    currency: a.currency,
    firstDay: dayOf(a.firstDay),
    lastDay,
    open: isOpen(a.kind, lastDay, today),
    text: adAlertText(a),
    values: (a.values ?? {}) as Record<string, string>,
  };
}

/**
 * The brand's alerts, newest episode first, at most `limit`, and how many more. `createdFrom/createdBefore`: raised in
 * that window (the digest's week; index (brandId, createdAt)). `recentFrom` ("YYYY-MM-DD"): seen on or after that day
 * (the chat; index (brandId, lastDay)), the conversion kinds compared CONV_LAG_DAYS earlier, as their day is already
 * that far back when raised.
 */
export async function listAlerts(
  scope: { workspaceId: string; brandId: string },
  by: { createdFrom: Date; createdBefore: Date } | { recentFrom: string },
  limit: number,
): Promise<{ alerts: AdAlertView[]; more: number }> {
  const where: Prisma.AdAlertWhereInput = {
    workspaceId: scope.workspaceId,
    brandId: scope.brandId,
    ...("createdFrom" in by
      ? { createdAt: { gte: by.createdFrom, lt: by.createdBefore } }
      : {
          OR: [
            { kind: { in: CONVERSION_KINDS }, lastDay: { gte: dayDate(addDays(by.recentFrom, -CONV_LAG_DAYS)) } },
            { kind: { notIn: CONVERSION_KINDS }, lastDay: { gte: dayDate(by.recentFrom) } },
          ],
        }),
  };
  const [rows, count] = await Promise.all([
    prisma.adAlert.findMany({
      where,
      orderBy: [{ firstDay: "desc" }, { id: "asc" }],
      take: limit,
      select: { id: true, kind: true, accountId: true, campaignName: true, currency: true, firstDay: true, lastDay: true, values: true },
    }),
    prisma.adAlert.count({ where }),
  ]);
  return { alerts: rows.map((r) => alertView(r)), more: Math.max(0, count - rows.length) };
}

// ---- the job -------------------------------------------------------------------------------------------------------

/**
 * META_ADS's afterRun hook (sources.ts runs it after a complete daily or manual run only). Queues the evaluation only
 * when the run read up to its own window's end: then syncedThrough is the account-local yesterday the run computed
 * itself (a fresh "today" could have rolled over midnight). Keyed by source and day, so the daily run and Sync now
 * evaluate a day once.
 */
export async function enqueueAdAlerts(source: DataSource, outcome: SyncOutcome, syncedThrough: string | null) {
  if (!outcome.window || syncedThrough !== outcome.window.to) return;
  await enqueueJob({
    type: ADS_ALERTS_JOB,
    workspaceId: source.workspaceId,
    brandId: source.brandId,
    payload: { workspaceId: source.workspaceId, brandId: source.brandId, dataSourceId: source.id, day: syncedThrough },
    idempotencyKey: `ads-alerts:${source.id}:${syncedThrough}`,
    maxAttempts: 3,
  });
}

const Payload = z.object({ workspaceId: z.string(), brandId: z.string(), dataSourceId: z.string(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/**
 * Job handler. Re-reads the source by id AND the payload's workspace and brand, kind META_ADS and not OFF, so a
 * payload naming another brand's source finds nothing. Reads the account's AdDay rows from S − READ_BACK_DAYS (the
 * start of the NO_PURCHASES lookback) to S, the EUR rates for the floors and, while S is in the current UTC month, the
 * month's pacing, then stores each alert. The bell's
 * recipients are read once, before the writes, and only when something was found.
 */
export async function runAdAlerts(payload: unknown) {
  const p = Payload.parse(payload);
  const source = await prisma.dataSource.findFirst({
    where: { id: p.dataSourceId, workspaceId: p.workspaceId, brandId: p.brandId, kind: "META_ADS", status: { not: "OFF" } },
  });
  if (!source || !source.syncedThrough || dayOf(source.syncedThrough) < p.day) return;
  const settings = (source.settings ?? {}) as AdSettings;
  if (!settings.currency) return;
  const scope = { workspaceId: source.workspaceId, brandId: source.brandId };
  const dConv = addDays(p.day, -CONV_LAG_DAYS);
  const rows = await prisma.adDay.findMany({
    where: { ...scope, platform: "META", accountId: source.externalId, day: { gte: dayDate(addDays(p.day, -READ_BACK_DAYS)), lte: dayDate(p.day) } },
    select: { campaignId: true, campaignName: true, day: true, spend: true, purchases: true, purchaseValue: true },
  });
  const rates = settings.currency === "EUR" ? null : await rateTable(["EUR", settings.currency], addDays(dConv, -2), p.day);
  const { candidates, noRate } = evaluateAccount(rows.map((r) => ({ ...r, day: dayOf(r.day) })), {
    brandId: source.brandId,
    accountId: source.externalId,
    currency: settings.currency,
    day: p.day,
    backfillStart: settings.backfill?.start ?? null,
    rates,
  });
  if (noRate) console.warn("[ads] no exchange rate: money-floored alerts skipped", source.brandId, source.id, settings.currency);
  // A month's last day is evaluated on the 1st of the next: an OVER_PACE raised then would already be closed (isOpen).
  if (p.day.slice(0, 7) === currentMonth()) {
    const pace = evaluatePacing((await listBudgets(scope, p.day.slice(0, 7))).pacing.find((x) => x.platform === "META"), source.brandId);
    if (pace) candidates.push(pace);
  }
  if (!candidates.length) return;
  const recipients = await adAlertRecipients(scope);
  for (const c of candidates) await recordAlert(scope, c, recipients);
}

/**
 * Stores one alert, in its own transaction. The episode's row (same subject, lastDay ≥ day − 1 and firstDay ≤ day + 1,
 * so a rerun of an older day never joins a later episode; OVER_PACE: the same month, which its subjectKey holds) is locked and moved on, with no new notice. Otherwise a new row; ON CONFLICT DO
 * NOTHING on dedupeKey makes a rerun, or two accounts' jobs racing on OVER_PACE, insert it once; only the inserted row
 * notifies, so an episode never sends a second notice.
 */
async function recordAlert(scope: { workspaceId: string; brandId: string }, c: Candidate, recipients: readonly string[]) {
  const month = c.kind === "OVER_PACE";
  await prisma.$transaction(async (tx) => {
    const { insertedId } = await recordEpisode(tx, {
      table: "AdAlert",
      scope,
      subjectKey: c.subjectKey,
      day: c.day,
      values: c.values,
      join: month ? "subjectKey" : { before: 1, after: 1 },
      insert: async (t) => (await t.adAlert.createManyAndReturn({
        data: [{
          ...scope,
          kind: c.kind,
          accountId: c.accountId,
          campaignId: c.campaignId ?? null,
          campaignName: c.campaignName ?? null,
          currency: c.currency,
          firstDay: dayDate(c.day),
          lastDay: dayDate(c.day),
          values: c.values,
          subjectKey: c.subjectKey,
          dedupeKey: month ? c.subjectKey : `${c.subjectKey}:${c.day}`,
        }],
        skipDuplicates: true,
        select: { id: true },
      }))[0],
    });
    if (insertedId) await notifyAdAlert(tx, { id: insertedId, ...scope }, recipients);
  });
}
