import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/prisma";
import { startScheduledAgents, weeklySlot } from "@/server/jobs/runner";

/**
 * The weekly SEO and GEO sweep against Postgres: a run of any trigger in the last week holds it back, a brand runs on
 * its own weekday, a brand that missed its day catches up, and a brand without a website is skipped.
 */
let ws: string;
const now = new Date();
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
/** Days before the start of today (UTC), as the sweep counts them. */
const beforeToday = (days: number) => new Date(new Date(now.toISOString().slice(0, 10)).getTime() - days * 86_400_000);
/** A brand id whose weekly slot is (or isn't) today. */
const idWhere = (today: boolean) => {
  for (let i = 0; ; i++) if ((weeklySlot(`weekly-${today}-${i}`) === now.getUTCDay()) === today) return `weekly-${today}-${i}`;
};
const onDay = idWhere(true);
const offDay = idWhere(false);
const noSite = "weekly-no-site";

async function brand(id: string, websiteUrl: string | null) {
  await prisma.brand.create({ data: { id, workspaceId: ws, slug: id, displayName: id } });
  await prisma.brandProfile.create({ data: { workspaceId: ws, brandId: id, websiteUrl } });
}
const pastRun = (brandId: string, agentKey: string, days: number, trigger = "manual") =>
  prisma.agentRun.create({ data: { workspaceId: ws, brandId, agentKey, trigger, status: "SUCCEEDED", createdAt: beforeToday(days) } });
const scheduled = (brandId: string) =>
  prisma.agentRun.findMany({ where: { brandId, trigger: "schedule", agentKey: { in: ["seo", "geo"] } }, select: { agentKey: true } }).then((r) => r.map((x) => x.agentKey).sort());

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-scheduled-agents" } })).id;
  await brand(onDay, "https://on.test");
  await brand(offDay, "https://off.test");
  await brand(noSite, null);
  // Days before today. On its day: SEO last ran 6.5 days before (due), GEO 2 days before, by hand (held back).
  await pastRun(onDay, "seo", 6.5, "schedule");
  await pastRun(onDay, "geo", 2);
  // Not its day: SEO ran 6.5 days before (waits for its day), GEO 9 days before (missed its day: catches up).
  await pastRun(offDay, "seo", 6.5, "schedule");
  await pastRun(offDay, "geo", 9, "schedule");
});

describe("startScheduledAgents", () => {
  it("starts the weekly agents that are due, once", async () => {
    await startScheduledAgents(now);
    // Only the runs this sweep started are newer than a day.
    const fresh = (brandId: string) =>
      prisma.agentRun.findMany({ where: { brandId, agentKey: { in: ["seo", "geo"] }, createdAt: { gt: ago(1) } }, select: { agentKey: true, trigger: true } });
    expect((await fresh(onDay)).map((r) => [r.agentKey, r.trigger])).toEqual([["seo", "schedule"]]);
    expect((await fresh(offDay)).map((r) => [r.agentKey, r.trigger])).toEqual([["geo", "schedule"]]);
    expect(await scheduled(noSite)).toEqual([]);

    // A second sweep the same day starts nothing more.
    await startScheduledAgents(now);
    expect(await fresh(onDay)).toHaveLength(1);
    expect(await fresh(offDay)).toHaveLength(1);
  });
});
