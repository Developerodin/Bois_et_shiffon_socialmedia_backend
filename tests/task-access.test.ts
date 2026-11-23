import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const db = vi.hoisted(() => ({
  workspaceMember: { findMany: vi.fn(), findFirst: vi.fn() },
  brandMember: { findMany: vi.fn(), findFirst: vi.fn() },
  role: { findMany: vi.fn(async () => []) },
  workProject: { findFirst: vi.fn() },
  $queryRaw: vi.fn(),
}));
vi.mock("@/server/db/prisma", () => ({ prisma: db }));

import { canBeAssigned, commentVisibility, findVisibleTask, isSoleStaff, taskViewer, visibleTaskSql } from "@/server/tasks/access";
import type { PermissionKey } from "@/server/auth/permissions.catalog";
import type { prisma } from "@/server/db/prisma";

const tx = db as unknown as typeof prisma;
const scope = { workspaceId: "w1", brandId: "b1", userId: "u1" };
const viewer = (perms: PermissionKey[], clientReviewer = false) => taskViewer({ ...scope, perms: new Set(perms), clientReviewer });

beforeEach(() => {
  vi.clearAllMocks();
  db.workspaceMember.findFirst.mockResolvedValue(null);
  db.brandMember.findFirst.mockResolvedValue(null);
  db.workProject.findFirst.mockResolvedValue(null);
});

describe("visibleTaskSql", () => {
  it("staff see every task of the brand", () => {
    const s = visibleTaskSql(viewer(["brand.read", "tasks.read"]));
    expect(s.sql).toBe('(t."workspaceId" = ? AND t."brandId" = ?)');
    expect(s.values).toEqual(["w1", "b1"]);
  });

  it("client predicate has the reviewer-or-shared clause", () => {
    const s = visibleTaskSql(viewer(["brand.read", "tasks.read"], true), "x");
    expect(s.sql).toBe(
      '(x."workspaceId" = ? AND x."brandId" = ? AND (x."reviewerId" = ? OR EXISTS (SELECT 1 FROM "WorkProject" p WHERE p.id = x."workProjectId" AND p."clientVisible")))',
    );
    expect(s.values).toEqual(["w1", "b1", "u1"]);
  });

  it("no tasks.read is FALSE", () => {
    expect(visibleTaskSql(viewer(["brand.read"])).sql).toBe("FALSE");
    expect(visibleTaskSql(viewer(["brand.read"], true)).sql).toBe("FALSE");
  });

  it("refuses an alias that isn't a plain identifier", () => {
    expect(() => visibleTaskSql(viewer(["tasks.read"]), 't"; DROP')).toThrow();
  });

  it("findVisibleTask asks once with the predicate and returns null when nothing matches", async () => {
    db.$queryRaw.mockResolvedValueOnce([{ id: "k1" }]).mockResolvedValueOnce([]);
    const v = viewer(["tasks.read"], true);
    expect(await findVisibleTask(tx, v, "k1")).toEqual({ id: "k1" });
    expect(await findVisibleTask(tx, v, "k2")).toBeNull();
    const [strings, ...values] = db.$queryRaw.mock.calls[0]! as unknown as [TemplateStringsArray, ...unknown[]];
    const q = Prisma.sql(strings, ...values);
    expect(q.sql).toContain('t."reviewerId" = ?');
    expect(q.values).toEqual(["k1", "w1", "b1", "u1"]);
  });
});

describe("taskViewer and comments", () => {
  it("reads the route scope without another query", () => {
    expect(viewer(["tasks.read", "tasks.manage"])).toEqual({ ...scope, canRead: true, canManage: true, client: false });
    expect(db.workspaceMember.findFirst).not.toHaveBeenCalled();
  });

  it("client never sees internal comments", () => {
    expect(commentVisibility(viewer(["tasks.read"], true))).toEqual({ internal: false });
    expect(commentVisibility(viewer(["tasks.read"]))).toEqual({});
  });
});

describe("canBeAssigned", () => {
  const task = { reviewerId: null, workProjectId: "p1" };

  it("assignee without tasks.read is refused", async () => {
    expect(await canBeAssigned(tx, scope, "u2", task)).toBe(false);
    expect(db.workspaceMember.findFirst.mock.calls[0]![0].where).toMatchObject({ userId: "u2", roleRef: { permissions: { has: "tasks.read" } } });
  });

  it("staff with tasks.read can be given any task of the brand", async () => {
    db.brandMember.findFirst.mockImplementation(async ({ where }: { where: { role: { NOT?: unknown } } }) => (where.role.NOT ? { id: "g1" } : null));
    expect(await canBeAssigned(tx, scope, "u2", task)).toBe(true);
  });

  it("client assignee refused on a non-shared task", async () => {
    db.brandMember.findFirst.mockImplementation(async ({ where }: { where: { role: { NOT?: unknown } } }) => (where.role.NOT ? null : { id: "g1" }));
    expect(await canBeAssigned(tx, scope, "u2", task)).toBe(false);
    expect(db.workProject.findFirst.mock.calls[0]![0].where).toMatchObject({ id: "p1", workspaceId: "w1", brandId: "b1", clientVisible: true });
  });

  it("client assignee allowed on a shared task or one they review", async () => {
    db.brandMember.findFirst.mockImplementation(async ({ where }: { where: { role: { NOT?: unknown } } }) => (where.role.NOT ? null : { id: "g1" }));
    expect(await canBeAssigned(tx, scope, "u2", { reviewerId: "u2", workProjectId: null })).toBe(true);
    db.workProject.findFirst.mockResolvedValue({ id: "p1" });
    expect(await canBeAssigned(tx, scope, "u2", task)).toBe(true);
  });
});

describe("isSoleStaff", () => {
  const roleRef = (permissions: string[]) => ({ permissions });

  it("creator plus approver is not sole staff", async () => {
    db.workspaceMember.findMany.mockResolvedValue([{ userId: "u2", role: "EDITOR", roleRef: roleRef([]) }]);
    db.brandMember.findMany.mockResolvedValue([{ userId: "u2", role: { isSystem: true, slug: "approver", permissions: ["brand.read", "content.approve", "tasks.read"] } }]);
    expect(await isSoleStaff("w1", "b1", "u1")).toBe(false);
  });

  it("one staff member is sole staff", async () => {
    db.workspaceMember.findMany.mockResolvedValue([]);
    db.brandMember.findMany.mockResolvedValue([]);
    expect(await isSoleStaff("w1", "b1", "u1")).toBe(true);
  });

  it("a client reviewer alongside doesn't count as other staff", async () => {
    db.workspaceMember.findMany.mockResolvedValue([{ userId: "u2", role: "EDITOR", roleRef: roleRef([]) }]);
    db.brandMember.findMany.mockResolvedValue([{ userId: "u2", role: { isSystem: true, slug: "client-reviewer", permissions: ["brand.read", "tasks.read"] } }]);
    expect(await isSoleStaff("w1", "b1", "u1")).toBe(true);
  });
});
