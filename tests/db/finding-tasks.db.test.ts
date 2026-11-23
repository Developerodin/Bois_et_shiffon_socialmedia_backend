import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/db/prisma";
import type { PermissionKey } from "@/server/auth/permissions.catalog";
import { taskViewer } from "@/server/tasks/access";
import { clearFindings, fileFindingTasks, taskFromFinding, tasksFromReport } from "@/server/seo/finding-tasks";

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

describe("tasks from a report", () => {
  let brandId: string;
  let runId: string;
  let at = Date.parse("2026-11-01T06:00:00Z");
  const f = (id: string, o: Record<string, unknown> = {}) => ({ id, category: "On-page", severity: "high", title: `Fix ${id}`, detail: "d", fix: "f", ...o });
  /** A report, each one newer than the last. */
  const save = async (kind: "SEO" | "GEO", findings: object[], agentRunId: string | null = runId) =>
    (await prisma.auditReport.create({ data: { workspaceId: scope.workspaceId, brandId, kind, score: 50, summary: "s", findings, metrics: {}, agentRunId, createdAt: new Date((at += 3_600_000)) } })).id;
  const run = (reportId: string) => tasksFromReport({ workspaceId: scope.workspaceId, brandId, reportId });
  const tasksOf = (findingId: string) => prisma.task.findMany({ where: { brandId, findingId }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    brandId = (await prisma.brand.create({ data: { workspaceId: scope.workspaceId, slug: "from-report", displayName: "R" } })).id;
    runId = (await prisma.agentRun.create({ data: { workspaceId: scope.workspaceId, brandId, agentKey: "seo", trigger: "manual", triggeredByUserId: scope.userId, createdAt: new Date(at) } })).id;
  });

  it("makes one system task per finding, and nothing on a second run", async () => {
    const reportId = await save("SEO", [f("a", { urls: ["https://x.com/a"] }), f("b")]);
    await run(reportId);
    await run(reportId);
    const tasks = await prisma.task.findMany({ where: { brandId }, orderBy: { findingId: "asc" } });
    expect(tasks.map((t) => [t.findingId, t.findingKind, t.status, t.createdById, t.ownerId, t.reviewerId, t.dueOn, t.auditReportId])).toEqual([
      ["a", "SEO", "TODO", null, null, null, null, reportId],
      ["b", "SEO", "TODO", null, null, null, null, reportId],
    ]);
    expect(tasks[0]).toMatchObject({ areas: ["SEO", "WEBSITE"], findingUrls: ["https://x.com/a"] });
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: tasks[0]!.id, action: "task.create" } });
    expect(audit.actorUserId).toBeNull();
    expect(audit.metadata).toEqual({ title: "Fix a", auditReportId: reportId, findingId: "a", source: "audit", agentRunId: runId, triggeredByUserId: scope.userId });
  });

  it("a cancelled finding is not made again; a finding done before the run but still reported is", async () => {
    const [a] = await tasksOf("a");
    const [b] = await tasksOf("b");
    await prisma.task.update({ where: { id: a!.id }, data: { status: "CANCELLED" } });
    await prisma.task.update({ where: { id: b!.id }, data: { status: "DONE", completedAt: new Date(at - 86_400_000) } });
    await run(await save("SEO", [f("a"), f("b")]));
    expect((await tasksOf("a")).map((t) => t.status)).toEqual(["CANCELLED"]);
    expect((await tasksOf("b")).map((t) => t.status)).toEqual(["DONE", "TODO"]);
  });

  it("a finding finished since the run started, or waiting for a re-check, is not made again", async () => {
    const newRun = (await prisma.agentRun.create({ data: { workspaceId: scope.workspaceId, brandId, agentKey: "seo", trigger: "schedule", createdAt: new Date(at + 60_000) } })).id;
    const [, b] = await tasksOf("b");
    await prisma.task.update({ where: { id: b!.id }, data: { status: "DONE", completedAt: new Date(at + 120_000) } });
    await prisma.task.create({ data: { workspaceId: scope.workspaceId, brandId, title: "c", status: "DONE", completedAt: new Date(at - 86_400_000), recheckOn: new Date(Date.now() + 86_400_000), findingKind: "SEO", findingId: "c" } });
    await run(await save("SEO", [f("b"), f("c")], newRun));
    expect(await tasksOf("b")).toHaveLength(2);
    expect(await tasksOf("c")).toHaveLength(1);
  });

  it("an older report does nothing once a newer one exists", async () => {
    const older = await save("SEO", [f("d")]);
    await save("SEO", []);
    await run(older);
    expect(await tasksOf("d")).toHaveLength(0);
  });

  it("GEO findings become GEO tasks", async () => {
    await run(await save("GEO", [f("llms-txt-missing")]));
    expect((await tasksOf("llms-txt-missing")).map((t) => t.findingKind)).toEqual(["GEO"]);
  });

  it("a Make a task click that wins the race doesn't fail the job", async () => {
    const reportId = await save("SEO", [f("e")]);
    const original = prisma.$transaction.bind(prisma);
    vi.spyOn(prisma, "$transaction").mockImplementationOnce((async (...args: Parameters<typeof original>) => {
      await taskFromFinding({ ...scope, brandId }, taskViewer({ ...scope, brandId }), reportId, "e");
      return original(...args);
    }) as typeof prisma.$transaction);
    await run(reportId);
    expect((await tasksOf("e")).map((t) => t.createdById)).toEqual([scope.userId]);
  });

  it("a newer GEO review replaces the untouched tasks of the last one, never one a person took up", async () => {
    const review = (title: string) => f(`content-${title}`, { category: "Content (AI review)", title });
    await run(await save("GEO", [review("old-a"), review("old-b"), review("kept")]));
    const [taken] = await tasksOf("content-old-b");
    await prisma.task.update({ where: { id: taken!.id }, data: { ownerId: scope.userId } });
    const byHand = await prisma.task.create({ data: { workspaceId: scope.workspaceId, brandId, title: "h", findingKind: "GEO", findingId: "content-by-hand", createdById: scope.userId } });
    await run(await save("GEO", [review("kept"), review("new")]));
    const open = await prisma.task.findMany({ where: { brandId, findingId: { startsWith: "content-" }, status: "TODO" }, select: { findingId: true } });
    expect(open.map((t) => t.findingId).sort()).toEqual(["content-by-hand", "content-kept", "content-new", "content-old-b"]);
    const [replaced] = await tasksOf("content-old-a");
    expect(replaced!.status).toBe("CANCELLED");
    expect(await prisma.taskComment.findMany({ where: { taskId: replaced!.id }, select: { kind: true, body: true } })).toEqual([{ kind: "SYSTEM", body: expect.stringMatching(/^Replaced by the \d{4}-\d{2}-\d{2} GEO review$/) }]);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: byHand.id } })).status).toBe("TODO");
  });

  it("a review task the system replaced comes back when a later review names it again", async () => {
    await run(await save("GEO", [f("content-old-a", { category: "Content (AI review)", title: "old-a" })]));
    expect((await tasksOf("content-old-a")).map((t) => t.status)).toEqual(["CANCELLED", "TODO"]);
  });

  it("the 50 cap counts only findings that get a task, so the rest come with the next report", async () => {
    const many = Array.from({ length: 51 }, (_, i) => f(`cap-${String(i).padStart(2, "0")}`));
    await run(await save("SEO", many));
    expect(await prisma.task.count({ where: { brandId, findingId: { startsWith: "cap-" } } })).toBe(50);
    await run(await save("SEO", many));
    expect(await tasksOf("cap-50")).toHaveLength(1);
  });

  it("Make all tasks files the report's findings as the person's tasks, once; an older report is refused", async () => {
    const reportId = await save("SEO", [f("bulk-a"), f("bulk-b")]);
    const ids = { workspaceId: scope.workspaceId, brandId, reportId };
    expect(await fileFindingTasks(ids, scope.userId)).toBe(2);
    expect(await fileFindingTasks(ids, scope.userId)).toBe(0);
    expect((await tasksOf("bulk-a")).map((t) => t.createdById)).toEqual([scope.userId]);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: (await tasksOf("bulk-a"))[0]!.id, action: "task.create" } });
    expect(audit).toMatchObject({ actorUserId: scope.userId, metadata: expect.objectContaining({ source: "report-page" }) });
    await save("SEO", []);
    expect(await fileFindingTasks(ids, scope.userId)).toBeNull();
  });
});
