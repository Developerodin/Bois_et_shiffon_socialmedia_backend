import { beforeEach, describe, expect, it, vi } from "vitest";

type Where = { where: Record<string, unknown> };
const db = vi.hoisted(() => {
  const d = {
    task: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    workProject: { findFirst: vi.fn() },
    taskComment: { findFirst: vi.fn() },
    contentItem: { findFirst: vi.fn() },
    auditReport: { findFirst: vi.fn() },
    taskChecklistItem: { groupBy: vi.fn(), findMany: vi.fn() },
    taskAttachment: { findMany: vi.fn() },
    auditEvent: { create: vi.fn() },
    notification: { createMany: vi.fn() },
    workspaceMember: { findFirst: vi.fn(), findMany: vi.fn() },
    brandMember: { findFirst: vi.fn(), findMany: vi.fn(async () => []) },
    role: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(),
  };
  d.$transaction.mockImplementation(async (fn: (tx: typeof d) => unknown) => fn(d));
  return d;
});
const m = vi.hoisted(() => ({ people: vi.fn(), authorize: vi.fn(), signed: vi.fn(async (key: string) => `https://signed/${key}`) }));
vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/storage/media", async (orig) => ({ ...(await orig<object>()), signedMediaUrl: m.signed }));
vi.mock("@/server/services/project-members", () => ({ listProjectPeople: m.people }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: m.authorize }));
vi.mock("@/server/auth/rate-limit", async (orig) => ({ ...(await orig<object>()), hitRateLimit: vi.fn(async () => ({ allowed: true, count: 1 })) }));

import { AccessDeniedError } from "@/server/auth/errors";
import { brandOwners } from "@/server/services/publishing";
import { createTask, getTask, patchTask, TaskInput, toTaskDtos } from "@/server/tasks/service";
import { MANAGE_PATCH_FIELDS } from "@/shared";
import { TaskError } from "@/server/tasks/errors";
import { notifyTx } from "@/server/notifications/tasks";
import { taskViewer } from "@/server/tasks/access";
import type { PermissionKey } from "@/server/auth/permissions.catalog";
import { POST as tasksPost } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/tasks/route";
import { GET as taskGet, PATCH as taskPatch } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/tasks/[taskId]/route";

const MANAGER: PermissionKey[] = ["brand.read", "tasks.read", "tasks.manage"];
const scopeOf = (perms: PermissionKey[] = MANAGER) => ({ workspaceId: "w1", brandId: "b1", userId: "u1", perms: new Set(perms), clientReviewer: false });
const scope = scopeOf();
const v = taskViewer(scope);
const RID = "6f1c2c1e-6a43-4c1b-9a3e-2f1d5b7c8a90";

// Staff with tasks.read on the brand (through the workspace role): u1, u2, u3.
let staff = new Set(["u1", "u2", "u3"]);
const row = (o: Record<string, unknown> = {}) => ({
  id: "t1", workspaceId: "w1", brandId: "b1", title: "Fix menu", description: null, status: "TODO", priority: "NORMAL", areas: ["WEBSITE"],
  ownerId: "u1", reviewerId: null, createdById: "u1", dueOn: new Date("2026-11-30T00:00:00Z"), blockedReason: null, blockedOnId: null,
  workProjectId: null, contentItemId: null, url: null, changeKind: null, acceptanceCriteria: null, previewUrl: null, checkedLiveAt: null,
  checkedLiveById: null, auditReportId: null, findingKind: null, findingId: null, findingUrls: [], findingClearedAt: null, recheckOn: null,
  completedAt: null, requestId: null, createdAt: new Date("2026-11-23T10:00:00Z"), updatedAt: new Date("2026-11-23T10:00:00Z"),
  workProject: null, contentItem: null, ...o,
});
const people = () => ({
  viaWorkspace: [
    { userId: "u1", name: "Ana", email: "ana@x.com", role: "Owner", active: true },
    { userId: "u2", name: "Bob", email: "bob@x.com", role: "Admin", active: true },
    { userId: "u4", name: "Dee", email: "dee@x.com", role: "Reader", active: true },
  ],
  people: [
    { id: "g1", userId: "u3", name: "Cy", email: "cy@x.com", role: { id: "r", name: "Creator", permissions: ["brand.read", "tasks.read"] }, active: true, client: false },
    { id: "g2", userId: "u5", name: "Cli", email: "cli@x.com", role: { id: "c", name: "Client reviewer", permissions: ["brand.read", "tasks.read"] }, active: true, client: true },
  ],
  invitations: [],
});
const updated = () => db.task.update.mock.calls[0]![0].data as Record<string, unknown>;
const audits = () => db.auditEvent.create.mock.calls.map((c) => c[0].data as Record<string, unknown>);
const input = (o: Record<string, unknown> = {}) => ({ title: "Fix menu", areas: ["WEBSITE" as const], priority: "NORMAL" as const, ...o });
const req = (method: string, body?: unknown) => new Request("http://x/api", { method, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (o: Record<string, string> = {}) => ({ params: Promise.resolve({ workspaceId: "w1", brandId: "b1", taskId: "t1", ...o }) });

beforeEach(() => {
  vi.clearAllMocks();
  scope.perms = new Set(MANAGER); // tests that narrow it can't leak, even when an assertion fails first
  staff = new Set(["u1", "u2", "u3"]);
  db.$queryRaw.mockResolvedValue([{ id: "t1" }]);
  db.task.findFirst.mockResolvedValue(null);
  db.task.findUnique.mockResolvedValue(row());
  db.task.create.mockImplementation(async ({ data }: { data: object }) => ({ id: "t1", ...data }));
  db.task.update.mockResolvedValue({});
  db.workProject.findFirst.mockResolvedValue(null);
  db.taskComment.findFirst.mockResolvedValue(null);
  db.contentItem.findFirst.mockResolvedValue(null);
  db.auditReport.findFirst.mockResolvedValue(null);
  db.taskChecklistItem.groupBy.mockResolvedValue([]);
  db.taskChecklistItem.findMany.mockResolvedValue([]);
  db.taskAttachment.findMany.mockResolvedValue([]);
  db.auditEvent.create.mockResolvedValue({ id: "a1" });
  db.workspaceMember.findFirst.mockImplementation(async ({ where }: Where) => (staff.has(where.userId as string) ? { id: "m" } : null));
  db.workspaceMember.findMany.mockImplementation(async () => [...staff].filter((u) => u !== "u3").map((userId) => ({ userId, role: "ADMIN", roleRef: { permissions: ["brand.read", "tasks.read"] } })));
  db.brandMember.findFirst.mockResolvedValue(null);
  m.people.mockResolvedValue(people());
  m.authorize.mockImplementation(async (_r: Request, _p: unknown, key: PermissionKey) => {
    if (!scope.perms.has(key)) throw new AccessDeniedError(`Missing permission ${key}`);
    return scope;
  });
});

describe("TaskInput", () => {
  it("has exactly the manager's PATCH fields, plus requestId", () => {
    expect(Object.keys(TaskInput.shape).filter((k) => k !== "requestId").sort()).toEqual([...MANAGE_PATCH_FIELDS].sort());
  });
});

describe("createTask", () => {
  it("same requestId returns the same task", async () => {
    db.task.findFirst.mockResolvedValue({ id: "t1" });
    const dto = await createTask(scope, v, input({ requestId: RID }));
    expect(dto.id).toBe("t1");
    expect(db.task.create).not.toHaveBeenCalled();
    expect(db.task.findFirst.mock.calls[0]![0].where).toMatchObject({ workspaceId: "w1", brandId: "b1", requestId: RID });
    expect(db.$executeRaw).toHaveBeenCalled();
  });

  it("foreign workProjectId → 400 on create", async () => {
    const err = await createTask(scope, v, input({ workProjectId: "p9" })).catch((e) => e);
    expect(err).toBeInstanceOf(TaskError);
    expect(err).toMatchObject({ status: 400, message: "Invalid workProjectId" });
    expect(db.workProject.findFirst.mock.calls[0]![0].where).toMatchObject({ id: "p9", workspaceId: "w1", brandId: "b1" });
    expect(db.task.create).not.toHaveBeenCalled();
  });

  it("an owner who can't see tasks → 400", async () => {
    const err = await createTask(scope, v, input({ ownerId: "u4" })).catch((e) => e);
    expect(err).toMatchObject({ status: 400, message: "Invalid ownerId" });
  });

  it("create with another owner notifies them; audit task.create written", async () => {
    await createTask(scope, v, input({ ownerId: "u2", dueOn: "2026-11-30" }));
    const data = db.task.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ workspaceId: "w1", brandId: "b1", createdById: "u1", ownerId: "u2", dueOn: new Date("2026-11-30T00:00:00Z") });
    expect(audits()[0]).toMatchObject({ action: "task.create", entityType: "Task", entityId: "t1", actorUserId: "u1", workspaceId: "w1", brandId: "b1" });
    expect(db.notification.createMany).toHaveBeenCalledWith({
      data: [{ userId: "u2", workspaceId: "w1", brandId: "b1", kind: "TASK_ASSIGNED", taskId: "t1", actorId: "u1", dedupeKey: "TASK_ASSIGNED:u2:a1" }],
      skipDuplicates: true,
    });
  });

  it("create for yourself notifies nobody", async () => {
    await createTask(scope, v, input({ ownerId: "u1" }));
    expect(db.notification.createMany).not.toHaveBeenCalled();
  });
});

describe("notifyTx", () => {
  it("skips the actor", async () => {
    await notifyTx(db as never, { userId: "u1", workspaceId: "w1", brandId: "b1", kind: "REVIEW_REQUESTED", taskId: "t1", actorId: "u1", auditEventId: "a1" });
    expect(db.notification.createMany).not.toHaveBeenCalled();
  });
});

describe("getTask", () => {
  it("gone owner flagged", async () => {
    db.task.findUnique.mockResolvedValue(row({ ownerId: "u9", reviewerId: "u5", workProject: { id: "p1", name: "Launch" }, workProjectId: "p1" }));
    db.taskChecklistItem.groupBy.mockResolvedValue([{ taskId: "t1", _count: { _all: 3, doneAt: 1 } }]);
    const dto = await getTask(scope, v, "t1");
    expect(dto.owner).toMatchObject({ id: "u9", gone: true });
    expect(dto.reviewer).toEqual({ id: "u5", name: "Cli", gone: false, client: true });
    expect(dto.owner).toMatchObject({ client: false });
    expect(dto.project).toEqual({ id: "p1", name: "Launch" });
    expect(dto.workProjectId).toBe("p1");
    expect(dto.checklist).toEqual({ done: 1, total: 3 });
    expect(dto.dueOn).toBe("2026-11-30");
    expect(dto.actions).toContain("cancel");
  });

  it("the single-task read returns checklist lines in (position, id) order and attachments with a signed URL", async () => {
    db.taskChecklistItem.findMany.mockResolvedValue([{ id: "i1", taskId: "t1", text: "Check menu", position: 0, doneAt: new Date("2026-11-23T11:00:00Z"), doneById: "u1" }]);
    db.taskAttachment.findMany.mockResolvedValue([
      { id: "at1", taskId: "t1", mediaUploadId: "up1", role: "BEFORE", createdById: "u1", createdAt: new Date("2026-11-23T10:00:00Z"), mediaUpload: { key: "w1/b1/uploads/a.jpg" } },
    ]);
    const dto = await getTask(scope, v, "t1");
    expect(db.taskChecklistItem.findMany.mock.calls[0]![0]).toMatchObject({ where: { taskId: "t1" }, orderBy: [{ position: "asc" }, { id: "asc" }] });
    expect(db.taskAttachment.findMany.mock.calls[0]![0].where).toEqual({ taskId: "t1" });
    expect(dto.checklistItems).toEqual([{ id: "i1", text: "Check menu", position: 0, doneAt: "2026-11-23T11:00:00.000Z", doneById: "u1" }]);
    expect(dto.attachments).toEqual([
      { id: "at1", mediaUploadId: "up1", role: "BEFORE", createdById: "u1", createdAt: "2026-11-23T10:00:00.000Z", url: "https://signed/w1/b1/uploads/a.jpg" },
    ]);
    expect(m.signed).toHaveBeenCalledWith("w1/b1/uploads/a.jpg");
  });

  it("clientVisible true when the reviewer is a client", async () => {
    db.task.findUnique.mockResolvedValue(row({ reviewerId: "u5" }));
    db.brandMember.findFirst.mockImplementation(async ({ where }: Where) => ((where.role as { NOT?: unknown }).NOT ? null : { id: "g2" }));
    const dto = await getTask(scope, v, "t1");
    expect(dto.clientVisible).toBe(true);
    expect(db.brandMember.findFirst.mock.calls[0]![0].where).toMatchObject({ userId: "u5", brandId: "b1", role: { isSystem: true, slug: "client-reviewer" } });
  });

  it("clientVisible true when the project is shared", async () => {
    db.task.findUnique.mockResolvedValue(row({ workProjectId: "p1" }));
    db.workProject.findFirst.mockResolvedValue({ id: "p1" });
    expect((await getTask(scope, v, "t1")).clientVisible).toBe(true);
    expect(db.workProject.findFirst.mock.calls[0]![0].where).toMatchObject({ id: "p1", clientVisible: true });
  });

  it("clientVisible false otherwise", async () => {
    expect((await getTask(scope, v, "t1")).clientVisible).toBe(false);
    db.task.findUnique.mockResolvedValue(row({ reviewerId: "u2", workProjectId: "p1" }));
    expect((await getTask(scope, v, "t1")).clientVisible).toBe(false);
  });

  it("viewerIsClient reflects the viewer", async () => {
    expect((await getTask(scope, v, "t1")).viewerIsClient).toBe(false);
    const c = { ...scope, clientReviewer: true };
    db.task.findUnique.mockResolvedValue(row({ reviewerId: "u1" }));
    expect((await getTask(c, taskViewer(c), "t1")).viewerIsClient).toBe(true);
  });

  it("list rows stay light: counts only, no lines or attachments read", async () => {
    const [dto] = await toTaskDtos(scope, [row() as never]);
    expect(dto).not.toHaveProperty("checklistItems");
    expect(dto).not.toHaveProperty("attachments");
    expect(db.taskChecklistItem.findMany).not.toHaveBeenCalled();
    expect(db.taskAttachment.findMany).not.toHaveBeenCalled();
  });

  it("a task the viewer can't see is 404", async () => {
    db.$queryRaw.mockResolvedValue([]);
    await expect(getTask(scope, v, "t1")).rejects.toMatchObject({ status: 404 });
  });

  it("the owner's actions; sole staff resolved only for the owner", async () => {
    const reader = scopeOf(["brand.read", "tasks.read"]);
    db.task.findUnique.mockResolvedValue(row({ ownerId: "u2" }));
    const dto = await getTask(reader, taskViewer(reader), "t1");
    expect(dto.actions).toEqual([]);
    expect(db.brandMember.findMany).not.toHaveBeenCalled();
    db.task.findUnique.mockResolvedValue(row({ ownerId: "u1" }));
    expect((await getTask(reader, taskViewer(reader), "t1")).actions).toEqual(expect.arrayContaining(["start", "markDone", "block"]));
  });
});

describe("patchTask", () => {
  it("PATCH ignores status; audit task.update with changed field names", async () => {
    await patchTask(scope, v, "t1", { status: "DONE", completedAt: "2026-11-23T00:00:00Z", title: "New title", priority: "NORMAL" });
    expect(updated()).toEqual({ title: "New title" });
    expect(db.$executeRaw).toHaveBeenCalled();
    expect(audits()[0]).toMatchObject({ action: "task.update", entityType: "Task", entityId: "t1", metadata: { title: "New title", fields: ["title"] } });
  });

  it("foreign workProjectId → 400 on PATCH", async () => {
    await expect(patchTask(scope, v, "t1", { workProjectId: "p9" })).rejects.toMatchObject({ status: 400, message: "Invalid workProjectId" });
    expect(db.task.update).not.toHaveBeenCalled();
  });

  it("foreign contentItemId → 400 on PATCH", async () => {
    await expect(patchTask(scope, v, "t1", { contentItemId: "c9" })).rejects.toMatchObject({ status: 400, message: "Invalid contentItemId" });
    expect(db.contentItem.findFirst.mock.calls[0]![0].where).toMatchObject({ id: "c9", workspaceId: "w1", brandId: "b1" });
  });

  it("an invalid value → 400", async () => {
    await expect(patchTask(scope, v, "t1", { url: "javascript:alert(1)" })).rejects.toMatchObject({ status: 400 });
    await expect(patchTask(scope, v, "t1", { areas: [] })).rejects.toMatchObject({ status: 400 });
  });

  it("reviewerId PATCH refused in review", async () => {
    db.task.findUnique.mockResolvedValue(row({ status: "IN_REVIEW", reviewerId: "u2" }));
    await expect(patchTask(scope, v, "t1", { reviewerId: "u3" })).rejects.toMatchObject({ status: 409 });
    expect(db.task.update).not.toHaveBeenCalled();
  });

  it("reviewerId PATCH allowed when the reviewer lost access", async () => {
    staff.delete("u2");
    db.task.findUnique.mockResolvedValue(row({ status: "IN_REVIEW", reviewerId: "u2" }));
    await patchTask(scope, v, "t1", { reviewerId: "u3" });
    expect(updated()).toEqual({ reviewerId: "u3" });
  });

  it("a reviewer replaced on a task in review is asked to review", async () => {
    staff.delete("u2");
    db.task.findUnique.mockResolvedValue(row({ status: "IN_REVIEW", reviewerId: "u2" }));
    await patchTask(scope, v, "t1", { reviewerId: "u3" });
    expect(db.notification.createMany.mock.calls[0]![0].data[0]).toMatchObject({ userId: "u3", kind: "REVIEW_REQUESTED", taskId: "t1", actorId: "u1" });
  });

  it("a reviewer set outside review is not asked to review yet", async () => {
    await patchTask(scope, v, "t1", { reviewerId: "u3" });
    expect(updated()).toEqual({ reviewerId: "u3" });
    expect(db.notification.createMany).not.toHaveBeenCalled();
  });

  it("clearing the reviewer of a task with a review verdict is refused (409)", async () => {
    db.task.findUnique.mockResolvedValue(row({ status: "TODO", reviewerId: "u2" }));
    db.taskComment.findFirst.mockResolvedValue({ id: "c1" });
    await expect(patchTask(scope, v, "t1", { reviewerId: null })).rejects.toMatchObject({ status: 409, code: "task.reviewed" });
    expect(db.taskComment.findFirst.mock.calls[0]![0].where).toEqual({ taskId: "t1", kind: { in: ["APPROVED", "CHANGES_REQUESTED"] } });
    expect(db.task.update).not.toHaveBeenCalled();
  });

  it("clearing the reviewer of a task never reviewed is allowed; another reviewer is always allowed", async () => {
    db.task.findUnique.mockResolvedValue(row({ status: "TODO", reviewerId: "u2" }));
    await patchTask(scope, v, "t1", { reviewerId: null });
    expect(updated()).toEqual({ reviewerId: null });
    db.taskComment.findFirst.mockResolvedValue({ id: "c1" });
    await patchTask(scope, v, "t1", { reviewerId: "u3" });
    expect(db.task.update.mock.calls[1]![0].data).toEqual({ reviewerId: "u3" });
  });

  it("url change clears checked live", async () => {
    db.task.findUnique.mockResolvedValue(row({ url: "https://a.com/x", checkedLiveAt: new Date(), checkedLiveById: "u1" }));
    await patchTask(scope, v, "t1", { url: "https://a.com/y" });
    expect(updated()).toEqual({ url: "https://a.com/y", checkedLiveAt: null, checkedLiveById: null });
  });

  it("an owner change notifies the new owner", async () => {
    await patchTask(scope, v, "t1", { ownerId: "u3" });
    expect(db.notification.createMany.mock.calls[0]![0].data[0]).toMatchObject({ userId: "u3", kind: "TASK_ASSIGNED", dedupeKey: "TASK_ASSIGNED:u3:a1" });
  });

  it("moving to a project the current owner can't see is refused", async () => {
    staff.delete("u2");
    db.task.findUnique.mockResolvedValue(row({ ownerId: "u2" }));
    db.workProject.findFirst.mockResolvedValue({ id: "p1" });
    await expect(patchTask(scope, v, "t1", { workProjectId: "p1" })).rejects.toMatchObject({ status: 400, message: "Invalid ownerId" });
  });

  it("nothing changed writes nothing", async () => {
    await patchTask(scope, v, "t1", { title: "Fix menu" });
    expect(db.task.update).not.toHaveBeenCalled();
    expect(db.auditEvent.create).not.toHaveBeenCalled();
  });
});

describe("routes", () => {
  it("reader cannot PATCH (403)", async () => {
    scope.perms = new Set(["brand.read", "tasks.read"]);
    const res = await taskPatch(req("PATCH", { title: "x" }), params());
    expect(res.status).toBe(403);
  });

  it("reader cannot POST tasks (403)", async () => {
    scope.perms = new Set(["brand.read", "tasks.read"]);
    const res = await tasksPost(req("POST", input()), params());
    expect(res.status).toBe(403);
  });

  it("POST creates (201), GET reads, TaskError maps to a problem", async () => {
    const created = await tasksPost(req("POST", input()), params());
    expect(created.status).toBe(201);
    expect((await created.json()).task.id).toBe("t1");
    expect((await taskGet(req("GET"), params())).status).toBe(200);
    expect(m.authorize.mock.calls.map((c) => c[2])).toEqual(["tasks.manage", "tasks.read"]);
    const bad = await tasksPost(req("POST", input({ workProjectId: "p9" })), params());
    expect(bad.status).toBe(400);
    expect((await bad.json()).detail).toBe("Invalid workProjectId");
    expect((await tasksPost(req("POST", { title: "" }), params())).status).toBe(400);
  });
});

describe("brandOwners", () => {
  it("post owner picker unchanged", async () => {
    const rows = await brandOwners(scope, { reveal: false });
    expect(rows).toEqual([{ id: "u1", name: "Ana" }, { id: "u2", name: "Bob" }, { id: "u4", name: "Dee" }, { id: "u3", name: "Cy" }]);
    expect(db.workspaceMember.findMany).not.toHaveBeenCalled();
  });

  it("tasks.read with clients: workspace members by their role's key, client grants included and marked", async () => {
    const rows = await brandOwners(scope, { key: "tasks.read", includeClients: true });
    expect(rows.map((r) => [r.id, r.client])).toEqual([["u1", false], ["u2", false], ["u3", false], ["u5", true]]);
  });

  it("a client grant held by someone whose workspace role approves content is not a client", async () => {
    db.workspaceMember.findMany.mockResolvedValue([{ userId: "u5", role: "MEMBER", roleRef: { permissions: ["brand.read", "content.approve"] } }]);
    const rows = await brandOwners(scope, { key: "tasks.read", includeClients: true });
    expect(rows.find((r) => r.id === "u5")).toEqual({ id: "u5", name: "Cli", client: false });
  });
});
