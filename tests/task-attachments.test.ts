import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const db = vi.hoisted(() => {
  const d = {
    task: { findUnique: vi.fn() },
    mediaUpload: { findFirst: vi.fn(), delete: vi.fn() },
    taskAttachment: { findFirst: vi.fn(), create: vi.fn(), delete: vi.fn() },
    auditEvent: { create: vi.fn() },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(),
  };
  d.$transaction.mockImplementation(async (fn: (tx: typeof d) => unknown) => fn(d));
  return d;
});
const m = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/storage/media", async (orig) => ({ ...(await orig<object>()), signedMediaUrl: async (key: string) => `https://signed/${key}` }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: m.authorize }));

import { AccessDeniedError } from "@/server/auth/errors";
import type { PermissionKey } from "@/server/auth/permissions.catalog";
import { taskViewer } from "@/server/tasks/access";
import { addAttachment, removeAttachment } from "@/server/tasks/attachments";
import { POST as attachPost } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/tasks/[taskId]/attachments/route";
import { DELETE as attachDelete } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/tasks/[taskId]/attachments/[attachmentId]/route";

const MANAGER: PermissionKey[] = ["brand.read", "tasks.read", "tasks.manage"];
const scopeOf = (perms: PermissionKey[], userId = "u1") => ({ workspaceId: "w1", brandId: "b1", userId, perms: new Set(perms), clientReviewer: false });
let routeScope = scopeOf(MANAGER);
const manager = scopeOf(MANAGER);
const creatorOwner = scopeOf(["brand.read", "tasks.read", "content.create"], "u2");
const readerOwner = scopeOf(["brand.read", "tasks.read"], "u2");

const attachment = (o: Record<string, unknown> = {}) => ({ id: "at1", taskId: "t1", mediaUploadId: "up1", role: "BEFORE", createdById: "u1", createdAt: new Date("2026-11-23T10:00:00Z"), ...o });
const audits = () => db.auditEvent.create.mock.calls.map((c) => c[0].data as Record<string, unknown>);
const req = (method: string, body?: unknown) => new Request("http://x/api", { method, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (o: Record<string, string> = {}) => ({ params: Promise.resolve({ workspaceId: "w1", brandId: "b1", taskId: "t1", attachmentId: "at1", ...o }) });

beforeEach(() => {
  vi.clearAllMocks();
  routeScope = scopeOf(MANAGER);
  db.$queryRaw.mockResolvedValue([{ id: "t1" }]);
  // u1 (the manager) made the task; u2 owns it.
  db.task.findUnique.mockResolvedValue({ title: "Fix menu", ownerId: "u2", createdById: "u1" });
  db.mediaUpload.findFirst.mockResolvedValue({ id: "up1", key: "w1/b1/uploads/a.jpg" });
  db.taskAttachment.findFirst.mockResolvedValue(attachment());
  db.taskAttachment.create.mockImplementation(async ({ data }: { data: object }) => attachment(data as Record<string, unknown>));
  db.taskAttachment.delete.mockResolvedValue(attachment());
  db.auditEvent.create.mockResolvedValue({ id: "a1" });
  m.authorize.mockImplementation(async (_r: Request, _p: unknown, key: PermissionKey) => {
    if (!routeScope.perms.has(key)) throw new AccessDeniedError(`Missing permission ${key}`);
    return routeScope;
  });
});

describe("attachments", () => {
  it("attaches a verified brand photo with no product, re-read in the transaction, and audits it", async () => {
    const dto = await addAttachment(manager, taskViewer(manager), "t1", { mediaUploadId: "up1", role: "AFTER" });
    expect(db.mediaUpload.findFirst.mock.calls[0]![0].where).toEqual({ id: "up1", workspaceId: "w1", brandId: "b1", status: "VERIFIED", kind: "photo", productId: null });
    expect(db.taskAttachment.create.mock.calls[0]![0].data).toEqual({ taskId: "t1", mediaUploadId: "up1", role: "AFTER", createdById: "u1" });
    expect(dto).toEqual({ id: "at1", mediaUploadId: "up1", role: "AFTER", createdById: "u1", createdAt: "2026-11-23T10:00:00.000Z", url: "https://signed/w1/b1/uploads/a.jpg" });
    expect(db.$executeRaw).toHaveBeenCalled();
    expect(audits()[0]).toMatchObject({ action: "task.attachment.add", entityType: "Task", entityId: "t1", metadata: { title: "Fix menu", attachmentId: "at1", role: "AFTER" } });
  });

  it("an upload purged between the re-read and the insert (P2003) → 400, not 500", async () => {
    db.taskAttachment.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("FK", { code: "P2003", clientVersion: "x" }));
    await expect(addAttachment(manager, taskViewer(manager), "t1", { mediaUploadId: "up1", role: "BEFORE" })).rejects.toMatchObject({ status: 400, message: "Invalid mediaUploadId" });
    expect(db.auditEvent.create).not.toHaveBeenCalled();
  });

  it("attach refuses a product photo", async () => {
    // A product photo has a productId, so the productId: null re-read finds nothing.
    db.mediaUpload.findFirst.mockResolvedValue(null);
    await expect(addAttachment(manager, taskViewer(manager), "t1", { mediaUploadId: "up-product", role: "BEFORE" })).rejects.toMatchObject({ status: 400, message: "Invalid mediaUploadId" });
    expect(db.mediaUpload.findFirst.mock.calls[0]![0].where).toMatchObject({ productId: null });
    expect(db.taskAttachment.create).not.toHaveBeenCalled();
  });

  it("attach refuses another brand's upload", async () => {
    db.mediaUpload.findFirst.mockResolvedValue(null);
    await expect(addAttachment(manager, taskViewer(manager), "t1", { mediaUploadId: "up-other", role: "BEFORE" })).rejects.toMatchObject({ status: 400 });
    expect(db.mediaUpload.findFirst.mock.calls[0]![0].where).toMatchObject({ workspaceId: "w1", brandId: "b1" });
    expect(db.taskAttachment.create).not.toHaveBeenCalled();
  });

  it("owner without content.create gets 403; with it, may attach", async () => {
    await expect(addAttachment(readerOwner, taskViewer(readerOwner), "t1", { mediaUploadId: "up1", role: "BEFORE" })).rejects.toMatchObject({ status: 403 });
    await expect(removeAttachment(readerOwner, taskViewer(readerOwner), "t1", "at1")).rejects.toMatchObject({ status: 403 });
    await addAttachment(creatorOwner, taskViewer(creatorOwner), "t1", { mediaUploadId: "up1", role: "BEFORE" });
    expect(db.taskAttachment.create).toHaveBeenCalledTimes(1);
  });

  it("a manager without tasks.all who neither owns nor made the task gets 403; with tasks.all may attach", async () => {
    db.task.findUnique.mockResolvedValue({ title: "Fix menu", ownerId: "u2", createdById: "u9" });
    await expect(addAttachment(manager, taskViewer(manager), "t1", { mediaUploadId: "up1", role: "BEFORE" })).rejects.toMatchObject({ status: 403 });
    const admin = scopeOf([...MANAGER, "tasks.all"]);
    await expect(addAttachment(admin, taskViewer(admin), "t1", { mediaUploadId: "up1", role: "BEFORE" })).resolves.toMatchObject({ id: "at1" });
  });

  it("someone else with content.create but not owner or manager gets 403", async () => {
    db.task.findUnique.mockResolvedValue({ title: "Fix menu", ownerId: "u9" });
    await expect(addAttachment(creatorOwner, taskViewer(creatorOwner), "t1", { mediaUploadId: "up1", role: "BEFORE" })).rejects.toMatchObject({ status: 403 });
  });

  it("a hidden task → 404; a bad role → 400", async () => {
    db.$queryRaw.mockResolvedValue([]);
    await expect(addAttachment(manager, taskViewer(manager), "t1", { mediaUploadId: "up1", role: "BEFORE" })).rejects.toMatchObject({ status: 404 });
    db.$queryRaw.mockResolvedValue([{ id: "t1" }]);
    await expect(addAttachment(manager, taskViewer(manager), "t1", { mediaUploadId: "up1", role: "DURING" })).rejects.toMatchObject({ status: 400 });
  });

  it("another task's attachment → 404", async () => {
    db.taskAttachment.findFirst.mockResolvedValue(null);
    await expect(removeAttachment(manager, taskViewer(manager), "t1", "at9")).rejects.toMatchObject({ status: 404 });
    expect(db.taskAttachment.findFirst.mock.calls[0]![0].where).toEqual({ id: "at9", taskId: "t1" });
    expect(db.taskAttachment.delete).not.toHaveBeenCalled();
  });

  it("deleting an attachment keeps the upload", async () => {
    await removeAttachment(manager, taskViewer(manager), "t1", "at1");
    expect(db.taskAttachment.delete).toHaveBeenCalledWith({ where: { id: "at1" } });
    expect(db.mediaUpload.delete).not.toHaveBeenCalled();
    expect(audits()[0]).toMatchObject({ action: "task.attachment.remove", entityId: "t1", metadata: { title: "Fix menu", attachmentId: "at1", mediaUploadId: "up1" } });
  });
});

describe("routes", () => {
  const noRead = () => (routeScope = scopeOf(["brand.read", "content.create"]));

  it("POST attachment without tasks.read → 403", async () => {
    noRead();
    expect((await attachPost(req("POST", { mediaUploadId: "up1", role: "BEFORE" }), params())).status).toBe(403);
  });
  it("DELETE attachment without tasks.read → 403", async () => {
    noRead();
    expect((await attachDelete(req("DELETE"), params())).status).toBe(403);
  });

  it("POST 201 and DELETE 204 with tasks.read", async () => {
    const created = await attachPost(req("POST", { mediaUploadId: "up1", role: "BEFORE" }), params());
    expect(created.status).toBe(201);
    expect((await created.json()).attachment.id).toBe("at1");
    expect((await attachDelete(req("DELETE"), params())).status).toBe(204);
    expect(m.authorize.mock.calls.map((c) => c[2])).toEqual(["tasks.read", "tasks.read"]);
  });
});
