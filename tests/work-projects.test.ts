import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

type Where = { where: Record<string, unknown> };
const db = vi.hoisted(() => {
  const d = {
    workProject: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    workProjectMilestone: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), aggregate: vi.fn() },
    task: { groupBy: vi.fn(), findFirst: vi.fn() },
    campaign: { findFirst: vi.fn() },
    contentItem: { findMany: vi.fn() },
    auditEvent: { create: vi.fn() },
    workspaceMember: { findFirst: vi.fn(), findMany: vi.fn() },
    brandMember: { findFirst: vi.fn(), findMany: vi.fn() },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(),
  };
  d.$transaction.mockImplementation(async (fn: (tx: typeof d) => unknown) => fn(d));
  return d;
});
const m = vi.hoisted(() => ({ people: vi.fn(), authorize: vi.fn() }));
vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/services/project-members", () => ({ listProjectPeople: m.people }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: m.authorize }));

import { AccessDeniedError } from "@/server/auth/errors";
import type { PermissionKey } from "@/server/auth/permissions.catalog";
import { taskViewer } from "@/server/tasks/access";
import { addMilestone, createProject, getProject, listProjects, patchMilestone, patchProject } from "@/server/tasks/projects";
import { POST as projectsPost } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/work-projects/route";
import { PATCH as projectPatch } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/work-projects/[projectId]/route";
import { POST as milestonesPost } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/work-projects/[projectId]/milestones/route";
import { DELETE as milestoneDelete, PATCH as milestonePatch } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/work-projects/[projectId]/milestones/[milestoneId]/route";

const MANAGER: PermissionKey[] = ["brand.read", "tasks.read", "tasks.manage"];
const scopeOf = (perms: PermissionKey[] = MANAGER, clientReviewer = false) => ({ workspaceId: "w1", brandId: "b1", userId: "u1", perms: new Set(perms), clientReviewer });
let scope = scopeOf();
const v = () => taskViewer(scope);

let staff = new Set(["u1", "u2"]);
const project = (o: Record<string, unknown> = {}) => ({
  id: "p1", workspaceId: "w1", brandId: "b1", name: "Launch", description: null, ownerId: null, status: "ACTIVE", startsOn: null, dueOn: null,
  campaignId: null, clientVisible: false, requestId: null, createdAt: new Date("2026-11-23T10:00:00Z"), updatedAt: new Date("2026-11-23T10:00:00Z"),
  campaign: null, milestones: [], ...o,
});
const req = (method: string, body?: unknown) => new Request("http://x/api", { method, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (o: Record<string, string> = {}) => ({ params: Promise.resolve({ workspaceId: "w1", brandId: "b1", projectId: "p1", milestoneId: "m1", ...o }) });

beforeEach(() => {
  vi.clearAllMocks();
  scope = scopeOf();
  staff = new Set(["u1", "u2"]);
  db.workProject.findFirst.mockResolvedValue(project());
  db.workProject.findMany.mockResolvedValue([]);
  db.workProject.create.mockImplementation(async ({ data }: { data: object }) => project({ ...data }));
  db.workProject.update.mockImplementation(async ({ data }: { data: object }) => project({ ...data }));
  db.workProjectMilestone.findFirst.mockResolvedValue({ id: "m1", workProjectId: "p1", title: "Shoot", dueOn: new Date("2026-12-01T00:00:00Z"), doneAt: null, position: 0 });
  db.workProjectMilestone.findMany.mockResolvedValue([]);
  db.workProjectMilestone.aggregate.mockResolvedValue({ _max: { position: null } });
  db.workProjectMilestone.create.mockImplementation(async ({ data }: { data: object }) => ({ id: "m1", doneAt: null, ...data }));
  db.workProjectMilestone.update.mockImplementation(async ({ data }: { data: object }) => ({ id: "m1", workProjectId: "p1", title: "Shoot", dueOn: new Date("2026-12-01T00:00:00Z"), doneAt: null, position: 0, ...data }));
  db.task.groupBy.mockResolvedValue([]);
  db.task.findFirst.mockResolvedValue(null);
  db.campaign.findFirst.mockResolvedValue(null);
  db.contentItem.findMany.mockResolvedValue([]);
  db.auditEvent.create.mockResolvedValue({ id: "a1" });
  db.$queryRaw.mockResolvedValue([]);
  db.workspaceMember.findFirst.mockImplementation(async ({ where }: Where) => (staff.has(where.userId as string) ? { id: "m" } : null));
  db.workspaceMember.findMany.mockResolvedValue([]);
  db.brandMember.findFirst.mockResolvedValue(null);
  db.brandMember.findMany.mockResolvedValue([]);
  m.people.mockResolvedValue({ viaWorkspace: [], people: [], invitations: [] });
  m.authorize.mockImplementation(async (_r: Request, _p: unknown, key: PermissionKey) => {
    if (!scope.perms.has(key)) throw new AccessDeniedError(`Missing permission ${key}`);
    return scope;
  });
});

describe("createProject", () => {
  it("without tasks.all: no project made shared, archived or owned by someone else (403); owned by you is fine", async () => {
    for (const body of [{ clientVisible: true }, { status: "ARCHIVED" as const }, { ownerId: "u2" }]) {
      await expect(createProject(scope, v(), { name: "Launch", ...body })).rejects.toMatchObject({ status: 403 });
    }
    expect(db.workProject.create).not.toHaveBeenCalled();
    await createProject(scope, v(), { name: "Launch", ownerId: "u1" });
    expect(db.workProject.create).toHaveBeenCalledTimes(1);
  });

  it("campaign of another brand → 400", async () => {
    const err = await createProject(scope, v(), { name: "Launch", campaignId: "c9" }).catch((e) => e);
    expect(err).toMatchObject({ status: 400, message: "Invalid campaignId" });
    expect(db.campaign.findFirst.mock.calls[0]![0].where).toMatchObject({ id: "c9", workspaceId: "w1", brandId: "b1" });
    expect(db.workProject.create).not.toHaveBeenCalled();
  });

  it("same campaign twice in a brand → 409", async () => {
    db.campaign.findFirst.mockResolvedValue({ id: "c1" });
    db.workProject.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("Unique", { code: "P2002", clientVersion: "x" }));
    const err = await createProject(scope, v(), { name: "Launch", campaignId: "c1" }).catch((e) => e);
    expect(err).toMatchObject({ status: 409 });
  });

  it("foreign project owner → 400", async () => {
    scope = scopeOf([...MANAGER, "tasks.all"]);
    const err = await createProject(scope, v(), { name: "Launch", ownerId: "u9" }).catch((e) => e);
    expect(err).toMatchObject({ status: 400, message: "Invalid ownerId" });
    expect(db.workProject.create).not.toHaveBeenCalled();
  });

  it("writes the project and an audit event", async () => {
    scope = scopeOf([...MANAGER, "tasks.all"]);
    await createProject(scope, v(), { name: "Launch", ownerId: "u2", dueOn: "2026-12-20" });
    expect(db.workProject.create.mock.calls[0]![0].data).toMatchObject({ workspaceId: "w1", brandId: "b1", name: "Launch", ownerId: "u2", dueOn: new Date("2026-12-20T00:00:00Z") });
    expect(db.auditEvent.create.mock.calls[0]![0].data).toMatchObject({ action: "workProject.create", entityType: "WorkProject", entityId: "p1" });
  });
});

describe("listProjects", () => {
  it("progress ignores cancelled, and counts only the viewer's visible tasks", async () => {
    db.workProject.findMany.mockResolvedValue([project()]);
    db.$queryRaw.mockResolvedValue([
      { workProjectId: "p1", status: "DONE", count: 2 },
      { workProjectId: "p1", status: "TODO", count: 1 },
      { workProjectId: "p1", status: "CANCELLED", count: 3 },
    ]);
    const { projects } = await listProjects(scope, v(), {});
    expect(projects[0]!.progress).toEqual({ done: 2, total: 3 });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    const parts = (db.$queryRaw.mock.calls[0] as unknown[]).slice(1);
    expect(parts.some((x) => String((x as { sql?: string })?.sql).includes(`t."workspaceId" = ?`))).toBe(true);
  });

  it("client lists only shared projects", async () => {
    scope = scopeOf(["brand.read", "tasks.read"], true);
    await listProjects(scope, v(), {});
    expect(db.workProject.findMany.mock.calls[0]![0].where).toMatchObject({ workspaceId: "w1", brandId: "b1", clientVisible: true });
  });

  it("a cursor that isn't a project this viewer sees on the brand → 400, nothing listed", async () => {
    db.workProject.findFirst.mockResolvedValue(null);
    await expect(listProjects(scope, v(), { cursor: "p9" })).rejects.toMatchObject({ status: 400, message: "Invalid cursor" });
    expect(db.workProject.findFirst.mock.calls[0]![0].where).toMatchObject({ id: "p9", workspaceId: "w1", brandId: "b1" });
    expect(db.workProject.findMany).not.toHaveBeenCalled();
  });

  it("a cursor on the brand pages from it", async () => {
    db.workProject.findFirst.mockResolvedValue({ id: "p1" });
    await listProjects(scope, v(), { cursor: "p1" });
    expect(db.workProject.findMany.mock.calls[0]![0]).toMatchObject({ cursor: { id: "p1" }, skip: 1 });
  });

  it("staff list is not limited to shared projects", async () => {
    await listProjects(scope, v(), {});
    expect(db.workProject.findMany.mock.calls[0]![0].where).not.toHaveProperty("clientVisible");
  });
});

describe("getProject", () => {
  it("client GET of an unshared project → 404", async () => {
    scope = scopeOf(["brand.read", "tasks.read"], true);
    db.workProject.findFirst.mockImplementation(async ({ where }: Where) => (where.clientVisible === true ? null : project()));
    const err = await getProject(scope, v(), "p1").catch((e) => e);
    expect(err).toMatchObject({ status: 404 });
  });

  it("counts tasks through the visibility predicate", async () => {
    db.$queryRaw.mockResolvedValue([{ status: "DONE", count: 1 }, { status: "TODO", count: 2 }]);
    const dto = await getProject(scope, v(), "p1");
    expect(dto.taskCounts).toEqual({ DONE: 1, TODO: 2 });
    expect(dto.progress).toEqual({ done: 1, total: 3 });
    const parts = (db.$queryRaw.mock.calls[0] as unknown[]).slice(1);
    expect(parts.some((x) => String((x as { sql?: string })?.sql).includes(`t."workspaceId" = ?`))).toBe(true);
  });
});

describe("patchProject", () => {
  beforeEach(() => {
    scope = scopeOf([...MANAGER, "tasks.all"]);
  });

  it("without tasks.all: no sharing, archiving or changing the owner (403); other fields are fine", async () => {
    scope = scopeOf();
    for (const body of [{ clientVisible: true }, { status: "ARCHIVED" }, { ownerId: "u2" }]) {
      await expect(patchProject(scope, v(), "p1", body)).rejects.toMatchObject({ status: 403 });
    }
    expect(db.workProject.update).not.toHaveBeenCalled();
    await patchProject(scope, v(), "p1", { name: "Relaunch" });
    expect(db.workProject.update.mock.calls[0]![0].data).toEqual({ name: "Relaunch" });
  });

  it("without tasks.all: owner set to yourself, as on create; cleared only from yourself", async () => {
    scope = scopeOf();
    db.workProject.findFirst.mockResolvedValue(project({ ownerId: "u2" }));
    await expect(patchProject(scope, v(), "p1", { ownerId: null })).rejects.toMatchObject({ status: 403 });
    await patchProject(scope, v(), "p1", { ownerId: "u1" });
    expect(db.workProject.update.mock.calls[0]![0].data).toEqual({ ownerId: "u1" });
    db.workProject.findFirst.mockResolvedValue(project({ ownerId: "u1" }));
    await patchProject(scope, v(), "p1", { ownerId: null });
    expect(db.workProject.update.mock.calls[1]![0].data).toEqual({ ownerId: null });
  });

  it("cannot hide a project a client is reviewing in", async () => {
    db.workProject.findFirst.mockResolvedValue(project({ clientVisible: true }));
    db.brandMember.findMany.mockResolvedValue([{ userId: "u5" }]);
    db.task.findFirst.mockResolvedValue({ id: "t1" });
    const err = await patchProject(scope, v(), "p1", { clientVisible: false }).catch((e) => e);
    expect(err).toMatchObject({ status: 409, message: "A client reviews tasks in this project" });
    expect(db.task.findFirst.mock.calls[0]![0].where).toMatchObject({ workProjectId: "p1" });
    expect(db.workProject.update).not.toHaveBeenCalled();
  });

  it("hides a project no client works in", async () => {
    db.workProject.findFirst.mockResolvedValue(project({ clientVisible: true }));
    await patchProject(scope, v(), "p1", { clientVisible: false });
    expect(db.workProject.update.mock.calls[0]![0].data).toEqual({ clientVisible: false });
    expect(db.auditEvent.create.mock.calls[0]![0].data).toMatchObject({ action: "workProject.update" });
  });

  it("archives through status", async () => {
    await patchProject(scope, v(), "p1", { status: "ARCHIVED" });
    expect(db.workProject.update.mock.calls[0]![0].data).toEqual({ status: "ARCHIVED" });
  });
});

describe("milestones", () => {
  it("another project's milestone → 404", async () => {
    db.workProjectMilestone.findFirst.mockResolvedValue(null);
    const err = await patchMilestone(scope, v(), "p1", "m9", { done: true }).catch((e) => e);
    expect(err).toMatchObject({ status: 404 });
    expect(db.workProjectMilestone.findFirst.mock.calls[0]![0].where).toEqual({ id: "m9", workProjectId: "p1" });
  });

  it("a milestone of another brand's project → 404", async () => {
    db.workProject.findFirst.mockResolvedValue(null);
    const err = await addMilestone(scope, v(), "p9", { title: "Shoot", dueOn: "2026-12-01" }).catch((e) => e);
    expect(err).toMatchObject({ status: 404 });
    expect(db.workProject.findFirst.mock.calls[0]![0].where).toMatchObject({ id: "p9", workspaceId: "w1", brandId: "b1" });
  });

  it("adds at the end and audits", async () => {
    db.workProjectMilestone.aggregate.mockResolvedValue({ _max: { position: 2 } });
    const dto = await addMilestone(scope, v(), "p1", { title: "Shoot", dueOn: "2026-12-01" });
    expect(dto).toMatchObject({ title: "Shoot", dueOn: "2026-12-01", position: 3 });
    expect(db.auditEvent.create.mock.calls[0]![0].data).toMatchObject({ action: "workProject.milestone.add", entityId: "p1" });
  });
});

describe("routes need tasks.manage to write", () => {
  const READER: PermissionKey[] = ["brand.read", "tasks.read"];
  it("POST work-projects → 403", async () => {
    scope = scopeOf(READER);
    expect((await projectsPost(req("POST", { name: "X" }), params())).status).toBe(403);
  });
  it("PATCH work-projects/:id → 403", async () => {
    scope = scopeOf(READER);
    expect((await projectPatch(req("PATCH", { name: "X" }), params())).status).toBe(403);
  });
  it("POST milestones → 403", async () => {
    scope = scopeOf(READER);
    expect((await milestonesPost(req("POST", { title: "X", dueOn: "2026-12-01" }), params())).status).toBe(403);
  });
  it("PATCH milestones/:id → 403", async () => {
    scope = scopeOf(READER);
    expect((await milestonePatch(req("PATCH", { done: true }), params())).status).toBe(403);
  });
  it("DELETE milestones/:id → 403", async () => {
    scope = scopeOf(READER);
    expect((await milestoneDelete(req("DELETE"), params())).status).toBe(403);
  });
});
