import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// list.ts also holds the route handlers, whose auth import pulls next-auth (unloadable under vitest). Not used here.
vi.mock("@/server/auth/request-user", () => ({ requestUserId: vi.fn() }));
import { prisma } from "@/server/db/prisma";
import { ensureSystemRoles } from "@/server/auth/permissions";
import { addDays } from "@/server/data/sources";
import { countUnread, listNotifications } from "@/server/notifications/list";
import { seoAlertRecipients } from "@/server/notifications/seo";
import { runSeoDeclines } from "@/server/seo/declines";

/**
 * SEO_ALERT notices in the bell against Postgres: one grouped notice per decline run that raised alerts, none on a site's
 * first evaluation or for a run that only extended episodes; who gets them (brand.read and analytics.read, role ∪ grant,
 * clients included) agrees with who can list them; losing the key or archiving the brand hides them.
 *
 * People on brand `seo-bell-a`: Owner, Viewer, Creator and Client reviewer grants (all read analytics), a custom
 * workspace role with brand.read only (`brandOnly`) and a Member with no grant.
 */
let ws: string;
let brand: string;
let other: string;
const user: Record<string, string> = {};
const roles: Record<string, string> = {};
const S = "2026-11-20";
const SITE = "https://shop.test/";
const day = (d: string) => new Date(`${d}T00:00:00Z`);

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-seo-alert-bell" } })).id;
  brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "seo-bell-a", displayName: "Seo bell A" } })).id;
  other = (await prisma.brand.create({ data: { workspaceId: ws, slug: "seo-bell-b", displayName: "Seo bell B" } })).id;
  await ensureSystemRoles(ws);
  for (const r of await prisma.role.findMany({ where: { workspaceId: ws } })) roles[r.slug] = r.id;
  roles.brandOnly = (await prisma.role.create({ data: { workspaceId: ws, slug: "brand-only", name: "Brand only", permissions: ["brand.read"] } })).id;
  roles.tasksOnly = (await prisma.role.create({ data: { workspaceId: ws, slug: "tasks-only", name: "Tasks only", scope: "PROJECT", permissions: ["brand.read", "tasks.read"] } })).id;
  for (const n of ["owner", "viewer", "creator", "clientr", "brandOnly", "plain"]) user[n] = (await prisma.user.create({ data: { email: `${n}@seo-alert-bell.test` } })).id;
  const member = (n: string, roleId: string) => prisma.workspaceMember.create({ data: { workspaceId: ws, userId: user[n]!, roleId } });
  await member("owner", roles.owner!);
  for (const n of ["viewer", "creator", "clientr", "plain"]) await member(n, roles.member!);
  await member("brandOnly", roles.brandOnly!);
  for (const [n, slug] of [["viewer", "viewer"], ["creator", "creator"], ["clientr", "client-reviewer"]] as const) {
    await prisma.brandMember.create({ data: { workspaceId: ws, brandId: brand, userId: user[n]!, roleId: roles[slug]! } });
  }
});

beforeEach(async () => {
  await prisma.notification.deleteMany({});
  await prisma.seoAlert.deleteMany({});
  await prisma.searchDay.deleteMany({});
  await prisma.dataSource.deleteMany({});
  await prisma.brand.update({ where: { id: brand }, data: { status: "ACTIVE" } });
  await prisma.brandMember.updateMany({ where: { userId: user.viewer }, data: { roleId: roles.viewer } });
});

const name = (id: string) => Object.keys(user).find((k) => user[k] === id);
/** The brand's Search Console source; `seen`: the site already had its first evaluation. */
const source = (seen: boolean) =>
  prisma.dataSource.create({
    data: {
      workspaceId: ws, brandId: brand, kind: "SEARCH_CONSOLE", externalId: SITE, label: SITE, syncedThrough: day(addDays(S, 20)),
      settings: { backfill: { start: "2026-06-01" }, ...(seen && { declinesSeenFor: SITE }) },
    },
  });
/** Pages that had `clicks` clicks 40 days before S and none since; the site steady. */
async function declining(paths: string[], clicks = 40) {
  await prisma.searchDay.createMany({
    data: [
      ...paths.map((p) => ({ workspaceId: ws, brandId: brand, siteUrl: SITE, dimension: "PAGE" as const, day: day(addDays(S, -40)), page: `https://shop.test${p}`, clicks, impressions: 100, positionSum: 500 })),
      { workspaceId: ws, brandId: brand, siteUrl: SITE, dimension: "SITE" as const, day: day(addDays(S, -40)), page: "", clicks: 1000, impressions: 9000, positionSum: 9000 },
      { workspaceId: ws, brandId: brand, siteUrl: SITE, dimension: "SITE" as const, day: day(addDays(S, -10)), page: "", clicks: 1000, impressions: 9000, positionSum: 9000 },
    ],
    skipDuplicates: true,
  });
}
const run = (sourceId: string, d = S) => runSeoDeclines({ workspaceId: ws, brandId: brand, dataSourceId: sourceId, day: d });
const notices = () => prisma.notification.findMany({ where: { kind: "SEO_ALERT" } });

describe("one grouped notice per run", () => {
  it("a run raising 3 alerts: one notice per recipient, pointing at the biggest loss and naming 3; a rerun adds none", async () => {
    const s = await source(true);
    await declining(["/a", "/b"]);
    await declining(["/big"], 90);
    await run(s.id);
    const recipients = await seoAlertRecipients({ workspaceId: ws, brandId: brand });
    expect(recipients.map(name).sort()).toEqual(["clientr", "creator", "owner", "viewer"]);
    expect((await notices()).map((n) => name(n.userId)).sort()).toEqual(["clientr", "creator", "owner", "viewer"]);
    const [n] = (await listNotifications(user.viewer!, ws)).notifications;
    expect(n).toMatchObject({ kind: "SEO_ALERT", brandId: brand, taskId: null, count: 1 });
    expect(n!.alert).toEqual({ kind: "CLICKS_DOWN", text: "3 pages losing search traffic, e.g. /big", seoUrl: "https://shop.test/big" });
    await run(s.id);
    expect(await notices()).toHaveLength(4);
  });

  it("a run that only extends episodes writes none", async () => {
    const s = await source(true);
    await declining(["/a"]);
    await run(s.id);
    await run(s.id, addDays(S, 1));
    expect(await notices()).toHaveLength(4);
    expect(await prisma.seoAlert.count()).toBe(1);
  });

  it("none on a site's first evaluation; the next run's new alert notifies; choosing the site again is quiet again", async () => {
    const s = await source(false);
    await declining(["/a"]);
    await run(s.id);
    expect(await notices()).toEqual([]);
    expect(await prisma.seoAlert.count()).toBe(1);
    expect((await prisma.dataSource.findUniqueOrThrow({ where: { id: s.id } })).settings).toMatchObject({ backfill: { start: "2026-06-01" }, declinesSeenFor: SITE });
    await declining(["/b"]);
    await run(s.id, addDays(S, 1));
    const [n] = (await listNotifications(user.owner!, ws)).notifications;
    expect(n?.alert?.text).toContain("Clicks down 100% on /b");
    // chooseSearchSite rewrites the settings: the site's next evaluation is a first one again.
    await prisma.dataSource.update({ where: { id: s.id }, data: { settings: { backfill: { start: "2026-06-01" } } } });
    await declining(["/c"]);
    await run(s.id, addDays(S, 2));
    expect(await notices()).toHaveLength(4);
  });
});

describe("who sees them", () => {
  it("the people notified are exactly the people who can list a notice; brand.read alone gets nothing", async () => {
    const s = await source(true);
    await declining(["/a"]);
    await run(s.id);
    const lead = await prisma.seoAlert.findFirstOrThrow({});
    // Everyone gets a row, so the read rule alone decides who sees it.
    await prisma.notification.createMany({
      data: Object.values(user).map((userId) => ({ kind: "SEO_ALERT" as const, seoAlertId: lead.id, workspaceId: ws, brandId: brand, userId, dedupeKey: `x:${userId}` })),
      skipDuplicates: true,
    });
    const recipients = new Set(await seoAlertRecipients({ workspaceId: ws, brandId: brand }));
    for (const id of Object.values(user)) {
      expect([name(id), await countUnread(id, ws) > 0]).toEqual([name(id), recipients.has(id)]);
    }
    expect(recipients.has(user.brandOnly!)).toBe(false);
  });

  it("hidden once the reader loses analytics.read, and when the brand is archived", async () => {
    const s = await source(true);
    await declining(["/a"]);
    await run(s.id);
    expect(await countUnread(user.viewer!, ws)).toBe(1);
    await prisma.brandMember.updateMany({ where: { userId: user.viewer }, data: { roleId: roles.tasksOnly } });
    expect(await countUnread(user.viewer!, ws)).toBe(0);
    expect((await listNotifications(user.viewer!, ws)).notifications).toEqual([]);
    await prisma.brand.update({ where: { id: brand }, data: { status: "ARCHIVED" } });
    expect(await countUnread(user.owner!, ws)).toBe(0);
    expect(await seoAlertRecipients({ workspaceId: ws, brandId: brand })).toEqual([]);
  });

  it("a notice never shows another brand's alert", async () => {
    const foreign = await prisma.seoAlert.create({
      data: {
        workspaceId: ws, brandId: other, kind: "CLICKS_DOWN", siteUrl: SITE, page: "https://other.test/secret", pageKey: "other.test/secret", runKey: "r",
        firstDay: day(S), lastDay: day(S), values: { now: "1", before: "40", to: S }, subjectKey: "k", dedupeKey: "k",
      },
    });
    await prisma.notification.create({ data: { kind: "SEO_ALERT", seoAlertId: foreign.id, workspaceId: ws, brandId: brand, userId: user.owner!, dedupeKey: "forged" } });
    const [n] = (await listNotifications(user.owner!, ws)).notifications;
    expect(n?.alert).toBeNull();
  });
});
