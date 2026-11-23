import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// list.ts also holds the route handlers, whose auth import pulls next-auth (unloadable under vitest). Not used here.
vi.mock("@/server/auth/request-user", () => ({ requestUserId: vi.fn() }));
import { prisma } from "@/server/db/prisma";
import { notifyOverdueTasks, notifyRechecks, pruneNotifications } from "@/server/notifications/daily-tasks";
import { countUnread, listNotifications, markRead } from "@/server/notifications/list";

/**
 * One workspace, two brands: `east` in Pacific/Auckland (UTC+13 in November), `utc` with no profile (DEFAULT_TIME_ZONE).
 * `staff` is an Owner; `client` holds the client-reviewer grant on east; `creator` has a creator grant on east only.
 * NOW is 2026-11-23 12:00 UTC: already 2026-11-24 in Auckland, still 2026-11-23 on the UTC brand.
 */
const NOW = new Date("2026-11-23T12:00:00Z");
const day = (s: string) => new Date(`${s}T00:00:00Z`);

let ws: string;
let east: string;
let utc: string;
let staff: string;
let client: string;
let creator: string;
let creatorGrant: string;

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-task-notifications" } })).id;
  [east, utc] = (
    await Promise.all([
      prisma.brand.create({ data: { workspaceId: ws, slug: "east", displayName: "East" } }),
      prisma.brand.create({ data: { workspaceId: ws, slug: "utc", displayName: "Utc" } }),
    ])
  ).map((b) => b.id) as [string, string];
  await prisma.brandProfile.create({ data: { workspaceId: ws, brandId: east, timeZone: "Pacific/Auckland" } });
  const [ownerRole, memberRole, clientRole, creatorRole] = await Promise.all([
    prisma.role.create({ data: { workspaceId: ws, slug: "owner", name: "Owner", isSystem: true, permissions: ["brand.read", "content.approve", "tasks.read", "tasks.manage"] } }),
    prisma.role.create({ data: { workspaceId: ws, slug: "member", name: "Member", isSystem: true, permissions: [] } }),
    prisma.role.create({ data: { workspaceId: ws, slug: "client-reviewer", name: "Client", isSystem: true, scope: "PROJECT", permissions: ["brand.read", "content.approve", "tasks.read"] } }),
    prisma.role.create({ data: { workspaceId: ws, slug: "creator", name: "Creator", isSystem: true, scope: "PROJECT", permissions: ["brand.read", "tasks.read", "tasks.manage"] } }),
  ]);
  [staff, client, creator] = (
    await Promise.all(["staff", "client", "creator"].map((n) => prisma.user.create({ data: { email: `${n}@task-notifications.test` } })))
  ).map((u) => u.id) as [string, string, string];
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: ws, userId: staff, roleId: ownerRole.id },
      { workspaceId: ws, userId: client, roleId: memberRole.id },
      { workspaceId: ws, userId: creator, roleId: memberRole.id },
    ],
  });
  await prisma.brandMember.create({ data: { workspaceId: ws, brandId: east, userId: client, roleId: clientRole.id } });
  creatorGrant = (await prisma.brandMember.create({ data: { workspaceId: ws, brandId: east, userId: creator, roleId: creatorRole.id } })).id;
});

beforeEach(async () => {
  await prisma.notification.deleteMany({});
  await prisma.task.deleteMany({});
});

const task = (data: { brandId: string; ownerId?: string; reviewerId?: string; status?: "TODO" | "DONE" | "CANCELLED"; dueOn?: Date; recheckOn?: Date; title?: string }) =>
  prisma.task.create({ data: { workspaceId: ws, title: data.title ?? "T", ...data } });
const keys = async () => (await prisma.notification.findMany({ orderBy: { dedupeKey: "asc" } })).map((n) => n.dedupeKey);

describe("daily task notifications", () => {
  it("overdue uses the brand's local date", async () => {
    const a = await task({ brandId: east, ownerId: staff, dueOn: day("2026-11-23") }); // Auckland is on the 24th: overdue
    await task({ brandId: utc, ownerId: staff, dueOn: day("2026-11-23") }); // still the 23rd here: due today, not overdue
    await task({ brandId: east, dueOn: day("2026-11-01") }); // nobody owns it
    await task({ brandId: east, ownerId: staff, status: "CANCELLED", dueOn: day("2026-11-01") }); // closed
    await notifyOverdueTasks(NOW);
    expect(await keys()).toEqual([`TASK_OVERDUE:${staff}:${a.id}:2026-11-23:w0`]);
    const n = await prisma.notification.findFirstOrThrow();
    expect(n).toMatchObject({ userId: staff, workspaceId: ws, brandId: east, kind: "TASK_OVERDUE", taskId: a.id, readAt: null });
  });

  it("sweep twice adds nothing", async () => {
    await task({ brandId: utc, ownerId: staff, dueOn: day("2026-11-20") });
    await task({ brandId: utc, ownerId: staff, status: "DONE", recheckOn: day("2026-11-23") });
    await notifyOverdueTasks(NOW);
    await notifyRechecks(NOW);
    const first = await keys();
    expect(first).toHaveLength(2);
    await notifyOverdueTasks(NOW);
    await notifyRechecks(NOW);
    expect(await keys()).toEqual(first);
    // Still overdue: nothing more the rest of the week, one reminder a week later, and a new due date starts over.
    await notifyOverdueTasks(new Date("2026-11-27T12:00:00Z"));
    expect(await keys()).toHaveLength(2);
    await notifyOverdueTasks(new Date("2026-11-28T12:00:00Z"));
    expect(await keys()).toHaveLength(3);
    await prisma.task.updateMany({ where: { dueOn: day("2026-11-20") }, data: { dueOn: day("2026-11-25") } });
    await notifyOverdueTasks(new Date("2026-11-26T12:00:00Z"));
    expect((await keys()).filter((k) => k.endsWith(":2026-11-25:w0"))).toHaveLength(1);
  });

  it("recheck only for DONE, catching up a missed week keyed by its own day", async () => {
    const done = await task({ brandId: east, ownerId: staff, status: "DONE", recheckOn: day("2026-11-24") });
    await task({ brandId: east, ownerId: staff, status: "TODO", recheckOn: day("2026-11-24") });
    const missed = await task({ brandId: east, ownerId: staff, status: "DONE", recheckOn: day("2026-11-18") }); // 6 days ago in Auckland
    await task({ brandId: east, ownerId: staff, status: "DONE", recheckOn: day("2026-11-17") }); // a week ago: too old
    await task({ brandId: east, ownerId: staff, status: "DONE", recheckOn: day("2026-11-25") }); // tomorrow
    await notifyRechecks(NOW);
    expect(await keys()).toEqual([`TASK_RECHECK:${staff}:${missed.id}:2026-11-18`, `TASK_RECHECK:${staff}:${done.id}:2026-11-24`].sort());
    // The next day's sweep resends neither; only the one due that day (the 25th in Auckland) is new.
    await notifyRechecks(new Date("2026-11-24T12:00:00Z"));
    expect(await keys()).toHaveLength(3);
  });

  it("prunes notices older than 90 days", async () => {
    const t = await task({ brandId: utc, ownerId: staff });
    await prisma.notification.createMany({
      data: [
        { userId: staff, workspaceId: ws, brandId: utc, kind: "TASK_ASSIGNED", taskId: t.id, dedupeKey: "old", createdAt: new Date(NOW.getTime() - 91 * 86_400_000) },
        { userId: staff, workspaceId: ws, brandId: utc, kind: "TASK_ASSIGNED", taskId: t.id, dedupeKey: "new", createdAt: new Date(NOW.getTime() - 89 * 86_400_000) },
      ],
    });
    await pruneNotifications(NOW);
    expect(await keys()).toEqual(["new"]);
  });
});

describe("notification list and count", () => {
  const notify = (userId: string, taskId: string, brandId: string, key: string) =>
    prisma.notification.create({ data: { userId, workspaceId: ws, brandId, kind: "TASK_ASSIGNED", taskId, dedupeKey: key } });

  it("client sees no notifications for hidden tasks", async () => {
    const reviewed = await task({ brandId: east, reviewerId: client, title: "Reviewed" });
    const hidden = await task({ brandId: east, title: "Hidden" });
    await notify(client, reviewed.id, east, "c1");
    await notify(client, hidden.id, east, "c2");
    const page = await listNotifications(client, ws);
    expect(page.notifications.map((n) => n.taskTitle)).toEqual(["Reviewed"]);
    expect(page.notifications[0]).toMatchObject({ brandId: east, taskId: reviewed.id, kind: "TASK_ASSIGNED", readAt: null });
    expect(await countUnread(client, ws)).toBe(1);
  });

  it("count and list agree after losing access", async () => {
    const t = await task({ brandId: east, ownerId: creator });
    await notify(creator, t.id, east, "k1");
    expect(await countUnread(creator, ws)).toBe(1);
    expect((await listNotifications(creator, ws)).notifications).toHaveLength(1);
    await prisma.brandMember.delete({ where: { id: creatorGrant } });
    expect(await countUnread(creator, ws)).toBe(0);
    expect((await listNotifications(creator, ws)).notifications).toHaveLength(0);
  });

  it("groups unread by kind and business, pages read ones 20 at a time, and counts at most 100", async () => {
    const t = await task({ brandId: utc, ownerId: staff });
    const base = NOW.getTime();
    // 105 unread assignments on one business, 1 unread review request, 30 read assignments (older).
    await prisma.notification.createMany({
      data: [
        ...Array.from({ length: 105 }, (_, i) => ({ userId: staff, workspaceId: ws, brandId: utc, kind: "TASK_ASSIGNED" as const, taskId: t.id, dedupeKey: `p${i}`, createdAt: new Date(base + i * 1000) })),
        { userId: staff, workspaceId: ws, brandId: utc, kind: "REVIEW_REQUESTED" as const, taskId: t.id, dedupeKey: "r", createdAt: new Date(base - 1000) },
        ...Array.from({ length: 30 }, (_, i) => ({ userId: staff, workspaceId: ws, brandId: utc, kind: "TASK_ASSIGNED" as const, taskId: t.id, dedupeKey: `old${i}`, readAt: NOW, createdAt: new Date(base - 100_000 + i * 1000) })),
      ],
    });
    const first = await listNotifications(staff, ws);
    const [assigned, review, ...read] = first.notifications;
    expect([assigned!.kind, assigned!.count, assigned!.readAt]).toEqual(["TASK_ASSIGNED", 105, null]);
    expect(assigned!.createdAt).toBe(new Date(base + 104_000).toISOString());
    expect([review!.kind, review!.count]).toEqual(["REVIEW_REQUESTED", 1]);
    expect(read).toHaveLength(20);
    expect(read.every((n) => n.readAt && n.count === 1)).toBe(true);
    const second = await listNotifications(staff, ws, first.nextCursor!);
    expect(second.notifications).toHaveLength(10);
    expect(second.notifications[0]!.createdAt < read.at(-1)!.createdAt).toBe(true);
    expect(await countUnread(staff, ws)).toBe(100);
    // Opening the group marks it read up to the newest it showed; a newer one stays unread.
    await prisma.notification.create({ data: { userId: staff, workspaceId: ws, brandId: utc, kind: "TASK_ASSIGNED", taskId: t.id, dedupeKey: "late", createdAt: new Date(base + 200_000) } });
    expect(await markRead(staff, ws, { kind: "TASK_ASSIGNED", brandId: utc, upTo: assigned!.createdAt })).toBe(105);
    expect(await countUnread(staff, ws)).toBe(2);
  });
});
