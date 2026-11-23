import { beforeEach, describe, expect, it, vi } from "vitest";

type Where = { where: Record<string, unknown> };
const db = vi.hoisted(() => {
  const d = {
    task: { findUnique: vi.fn(), update: vi.fn() },
    workProject: { findFirst: vi.fn() },
    contentItem: { findFirst: vi.fn() },
    auditReport: { findFirst: vi.fn() },
    taskChecklistItem: { groupBy: vi.fn(), findMany: vi.fn() },
    taskAttachment: { findMany: vi.fn() },
    taskComment: { create: vi.fn() },
    auditEvent: { create: vi.fn(), findFirst: vi.fn() },
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
const m = vi.hoisted(() => ({ people: vi.fn(), authorize: vi.fn() }));
vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/services/project-members", () => ({ listProjectPeople: m.people }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: m.authorize }));

import { Prisma } from "@prisma/client";
import { AccessDeniedError } from "@/server/auth/errors";
import { runTaskAction } from "@/server/tasks/actions";
import { taskViewer } from "@/server/tasks/access";
import type { PermissionKey } from "@/server/auth/permissions.catalog";
import { POST as taskPost } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/tasks/[taskId]/route";

const MANAGER: PermissionKey[] = ["brand.read", "tasks.read", "tasks.manage"];
const scope = { workspaceId: "w1", brandId: "b1", userId: "u1", perms: new Set(MANAGER), clientReviewer: false };
const v = taskViewer(scope);

// Staff with tasks.read on the brand (through the workspace role): u1, u2, u3. u4 can't see tasks.
let staff = new Set(["u1", "u2", "u3"]);
const row = (o: Record<string, unknown> = {}) => ({
  id: "t1", workspaceId: "w1", brandId: "b1", title: "Fix menu", description: null, status: "IN_PROGRESS", priority: "NORMAL", areas: ["WEBSITE"],
  ownerId: "u1", reviewerId: null, createdById: "u1", dueOn: null, blockedReason: null, blockedOnId: null,
  workProjectId: null, contentItemId: null, url: null, changeKind: null, acceptanceCriteria: null, previewUrl: null, checkedLiveAt: null,
  checkedLiveById: null, auditReportId: null, findingKind: null, findingId: null, findingUrls: [], findingClearedAt: null, recheckOn: null,
  completedAt: null, requestId: null, createdAt: new Date("2026-11-23T10:00:00Z"), updatedAt: new Date("2026-11-23T10:00:00Z"),
  workProject: null, contentItem: null, ...o,
});
const updated = () => db.task.update.mock.calls[0]![0].data as Record<string, unknown>;
const audits = () => db.auditEvent.create.mock.calls.map((c) => c[0].data as Record<string, unknown>);
const notices = () => db.notification.createMany.mock.calls.map((c) => c[0].data[0] as Record<string, unknown>);
const params = { params: Promise.resolve({ workspaceId: "w1", brandId: "b1", taskId: "t1" }) };
const post = (body: unknown) => taskPost(new Request("http://x/api", { method: "POST", body: JSON.stringify(body) }), params);

beforeEach(() => {
  vi.clearAllMocks();
  staff = new Set(["u1", "u2", "u3"]);
  scope.perms = new Set(MANAGER);
  db.$queryRaw.mockResolvedValue([{ id: "t1" }]);
  db.task.findUnique.mockResolvedValue(row());
  db.task.update.mockResolvedValue({});
  db.taskChecklistItem.groupBy.mockResolvedValue([]);
  db.taskChecklistItem.findMany.mockResolvedValue([]);
  db.taskAttachment.findMany.mockResolvedValue([]);
  db.taskComment.create.mockResolvedValue({ id: "c1" });
  db.auditEvent.create.mockResolvedValue({ id: "a1" });
  db.workspaceMember.findFirst.mockImplementation(async ({ where }: Where) => (staff.has(where.userId as string) ? { id: "m" } : null));
  db.workspaceMember.findMany.mockImplementation(async ({ where }: { where: { userId?: { not?: string } } }) =>
    [...staff].filter((u) => u !== where.userId?.not).map((userId) => ({ userId, role: "ADMIN", roleRef: { permissions: ["brand.read", "tasks.read"] } })),
  );
  db.brandMember.findFirst.mockResolvedValue(null);
  m.people.mockResolvedValue({ viaWorkspace: [], people: [], invitations: [] });
  m.authorize.mockImplementation(async (_r: Request, _p: unknown, key: PermissionKey) => {
    if (!scope.perms.has(key)) throw new AccessDeniedError(`Missing permission ${key}`);
    return scope;
  });
});

describe("review", () => {
  it("submitForReview notifies the reviewer once", async () => {
    await runTaskAction(scope, v, "t1", { action: "submitForReview", reviewerId: "u2" });
    expect(updated()).toEqual({ status: "IN_REVIEW", reviewerId: "u2" });
    expect(db.$executeRaw).toHaveBeenCalled();
    expect(db.notification.createMany).toHaveBeenCalledTimes(1);
    expect(notices()[0]).toMatchObject({ userId: "u2", kind: "REVIEW_REQUESTED", taskId: "t1", actorId: "u1", dedupeKey: "REVIEW_REQUESTED:u2:a1" });
  });

  it("resubmit after changes notifies again", async () => {
    await runTaskAction(scope, v, "t1", { action: "submitForReview", reviewerId: "u2" });
    // The reviewer asked for changes: back in progress, reviewer kept. Sent again without naming the reviewer.
    db.task.findUnique.mockResolvedValue(row({ reviewerId: "u2" }));
    db.auditEvent.create.mockResolvedValue({ id: "a2" });
    await runTaskAction(scope, v, "t1", { action: "submitForReview" });
    expect(notices().map((n) => n.dedupeKey)).toEqual(["REVIEW_REQUESTED:u2:a1", "REVIEW_REQUESTED:u2:a2"]);
  });

  it("actor gets no notification", async () => {
    // A manager sends someone else's task to themselves for review.
    db.task.findUnique.mockResolvedValue(row({ ownerId: "u2" }));
    await runTaskAction(scope, v, "t1", { action: "submitForReview", reviewerId: "u1" });
    expect(updated()).toMatchObject({ status: "IN_REVIEW", reviewerId: "u1" });
    expect(db.notification.createMany).not.toHaveBeenCalled();
  });

  it("submitForReview refuses a reviewer who can't be assigned", async () => {
    await expect(runTaskAction(scope, v, "t1", { action: "submitForReview", reviewerId: "u4" })).rejects.toMatchObject({ status: 400, message: "Invalid reviewerId" });
    // The stored reviewer is checked too.
    db.task.findUnique.mockResolvedValue(row({ reviewerId: "u4" }));
    await expect(runTaskAction(scope, v, "t1", { action: "submitForReview" })).rejects.toMatchObject({ status: 400, message: "Invalid reviewerId" });
    expect(db.task.update).not.toHaveBeenCalled();
  });

  it("the owner can't review their own task while someone else could", async () => {
    await expect(runTaskAction(scope, v, "t1", { action: "submitForReview", reviewerId: "u1" })).rejects.toMatchObject({ status: 409, message: "The reviewer can't be the owner." });
    staff = new Set(["u1"]);
    await runTaskAction(scope, v, "t1", { action: "submitForReview", reviewerId: "u1" });
    expect(updated()).toEqual({ status: "IN_REVIEW", reviewerId: "u1" });
  });

  it("approve writes APPROVED comment and DONE", async () => {
    db.task.findUnique.mockResolvedValue(row({ status: "IN_REVIEW", ownerId: "u2", reviewerId: "u1", blockedReason: "x", blockedOnId: "u3" }));
    await runTaskAction(scope, v, "t1", { action: "approve", note: " Looks good " });
    expect(updated()).toMatchObject({ status: "DONE", blockedReason: null, blockedOnId: null });
    expect(updated().completedAt).toBeInstanceOf(Date);
    expect(db.taskComment.create).toHaveBeenCalledWith({
      data: { workspaceId: "w1", brandId: "b1", taskId: "t1", authorId: "u1", kind: "APPROVED", body: "Looks good", byClient: false, internal: false },
    });
  });

  it("requestChanges writes CHANGES_REQUESTED with the reason", async () => {
    db.task.findUnique.mockResolvedValue(row({ status: "IN_REVIEW", ownerId: "u2", reviewerId: "u1" }));
    await runTaskAction(scope, v, "t1", { action: "requestChanges", reason: "Wrong photo" });
    expect(updated()).toEqual({ status: "IN_PROGRESS" });
    expect(db.taskComment.create.mock.calls[0]![0].data).toMatchObject({ kind: "CHANGES_REQUESTED", body: "Wrong photo", internal: false });
  });

  it("reviewer who lost access cannot approve", async () => {
    staff.delete("u1");
    db.task.findUnique.mockResolvedValue(row({ status: "IN_REVIEW", ownerId: "u2", reviewerId: "u1" }));
    await expect(runTaskAction(scope, v, "t1", { action: "approve" })).rejects.toMatchObject({ status: 403 });
    expect(db.task.update).not.toHaveBeenCalled();
    expect(db.taskComment.create).not.toHaveBeenCalled();
  });
});

describe("other actions", () => {
  it("blockedOnId must be assignable", async () => {
    await expect(runTaskAction(scope, v, "t1", { action: "block", reason: "Photos", blockedOnId: "u4" })).rejects.toMatchObject({ status: 400, message: "Invalid blockedOnId" });
    await runTaskAction(scope, v, "t1", { action: "block", reason: "Photos", blockedOnId: "u3" });
    expect(updated()).toEqual({ blockedReason: "Photos", blockedOnId: "u3" });
  });

  it("a refused action is a 409 with the reason; an invisible task is a 404", async () => {
    db.task.findUnique.mockResolvedValue(row({ status: "DONE" }));
    await expect(runTaskAction(scope, v, "t1", { action: "start" })).rejects.toMatchObject({ status: 409, message: "Only a to-do task can be started." });
    db.$queryRaw.mockResolvedValue([]);
    await expect(runTaskAction(scope, v, "t1", { action: "start" })).rejects.toMatchObject({ status: 404 });
    expect(db.task.update).not.toHaveBeenCalled();
  });

  it.each([
    ["start", { status: "TODO" }, {}],
    ["submitForReview", {}, { reviewerId: "u2" }],
    ["approve", { status: "IN_REVIEW", ownerId: "u2", reviewerId: "u1" }, {}],
    ["requestChanges", { status: "IN_REVIEW", ownerId: "u2", reviewerId: "u1" }, { reason: "Redo" }],
    ["markDone", {}, {}],
    ["block", {}, { reason: "Waiting" }],
    ["unblock", { blockedReason: "Waiting" }, {}],
    ["checkedLive", { url: "https://a.com/x" }, {}],
    ["cancel", {}, {}],
    ["reopen", { status: "DONE", completedAt: new Date() }, {}],
  ] as const)("audit task.%s", async (action, task, body) => {
    db.task.findUnique.mockResolvedValue(row(task));
    await runTaskAction(scope, v, "t1", { action, ...body });
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({ action: `task.${action}`, entityType: "Task", entityId: "t1", actorUserId: "u1", metadata: { title: "Fix menu" } });
  });

  it("reopen while another open task holds the finding → 409", async () => {
    db.task.findUnique.mockResolvedValue(row({ status: "DONE", findingKind: "SEO", findingId: "f1" }));
    db.task.update.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "x" }));
    await expect(runTaskAction(scope, v, "t1", { action: "reopen" })).rejects.toMatchObject({ status: 409 });
  });
});

describe("route", () => {
  it("POST without tasks.read → 403", async () => {
    scope.perms = new Set(["brand.read"]);
    expect((await post({ action: "start" })).status).toBe(403);
    expect(db.task.update).not.toHaveBeenCalled();
  });

  it("a reader who owns the task acts on it (tasks.read); a bad body is a 400", async () => {
    scope.perms = new Set(["brand.read", "tasks.read"]);
    db.task.findUnique.mockResolvedValue(row({ status: "TODO" }));
    const res = await post({ action: "start" });
    expect(res.status).toBe(200);
    expect((await res.json()).task.id).toBe("t1");
    expect(m.authorize.mock.calls[0]![2]).toBe("tasks.read");
    expect((await post({ action: "explode" })).status).toBe(400);
    db.task.findUnique.mockResolvedValue(row({ status: "TODO" }));
    expect((await post({ action: "cancel" })).status).toBe(409);
  });
});
