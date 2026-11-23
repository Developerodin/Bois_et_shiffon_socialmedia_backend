import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/db/prisma";
import type { PermissionKey } from "@/server/auth/permissions.catalog";
import { taskViewer } from "@/server/tasks/access";
import { clearFindings, taskFromFinding } from "@/server/seo/finding-tasks";

/** Make-task races and the clear job against a real Postgres: the partial unique index and the status re-check. */
let scope: { workspaceId: string; brandId: string; userId: string; perms: Set<PermissionKey>; clientReviewer: boolean };
let reportId: string;
let laterReportId: string;

beforeAll(async () => {
  const ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-finding-tasks" } })).id;
  const brandId = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "B" } })).id;
  const userId = (await prisma.user.create({ data: { email: "manager@finding-tasks.test" } })).id;
  scope = { workspaceId: ws, brandId, userId, perms: new Set(["brand.read", "tasks.read", "tasks.manage"]), clientReviewer: false };
  const finding = { id: "title-missing", category: "On-page", severity: "high", title: "Pages without a title", detail: "d", fix: "f", urls: ["https://x.com/a"] };
  const base = { workspaceId: ws, brandId, kind: "SEO" as const, score: 50, summary: "s" };
  reportId = (await prisma.auditReport.create({ data: { ...base, findings: [finding], metrics: { pagesChecked: ["https://x.com/a"] } } })).id;
  laterReportId = (await prisma.auditReport.create({ data: { ...base, findings: [], metrics: { pagesChecked: ["https://x.com/a"] } } })).id;
});

afterEach(() => vi.restoreAllMocks());

describe("make a task from a finding", () => {
  it("concurrent make-task returns one", async () => {
    const v = taskViewer(scope);
    const [a, b] = await Promise.all([taskFromFinding(scope, v, reportId, "title-missing"), taskFromFinding(scope, v, reportId, "title-missing")]);
    expect(a.task.id).toBe(b.task.id);
    expect(await prisma.task.count({ where: { brandId: scope.brandId, findingId: "title-missing" } })).toBe(1);
  });
});

describe("clear job", () => {
  it("task moved to review mid-job is not closed, and is told it stays in review", async () => {
    const task = await prisma.task.findFirstOrThrow({ where: { brandId: scope.brandId, findingId: "title-missing" } });
    const original = prisma.$transaction.bind(prisma);
    // The candidates are read before this transaction opens: move the task to review in between.
    vi.spyOn(prisma, "$transaction").mockImplementationOnce((async (...args: Parameters<typeof original>) => {
      await prisma.task.update({ where: { id: task.id }, data: { status: "IN_REVIEW", reviewerId: scope.userId } });
      return original(...args);
    }) as typeof prisma.$transaction);
    await clearFindings({ workspaceId: scope.workspaceId, brandId: scope.brandId, reportId: laterReportId });
    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.status).toBe("IN_REVIEW");
    expect(after.findingClearedAt).toBeNull();
    expect(await prisma.auditEvent.count({ where: { entityId: task.id, action: "task.cleared-by-audit" } })).toBe(0);
    // Re-read under the lock: the comment matches what the task is now.
    const comments = await prisma.taskComment.findMany({ where: { taskId: task.id } });
    expect(comments.map((c) => c.body)).toEqual([expect.stringContaining("It stays in review until the reviewer decides.")]);
  });

  it("closes the task once the finding is gone and its page was re-read", async () => {
    const task = await prisma.task.findFirstOrThrow({ where: { brandId: scope.brandId, findingId: "title-missing" } });
    await prisma.taskComment.deleteMany({ where: { taskId: task.id } });
    await prisma.task.update({ where: { id: task.id }, data: { status: "TODO", reviewerId: null, blockedReason: "waiting", blockedOnId: scope.userId } });
    await clearFindings({ workspaceId: scope.workspaceId, brandId: scope.brandId, reportId: laterReportId });
    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after).toMatchObject({ status: "DONE", blockedReason: null, blockedOnId: null });
    expect(after.findingClearedAt).not.toBeNull();
    expect(await prisma.taskComment.count({ where: { taskId: task.id, kind: "SYSTEM" } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { entityId: task.id, action: "task.cleared-by-audit" } })).toBe(1);
  });
});
