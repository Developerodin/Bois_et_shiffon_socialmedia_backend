import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/prisma";
import { ensureSystemRoles } from "@/server/auth/permissions";
import { buildDigest, clearSectionMemo, readableDigest, readerAccess, sweepAt } from "@/server/digest/build";

/**
 * buildDigest on built-in roles. `admin` is workspace Admin (every key); `viewer`, `client` hold the Viewer and Client
 * reviewer grants; `lead` a custom project role with tasks.all but no CRM key. The week is 2026-11-16..22 (UTC brand).
 */
const NOW = new Date("2026-11-23T08:00:00Z");
let ws: string;
let brand: string;
const user: Record<string, string> = {};

const kinds = (body: Awaited<ReturnType<typeof buildDigest>>) => body?.brands.map((b) => [b.brandId, b.sections.map((s) => s.kind)]);
const tasksOf = (body: Awaited<ReturnType<typeof buildDigest>>) => body?.brands[0]?.sections.find((s) => s.kind === "tasks");

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-digest" } })).id;
  brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "B" } })).id;
  await ensureSystemRoles(ws);
  const role = Object.fromEntries((await prisma.role.findMany({ where: { workspaceId: ws } })).map((r) => [r.slug, r.id]));
  role.lead = (await prisma.role.create({ data: { workspaceId: ws, slug: "lead", name: "Lead", scope: "PROJECT", permissions: ["brand.read", "tasks.read", "tasks.all"] } })).id;
  for (const [name, grant] of [["admin", null], ["viewer", "viewer"], ["client", "client-reviewer"], ["lead", "lead"]] as const) {
    user[name] = (await prisma.user.create({ data: { email: `${name}@digest.test`, name } })).id;
    await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: user[name]!, roleId: role[grant ? "member" : "admin"]! } });
    if (grant) await prisma.brandMember.create({ data: { workspaceId: ws, brandId: brand, userId: user[name]!, roleId: role[grant]! } });
  }
  const synced = { syncedThrough: new Date("2026-11-20T00:00:00Z") };
  await prisma.dataSource.createMany({
    data: [
      { workspaceId: ws, brandId: brand, kind: "SEARCH_CONSOLE", externalId: "sc-domain:b.test", ...synced },
      { workspaceId: ws, brandId: brand, kind: "SHOPIFY_ORDERS", externalId: "b.myshopify.com", ...synced },
      { workspaceId: ws, brandId: brand, kind: "META_ADS", externalId: "act_1", ...synced },
    ],
  });
  await prisma.contentItem.create({ data: { workspaceId: ws, brandId: brand, title: "Post", channel: "INSTAGRAM_POST", status: "AWAITING_APPROVAL" } });
  await prisma.task.createMany({
    data: [
      { workspaceId: ws, brandId: brand, title: "Fix the footer", areas: ["WEBSITE"], ownerId: user.viewer, dueOn: new Date("2026-11-20T00:00:00Z") },
      { workspaceId: ws, brandId: brand, title: "Reply to a conversation", areas: ["CRM"] },
      { workspaceId: ws, brandId: brand, title: "Done last week", areas: ["GENERAL"], status: "DONE", completedAt: new Date("2026-11-18T10:00:00Z") },
    ],
  });
});

describe("buildDigest", () => {
  it("an admin gets every section, CRM tasks counted", async () => {
    const body = await buildDigest(user.admin!, ws, NOW);
    expect(kinds(body)).toEqual([[brand, ["content", "tasks", "seo", "posts", "sales", "ads"]]]);
    expect(body?.brands[0]?.week).toEqual({ from: "2026-11-16", to: "2026-11-22" });
    expect(tasksOf(body)).toMatchObject({ crm: true, done: 1, open: 2, overdue: 1, overdueTasks: [{ title: "Fix the footer" }] });
    expect(body?.brands[0]?.sections.find((s) => s.kind === "sales")).toMatchObject({ data: [] });
  });

  it("a viewer gets no sales or ads, and counts only their own tasks", async () => {
    const body = await buildDigest(user.viewer!, ws, NOW);
    expect(kinds(body)).toEqual([[brand, ["content", "tasks", "seo", "posts"]]]);
    expect(tasksOf(body)).toMatchObject({ crm: false, done: 0, open: 1, overdue: 1 });
  });

  it("a client reviewer by default gets no sales or ads, and no task they can't see", async () => {
    const body = await buildDigest(user.client!, ws, NOW);
    expect(kinds(body)).toEqual([[brand, ["content", "tasks", "seo", "posts"]]]);
    expect(tasksOf(body)).toMatchObject({ done: 0, open: 0, overdue: 0 });
  });

  it("a CRM task is counted only with inbox.read or crm.manage", async () => {
    expect(tasksOf(await buildDigest(user.lead!, ws, NOW))).toMatchObject({ crm: false, done: 1, open: 1 });
  });

  it("an overdue task the reader can no longer see is dropped on read; the counts stay as built", async () => {
    const body = (await buildDigest(user.viewer!, ws, NOW))!;
    const task = await prisma.task.findFirstOrThrow({ where: { workspaceId: ws, title: "Fix the footer" } });
    await prisma.task.update({ where: { id: task.id }, data: { ownerId: user.admin } });
    try {
      const now = await readableDigest(body, user.viewer!, ws, (await readerAccess(user.viewer!, ws))!);
      expect(tasksOf(now)).toMatchObject({ overdue: 1, overdueTasks: [] });
    } finally {
      await prisma.task.update({ where: { id: task.id }, data: { ownerId: user.viewer } });
    }
  });

  it("nothing to say → null; a non-member → null", async () => {
    const quiet = (await prisma.workspace.create({ data: { name: "Q", slug: "w-digest-quiet" } })).id;
    await prisma.brand.create({ data: { workspaceId: quiet, slug: "q", displayName: "Q" } });
    await ensureSystemRoles(quiet);
    const admin = await prisma.role.findFirstOrThrow({ where: { workspaceId: quiet, slug: "admin" } });
    await prisma.workspaceMember.create({ data: { workspaceId: quiet, userId: user.viewer!, roleId: admin.id } });
    expect(await buildDigest(user.viewer!, quiet, NOW)).toBeNull();
    expect(await buildDigest(user.client!, quiet, NOW)).toBeNull();
  });

  it("another workspace's brands are never included", async () => {
    const other = (await prisma.workspace.create({ data: { name: "O", slug: "w-digest-other" } })).id;
    const otherBrand = (await prisma.brand.create({ data: { workspaceId: other, slug: "o", displayName: "O" } })).id;
    await ensureSystemRoles(other);
    const admin = await prisma.role.findFirstOrThrow({ where: { workspaceId: other, slug: "admin" } });
    await prisma.workspaceMember.create({ data: { workspaceId: other, userId: user.admin!, roleId: admin.id } });
    await prisma.contentItem.create({ data: { workspaceId: other, brandId: otherBrand, title: "Other", channel: "INSTAGRAM_POST", status: "AWAITING_APPROVAL" } });
    expect((await buildDigest(user.admin!, ws, NOW))?.brands.map((b) => b.brandId)).toEqual([brand]);
    expect((await buildDigest(user.admin!, other, NOW))?.brands.map((b) => b.brandId)).toEqual([otherBrand]);
  });
});

describe("ads alerts in the digest", () => {
  // Digests of Monday 11-23 (sweep 05:00 UTC, cutoff 08:00) and Monday 11-30.
  const week23 = sweepAt("2026-11-16");
  const week30 = sweepAt("2026-11-23");
  let seq = 0;
  const alert = (brandId: string, kind: "SPEND_UP" | "ROAS_DOWN", day: string, createdAt: string) =>
    prisma.adAlert.create({
      data: {
        workspaceId: ws, brandId, kind, accountId: "act_1", currency: "EUR", firstDay: new Date(day), lastDay: new Date(day),
        values: { day, now: "60.00", baseline: "40.00", ratio: "1.50", roas: "1.95", baselineRoas: "3.00" },
        subjectKey: `k${++seq}`, dedupeKey: `k${seq}:${day}`, createdAt: new Date(createdAt),
      },
    });
  const adsOf = (body: Awaited<ReturnType<typeof buildDigest>>, brandId = brand) =>
    body?.brands.find((b) => b.brandId === brandId)?.sections.find((s) => s.kind === "ads");
  const days = (body: Awaited<ReturnType<typeof buildDigest>>, brandId = brand) => {
    const s = adsOf(body, brandId);
    return s?.kind === "ads" ? (s.alerts ?? []).map((a) => [a.kind, a.firstDay]) : undefined;
  };

  beforeEach(async () => {
    clearSectionMemo();
    await prisma.adAlert.deleteMany({});
  });

  it("lists the alerts raised in its week by when they were raised; one raised after the cutoff waits for the next digest", async () => {
    // A ROAS_DOWN for Saturday 11-21 raised in Wednesday 11-25's run (S = 11-24): the Monday 11-30 digest.
    await alert(brand, "ROAS_DOWN", "2026-11-21", "2026-11-25T06:30:00Z");
    // Raised by Monday 11-23's own sync (06:00, before the 08:00 cutoff): the 11-23 digest.
    await alert(brand, "SPEND_UP", "2026-11-22", "2026-11-23T06:00:00Z");
    // Raised Monday 11-30 at 09:00, after that digest's cutoff: the 12-07 digest.
    await alert(brand, "SPEND_UP", "2026-11-29", "2026-11-30T09:00:00Z");
    expect(days(await buildDigest(user.admin!, ws, NOW, week23))).toEqual([["SPEND_UP", "2026-11-22"]]);
    expect(days(await buildDigest(user.admin!, ws, NOW, week30))).toEqual([["ROAS_DOWN", "2026-11-21"]]);
    expect(days(await buildDigest(user.admin!, ws, NOW, sweepAt("2026-11-30")))).toEqual([["SPEND_UP", "2026-11-29"]]);
    const s = adsOf(await buildDigest(user.admin!, ws, NOW, week30));
    expect(s?.kind === "ads" && s.alerts?.[0]).toMatchObject({ text: expect.stringContaining("ROAS down 35% on act_1"), lastDay: "2026-11-21" });
  });

  it("a reader without ads.read gets no alerts: the ads section isn't there", async () => {
    await alert(brand, "SPEND_UP", "2026-11-22", "2026-11-23T06:00:00Z");
    expect(adsOf(await buildDigest(user.viewer!, ws, NOW, week23))).toBeUndefined();
  });

  it("a brand with only alerts to report still gets its digest", async () => {
    const quiet = (await prisma.brand.create({ data: { workspaceId: ws, slug: "alerts-only", displayName: "Alerts only" } })).id;
    expect((await buildDigest(user.admin!, ws, NOW, week23))?.brands.map((b) => b.brandId)).toEqual([brand]);
    clearSectionMemo();
    await alert(quiet, "SPEND_UP", "2026-11-22", "2026-11-23T06:00:00Z");
    const body = await buildDigest(user.admin!, ws, NOW, week23);
    expect(body?.brands.map((b) => b.brandId)).toEqual([brand, quiet]);
    expect(adsOf(body, quiet)).toMatchObject({ data: null, alerts: [{ kind: "SPEND_UP", firstDay: "2026-11-22" }] });
    await prisma.brand.update({ where: { id: quiet }, data: { status: "ARCHIVED" } });
  });
});

describe("declining pages in the digest", () => {
  const week23 = sweepAt("2026-11-16");
  const week30 = sweepAt("2026-11-23");
  let seq = 0;
  const alert = (pageKey: string, createdAt: string) =>
    prisma.seoAlert.create({
      data: {
        workspaceId: ws, brandId: brand, kind: pageKey ? "CLICKS_DOWN" : "SITE_DOWN", siteUrl: "sc-domain:b.test", page: pageKey ? `https://${pageKey}` : "", pageKey,
        runKey: "r", firstDay: new Date("2026-11-17"), lastDay: new Date("2026-11-17"), values: { now: "10", before: "40", to: "2026-11-17" },
        subjectKey: `s${++seq}`, dedupeKey: `s${seq}`, createdAt: new Date(createdAt),
      },
    });
  const seoOf = (body: Awaited<ReturnType<typeof buildDigest>>) => body?.brands[0]?.sections.find((s) => s.kind === "seo");

  beforeEach(async () => {
    clearSectionMemo();
    await prisma.seoAlert.deleteMany({});
  });

  it("counts the alerts raised in its week, each in one digest, with up to 3 cleaned paths and no host", async () => {
    for (const p of ["b.test/a", "b.test/b", "b.test/c", "b.test/d"]) await alert(p, "2026-11-20T06:00:00Z");
    await alert("", "2026-11-21T06:00:00Z");
    await alert("b.test/late", "2026-11-23T09:00:00Z");
    const s = seoOf(await buildDigest(user.admin!, ws, NOW, week23));
    expect(s?.kind === "seo" && s.declines?.count).toBe(5);
    expect(s?.kind === "seo" && s.declines?.pages).toHaveLength(3);
    expect(s?.kind === "seo" && s.declines?.pages.every((p) => p.startsWith("/b") || p.startsWith("/a") || p.startsWith("/c") || p.startsWith("/d"))).toBe(true);
    clearSectionMemo();
    const next = seoOf(await buildDigest(user.admin!, ws, NOW, week30));
    expect(next?.kind === "seo" && next.declines).toEqual({ count: 1, pages: ["/late"] });
  });

  it("a reader without analytics.read gets no seo section", async () => {
    await alert("b.test/a", "2026-11-20T06:00:00Z");
    expect(seoOf(await buildDigest(user.lead!, ws, NOW, week23))).toBeUndefined();
  });
});
