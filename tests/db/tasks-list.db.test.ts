import { beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import type { PermissionKey } from "@/server/auth/permissions.catalog";
import { taskViewer } from "@/server/tasks/access";
import { ListQuery, listTasks, todayTasks } from "@/server/tasks/list";
import type { TaskView } from "@/shared";

/**
 * Lists and Today against Postgres: keyset pages, the Done order, brand-local "today", and a client's page built on the
 * visibility predicate in SQL. Brand `paris` has a Europe/Paris profile; `plain` has no profile; `client` holds a
 * client-reviewer grant on `plain`.
 */
let ws: string;
let paris: string;
let plain: string;
let staff: string;
let client: string;

const STAFF: PermissionKey[] = ["brand.read", "tasks.read", "tasks.manage"];
const scopeOf = (brandId: string, userId = staff, clientReviewer = false, perms: PermissionKey[] = STAFF) =>
  ({ workspaceId: ws, brandId, userId, perms: new Set(perms), clientReviewer });

/** Every page of a view, following nextCursor. */
async function allPages(brandId: string, view: TaskView, userId = staff, clientReviewer = false) {
  const s = scopeOf(brandId, userId, clientReviewer, clientReviewer ? ["brand.read", "tasks.read"] : STAFF);
  const pages: string[][] = [];
  let cursor: string | undefined;
  do {
    const out = await listTasks(s, taskViewer(s), { view, cursor });
    pages.push(out.tasks.map((t) => t.id));
    cursor = out.nextCursor ?? undefined;
  } while (cursor);
  return pages;
}

const day = (s: string) => new Date(`${s}T00:00:00Z`);
const make = (brandId: string, rows: Partial<Prisma.TaskCreateManyInput>[]) =>
  prisma.task.createManyAndReturn({ data: rows.map((r, i) => ({ workspaceId: ws, brandId, title: `t${i}`, ...r })), select: { id: true } });

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-tasks-list" } })).id;
  [paris, plain] = (
    await Promise.all([
      prisma.brand.create({ data: { workspaceId: ws, slug: "paris", displayName: "Paris" } }),
      prisma.brand.create({ data: { workspaceId: ws, slug: "plain", displayName: "Plain" } }),
    ])
  ).map((b) => b.id);
  await prisma.brandProfile.create({ data: { workspaceId: ws, brandId: paris, timeZone: "Europe/Paris" } });
  [staff, client] = (
    await Promise.all([prisma.user.create({ data: { email: "staff@tasks-list.test" } }), prisma.user.create({ data: { email: "client@tasks-list.test" } })])
  ).map((u) => u.id);
});

describe("task lists", () => {
  it("keyset pages don't repeat or skip", async () => {
    // 55 open tasks on `plain`: 43 with due days (several sharing a day), 12 without.
    await make(plain, Array.from({ length: 55 }, (_, i) => ({ ownerId: staff, dueOn: i < 43 ? day(`2026-12-${String((i % 9) + 1).padStart(2, "0")}`) : null })));
    const pages = await allPages(plain, "open");
    expect(pages.map((p) => p.length)).toEqual([50, 5]);
    const ids = pages.flat();
    expect(new Set(ids).size).toBe(55);
    const rows = await prisma.task.findMany({ where: { brandId: plain }, select: { id: true, dueOn: true } });
    const expected = rows
      .map((r) => ({ id: r.id, due: r.dueOn?.toISOString().slice(0, 10) ?? "infinity" }))
      .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((r) => r.id);
    expect(ids).toEqual(expected);
    // The undated ones come last.
    expect(ids.slice(-12).every((id) => rows.find((r) => r.id === id)!.dueOn === null)).toBe(true);
    await prisma.task.deleteMany({ where: { brandId: plain } });
  });

  it("done view sorts by completedAt", async () => {
    const now = Date.now();
    const at = (daysAgo: number) => new Date(now - daysAgo * 86_400_000);
    const rows = await make(plain, [
      { status: "DONE", completedAt: at(3) },
      { status: "DONE", completedAt: at(1) },
      { status: "DONE", completedAt: at(40) }, // older than 30 days: left out
      { status: "DONE", completedAt: at(2) },
      { status: "CANCELLED" },
      { status: "TODO" },
    ]);
    expect((await allPages(plain, "done")).flat()).toEqual([rows[1]!.id, rows[3]!.id, rows[0]!.id]);
    await prisma.task.deleteMany({ where: { brandId: plain } });
  });

  it("client list is never short", async () => {
    // 60 tasks, 10 of them reviewed by the client: one page of 10, no cursor.
    await make(plain, Array.from({ length: 60 }, (_, i) => ({ reviewerId: i % 6 === 0 ? client : null, dueOn: day("2026-12-01") })));
    const pages = await allPages(plain, "open", client, true);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toHaveLength(10);
    await prisma.task.deleteMany({ where: { brandId: plain } });
  });
});

describe("Today", () => {
  // 23:30 UTC on 23 Nov is 00:30 on 24 Nov in Paris.
  const NOW = new Date("2026-11-23T23:30:00Z");

  it("today counts overdue in the brand time zone", async () => {
    const [yesterday, today, tomorrow] = await make(paris, [
      { ownerId: staff, dueOn: day("2026-11-23") }, // Paris yesterday: overdue there (still "today" in UTC)
      { ownerId: staff, dueOn: day("2026-11-24") }, // Paris today
      { ownerId: staff, dueOn: day("2026-11-25") },
    ]);
    const s = scopeOf(paris);
    const out = await todayTasks(s, taskViewer(s), NOW);
    expect(out.mine.count).toBe(2);
    expect(out.mine.tasks.map((t) => t.id)).toEqual([yesterday!.id, today!.id]);
    const overdue = await listTasks(s, taskViewer(s), { view: "overdue" }, NOW);
    expect(overdue.tasks.map((t) => t.id)).toEqual([yesterday!.id]);
    const dueToday = await listTasks(s, taskViewer(s), { view: "due-today" }, NOW);
    expect(dueToday.tasks.map((t) => t.id)).toEqual([today!.id]);
    expect(tomorrow).toBeDefined();
  });

  it("brand without profile uses DEFAULT_TIME_ZONE", async () => {
    const [today, tomorrow] = await make(plain, [
      { ownerId: staff, dueOn: day("2026-11-23"), reviewerId: client, status: "IN_REVIEW" },
      { ownerId: staff, dueOn: day("2026-11-24"), blockedReason: "Waiting on photos" },
    ]);
    const s = scopeOf(plain);
    const out = await todayTasks(s, taskViewer(s), NOW);
    expect(out.mine).toMatchObject({ count: 1, tasks: [{ id: today!.id }] });
    expect(out.blockers).toMatchObject({ count: 1, tasks: [{ id: tomorrow!.id }] });
    expect(out.approvals.count).toBe(0);
    const dueToday = await listTasks(s, taskViewer(s), { view: "due-today" }, NOW);
    expect(dueToday.tasks.map((t) => t.id)).toEqual([today!.id]);
    await prisma.task.deleteMany({ where: { brandId: plain } });
  });
});

describe("source filter", () => {
  it("keeps the tasks of one audit kind, with the area and across pages", async () => {
    const perf = (await prisma.brand.create({ data: { workspaceId: ws, slug: "perf", displayName: "Perf" } })).id;
    // 52 GEO tasks (two pages), 3 SEO, 2 by hand; one GEO task outside the SEO area.
    const geo = await make(perf, Array.from({ length: 52 }, (_, i) => ({ areas: ["SEO" as const], findingKind: "GEO" as const, findingId: `g${i}` })));
    const seo = await make(perf, Array.from({ length: 3 }, (_, i) => ({ areas: ["SEO" as const], findingKind: "SEO" as const, findingId: `s${i}` })));
    await make(perf, [{ areas: ["SEO"] }, { areas: ["WEBSITE"] }]);
    const other = await make(perf, [{ areas: ["WEBSITE"], findingKind: "GEO", findingId: "w" }]);
    const s = scopeOf(perf);
    /** Every page, each asked with the same filters and the last page's cursor. */
    const all = async (q: Record<string, string>) => {
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const out = await listTasks(s, taskViewer(s), ListQuery.parse({ view: "open", ...q, ...(cursor ? { cursor } : {}) }));
        expect(out.tasks.every((t) => t.findingKind === q.source.toUpperCase())).toBe(true);
        ids.push(...out.tasks.map((t) => t.id));
        cursor = out.nextCursor ?? undefined;
      } while (cursor);
      return ids.sort();
    };
    expect(await all({ area: "seo", source: "geo" })).toEqual(geo.map((t) => t.id).sort());
    expect(await all({ source: "SEO" })).toEqual(seo.map((t) => t.id).sort());
    expect(await all({ source: "geo" })).toEqual([...geo, ...other].map((t) => t.id).sort());
    expect(ListQuery.safeParse({ view: "open", source: "ads" }).success).toBe(false);
  });
});
