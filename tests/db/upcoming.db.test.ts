import { beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import type { PermissionKey } from "@/server/auth/permissions.catalog";
import { taskViewer } from "@/server/tasks/access";
import { upcomingWork } from "@/server/tasks/upcoming";

/**
 * The Overview's next 7 days against Postgres: the brand-local window (Paris), website tasks only, open only, the
 * visibility rule (staff with and without tasks.all, a client, the CRM rule) on rows and counts alike, and milestones
 * of active projects the caller may see.
 */
let ws: string;
let paris: string;
let other: string;
let staff: string;
let member: string;
let client: string;

// 2026-11-27 23:30 UTC is already 2026-11-28 in Paris: the window is 11-28 .. 12-04.
const NOW = new Date("2026-11-27T23:30:00Z");
const day = (s: string) => new Date(`${s}T00:00:00Z`);

const ALL: PermissionKey[] = ["brand.read", "tasks.read", "tasks.manage", "tasks.all"];
const scopeOf = (userId: string, perms: PermissionKey[], clientReviewer = false, brandId = paris) => ({ workspaceId: ws, brandId, userId, perms: new Set(perms), clientReviewer });
const run = (s: ReturnType<typeof scopeOf>) => upcomingWork(s, taskViewer(s), NOW);
const titles = (r: Awaited<ReturnType<typeof run>>) => r.website.tasks.map((t) => t.title).sort();

const task = (data: Partial<Prisma.TaskUncheckedCreateInput>) =>
  prisma.task.create({ data: { workspaceId: ws, brandId: paris, title: "t", areas: ["WEBSITE"], ...data } });

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-upcoming" } })).id;
  [paris, other] = (
    await Promise.all([
      prisma.brand.create({ data: { workspaceId: ws, slug: "paris", displayName: "Paris" } }),
      prisma.brand.create({ data: { workspaceId: ws, slug: "other", displayName: "Other" } }),
    ])
  ).map((b) => b.id);
  await prisma.brandProfile.create({ data: { workspaceId: ws, brandId: paris, timeZone: "Europe/Paris" } });
  [staff, member, client] = (
    await Promise.all(["staff", "member", "client"].map((n) => prisma.user.create({ data: { email: `${n}@upcoming.test` } })))
  ).map((u) => u.id);

  const [shared, internal, archived] = await Promise.all([
    prisma.workProject.create({ data: { workspaceId: ws, brandId: paris, name: "Shared launch", clientVisible: true } }),
    prisma.workProject.create({ data: { workspaceId: ws, brandId: paris, name: "Internal" } }),
    prisma.workProject.create({ data: { workspaceId: ws, brandId: paris, name: "Old", status: "ARCHIVED" } }),
  ]);
  const otherProject = await prisma.workProject.create({ data: { workspaceId: ws, brandId: other, name: "Other brand" } });

  await Promise.all([
    task({ title: "first day", dueOn: day("2026-11-28") }),
    task({ title: "last day", dueOn: day("2026-12-04") }),
    task({ title: "after window", dueOn: day("2026-12-05") }),
    task({ title: "yesterday", dueOn: day("2026-11-27") }),
    task({ title: "undated" }),
    task({ title: "seo only", areas: ["SEO"], dueOn: day("2026-11-30") }),
    task({ title: "done", status: "DONE", completedAt: NOW, dueOn: day("2026-11-30") }),
    task({ title: "in review", status: "IN_REVIEW", dueOn: day("2026-11-30") }),
    task({ title: "crm too", areas: ["WEBSITE", "CRM"], dueOn: day("2026-11-30") }),
    task({ title: "member's", ownerId: member, dueOn: day("2026-11-29") }),
    task({ title: "shared", workProjectId: shared.id, dueOn: day("2026-12-01") }),
    task({ title: "other brand", brandId: other, dueOn: day("2026-11-30") }),
  ]);
  await prisma.workProjectMilestone.createMany({
    data: [
      { workProjectId: shared.id, title: "Shared step", dueOn: day("2026-11-29"), position: 0 },
      { workProjectId: internal.id, title: "Internal step", dueOn: day("2026-12-03"), position: 0 },
      { workProjectId: internal.id, title: "Done step", dueOn: day("2026-12-02"), doneAt: NOW, position: 1 },
      { workProjectId: internal.id, title: "Late step", dueOn: day("2026-12-05"), position: 2 },
      { workProjectId: archived.id, title: "Archived step", dueOn: day("2026-11-30"), position: 0 },
      { workProjectId: otherProject.id, title: "Other step", dueOn: day("2026-11-30"), position: 0 },
    ],
  });
});

describe("upcomingWork", () => {
  it("uses the brand's local days and keeps open website tasks in the window", async () => {
    const r = await run(scopeOf(staff, ALL));
    expect([r.timeZone, r.from, r.to]).toEqual(["Europe/Paris", "2026-11-28", "2026-12-04"]);
    expect(titles(r)).toEqual(["first day", "in review", "last day", "member's", "shared"].sort());
    expect(r.website.count).toBe(5);
    // Soonest first.
    expect(r.website.tasks[0].title).toBe("first day");
    expect(r.website.tasks.at(-1)?.title).toBe("last day");
  });

  it("shows the CRM-tagged website task only to someone with a CRM key", async () => {
    const r = await run(scopeOf(staff, [...ALL, "inbox.read"]));
    expect(titles(r)).toContain("crm too");
    expect(r.website.count).toBe(6);
  });

  it("gives staff without tasks.all only their own tasks, in rows and count", async () => {
    const r = await run(scopeOf(member, ["brand.read", "tasks.read"]));
    expect(titles(r)).toEqual(["member's"]);
    expect(r.website.count).toBe(1);
  });

  it("gives a client only shared tasks and shared projects' milestones, even with tasks.all", async () => {
    const r = await run(scopeOf(client, ["brand.read", "tasks.read", "tasks.all"], true));
    expect(titles(r)).toEqual(["shared"]);
    expect(r.website.count).toBe(1);
    expect(r.milestones.items.map((m) => m.title)).toEqual(["Shared step"]);
    expect(r.milestones.count).toBe(1);
  });

  it("lists open milestones of active projects in the window, with the project", async () => {
    const r = await run(scopeOf(staff, ALL));
    expect(r.milestones.items).toEqual([
      expect.objectContaining({ title: "Shared step", dueOn: "2026-11-29", project: expect.objectContaining({ name: "Shared launch" }) }),
      expect.objectContaining({ title: "Internal step", dueOn: "2026-12-03", project: expect.objectContaining({ name: "Internal" }) }),
    ]);
    expect(r.milestones.count).toBe(2);
  });

  it("answers an empty window with zero counts", async () => {
    const r = await upcomingWork(scopeOf(staff, ALL, false, other), taskViewer(scopeOf(staff, ALL, false, other)), new Date("2027-06-01T12:00:00Z"));
    expect(r.website).toEqual({ count: 0, tasks: [] });
    expect(r.milestones).toEqual({ count: 0, items: [] });
    expect(r.timeZone).toBe("UTC");
  });

  it("falls back to UTC for a stored zone Intl doesn't know", async () => {
    const odd = (await prisma.brand.create({ data: { workspaceId: ws, slug: "odd", displayName: "Odd" } })).id;
    await prisma.brandProfile.create({ data: { workspaceId: ws, brandId: odd, timeZone: "Mars/Olympus" } });
    const s = scopeOf(staff, ALL, false, odd);
    const r = await upcomingWork(s, taskViewer(s), NOW);
    expect([r.timeZone, r.from, r.to]).toEqual(["UTC", "2026-11-27", "2026-12-03"]);
  });

  it("caps the rows at 10 and counts the rest", async () => {
    const extra = Array.from({ length: 12 }, (_, i) => ({ workspaceId: ws, brandId: other, title: `x${i}`, areas: ["WEBSITE" as const], dueOn: day("2026-11-28") }));
    await prisma.task.createMany({ data: extra });
    const s = scopeOf(staff, ALL, false, other);
    const r = await upcomingWork(s, taskViewer(s), NOW);
    // `other` has no profile: UTC, so the window is 11-27 .. 12-03 and "other brand" (11-30) is in it too.
    expect(r.website.tasks).toHaveLength(10);
    expect(r.website.count).toBe(13);
    await prisma.task.deleteMany({ where: { brandId: other, title: { startsWith: "x" } } });
  });
});
