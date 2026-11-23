import { Prisma } from "@prisma/client";
import { GRAPH } from "@/server/integrations/providers";

/**
 * Meta Marketing API insights client. Pure: it takes an access token and an ad account id and returns buffered
 * campaign-day rows; it never writes to the database. The caller replaces each returned day in full (range delete
 * then insert), so a campaign missing from a returned day is gone from that day.
 *
 * Days are the ad account's days (its `timezone_name`), passed and returned as "YYYY-MM-DD" exactly as Meta reports.
 *
 * Rules:
 * - Campaign level, daily grain (`time_increment=1`), read in 7-day chunks with `limit=500`. A chunk is kept only
 *   when every page of it was read; `days` lists every day of every kept chunk (a day with no spend has no campaigns).
 * - Pages are built from the `after` cursor; `paging.next` is never followed (it carries the token). The token rides
 *   in the Authorization header, never in a URL. URLs and Meta's error text are never logged.
 * - Money stays a decimal string exactly as Meta sends it ("12.30"); counts become integers.
 * - `account_currency` on every row must equal the account's currency, or the read stops as "failed".
 *
 * Failure modes (each stops the walk; kept chunks come back with `stoppedReason`):
 * - 190 / 102 / HTTP 401 → "reconnect" (token expired or revoked; expected once the 60-day token runs out).
 * - 4, 17, 32, 613, 80000–80014, HTTP 429, or `x-business-use-case-usage` / `x-ad-account-usage` above
 *   USAGE_STOP_PCT → "rate_limited" (partial window; the next run picks up the rest).
 * - 10, 200–299, HTTP 403 → "permission". `account_status` ≠ 1 → "permission" too (shown as DISABLED_MESSAGE).
 * - The walk runs at most MAX_MS; past it, the chunks read so far come back with "capped".
 * - Code 1/2 "reduce the amount of data" → the chunk is halved and retried, down to one day; then "failed".
 * - Network, timeout or 5xx is retried RETRIES times, then "failed"; so is anything else (bad JSON, malformed numbers).
 *   A bug (bad arguments) still throws.
 */

/**
 * Which numbers count as a purchase, in one place so the report footnote can quote it.
 * `use_account_attribution_setting=true` makes the API report with each ad set's own attribution setting, which is
 * what Ads Manager shows by default (normally 7-day click, 1-day view). We read the `value` key of the first action
 * type present: `omni_purchase` (Ads Manager's "Purchases" column: website, app and offline), falling back to the pixel's
 * `offsite_conversion.fb_pixel_purchase` for older accounts that report only that.
 * Footnote: "Purchases and purchase value as Meta reports them with each ad set's attribution setting (Ads Manager default)."
 */
export const PURCHASE_ATTRIBUTION = {
  param: "use_account_attribution_setting",
  key: "value",
  actionTypes: ["omni_purchase", "offsite_conversion.fb_pixel_purchase"],
  footnote: "Purchases and purchase value as Meta reports them with each ad set's attribution setting (Ads Manager default).",
} as const;

export const CHUNK_DAYS = 7;
export const PAGE_LIMIT = 500;
/** Stop when any usage header reports a percentage at or above this. */
export const USAGE_STOP_PCT = 75;
const TIMEOUT_MS = 15_000;
const RETRIES = 2;
const MAX_MS = 4 * 60_000;
const FIELDS = "campaign_id,campaign_name,spend,impressions,clicks,actions,action_values,account_currency";

export type StopReason = "reconnect" | "permission" | "rate_limited" | "failed" | "capped";

/** Shown instead of the permission message when the account itself is switched off (`disabled: true` on the window). */
export const DISABLED_MESSAGE = "This ad account is disabled in Meta";

export type CampaignDay = {
  campaignId: string;
  name: string;
  spend: string;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: string;
};
export type AdDayResult = { day: string; campaigns: CampaignDay[] };
export type AdWindow = { days: AdDayResult[]; currency: string | null; timeZone: string | null; stoppedReason?: StopReason; disabled?: true };

type Action = { action_type?: string; value?: string };
type Row = {
  campaign_id?: string;
  campaign_name?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: Action[];
  action_values?: Action[];
  account_currency?: string;
  date_start?: string;
};
type GraphError = { code?: number; message?: string };
type Answer = { status: number; body: Record<string, unknown> | null; headers: Headers | null };

/** Internal stop signal; the reason is ours, never Meta's text. */
class Stop extends Error {
  constructor(readonly reason: StopReason | "reduce" | "disabled") {
    super(reason);
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function daysBetween(from: string, to: string): string[] {
  if (!DAY.test(from) || !DAY.test(to) || from > to) throw new Error("from/to must be YYYY-MM-DD with from <= to");
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

function classify(status: number, body: Record<string, unknown> | null): StopReason | "reduce" | null {
  const e = body?.error as GraphError | undefined;
  if (status >= 200 && status < 400 && !e && body) return null;
  const code = e?.code;
  if (status === 401 || code === 190 || code === 102) return "reconnect";
  if (status === 429 || code === 4 || code === 17 || code === 32 || code === 613 || (code !== undefined && code >= 80000 && code <= 80014)) return "rate_limited";
  if ((code === 1 || code === 2) && /reduce the amount of data/i.test(e?.message ?? "")) return "reduce";
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299) || status === 403) return "permission";
  return "failed";
}

/** Highest percentage in the usage headers (business use case: per-type call_count/total_cputime/total_time; ad account: acc_id_util_pct). */
function usagePct(h: Headers | null): number {
  let max = 0;
  const visit = (v: unknown, key = ""): void => {
    if (typeof v === "number" && /call_count|total_cputime|total_time|util_pct/.test(key)) max = Math.max(max, v);
    else if (Array.isArray(v)) v.forEach((x) => visit(x));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, k);
  };
  for (const name of ["x-business-use-case-usage", "x-ad-account-usage"]) {
    const raw = h?.get(name);
    if (!raw) continue;
    try {
      visit(JSON.parse(raw));
    } catch {
      // An unreadable header is ignored; the error codes still stop us.
    }
  }
  return max;
}

/** One GET with the token in the header; never throws (network, timeout, bad JSON → status 0). */
async function get(token: string, url: string): Promise<Answer> {
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null, headers: res.headers };
  } catch {
    return { status: 0, body: null, headers: null };
  }
}

async function graph(token: string, url: string): Promise<Answer> {
  let a = await get(token, url);
  for (let n = 0; n < RETRIES && (a.status === 0 || a.status >= 500) && !(a.body?.error as GraphError | undefined)?.code; n++) a = await get(token, url);
  const reason = classify(a.status, a.body);
  if (reason) {
    // Only our reason and Meta's numeric code: no URL, no provider text.
    if (reason !== "reduce") console.error("[meta-ads]", reason, a.status, (a.body?.error as GraphError | undefined)?.code ?? null);
    throw new Stop(reason);
  }
  return a;
}

/** Meta's money string, checked with Prisma.Decimal and returned as Meta wrote it ("12.30" stays "12.30"). */
const decimal = (v: string | undefined) => {
  if (v === undefined) return "0";
  let d: Prisma.Decimal;
  try {
    d = new Prisma.Decimal(v);
  } catch {
    throw new Stop("failed");
  }
  if (!d.isFinite() || d.isNegative()) throw new Stop("failed");
  return v;
};
const count = (v: string | undefined) => new Prisma.Decimal(decimal(v)).toDecimalPlaces(0).toNumber();
const purchaseOf = (list: Action[] | undefined) => {
  for (const type of PURCHASE_ATTRIBUTION.actionTypes) {
    const hit = list?.find((a) => a.action_type === type);
    if (hit) return hit[PURCHASE_ATTRIBUTION.key];
  }
  return undefined;
};

/** Every page of one chunk, buffered. Returns the rows and whether usage asked us to stop after it. */
async function readChunk(token: string, accountId: string, since: string, until: string, currency: string): Promise<{ rows: Row[]; busy: boolean }> {
  const rows: Row[] = [];
  let after: string | undefined;
  for (;;) {
    const q = new URLSearchParams({
      level: "campaign",
      time_increment: "1",
      time_range: JSON.stringify({ since, until }),
      fields: FIELDS,
      [PURCHASE_ATTRIBUTION.param]: "true",
      limit: String(PAGE_LIMIT),
      ...(after ? { after } : {}),
    });
    const a = await graph(token, `${GRAPH}/act_${encodeURIComponent(accountId)}/insights?${q}`);
    const page = (Array.isArray(a.body?.data) ? a.body.data : []) as Row[];
    for (const r of page) if (r.account_currency !== currency) throw new Stop("failed");
    rows.push(...page);
    const paging = a.body?.paging as { next?: string; cursors?: { after?: string } } | undefined;
    const more = Boolean(paging?.next && paging.cursors?.after);
    const busy = usagePct(a.headers) >= USAGE_STOP_PCT;
    if (busy && more) throw new Stop("rate_limited"); // this chunk is unfinished: drop it
    if (!more) return { rows, busy };
    after = paging!.cursors!.after;
  }
}

/**
 * Spend, impressions, clicks, purchases and purchase value per campaign for each ad-account day in [from, to], all
 * buffered before returning. See the module comment for chunking, stops and halving.
 */
export async function fetchAdWindow(token: string, accountId: string, from: string, to: string): Promise<AdWindow> {
  const all = daysBetween(from, to);
  const out: AdWindow = { days: [], currency: null, timeZone: null };
  const started = Date.now();
  try {
    const acct = (await graph(token, `${GRAPH}/act_${encodeURIComponent(accountId)}?fields=currency,timezone_name,account_status`)).body!;
    if (typeof acct.currency !== "string" || typeof acct.timezone_name !== "string") throw new Stop("failed");
    out.currency = acct.currency;
    out.timeZone = acct.timezone_name;
    if (acct.account_status !== 1) throw new Stop("disabled");

    let size = CHUNK_DAYS;
    for (let i = 0; i < all.length; ) {
      if (i > 0 && Date.now() - started > MAX_MS) throw new Stop("capped");
      const chunk = all.slice(i, i + size);
      let read: { rows: Row[]; busy: boolean };
      try {
        read = await readChunk(token, accountId, chunk[0], chunk[chunk.length - 1], out.currency);
      } catch (e) {
        if (e instanceof Stop && e.reason === "reduce") {
          if (size === 1) throw new Stop("failed");
          size = Math.ceil(chunk.length / 2);
          continue; // retry the same start, smaller
        }
        throw e;
      }
      const byDay = new Map(chunk.map((day) => [day, [] as CampaignDay[]]));
      for (const r of read.rows) {
        const list = byDay.get(r.date_start ?? "");
        if (!list || !r.campaign_id) throw new Stop("failed");
        list.push({
          campaignId: r.campaign_id,
          name: r.campaign_name ?? "",
          spend: decimal(r.spend),
          impressions: count(r.impressions),
          clicks: count(r.clicks),
          purchases: count(purchaseOf(r.actions)),
          purchaseValue: decimal(purchaseOf(r.action_values)),
        });
      }
      out.days.push(...[...byDay].map(([day, campaigns]) => ({ day, campaigns })));
      i += chunk.length;
      if (read.busy && i < all.length) throw new Stop("rate_limited");
    }
    return out;
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    if (e.reason === "disabled") return { ...out, stoppedReason: "permission", disabled: true };
    return { ...out, stoppedReason: e.reason === "reduce" ? "failed" : e.reason };
  }
}
