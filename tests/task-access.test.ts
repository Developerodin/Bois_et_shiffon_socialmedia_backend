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

import { canBeAssigned, clientCanSee, commentVisibility, findVisibleTask, isClientOn, isSoleStaff, managesTask, ownedBySql, taskViewer, visibleTaskSql, visibleTasksAcrossSql } from "@/server/tasks/access";
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
  it("tasks.all sees every task of the brand", () => {
    const s = visibleTaskSql(viewer(["brand.read", "tasks.read", "tasks.all"]));
    expect(s.sql).toBe('(t."workspaceId" = ? AND t."brandId" = ?)');
    expect(s.values).toEqual(["w1", "b1"]);
  });

  it("other staff see what they own (or their role owns), review, unblock or created", () => {
    const s = visibleTaskSql(viewer(["brand.read", "tasks.read", "tasks.manage"]));
    expect(s.sql).toBe(
      '(t."workspaceId" = ? AND t."brandId" = ? AND ((t."ownerId" = ? OR (t."ownerRoleId" IS NOT NULL AND EXISTS (SELECT 1 FROM "BrandMember" bm WHERE bm."brandId" = t."brandId" AND bm."userId" = ? AND bm."roleId" = t."ownerRoleId"))) OR t."reviewerId" = ? OR t."blockedOnId" = ? OR t."createdById" = ?))',
    );
    expect(s.values).toEqual(["w1", "b1", "u1", "u1", "u1", "u1", "u1"]);
  });

  it("a client's tasks.all is ignored: still the client clause", () => {
    const v = viewer(["brand.read", "tasks.read", "tasks.all"], true);
    expect(v.all).toBe(false);
    expect(visibleTaskSql(v).sql).toContain("clientVisible");
  });

  it("ownedBySql: the owner, or a holder of the owning role on the task's brand", () => {
    const s = ownedBySql("u1", "x");
    expect(s.sql).toBe('(x."ownerId" = ? OR (x."ownerRoleId" IS NOT NULL AND EXISTS (SELECT 1 FROM "BrandMember" bm WHERE bm."brandId" = x."brandId" AND bm."userId" = ? AND bm."roleId" = x."ownerRoleId")))');
    expect(() => ownedBySql("u1", "x; --")).toThrow();
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
    expect(viewer(["tasks.read", "tasks.manage"])).toEqual({ ...scope, canRead: true, canManage: true, all: false, client: false });
    expect(viewer(["tasks.read", "tasks.all"]).all).toBe(true);
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

describe("managesTask", () => {
  const perms = (...p: PermissionKey[]) => ({ userId: "u1", perms: new Set(p) });
  it("tasks.all manages any task; tasks.manage only one you own or created", () => {
    const other = { ownerId: "u2", createdById: "u3" };
    expect(managesTask(perms("tasks.all"), other)).toBe(true);
    expect(managesTask(perms("tasks.manage"), other)).toBe(false);
    expect(managesTask(perms("tasks.manage"), { ownerId: "u1", createdById: null })).toBe(true);
    expect(managesTask(perms("tasks.manage"), { ownerId: null, createdById: "u1" })).toBe(true);
    expect(managesTask(perms("tasks.read"), { ownerId: "u1", createdById: "u1" })).toBe(false);
    expect(managesTask({ ...perms("tasks.all"), clientReviewer: true }, other)).toBe(false);
  });
});

describe("visibleTasksAcrossSql per brand", () => {
  const sqlFor = async (own: string[], grants: { brandId: string; role: { isSystem: boolean; slug: string; permissions: string[] } }[]) => {
    db.workspaceMember.findUnique.mockResolvedValue({ roleRef: { permissions: own } });
    db.brandMember.findMany.mockResolvedValue(grants);
    return visibleTasksAcrossSql("u1", "w1");
  };
  const grant = (brandId: string, permissions: string[], slug = "custom") => ({ brandId, role: { isSystem: slug !== "custom", slug, permissions } });

  it("a workspace role with tasks.all sees every brand whole; without it, its own tasks there", async () => {
    expect((await sqlFor(["brand.read", "tasks.read", "tasks.all", "content.approve"], [])).sql).toContain("(TRUE OR (FALSE AND");
    const mine = await sqlFor(["brand.read", "tasks.read"], []);
    expect(mine.sql).toContain('t."createdById" = ?');
    expect(mine.sql).toContain("(FALSE OR (TRUE AND");
  });

  it("a member: brands granted tasks.all whole, other staff grants their own tasks", async () => {
    const s = await sqlFor([], [grant("b1", ["brand.read", "tasks.read", "tasks.all"]), grant("b2", ["brand.read", "tasks.read"])]);
    expect(s.sql).toContain('(t."brandId" IN (?) OR (t."brandId" IN (?) AND ((t."ownerId" = ?');
    expect(s.values.slice(2, 4)).toEqual(["b1", "b2"]);
  });

  it("a client grant's tasks.all is ignored (client clause)", async () => {
    const s = await sqlFor(["brand.read"], [grant("b2", ["brand.read", "tasks.read", "tasks.all"], "client-reviewer")]);
    expect(s.sql).toContain("(FALSE OR (FALSE AND");
    expect(s.sql).toContain('p."clientVisible"');
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
