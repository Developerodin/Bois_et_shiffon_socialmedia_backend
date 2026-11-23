// recorded 2026-11-23, Marketing API v23.0 (shape from docs)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAdWindow, PURCHASE_ATTRIBUTION } from "@/server/data/meta-ads";

const TOKEN = "EAAB.secret-token-value";
const ACCT = "1234567890";

type Reply = [number, unknown, Record<string, string>?];
let urls: string[];
let auths: string[];

/** Each request gets the next reply: [status, json, headers?]. */
function stub(replies: Reply[]) {
  urls = [];
  auths = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      urls.push(url);
      auths.push((init.headers as Record<string, string>).authorization);
      const [status, json, headers] = replies.shift() ?? [500, {}];
      return Response.json(json, { status, headers });
    }),
  );
}

const ACCOUNT: Reply = [200, { id: `act_${ACCT}`, currency: "EUR", timezone_name: "Europe/Paris", account_status: 1 }];
const row = (day: string, id: string, extra: Record<string, unknown> = {}) => ({
  campaign_id: id,
  campaign_name: `Campaign ${id}`,
  spend: "12.30",
  impressions: "1000",
  clicks: "25",
  actions: [
    { action_type: "link_click", value: "25" },
    { action_type: "omni_purchase", value: "3" },
    { action_type: "offsite_conversion.fb_pixel_purchase", value: "2" },
  ],
  action_values: [{ action_type: "omni_purchase", value: "149.90" }],
  account_currency: "EUR",
  date_start: day,
  date_stop: day,
  ...extra,
});
const page = (data: unknown[], after?: string): Reply => [
  200,
  { data, paging: after ? { cursors: { before: "b", after }, next: `https://graph.facebook.com/v23.0/act_${ACCT}/insights?access_token=${TOKEN}&after=${after}` } : { cursors: { before: "b", after: "z" } } },
];
const graphError = (status: number, code: number, message = "error"): Reply => [status, { error: { message, type: "OAuthException", code } }];
const param = (u: string, k: string) => new URL(u).searchParams.get(k);

let logs: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logs = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  logs.mockRestore();
});

describe("fetchAdWindow", () => {
  it("reads two pages from the after cursor and maps purchases from omni_purchase", async () => {
    stub([ACCOUNT, page([row("2026-11-01", "c1")], "CUR1"), page([row("2026-11-02", "c2", { spend: "0.5" })])]);
    const w = await fetchAdWindow(TOKEN, ACCT, "2026-11-01", "2026-11-03");

    expect(w.stoppedReason).toBeUndefined();
    expect(w).toMatchObject({ currency: "EUR", timeZone: "Europe/Paris" });
    expect(w.days.map((d) => d.day)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(w.days[0].campaigns).toEqual([{ campaignId: "c1", name: "Campaign c1", spend: "12.30", impressions: 1000, clicks: 25, purchases: 3, purchaseValue: "149.90" }]);
    expect(w.days[1].campaigns[0].spend).toBe("0.5");
    expect(w.days[2].campaigns).toEqual([]);

    const [, first, second] = urls;
    expect(param(first, "level")).toBe("campaign");
    expect(param(first, "time_increment")).toBe("1");
    expect(param(first, "limit")).toBe("500");
    expect(param(first, PURCHASE_ATTRIBUTION.param)).toBe("true");
    expect(JSON.parse(param(first, "time_range")!)).toEqual({ since: "2026-11-01", until: "2026-11-03" });
    expect(param(first, "after")).toBeNull();
    expect(param(second, "after")).toBe("CUR1");
    // Built by us, not paging.next: no token anywhere in a URL.
    for (const u of urls) expect(u).not.toContain(TOKEN);
    expect(auths.every((a) => a === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("falls back to the pixel purchase when omni_purchase is missing", async () => {
    stub([ACCOUNT, page([row("2026-11-01", "c1", { actions: [{ action_type: "offsite_conversion.fb_pixel_purchase", value: "2" }], action_values: [] })])]);
    const w = await fetchAdWindow(TOKEN, ACCT, "2026-11-01", "2026-11-01");
    expect(w.days[0].campaigns[0]).toMatchObject({ purchases: 2, purchaseValue: "0" });
  });

  it("splits a long window into 7-day chunks", async () => {
    stub([ACCOUNT, page([]), page([])]);
    const w = await fetchAdWindow(TOKEN, ACCT, "2026-11-01", "2026-11-10");
    expect(w.days).toHaveLength(10);
    expect(JSON.parse(param(urls[1], "time_range")!)).toEqual({ since: "2026-11-01", until: "2026-11-07" });
    expect(JSON.parse(param(urls[2], "time_range")!)).toEqual({ since: "2026-11-08", until: "2026-11-10" });
  });

  it("stops as failed on a currency mismatch, keeping no rows of that chunk", async () => {
    stub([ACCOUNT, page([row("2026-11-01", "c1"), row("2026-11-01", "c2", { account_currency: "USD" })])]);
    const w = await fetchAdWindow(TOKEN, ACCT, "2026-11-01", "2026-11-02");
    expect(w.stoppedReason).toBe("failed");
    expect(w.days).toEqual([]);
  });

  it("stops as rate_limited on code 17, keeping completed chunks", async () => {
    stub([ACCOUNT, page([row("2026-11-01", "c1")]), graphError(400, 17, "User request limit reached")]);
    const w = await fetchAdWindow(TOKEN, ACCT, "2026-11-01", "2026-11-10");
    expect(w.stoppedReason).toBe("rate_limited");
    expect(w.days.map((d) => d.day)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"]);
  });

  it("stops as rate_limited when the usage header is at 80 %, dropping the unfinished chunk", async () => {
    const usage = { "x-business-use-case-usage": JSON.stringify({ "999": [{ type: "ads_insights", call_count: 80, total_cputime: 10, total_time: 10, estimated_time_to_regain_access: 0 }] }) };
    stub([ACCOUNT, [200, { data: [row("2026-11-01", "c1")], paging: { cursors: { after: "CUR1" }, next: "x" } }, usage]]);
    const w = await fetchAdWindow(TOKEN, ACCT, "2026-11-01", "2026-11-03");
    expect(w.stoppedReason).toBe("rate_limited");
    expect(w.days).toEqual([]);
    expect(urls).toHaveLength(2);
  });

  it("asks to reconnect on 190", async () => {
    stub([graphError(400, 190, `Error validating access token ${TOKEN}`)]);
    const w = await fetchAdWindow(TOKEN, ACCT, "2026-11-01", "2026-11-02");
    expect(w).toEqual({ days: [], currency: null, timeZone: null, stoppedReason: "reconnect" });
  });

  it("marks a disabled account as permission + disabled", async () => {
    stub([[200, { currency: "EUR", timezone_name: "Europe/Paris", account_status: 2 }]]);
    const w = await fetchAdWindow(TOKEN, ACCT, "2026-11-01", "2026-11-02");
    expect(w).toMatchObject({ stoppedReason: "permission", disabled: true, days: [] });
  });

  it("halves the chunk on 'reduce the amount of data' and retries, down to one day", async () => {
    const reduce = graphError(500, 1, "Please reduce the amount of data you're asking for, then retry your request");
    stub([ACCOUNT, reduce, page([row("2026-11-01", "c1")]), page([])]);
    const w = await fetchAdWindow(TOKEN, ACCT, "2026-11-01", "2026-11-07");
    expect(w.stoppedReason).toBeUndefined();
    expect(urls.slice(1).map((u) => JSON.parse(param(u, "time_range")!))).toEqual([
      { since: "2026-11-01", until: "2026-11-07" },
      { since: "2026-11-01", until: "2026-11-04" },
      { since: "2026-11-05", until: "2026-11-07" },
    ]);
    expect(w.days).toHaveLength(7);

    stub([ACCOUNT, reduce, reduce, reduce]);
    const one = await fetchAdWindow(TOKEN, ACCT, "2026-11-01", "2026-11-03");
    expect(one.stoppedReason).toBe("failed"); // 3 → 2 → 1 day, then gives up
  });

  it("retries a network error, then stops as failed", async () => {
    stub([ACCOUNT, [502, {}], [502, {}], [502, {}]]);
    const w = await fetchAdWindow(TOKEN, ACCT, "2026-11-01", "2026-11-01");
    expect(w.stoppedReason).toBe("failed");
    expect(urls).toHaveLength(4);
  });

  it("stops as capped past the time limit, keeping completed chunks", async () => {
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    stub([ACCOUNT, page([])]);
    const f = globalThis.fetch as ReturnType<typeof vi.fn>;
    const inner = f.getMockImplementation() as (...a: Parameters<typeof fetch>) => Promise<Response>;
    f.mockImplementation(async (...a: Parameters<typeof fetch>) => {
      now += 3 * 60_000;
      return inner(...a);
    });
    const w = await fetchAdWindow(TOKEN, ACCT, "2026-11-01", "2026-11-10");
    clock.mockRestore();
    expect(w.stoppedReason).toBe("capped");
    expect(w.days).toHaveLength(7);
  });

  it("never puts the token in the result or the log", async () => {
    for (const reply of [graphError(400, 190, `bad token ${TOKEN}`), graphError(400, 10, `no permission ${TOKEN}`), graphError(400, 4, TOKEN)]) {
      stub([ACCOUNT, reply]);
      const w = await fetchAdWindow(TOKEN, ACCT, "2026-11-01", "2026-11-01");
      expect(JSON.stringify(w)).not.toContain(TOKEN);
    }
    expect(logs).toHaveBeenCalled();
    expect(JSON.stringify(logs.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(logs.mock.calls)).not.toContain("graph.facebook.com");
  });
});
