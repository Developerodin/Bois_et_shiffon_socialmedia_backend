import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DataSource } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { addDays } from "@/server/data/sources";
import { enqueueSeoDeclines, listSeoAlerts, runSeoDeclines, SEO_DECLINES_JOB } from "@/server/seo/declines";

/**
 * The seo.declines job against Postgres: one alert per episode (reruns, the next day, a 6- and an 8-day gap),
 * brand-scoped payloads, the open list and the afterRun guard.
 */
let ws: string;
const A = "sd-a";
const B = "sd-b";
const S = "2026-11-20";
const SITE = "https://shop.test/";

async function source(brandId = A, syncedThrough = addDays(S, 20)) {
  return prisma.dataSource.create({
    data: {
      workspaceId: ws, brandId, kind: "SEARCH_CONSOLE", externalId: SITE, label: SITE, syncedThrough: new Date(syncedThrough),
      settings: { reportsIn: "America/Los_Angeles", backfill: { start: "2026-06-01", end: "2026-11-01", days: 30 } },
    },
  });
}
const day = (d: string) => new Date(`${d}T00:00:00Z`);
/** A page that had 40 clicks 40 days before S and none since; the site steady (1,000 in each window). */
async function decline(brandId = A, path = "/a") {
  await prisma.searchDay.createMany({
    data: [
      { workspaceId: ws, brandId, siteUrl: SITE, dimension: "PAGE", day: day(addDays(S, -40)), page: `https://shop.test${path}`, clicks: 40, impressions: 100, positionSum: 500 },
      { workspaceId: ws, brandId, siteUrl: SITE, dimension: "SITE", day: day(addDays(S, -40)), page: "", clicks: 1000, impressions: 9000, positionSum: 9000 },
      { workspaceId: ws, brandId, siteUrl: SITE, dimension: "SITE", day: day(addDays(S, -10)), page: "", clicks: 1000, impressions: 9000, positionSum: 9000 },
    ],
    skipDuplicates: true,
  });
}
const run = (s: DataSource, d = S, brandId = s.brandId) => runSeoDeclines({ workspaceId: ws, brandId, dataSourceId: s.id, day: d });
const alerts = (brandId = A) => prisma.seoAlert.findMany({ where: { brandId }, orderBy: { firstDay: "asc" } });
const ymd = (d: Date) => d.toISOString().slice(0, 10);

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-seo-declines" } })).id;
  for (const id of [A, B]) await prisma.brand.create({ data: { id, workspaceId: ws, slug: id, displayName: id } });
});
beforeEach(async () => {
  for (const t of [prisma.notification, prisma.seoAlert, prisma.searchDay, prisma.dataSource, prisma.job]) await (t as typeof prisma.job).deleteMany({});
});

describe("runSeoDeclines", () => {
  it("raises a page's decline once; a rerun of the day adds nothing", async () => {
    const s = await source();
    await decline();
    await run(s);
    await run(s);
    const rows = await alerts();
    expect(rows.map((a) => [a.kind, a.pageKey, ymd(a.firstDay), ymd(a.lastDay), a.runKey])).toEqual([
      ["CLICKS_DOWN", "shop.test/a", addDays(S, -3), addDays(S, -3), `seo-declines:${s.id}:${S}`],
    ]);
    expect(rows[0]!.values).toMatchObject({ now: "0", before: "40" });
  });

  it("the next day extends the episode; 6 days later still joins; 8 days after that starts a new one", async () => {
    const s = await source();
    await decline();
    await run(s);
    await run(s, addDays(S, 1));
    expect((await alerts()).map((a) => [ymd(a.firstDay), ymd(a.lastDay)])).toEqual([[addDays(S, -3), addDays(S, -2)]]);
    await run(s, addDays(S, 7));
    expect((await alerts()).map((a) => [ymd(a.firstDay), ymd(a.lastDay)])).toEqual([[addDays(S, -3), addDays(S, 4)]]);
    await run(s, addDays(S, 15));
    expect((await alerts()).map((a) => [ymd(a.firstDay), ymd(a.lastDay)])).toEqual([[addDays(S, -3), addDays(S, 4)], [addDays(S, 12), addDays(S, 12)]]);
  });

  it("a payload naming another brand's source does nothing", async () => {
    const s = await source(A);
    await decline(A);
    await run(s, S, B);
    expect(await prisma.seoAlert.count()).toBe(0);
  });

  it("a source switched off, synced short of the day, or without the read days does nothing", async () => {
    const s = await source(A, addDays(S, -1));
    await decline();
    await run(s);
    await prisma.dataSource.update({ where: { id: s.id }, data: { syncedThrough: day(S), settings: { backfill: { start: addDays(S, -40) } } } });
    await run(s);
    await prisma.dataSource.update({ where: { id: s.id }, data: { status: "OFF", settings: { backfill: { start: "2026-06-01" } } } });
    await run(s);
    expect(await prisma.seoAlert.count()).toBe(0);
  });
});

describe("listSeoAlerts and the hook", () => {
  it("open alerts are the chosen site's, within 7 days of its last synced day, with a server-built url and path", async () => {
    const s = await source(A, S);
    await decline();
    await run(s);
    const { alerts: open } = await listSeoAlerts({ workspaceId: ws, brandId: A }, { open: true }, 50);
    expect(open).toMatchObject([{ kind: "CLICKS_DOWN", url: "https://shop.test/a", path: "/a", open: true, text: expect.stringContaining("Clicks down 100% on /a") }]);
    await prisma.dataSource.update({ where: { id: s.id }, data: { syncedThrough: day(addDays(S, 5)) } });
    expect((await listSeoAlerts({ workspaceId: ws, brandId: A }, { open: true }, 50)).alerts).toEqual([]);
    expect((await listSeoAlerts({ workspaceId: ws, brandId: B }, { open: true }, 50)).alerts).toEqual([]);
  });

  it("queues one job per source and day, only when the run read to its window's end", async () => {
    const s = await source();
    await enqueueSeoDeclines(s, { count: 1, complete: true, window: { from: S, to: S } }, addDays(S, -1));
    await enqueueSeoDeclines(s, { count: 1, complete: true, window: { from: S, to: S } }, S);
    await enqueueSeoDeclines(s, { count: 1, complete: true, window: { from: S, to: S } }, S);
    expect((await prisma.job.findMany({ where: { type: SEO_DECLINES_JOB } })).map((j) => j.idempotencyKey)).toEqual([`seo-declines:${s.id}:${S}`]);
  });
});
