import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const d = {
    task: { findUnique: vi.fn() },
    taskChecklistItem: { findFirst: vi.fn(), aggregate: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    taskComment: { findMany: vi.fn(), create: vi.fn() },
    auditEvent: { create: vi.fn() },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(),
  };
  d.$transaction.mockImplementation(async (fn: (tx: typeof d) => unknown) => fn(d));
  return d;
});
const m = vi.hoisted(() => ({ authorize: vi.fn(), owners: vi.fn() }));
vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: m.authorize }));
vi.mock("@/server/services/publishing", async (orig) => ({ ...(await orig<object>()), brandOwners: m.owners }));

import { AccessDeniedError } from "@/server/auth/errors";
import type { PermissionKey } from "@/server/auth/permissions.catalog";
import { taskViewer } from "@/server/tasks/access";
import { addChecklistItem, patchChecklistItem, removeChecklistItem } from "@/server/tasks/checklist";
import { addComment, listComments } from "@/server/tasks/comments";
import { POST as checklistPost } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/tasks/[taskId]/checklist/route";
import { DELETE as itemDelete, PATCH as itemPatch } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/tasks/[taskId]/checklist/[itemId]/route";
import { GET as commentsGet, POST as commentsPost } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/tasks/[taskId]/comments/route";

const MANAGER: PermissionKey[] = ["brand.read", "tasks.read", "tasks.manage"];
const READER: PermissionKey[] = ["brand.read", "tasks.read"];
const scopeOf = (perms: PermissionKey[] = MANAGER, o: { userId?: string; clientReviewer?: boolean } = {}) => ({
  workspaceId: "w1", brandId: "b1", userId: o.userId ?? "u1", perms: new Set(perms), clientReviewer: o.clientReviewer ?? false,
});
let routeScope = scopeOf();
const manager = scopeOf();
const reader = scopeOf(READER, { userId: "u2" });
const client = scopeOf(READER, { userId: "u5", clientReviewer: true });

const item = (o: Record<string, unknown> = {}) => ({ id: "i1", taskId: "t1", text: "Check menu", position: 0, doneAt: null, doneById: null, ...o });
const comment = (o: Record<string, unknown> = {}) => ({
  id: "c1", workspaceId: "w1", brandId: "b1", taskId: "t1", authorId: "u1", kind: "COMMENT", body: "Hi", byClient: false, internal: true, createdAt: new Date("2026-11-23T10:00:00Z"), ...o,
});
const audits = () => db.auditEvent.create.mock.calls.map((c) => c[0].data as Record<string, unknown>);
const req = (method: string, body?: unknown) => new Request("http://x/api", { method, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (o: Record<string, string> = {}) => ({ params: Promise.resolve({ workspaceId: "w1", brandId: "b1", taskId: "t1", itemId: "i1", ...o }) });

beforeEach(() => {
  vi.clearAllMocks();
  routeScope = scopeOf();
  db.$queryRaw.mockResolvedValue([{ id: "t1" }]);
  db.task.findUnique.mockResolvedValue({ title: "Fix menu", ownerId: "u1" });
  db.taskChecklistItem.findFirst.mockResolvedValue(item());
  db.taskChecklistItem.aggregate.mockResolvedValue({ _max: { position: 2 } });
  db.taskChecklistItem.create.mockImplementation(async ({ data }: { data: object }) => item({ id: "i2", ...data }));
  db.taskChecklistItem.update.mockImplementation(async ({ data }: { data: object }) => item(data as Record<string, unknown>));
  db.taskChecklistItem.delete.mockResolvedValue(item());
  db.taskComment.findMany.mockResolvedValue([]);
  db.taskComment.create.mockImplementation(async ({ data }: { data: object }) => comment({ id: "c2", ...data }));
  db.auditEvent.create.mockResolvedValue({ id: "a1" });
  m.owners.mockResolvedValue([{ id: "u1", name: "Ana" }, { id: "u5", name: "Cli" }]);
  m.authorize.mockImplementation(async (_r: Request, _p: unknown, key: PermissionKey) => {
    if (!routeScope.perms.has(key)) throw new AccessDeniedError(`Missing permission ${key}`);
    return routeScope;
  });
});

describe("checklist", () => {
  it("add puts the line last, under the task lock, and audits it", async () => {
    const dto = await addChecklistItem(manager, taskViewer(manager), "t1", { text: "  Check menu " });
    expect(db.taskChecklistItem.create.mock.calls[0]![0].data).toEqual({ taskId: "t1", text: "Check menu", position: 3 });
    expect(dto).toEqual({ id: "i2", text: "Check menu", position: 3, doneAt: null, doneById: null });
    expect(db.$executeRaw).toHaveBeenCalled();
    expect(audits()[0]).toMatchObject({ action: "task.checklist.add", entityType: "Task", entityId: "t1", metadata: { title: "Fix menu", itemId: "i2" } });
  });

  it("the owner without tasks.manage may edit; someone else may not (403)", async () => {
    db.task.findUnique.mockResolvedValue({ title: "Fix menu", ownerId: "u2" });
    await addChecklistItem(reader, taskViewer(reader), "t1", { text: "x" });
    db.task.findUnique.mockResolvedValue({ title: "Fix menu", ownerId: "u9" });
    await expect(addChecklistItem(reader, taskViewer(reader), "t1", { text: "x" })).rejects.toMatchObject({ status: 403 });
    expect(db.taskChecklistItem.create).toHaveBeenCalledTimes(1);
  });

  it("a hidden task → 404; text over 300 → 400", async () => {
    db.$queryRaw.mockResolvedValue([]);
    await expect(addChecklistItem(manager, taskViewer(manager), "t1", { text: "x" })).rejects.toMatchObject({ status: 404 });
    db.$queryRaw.mockResolvedValue([{ id: "t1" }]);
    await expect(addChecklistItem(manager, taskViewer(manager), "t1", { text: "x".repeat(301) })).rejects.toMatchObject({ status: 400 });
  });

  it("another task's checklist item → 404", async () => {
    db.taskChecklistItem.findFirst.mockResolvedValue(null);
    await expect(patchChecklistItem(manager, taskViewer(manager), "t1", "i9", { done: true })).rejects.toMatchObject({ status: 404 });
    expect(db.taskChecklistItem.findFirst.mock.calls[0]![0].where).toEqual({ id: "i9", taskId: "t1" });
    await expect(removeChecklistItem(manager, taskViewer(manager), "t1", "i9")).rejects.toMatchObject({ status: 404 });
    expect(db.taskChecklistItem.update).not.toHaveBeenCalled();
    expect(db.taskChecklistItem.delete).not.toHaveBeenCalled();
  });

  it("ticking records who and when; unticking clears both; audits each", async () => {
    const done = await patchChecklistItem(manager, taskViewer(manager), "t1", "i1", { done: true, position: 4 });
    const data = db.taskChecklistItem.update.mock.calls[0]![0].data;
    expect(data).toMatchObject({ doneById: "u1", position: 4 });
    expect(data.doneAt).toBeInstanceOf(Date);
    expect(done.doneById).toBe("u1");
    await patchChecklistItem(manager, taskViewer(manager), "t1", "i1", { done: false });
    expect(db.taskChecklistItem.update.mock.calls[1]![0].data).toEqual({ doneAt: null, doneById: null });
    expect(audits().map((a) => a.action)).toEqual(["task.checklist.update", "task.checklist.update"]);
    await expect(patchChecklistItem(manager, taskViewer(manager), "t1", "i1", {})).rejects.toMatchObject({ status: 400 });
  });

  it("delete removes the line and keeps its text in the audit", async () => {
    await removeChecklistItem(manager, taskViewer(manager), "t1", "i1");
    expect(db.taskChecklistItem.delete).toHaveBeenCalledWith({ where: { id: "i1" } });
    expect(audits()[0]).toMatchObject({ action: "task.checklist.remove", entityId: "t1", metadata: { title: "Fix menu", itemId: "i1", text: "Check menu" } });
  });
});

describe("comments", () => {
  it("client GET of a hidden task's comments → 404", async () => {
    db.$queryRaw.mockResolvedValue([]);
    await expect(listComments(client, taskViewer(client), "t1")).rejects.toMatchObject({ status: 404 });
    expect(db.taskComment.findMany).not.toHaveBeenCalled();
  });

  it("staff comment is internal unless shared", async () => {
    await addComment(manager, taskViewer(manager), "t1", { body: "Note" });
    await addComment(manager, taskViewer(manager), "t1", { body: "For you", shareWithClient: true });
    const [a, b] = db.taskComment.create.mock.calls.map((c) => c[0].data);
    expect(a).toEqual({ workspaceId: "w1", brandId: "b1", taskId: "t1", authorId: "u1", kind: "COMMENT", body: "Note", byClient: false, internal: true });
    expect(b).toMatchObject({ internal: false, byClient: false });
  });

  it("client comment is never internal", async () => {
    const dto = await addComment(client, taskViewer(client), "t1", { body: "Looks good", shareWithClient: false });
    expect(db.taskComment.create.mock.calls[0]![0].data).toMatchObject({ authorId: "u5", byClient: true, internal: false });
    expect(dto).toMatchObject({ byClient: true, internal: false, author: { id: "u5", name: "Cli", gone: false } });
  });

  it("comment on a private task stays hidden after the project is shared", async () => {
    // Written while the task was staff-only: no share toggle, so internal.
    await addComment(manager, taskViewer(manager), "t1", { body: "Internal pricing" });
    expect(db.taskComment.create.mock.calls[0]![0].data.internal).toBe(true);
    // The project is shared later: the client now sees the task, but reads only non-internal comments.
    db.taskComment.findMany.mockResolvedValue([comment({ id: "c3", internal: false, body: "Shared" })]);
    const rows = await listComments(client, taskViewer(client), "t1");
    expect(db.taskComment.findMany.mock.calls[0]![0].where).toEqual({ taskId: "t1", internal: false });
    expect(rows.map((r) => r.id)).toEqual(["c3"]);
    // Staff read them all.
    await listComments(manager, taskViewer(manager), "t1");
    expect(db.taskComment.findMany.mock.calls[1]![0].where).toEqual({ taskId: "t1" });
  });

  it("list: oldest first, author names, a gone author flagged, SYSTEM has none", async () => {
    db.taskComment.findMany.mockResolvedValue([
      comment({ id: "c2", authorId: "u9", createdAt: new Date("2026-11-23T11:00:00Z") }),
      comment({ id: "c1", authorId: null, kind: "SYSTEM" }),
    ]);
    const rows = await listComments(manager, taskViewer(manager), "t1");
    expect(rows.map((r) => r.id)).toEqual(["c1", "c2"]);
    expect(rows[0]!.author).toBeNull();
    expect(rows[1]!.author).toMatchObject({ id: "u9", gone: true });
    expect(rows[0]!.createdAt).toBe("2026-11-23T10:00:00.000Z");
  });

  it("body 1–4,000; audit task.comment on the comment", async () => {
    await expect(addComment(manager, taskViewer(manager), "t1", { body: "  " })).rejects.toMatchObject({ status: 400 });
    await expect(addComment(manager, taskViewer(manager), "t1", { body: "x".repeat(4_001) })).rejects.toMatchObject({ status: 400 });
    await addComment(manager, taskViewer(manager), "t1", { body: "ok" });
    expect(audits()[0]).toMatchObject({ action: "task.comment", entityType: "TaskComment", entityId: "c2", metadata: { taskId: "t1", internal: true } });
  });

  it("a hidden task can't be commented on (404)", async () => {
    db.$queryRaw.mockResolvedValue([]);
    await expect(addComment(client, taskViewer(client), "t1", { body: "x" })).rejects.toMatchObject({ status: 404 });
    expect(db.taskComment.create).not.toHaveBeenCalled();
  });
});

describe("routes", () => {
  const noRead = () => (routeScope = scopeOf(["brand.read"]));

  it("POST checklist without tasks.read → 403", async () => {
    noRead();
    expect((await checklistPost(req("POST", { text: "x" }), params())).status).toBe(403);
  });
  it("PATCH checklist item without tasks.read → 403", async () => {
    noRead();
    expect((await itemPatch(req("PATCH", { done: true }), params())).status).toBe(403);
  });
  it("DELETE checklist item without tasks.read → 403", async () => {
    noRead();
    expect((await itemDelete(req("DELETE"), params())).status).toBe(403);
  });
  it("POST comment without tasks.read → 403", async () => {
    noRead();
    expect((await commentsPost(req("POST", { body: "x" }), params())).status).toBe(403);
  });

  it("checklist and comment routes answer with tasks.read", async () => {
    const added = await checklistPost(req("POST", { text: "x" }), params());
    expect(added.status).toBe(201);
    expect((await added.json()).item.id).toBe("i2");
    expect((await (await itemPatch(req("PATCH", { done: true }), params())).json()).item.id).toBe("i1");
    expect((await itemDelete(req("DELETE"), params())).status).toBe(204);
    const posted = await commentsPost(req("POST", { body: "Hi" }), params());
    expect(posted.status).toBe(201);
    expect((await posted.json()).comment.id).toBe("c2");
    expect((await (await commentsGet(req("GET"), params())).json()).comments).toEqual([]);
    expect(new Set(m.authorize.mock.calls.map((c) => c[2]))).toEqual(new Set(["tasks.read"]));
    expect((await commentsPost(req("POST", { body: "" }), params())).status).toBe(400);
    db.taskChecklistItem.findFirst.mockResolvedValue(null);
    expect((await itemPatch(req("PATCH", { done: true }), params())).status).toBe(404);
  });
});
