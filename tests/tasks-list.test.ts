import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  task: { findMany: vi.fn() },
  contentItem: { findMany: vi.fn() },
  taskChecklistItem: { groupBy: vi.fn() },
  workspaceMember: { findMany: vi.fn() },
  brandMember: { findMany: vi.fn() },
  role: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
}));
const m = vi.hoisted(() => ({ people: vi.fn(), authorize: vi.fn() }));
vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/services/project-members", () => ({ listProjectPeople: m.people }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: m.authorize }));

import type { Prisma } from "@prisma/client";
import { decodeCursor, encodeCursor, listSql, listTasks, todayTasks } from "@/server/tasks/list";
import { taskViewer } from "@/server/tasks/access";
import type { PermissionKey } from "@/server/auth/permissions.catalog";
import { GET as tasksGet } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/tasks/route";

const scope = { workspaceId: "w1", brandId: "b1", userId: "u1", perms: new Set<PermissionKey>(["brand.read", "tasks.read"]), clientReviewer: false };
const v = taskViewer(scope);
const NOW = new Date("2026-11-23T12:00:00Z");
const text = (s: Prisma.Sql) => s.sql.replace(/\s+/g, " ");

const post = (o: Record<string, unknown>) => ({
  id: "c1", title: "Post", channel: "INSTAGRAM_POST", status: "DRAFT_REVIEW", scheduledFor: null, byHand: false, versions: [], publications: [], ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.$queryRaw.mockResolvedValue([]);
  db.task.findMany.mockResolvedValue([]);
  db.taskChecklistItem.groupBy.mockResolvedValue([]);
  db.workspaceMember.findMany.mockResolvedValue([]);
  db.brandMember.findMany.mockResolvedValue([]);
  db.role.findMany.mockResolvedValue([]);
  db.contentItem.findMany.mockResolvedValue([]);
  m.people.mockResolvedValue({ viaWorkspace: [], people: [], invitations: [] });
  m.authorize.mockResolvedValue(scope);
});

describe("cursor", () => {
  it("cursor round-trips", () => {
    const open = { due: "2026-11-30", id: "t1" };
    expect(decodeCursor("mine", encodeCursor("mine", open))).toEqual(open);
    expect(decodeCursor("open", encodeCursor("open", { due: "infinity", id: "t2" }))).toEqual({ due: "infinity", id: "t2" });
    const done = { completedAt: "2026-11-20T10:00:00.000Z", id: "t3" };
    expect(decodeCursor("done", encodeCursor("done", done))).toEqual(done);
    expect(encodeCursor("mine", open)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("cursor from another view → 400", async () => {
    expect(() => decodeCursor("approvals", encodeCursor("mine", { due: "2026-11-30", id: "t1" }))).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => decodeCursor("done", encodeCursor("mine", { due: "2026-11-30", id: "t1" }))).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => decodeCursor("mine", "not-a-cursor")).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => decodeCursor("mine", Buffer.from(JSON.stringify({ view: "mine", due: "2026-13-45", id: "t1" })).toString("base64url"))).toThrow(expect.objectContaining({ status: 400 }));
    const res = await tasksGet(new Request(`http://x/api?view=done&cursor=${encodeCursor("mine", { due: "2026-11-30", id: "t1" })}`), { params: Promise.resolve({ workspaceId: "w1", brandId: "b1" }) });
    expect(res.status).toBe(400);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("listSql", () => {
  it("listSql uses the open-status literal", () => {
    for (const view of ["mine", "approvals", "due-today", "overdue", "blocked", "open"] as const) {
      const sql = listSql(v, { view }, NOW);
      expect(text(sql)).toContain(`t.status IN ('TODO','IN_PROGRESS','IN_REVIEW')`);
      expect(sql.values).not.toContain("TODO");
      expect(text(sql)).toMatch(/ORDER BY COALESCE\(t\."dueOn", 'infinity'::date\), t\.id LIMIT \?$/);
      expect(sql.values.at(-1)).toBe(51);
    }
    const done = text(listSql(v, { view: "done" }, NOW));
    expect(done).not.toContain("t.status IN");
    expect(done).toContain(`t.status = 'DONE'`);
    expect(done).toMatch(/ORDER BY t\."completedAt" DESC, t\.id LIMIT \?$/);
  });

  it("filters and the keyset sit in the query as parameters", () => {
    const sql = listSql(v, { view: "mine", area: "WEBSITE", workProjectId: "p1", ownerId: "u2", cursor: encodeCursor("mine", { due: "2026-11-30", id: "t9" }) }, NOW);
    expect(text(sql)).toContain(`= ANY(t.areas)`);
    expect(text(sql)).toContain(`(COALESCE(t."dueOn", 'infinity'::date), t.id) > (`);
    expect(sql.values).toEqual(expect.arrayContaining(["w1", "b1", "u1", "WEBSITE", "p1", "u2", "2026-11-30", "t9"]));
  });
});

describe("listTasks", () => {
  it("view=mine posts on page 1 only", async () => {
    db.contentItem.findMany.mockResolvedValue([
      post({ id: "late", scheduledFor: new Date("2026-11-20T10:00:00Z") }),
      post({ id: "fine", scheduledFor: new Date("2026-11-30T10:00:00Z") }),
      post({ id: "blocked", status: "BLOCKED" }),
      post({ id: "failed", status: "APPROVED", publications: [{ status: "FAILED" }] }),
      post({ id: "checkBlocker", versions: [{ checks: [{ overall: "BLOCKER" }] }] }),
    ]);
    const first = await listTasks(scope, v, { view: "mine" }, NOW);
    expect(first.posts?.map((p) => p.id)).toEqual(["late", "blocked", "failed", "checkBlocker"]);
    expect(first.posts?.[0]).toEqual({ id: "late", title: "Post", channel: "INSTAGRAM_POST", status: "DRAFT_REVIEW", scheduledFor: "2026-11-20T10:00:00.000Z" });
    const args = db.contentItem.findMany.mock.calls[0]![0];
    expect(args.where).toMatchObject({ workspaceId: "w1", brandId: "b1", ownerId: "u1" });
    expect(args.where.status.in).toContain("DRAFT_REVIEW");
    expect(args.where.status.in).not.toContain("PUBLISHED");
    expect(args.take).toBe(20);

    db.contentItem.findMany.mockClear();
    const next = await listTasks(scope, v, { view: "mine", cursor: encodeCursor("mine", { due: "2026-11-30", id: "t1" }) }, NOW);
    expect(next.posts).toBeUndefined();
    const open = await listTasks(scope, v, { view: "open" }, NOW);
    expect(open.posts).toBeUndefined();
    expect(db.contentItem.findMany).not.toHaveBeenCalled();
  });

  it("51 rows → 50 tasks in SQL order and a cursor from the 50th", async () => {
    const page = Array.from({ length: 51 }, (_, i) => ({ id: `t${i}`, due: i < 49 ? "2026-11-30" : "infinity", completedAt: null }));
    db.$queryRaw.mockResolvedValue(page);
    // Prisma returns the rows in any order; the list keeps the SQL order.
    db.task.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => [...where.id.in].reverse().map((id) => taskRow(id)));
    const out = await listTasks(scope, v, { view: "open" }, NOW);
    expect(out.tasks.map((t) => t.id)).toEqual(page.slice(0, 50).map((r) => r.id));
    expect(decodeCursor("open", out.nextCursor!)).toEqual({ due: "infinity", id: "t49" });
  });
});

describe("todayTasks", () => {
  it("one count query, one row query, one read of the rows; a task in two groups shows in both", async () => {
    db.$queryRaw.mockImplementation(async (sql: Prisma.Sql) =>
      text(sql).includes("count(*)")
        ? [{ mine: 7, approvals: 1, blockers: 2 }]
        : [{ grp: "mine", id: "t1" }, { grp: "mine", id: "t2" }, { grp: "approvals", id: "t3" }, { grp: "blockers", id: "t1" }],
    );
    db.task.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => taskRow(id)));
    const out = await todayTasks(scope, v, NOW);
    expect(out.mine).toMatchObject({ count: 7, tasks: [{ id: "t1" }, { id: "t2" }] });
    expect(out.approvals).toMatchObject({ count: 1, tasks: [{ id: "t3" }] });
    expect(out.blockers).toMatchObject({ count: 2, tasks: [{ id: "t1" }] });
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
    expect(db.task.findMany).toHaveBeenCalledTimes(1);
    expect(db.task.findMany.mock.calls[0]![0].where.id.in).toEqual(["t1", "t2", "t3"]);
    const [counts, rows] = db.$queryRaw.mock.calls.map((c) => c[0] as Prisma.Sql);
    for (const sql of [counts!, rows!]) {
      expect(text(sql)).toContain(`t.status IN ('TODO','IN_PROGRESS','IN_REVIEW')`);
      expect(text(sql)).toContain(`LEFT JOIN "BrandProfile" bp`);
      expect(sql.values).toEqual(expect.arrayContaining(["UTC", NOW.toISOString()]));
    }
    expect(text(rows!).match(/UNION ALL/g)).toHaveLength(2);
  });
});

function taskRow(id: string) {
  return {
    id, workspaceId: "w1", brandId: "b1", title: id, description: null, status: "TODO", priority: "NORMAL", areas: ["GENERAL"],
    ownerId: null, reviewerId: null, createdById: null, dueOn: null, blockedReason: null, blockedOnId: null, workProjectId: null,
    contentItemId: null, url: null, changeKind: null, acceptanceCriteria: null, previewUrl: null, checkedLiveAt: null, checkedLiveById: null,
    auditReportId: null, findingKind: null, findingId: null, findingUrls: [], findingClearedAt: null, recheckOn: null, completedAt: null,
    requestId: null, createdAt: NOW, updatedAt: NOW, workProject: null, contentItem: null,
  };
}
