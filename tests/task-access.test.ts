import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const db = vi.hoisted(() => ({
  workspaceMember: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
  brandMember: { findMany: vi.fn(), findFirst: vi.fn() },
  role: { findMany: vi.fn(async () => []) },
  workProject: { findFirst: vi.fn() },
  $queryRaw: vi.fn(),
}));
vi.mock("@/server/db/prisma", () => ({ prisma: db }));

import { canBeAssigned, clientCanSee, commentVisibility, findVisibleTask, isClientOn, isSoleStaff, taskViewer, visibleTaskSql, visibleTasksAcrossSql } from "@/server/tasks/access";
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
      '(x."workspaceId" = ? AND x."brandId" = ? AND (x."reviewerId" = ? OR EXISTS (SELECT 1 FROM "WorkProject" p WHERE p.id = x."workProjectId" AND p."brandId" = x."brandId" AND p."clientVisible")))',
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

type Where = { where: Record<string, unknown> };
/** Who holds what: staff read tasks (workspace role or a staff grant), clients hold a client grant, approvers approve through their workspace role. */
function people({ staff = [] as string[], clients = [] as string[], approvers = [] as string[], clientPerms = ["brand.read", "tasks.read"] } = {}) {
  db.workspaceMember.findFirst.mockImplementation(async ({ where }: Where) => {
    const has = (where.roleRef as { permissions: { has: string } }).permissions.has;
    const user = where.userId as string;
    return (has === "content.approve" ? approvers : staff).includes(user) ? { id: "m" } : null;
  });
  db.brandMember.findFirst.mockImplementation(async ({ where }: Where) =>
    (where.role as { NOT?: unknown }).NOT ? null : clients.includes(where.userId as string) ? { role: { permissions: clientPerms } } : null,
  );
}

describe("isClientOn", () => {
  it("a client grant without content.approve from the workspace role is a client", async () => {
    people({ clients: ["u5"] });
    expect(await isClientOn(tx, scope, "u5")).toBe(true);
    expect(db.brandMember.findFirst.mock.calls[0]![0].where).toMatchObject({ workspaceId: "w1", brandId: "b1", userId: "u5", role: { isSystem: true, slug: "client-reviewer" } });
  });

  it("a client grant held by someone whose workspace role approves is staff; no client grant is no client", async () => {
    people({ clients: ["u5"], approvers: ["u5"] });
    expect(await isClientOn(tx, scope, "u5")).toBe(false);
    expect(await isClientOn(tx, scope, "u2")).toBe(false);
  });
});

describe("clientCanSee", () => {
  it("a shared project of the same brand, or a client reviewer", async () => {
    people({ clients: ["u5"], staff: ["u2"] });
    expect(await clientCanSee(tx, scope, { reviewerId: "u5", workProjectId: null })).toBe(true);
    expect(await clientCanSee(tx, scope, { reviewerId: "u2", workProjectId: null })).toBe(false);
    expect(await clientCanSee(tx, scope, { reviewerId: null, workProjectId: "p1" })).toBe(false);
    expect(db.workProject.findFirst.mock.calls[0]![0].where).toEqual({ id: "p1", workspaceId: "w1", brandId: "b1", clientVisible: true });
    db.workProject.findFirst.mockResolvedValue({ id: "p1" });
    expect(await clientCanSee(tx, scope, { reviewerId: null, workProjectId: "p1" })).toBe(true);
  });

  it("a reviewer with a client grant who approves as staff doesn't make the task client-visible", async () => {
    people({ clients: ["u5"], approvers: ["u5"] });
    expect(await clientCanSee(tx, scope, { reviewerId: "u5", workProjectId: null })).toBe(false);
  });
});

describe("canBeAssigned", () => {
  const task = { reviewerId: null, workProjectId: "p1" };

  it("assignee without tasks.read is refused", async () => {
    people();
    expect(await canBeAssigned(tx, scope, "u2", task)).toBe(false);
    expect(db.workspaceMember.findFirst.mock.calls.map((c) => c[0].where)).toContainEqual(expect.objectContaining({ userId: "u2", roleRef: { permissions: { has: "tasks.read" } } }));
  });

  it("staff with tasks.read can be given any task of the brand", async () => {
    people({ staff: ["u2"] });
    expect(await canBeAssigned(tx, scope, "u2", task)).toBe(true);
  });

  it("client assignee refused on a non-shared task", async () => {
    people({ clients: ["u2"] });
    expect(await canBeAssigned(tx, scope, "u2", task)).toBe(false);
    expect(db.workProject.findFirst.mock.calls[0]![0].where).toMatchObject({ id: "p1", workspaceId: "w1", brandId: "b1", clientVisible: true });
  });

  it("client assignee allowed on a shared task or one they review", async () => {
    people({ clients: ["u2"] });
    expect(await canBeAssigned(tx, scope, "u2", { reviewerId: "u2", workProjectId: null })).toBe(true);
    db.workProject.findFirst.mockResolvedValue({ id: "p1" });
    expect(await canBeAssigned(tx, scope, "u2", task)).toBe(true);
  });

  it("a client whose workspace role reads tasks is still a client (as in taskViewer)", async () => {
    people({ staff: ["u2"], clients: ["u2"] });
    expect(await canBeAssigned(tx, scope, "u2", task)).toBe(false);
  });

  it("a client grant without tasks.read is refused", async () => {
    people({ clients: ["u2"], clientPerms: ["brand.read"] });
    expect(await canBeAssigned(tx, scope, "u2", { reviewerId: "u2", workProjectId: null })).toBe(false);
  });
});

describe("visibleTasksAcrossSql", () => {
  it("leaves out archived brands", async () => {
    db.workspaceMember.findUnique.mockResolvedValue({ roleRef: { permissions: ["brand.read", "tasks.read"] } });
    db.brandMember.findMany.mockResolvedValue([]);
    const s = await visibleTasksAcrossSql("u1", "w1");
    expect(s.sql).toContain(`EXISTS (SELECT 1 FROM "Brand" b WHERE b.id = t."brandId" AND b."workspaceId" = ? AND b.status <> 'ARCHIVED')`);
  });

  it("a client grant without content.approve from the workspace role reads that brand as a client", async () => {
    db.workspaceMember.findUnique.mockResolvedValue({ roleRef: { permissions: ["brand.read", "tasks.read"] } });
    db.brandMember.findMany.mockResolvedValue([{ brandId: "b2", role: { isSystem: true, slug: "client-reviewer", permissions: ["brand.read", "tasks.read"] } }]);
    const s = await visibleTasksAcrossSql("u1", "w1");
    expect(s.sql).toContain('t."brandId" NOT IN (?)');
    expect(s.sql).toContain('p."brandId" = t."brandId"');
    db.workspaceMember.findUnique.mockResolvedValue({ roleRef: { permissions: ["brand.read", "tasks.read", "content.approve"] } });
    expect((await visibleTasksAcrossSql("u1", "w1")).sql).not.toContain("NOT IN");
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
