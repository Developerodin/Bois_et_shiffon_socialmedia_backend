import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { DataSource } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { ADS_ALERTS_JOB, enqueueAdAlerts, listAlerts, runAdAlerts } from "@/server/ads/alerts";
import { addDays } from "@/server/data/sources";

/**
 * The ads.alerts job against Postgres: one alert per episode (reruns, consecutive days, a gap), OVER_PACE once a month
 * when two accounts race, brand-scoped keys and reads, and listAlerts' two windows.
 */
let ws: string;
const S = "2026-11-25";
const A = "aa-a";
const B = "aa-b";

async function adSource(brandId: string, externalId: string, syncedThrough = S) {
  return prisma.dataSource.create({
    data: {
      workspaceId: ws, brandId, kind: "META_ADS", externalId, label: externalId, syncedThrough: new Date(syncedThrough),
      settings: { currency: "EUR", reportsIn: "Europe/Paris", backfill: { start: "2026-06-01", end: "2026-11-20", days: 7 } },
    },
  });
}
/** One campaign's spend per day for an account of a brand. */
async function spend(brandId: string, accountId: string, byDay: Record<string, number>) {
  await prisma.adDay.createMany({
    data: Object.entries(byDay).map(([day, amount]) => ({
      workspaceId: ws, brandId, platform: "META" as const, accountId, campaignId: "c1", campaignName: "Campaign", day: new Date(day),
      currency: "EUR", spend: String(amount), impressions: 100, clicks: 5, purchases: 0, purchaseValue: "0",
    })),
  });
}
const flat = (from: string, to: string, amount: number) => {
  const out: Record<string, number> = {};
  for (let d = from; d <= to; d = addDays(d, 1)) out[d] = amount;
  return out;
};
const run = (s: DataSource, day = S, brandId = s.brandId) => runAdAlerts({ workspaceId: ws, brandId, dataSourceId: s.id, day });
const alerts = (brandId = A) => prisma.adAlert.findMany({ where: { brandId }, orderBy: [{ kind: "asc" }, { firstDay: "asc" }] });
const ymd = (d: Date) => d.toISOString().slice(0, 10);

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-ad-alerts" } })).id;
  for (const id of [A, B]) await prisma.brand.create({ data: { id, workspaceId: ws, slug: id, displayName: id } });
});
beforeEach(async () => {
  await prisma.adAlert.deleteMany({});
  await prisma.adDay.deleteMany({});
  await prisma.adBudget.deleteMany({});
  await prisma.dataSource.deleteMany({});
  await prisma.job.deleteMany({});
});

describe("enqueueAdAlerts", () => {
  it("queues once per source and day, and only when the run reached its own window's end", async () => {
    const s = await adSource(A, "act_1");
    const outcome = { count: 1, complete: true, window: { from: "2026-11-19", to: S } };
    await enqueueAdAlerts(s, outcome, S); // the daily run
    await enqueueAdAlerts(s, outcome, S); // Sync now the same day
    await enqueueAdAlerts(s, outcome, "2026-11-24"); // syncedThrough held short of the window
    await enqueueAdAlerts(s, { count: 1, complete: true }, S); // no window: a backfill
    const jobs = await prisma.job.findMany({ where: { type: ADS_ALERTS_JOB } });
    expect(jobs.map((j) => [j.idempotencyKey, j.payload, j.maxAttempts])).toEqual([
      [`ads-alerts:${s.id}:${S}`, { workspaceId: ws, brandId: A, dataSourceId: s.id, day: S }, 3],
    ]);
  });
});

describe("runAdAlerts", () => {
  it("the same day twice → one alert", async () => {
    const s = await adSource(A, "act_1");
    await spend(A, "act_1", { ...flat("2026-11-18", "2026-11-24", 40), [S]: 60 });
    await run(s);
    await run(s);
    const rows = await alerts();
    expect(rows.map((a) => [a.kind, a.subjectKey, a.dedupeKey, ymd(a.firstDay), ymd(a.lastDay)])).toEqual([
      ["SPEND_UP", `SPEND_UP:${A}:act_1`, `SPEND_UP:${A}:act_1:${S}`, S, S],
    ]);
    expect(rows[0].values).toMatchObject({ now: "60.00", baseline: "40.00" });
  });

  it("D then D+1 → one alert whose lastDay and figures move", async () => {
    const s = await adSource(A, "act_1", "2026-11-26");
    await spend(A, "act_1", { ...flat("2026-11-18", "2026-11-24", 40), [S]: 60, "2026-11-26": 100 });
    await run(s, S);
    await run(s, "2026-11-26");
    const rows = await alerts();
    expect(rows.map((a) => [a.kind, ymd(a.firstDay), ymd(a.lastDay)])).toEqual([["SPEND_UP", S, "2026-11-26"]]);
    expect(rows[0].values).toMatchObject({ day: "2026-11-26", now: "100.00" });
    // A rerun of the earlier day keeps the later day and its figures.
    await run(s, S);
    const again = await alerts();
    expect([ymd(again[0].lastDay), (again[0].values as { day: string }).day]).toEqual(["2026-11-26", "2026-11-26"]);
  });

  it("a gap of a day → a new alert", async () => {
    const s = await adSource(A, "act_1", "2026-11-27");
    await spend(A, "act_1", { ...flat("2026-11-18", "2026-11-24", 40), [S]: 60, "2026-11-26": 40, "2026-11-27": 200 });
    await run(s, S);
    await run(s, "2026-11-27");
    expect((await alerts()).map((a) => [a.kind, ymd(a.firstDay), ymd(a.lastDay)])).toEqual([
      ["SPEND_UP", S, S],
      ["SPEND_UP", "2026-11-27", "2026-11-27"],
    ]);
  });

  it("two accounts' jobs at once → one OVER_PACE for the month", async () => {
    const one = await adSource(A, "act_1");
    const two = await adSource(A, "act_2");
    await spend(A, "act_1", flat("2026-11-01", S, 30));
    await spend(A, "act_2", flat("2026-11-01", S, 30));
    await prisma.adBudget.create({ data: { workspaceId: ws, brandId: A, platform: "META", month: new Date("2026-11-01"), amount: "600", currency: "EUR", updatedByUserId: "u1" } });
    await Promise.all([run(one), run(two)]);
    await run(one); // the next run of the same month moves it on
    const pace = (await alerts()).filter((a) => a.kind === "OVER_PACE");
    expect(pace.map((a) => [a.subjectKey, a.dedupeKey, ymd(a.firstDay), a.accountId, a.currency])).toEqual([
      [`OVER_PACE:${A}:2026-11`, `OVER_PACE:${A}:2026-11`, S, null, "EUR"],
    ]);
  });

  it("two brands sharing one ad account each get their own SPEND_UP", async () => {
    const a = await adSource(A, "act_1");
    const b = await adSource(B, "act_1");
    for (const brand of [A, B]) await spend(brand, "act_1", { ...flat("2026-11-18", "2026-11-24", 40), [S]: 60 });
    await run(a);
    await run(b);
    expect((await alerts(A)).map((x) => x.subjectKey)).toEqual([`SPEND_UP:${A}:act_1`]);
    expect((await alerts(B)).map((x) => x.subjectKey)).toEqual([`SPEND_UP:${B}:act_1`]);
  });

  it("a payload naming another brand's source does nothing; another brand's rows are never read", async () => {
    const a = await adSource(A, "act_1");
    await adSource(B, "act_1");
    await spend(A, "act_1", flat("2026-11-18", S, 40)); // flat: nothing to raise
    await spend(B, "act_1", { ...flat("2026-11-18", "2026-11-24", 40), [S]: 900 });
    await run(a, S, B);
    expect(await prisma.adAlert.count()).toBe(0);
    await run(a);
    expect(await prisma.adAlert.count()).toBe(0);
  });

  it("a day past the source's syncedThrough, or a switched-off source, does nothing", async () => {
    const s = await adSource(A, "act_1", "2026-11-24");
    await spend(A, "act_1", { ...flat("2026-11-18", "2026-11-24", 40), [S]: 60 });
    await run(s);
    await prisma.dataSource.update({ where: { id: s.id }, data: { syncedThrough: new Date(S), status: "OFF" } });
    await run(s);
    expect(await prisma.adAlert.count()).toBe(0);
  });
});

describe("listAlerts", () => {
  const alert = (brandId: string, kind: "SPEND_UP" | "NO_PURCHASES", key: string, lastDay: string, createdAt: string) =>
    prisma.adAlert.create({
      data: {
        workspaceId: ws, brandId, kind, accountId: "act_1", campaignName: kind === "NO_PURCHASES" ? "Spring" : null, currency: "EUR",
        firstDay: new Date(lastDay), lastDay: new Date(lastDay), values: { day: lastDay, spend: "30.00", now: "60.00", baseline: "40.00", ratio: "1.50" },
        subjectKey: key, dedupeKey: `${key}:${lastDay}`, createdAt: new Date(createdAt),
      },
    });

  it("by when they were raised, and by when they were last seen (conversion kinds 3 days earlier); never another brand's", async () => {
    await alert(A, "SPEND_UP", "s1", "2026-11-20", "2026-11-21T06:00:00Z");
    await alert(A, "NO_PURCHASES", "n1", "2026-11-16", "2026-11-20T06:00:00Z");
    await alert(A, "NO_PURCHASES", "n2", "2026-11-14", "2026-11-18T06:00:00Z");
    await alert(A, "SPEND_UP", "s2", "2026-11-10", "2026-11-11T06:00:00Z");
    await alert(B, "SPEND_UP", "b1", "2026-11-20", "2026-11-21T06:00:00Z");
    const scope = { workspaceId: ws, brandId: A };

    const week = await listAlerts(scope, { createdFrom: new Date("2026-11-16T08:00:00Z"), createdBefore: new Date("2026-11-21T06:00:00Z") }, 10);
    expect(week.alerts.map((a) => a.lastDay)).toEqual(["2026-11-16", "2026-11-14"]);

    const recent = await listAlerts(scope, { recentFrom: "2026-11-19" }, 10);
    expect(recent.alerts.map((a) => [a.kind, a.lastDay])).toEqual([["SPEND_UP", "2026-11-20"], ["NO_PURCHASES", "2026-11-16"]]);
    expect(recent.alerts[1].text).toContain('Campaign "Spring"');

    const capped = await listAlerts(scope, { recentFrom: "2026-11-01" }, 2);
    expect([capped.alerts.length, capped.more]).toEqual([2, 2]);
  });
});
