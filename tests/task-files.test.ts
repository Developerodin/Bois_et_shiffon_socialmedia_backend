import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const d = {
    task: { findUnique: vi.fn() },
    taskFile: { count: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn(), findUniqueOrThrow: vi.fn(), findMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    auditEvent: { create: vi.fn() },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(),
  };
  d.$transaction.mockImplementation(async (fn: (tx: typeof d) => unknown) => fn(d));
  return d;
});
const s = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  put: vi.fn(),
  del: vi.fn(),
  signed: vi.fn(),
  presign: vi.fn(),
  limit: vi.fn(),
  authorize: vi.fn(),
}));
vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/auth/rate-limit", () => ({ hitRateLimit: s.limit }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: s.authorize }));
vi.mock("@/server/storage/media", async (orig) => {
  const real = await orig<typeof import("@/server/storage/media")>();
  return {
    ...real,
    presignedPut: s.presign,
    putMedia: s.put,
    deleteMedia: s.del,
    signedMediaUrl: s.signed,
    getMediaBytes: async (key: string, max: number) => {
      const b = s.objects.get(key);
      if (!b) throw new Error("NoSuchKey");
      if (b.length > max) throw new real.MediaTooLarge();
      return b;
    },
  };
});

import { AccessDeniedError } from "@/server/auth/errors";
import type { PermissionKey } from "@/server/auth/permissions.catalog";
import { taskViewer } from "@/server/tasks/access";
import { createFileSlot, purgeStaleTaskFiles, removeFile, toFileDto, verifyFile } from "@/server/tasks/files";
import { POST as slotPost } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/tasks/[taskId]/files/route";
import { DELETE as fileDelete, POST as filePost } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/tasks/[taskId]/files/[fileId]/route";

const MANAGER: PermissionKey[] = ["brand.read", "tasks.read", "tasks.manage"];
const scopeOf = (perms: PermissionKey[], userId = "u1", clientReviewer = false) => ({ workspaceId: "w1", brandId: "b1", userId, perms: new Set(perms), clientReviewer });
const manager = scopeOf(MANAGER);
// The task's owner with tasks.read only: documents need no content.create.
const readerOwner = scopeOf(["brand.read", "tasks.read"], "u2");
const stranger = scopeOf(["brand.read", "tasks.read"], "u3");
const clientOwner = scopeOf(["brand.read", "tasks.read"], "u2", true);
let routeScope = manager;

const UP = "w1/b1/task-files/uploads/abc.pdf";
const PDF = Buffer.from("%PDF-1.7\nbody");
const NOW = new Date("2026-11-27T10:00:00Z");
const fileRow = (o: Record<string, unknown> = {}) => ({
  id: "f1", workspaceId: "w1", brandId: "b1", taskId: "t1", key: UP, status: "PENDING", contentType: "application/pdf", fileName: "Devis été.pdf", bytes: PDF.length, createdById: "u1", createdAt: NOW, ...o,
});
const audits = () => db.auditEvent.create.mock.calls.map((c) => c[0].data as Record<string, unknown>);
const params = (o: Record<string, string> = {}) => ({ params: Promise.resolve({ workspaceId: "w1", brandId: "b1", taskId: "t1", fileId: "f1", ...o }) });
const req = (method: string, body?: unknown) => new Request("http://x/api", { method, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  s.objects.clear();
  routeScope = manager;
  db.$queryRaw.mockResolvedValue([{ id: "t1" }]);
  db.task.findUnique.mockResolvedValue({ title: "Quote", ownerId: "u2", createdById: "u1" });
  db.taskFile.count.mockResolvedValue(0);
  db.taskFile.create.mockImplementation(async ({ data }: { data: object }) => fileRow(data as Record<string, unknown>));
  db.taskFile.updateMany.mockResolvedValue({ count: 1 });
  db.taskFile.findFirst.mockResolvedValue(fileRow());
  db.taskFile.findUniqueOrThrow.mockImplementation(async () => fileRow({ status: "VERIFIED", key: "w1/b1/task-files/abc.pdf" }));
  db.taskFile.deleteMany.mockResolvedValue({ count: 1 });
  db.auditEvent.create.mockResolvedValue({ id: "a1" });
  s.limit.mockResolvedValue({ allowed: true });
  s.presign.mockResolvedValue("https://put");
  s.signed.mockImplementation(async (key: string, _s: number, as?: string, type?: string) => `https://get/${key}?as=${as}&type=${type}`);
  s.del.mockResolvedValue(undefined);
  s.put.mockResolvedValue(undefined);
  s.authorize.mockImplementation(async (_r: Request, _p: unknown, key: PermissionKey) => {
    if (!routeScope.perms.has(key)) throw new AccessDeniedError(`Missing permission ${key}`);
    return routeScope;
  });
});

const slot = (scope = manager, body: unknown = { fileName: "Devis été.pdf", contentType: "application/pdf", bytes: PDF.length }) => createFileSlot(scope, taskViewer(scope), "t1", body);

describe("upload slot", () => {
  it("a PENDING row under the task's folder, a signed PUT for that type and size", async () => {
    const out = await slot();
    const data = db.taskFile.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ workspaceId: "w1", brandId: "b1", taskId: "t1", contentType: "application/pdf", fileName: "Devis été.pdf", bytes: PDF.length, createdById: "u1" });
    expect(data.key).toMatch(/^w1\/b1\/task-files\/uploads\/[0-9a-f-]{36}\.pdf$/);
    expect(s.presign).toHaveBeenCalledWith(data.key, "application/pdf", PDF.length, 600);
    expect(out).toEqual({ fileId: "f1", url: "https://put", headers: { "Content-Type": "application/pdf" } });
    expect(db.$executeRaw).toHaveBeenCalled(); // the task's lock
  });

  it("the owner with tasks.read alone may add one", async () => {
    await expect(slot(readerOwner)).resolves.toMatchObject({ fileId: "f1" });
  });

  it("refuses a type not on the list, a size over 25 MB, a full task, a stranger, a client owner, and past the hour's limit", async () => {
    await expect(slot(manager, { fileName: "x.html", contentType: "text/html", bytes: 10 })).rejects.toMatchObject({ status: 400 });
    await expect(slot(manager, { fileName: "x.pdf", contentType: "application/pdf", bytes: 25 * 1024 * 1024 + 1 })).rejects.toMatchObject({ status: 413 });
    await expect(slot(manager, { fileName: "x.pdf", contentType: "application/pdf", bytes: 0 })).rejects.toMatchObject({ status: 400 });
    db.taskFile.count.mockResolvedValueOnce(20);
    await expect(slot()).rejects.toMatchObject({ status: 409 });
    await expect(slot(stranger)).rejects.toMatchObject({ status: 403 });
    await expect(slot(clientOwner)).rejects.toMatchObject({ status: 403 });
    s.limit.mockResolvedValueOnce({ allowed: false });
    await expect(slot()).rejects.toMatchObject({ status: 429 });
    expect(db.taskFile.create).not.toHaveBeenCalled();
  });

  it("the route: 201 with the slot; without tasks.read 403", async () => {
    const res = await slotPost(req("POST", { fileName: "a.pdf", contentType: "application/pdf", bytes: 5 }), params());
    expect(res.status).toBe(201);
    routeScope = scopeOf(["brand.read"]);
    expect((await slotPost(req("POST", {}), params())).status).toBe(403);
  });
});

describe("verify", () => {
  const verify = (scope = manager) => verifyFile(scope, taskViewer(scope), "t1", "f1");

  it("claims the person's own fresh slot, checks the bytes, stores them under the verified type and audits", async () => {
    s.objects.set(UP, PDF);
    const dto = await verify();
    const claim = db.taskFile.updateMany.mock.calls[0]![0];
    expect(claim.where).toMatchObject({ id: "f1", taskId: "t1", workspaceId: "w1", brandId: "b1", createdById: "u1", status: "PENDING" });
    expect(claim.where.createdAt.gt).toBeInstanceOf(Date);
    expect(s.put).toHaveBeenCalledWith("w1/b1/task-files/abc.pdf", PDF, "application/pdf");
    expect(s.del).toHaveBeenCalledWith(UP);
    expect(db.taskFile.updateMany.mock.calls[1]![0]).toEqual({ where: { id: "f1", status: "CHECKING" }, data: { status: "VERIFIED", key: "w1/b1/task-files/abc.pdf" } });
    expect(audits()[0]).toMatchObject({ action: "task.file.add", entityId: "t1", metadata: { title: "Quote", fileId: "f1", contentType: "application/pdf" } });
    expect(dto).toMatchObject({ id: "f1", fileName: "Devis été.pdf", url: "https://get/w1/b1/task-files/abc.pdf?as=Devis-ete.pdf&type=application/pdf" });
  });

  it("text is stored and served as UTF-8", async () => {
    db.taskFile.findFirst.mockResolvedValueOnce(fileRow({ contentType: "text/csv", key: "w1/b1/task-files/uploads/abc.csv", bytes: 4 }));
    s.objects.set("w1/b1/task-files/uploads/abc.csv", Buffer.from("a,b\n"));
    await verify();
    expect(s.put).toHaveBeenCalledWith("w1/b1/task-files/abc.csv", expect.anything(), "text/csv; charset=utf-8");
  });

  it("a file that isn't what was announced is refused (400) and leaves nothing behind", async () => {
    s.objects.set(UP, Buffer.from("<html>!!!!!"));
    db.taskFile.findFirst.mockResolvedValueOnce(fileRow({ bytes: 11 }));
    await expect(verify()).rejects.toMatchObject({ status: 400 });
    expect(s.put).not.toHaveBeenCalled();
    expect(s.del).toHaveBeenCalledWith(UP);
    expect(s.del).toHaveBeenCalledWith("w1/b1/task-files/abc.pdf");
    expect(db.taskFile.deleteMany).toHaveBeenCalledWith({ where: { id: "f1", status: "CHECKING" } });
    expect(audits()).toEqual([]);
  });

  it("bigger or smaller than announced, or never uploaded → 400", async () => {
    s.objects.set(UP, Buffer.concat([PDF, Buffer.from("x")]));
    await expect(verify()).rejects.toMatchObject({ status: 400, message: "The file is bigger than announced." });
    s.objects.set(UP, PDF.subarray(0, 5));
    await expect(verify()).rejects.toMatchObject({ status: 400, message: "The file isn't the size that was announced." });
    s.objects.clear();
    await expect(verify()).rejects.toMatchObject({ status: 400, message: "The file didn't arrive. Try again." });
  });

  it("someone else's slot, or one on another task, is not found; a used or old slot is a 409; a client is refused", async () => {
    db.taskFile.updateMany.mockResolvedValueOnce({ count: 0 });
    db.taskFile.findFirst.mockResolvedValueOnce(null);
    await expect(verify()).rejects.toMatchObject({ status: 404 });
    db.taskFile.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(verify()).rejects.toMatchObject({ status: 409 });
    await expect(verify(clientOwner)).rejects.toMatchObject({ status: 403 });
    expect(s.put).not.toHaveBeenCalled();
  });

  it("the route answers { file } with 201", async () => {
    s.objects.set(UP, PDF);
    const res = await filePost(req("POST"), params());
    expect(res.status).toBe(201);
    expect((await res.json()).file.id).toBe("f1");
  });
});

describe("remove", () => {
  it("only this task's verified file, scoped to the brand; the row, the audit, then the object", async () => {
    db.taskFile.findFirst.mockResolvedValueOnce({ key: "w1/b1/task-files/abc.pdf" });
    await removeFile(manager, taskViewer(manager), "t1", "f1");
    expect(db.taskFile.findFirst.mock.calls[0]![0].where).toEqual({ id: "f1", taskId: "t1", workspaceId: "w1", brandId: "b1", status: "VERIFIED" });
    expect(db.taskFile.delete).toHaveBeenCalledWith({ where: { id: "f1" } });
    expect(audits()[0]).toMatchObject({ action: "task.file.remove", metadata: { fileId: "f1" } });
    expect(s.del).toHaveBeenCalledWith("w1/b1/task-files/abc.pdf");
  });

  it("another task's file → 404; a client → 403; the route answers 204", async () => {
    db.taskFile.findFirst.mockResolvedValueOnce(null);
    await expect(removeFile(manager, taskViewer(manager), "t1", "f-other")).rejects.toMatchObject({ status: 404 });
    await expect(removeFile(clientOwner, taskViewer(clientOwner), "t1", "f1")).rejects.toMatchObject({ status: 403 });
    expect(db.taskFile.delete).not.toHaveBeenCalled();
    db.taskFile.findFirst.mockResolvedValueOnce({ key: "k" });
    expect((await fileDelete(req("DELETE"), params())).status).toBe(204);
  });
});

describe("download link and sweep", () => {
  it("a file always downloads under a plain name with the verified type", async () => {
    await toFileDto(fileRow({ status: "VERIFIED", key: "w1/b1/task-files/x.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", fileName: "_契約.docx" }) as never);
    expect(s.signed).toHaveBeenCalledWith("w1/b1/task-files/x.docx", 3600, "file.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("the sweep removes day-old unfinished slots, the row first, then both keys", async () => {
    db.taskFile.findMany.mockResolvedValueOnce([{ id: "f1", key: UP }]);
    expect(await purgeStaleTaskFiles(NOW)).toBe(1);
    const where = db.taskFile.findMany.mock.calls[0]![0].where;
    expect(where.status).toEqual({ in: ["PENDING", "CHECKING"] });
    expect(where.createdAt.lt).toEqual(new Date(NOW.getTime() - 86_400_000));
    expect(s.del.mock.calls.map((c) => c[0])).toEqual([UP, "w1/b1/task-files/abc.pdf"]);
  });
});
