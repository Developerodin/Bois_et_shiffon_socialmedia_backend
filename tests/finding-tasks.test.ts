import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const db = vi.hoisted(() => {
  const d = {
    auditReport: { findFirst: vi.fn(), create: vi.fn() },
    task: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    taskComment: { createMany: vi.fn() },
    taskChecklistItem: { groupBy: vi.fn(async () => []), findMany: vi.fn(async () => []) },
    taskAttachment: { findMany: vi.fn(async () => []) },
    taskFile: { findMany: vi.fn(async () => []) },
    auditEvent: { create: vi.fn(), createMany: vi.fn() },
    job: { create: vi.fn(), upsert: vi.fn() },
    workspaceMember: { findFirst: vi.fn(), findMany: vi.fn(async () => []) },
    brandMember: { findFirst: vi.fn(), findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(),
  };
  d.$transaction.mockImplementation(async (fn: (tx: typeof d) => unknown) => fn(d));
  return d;
});
const m = vi.hoisted(() => ({ people: vi.fn(async () => ({ viaWorkspace: [], people: [], invitations: [] })), authorize: vi.fn() }));
vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/services/project-members", () => ({ listProjectPeople: m.people }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: m.authorize }));

import { AccessDeniedError } from "@/server/auth/errors";
import type { PermissionKey } from "@/server/auth/permissions.catalog";
import { taskViewer } from "@/server/tasks/access";
import { clearFindings, FINDING_CLEAR_JOB, FINDING_TASKS_JOB, isAutoClearable, isPositionalFindingId, taskFromFinding } from "@/server/seo/finding-tasks";
import { saveAuditReport } from "@/server/services/audit-reports";
import { POST as makeTask } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/audit-reports/[reportId]/findings/[findingId]/task/route";

const MANAGER: PermissionKey[] = ["brand.read", "tasks.read", "tasks.manage"];
let scope = { workspaceId: "w1", brandId: "b1", userId: "u1", perms: new Set<PermissionKey>(MANAGER), clientReviewer: false };
const v = () => taskViewer(scope);

const finding = (o: Record<string, unknown> = {}) => ({ id: "title-missing", category: "On-page", severity: "high", title: "Pages without a title", detail: "The title matters.", fix: "Add a title.", ...o });
const report = (o: Record<string, unknown> = {}) => ({
  id: "r1", workspaceId: "w1", brandId: "b1", kind: "SEO", findings: [finding({ urls: ["https://x.com/a"] })],
  metrics: { pagesChecked: ["https://x.com/", "https://x.com/a"] }, createdAt: new Date("2026-11-23T08:00:00Z"), ...o,
});
const taskRow = (o: Record<string, unknown> = {}) => ({
  id: "t1", workspaceId: "w1", brandId: "b1", title: "Pages without a title", description: null, status: "TODO", priority: "NORMAL", areas: ["SEO"],
  ownerId: null, reviewerId: null, createdById: "u1", dueOn: null, blockedReason: null, blockedOnId: null, workProjectId: null, contentItemId: null,
  url: null, changeKind: null, acceptanceCriteria: null, previewUrl: null, checkedLiveAt: null, checkedLiveById: null, auditReportId: "r1",
  findingKind: "SEO", findingId: "title-missing", findingUrls: [], findingClearedAt: null, recheckOn: null, completedAt: null, requestId: null,
  createdAt: new Date(), updatedAt: new Date(), workProject: null, contentItem: null, ...o,
});
const candidate = (o: Record<string, unknown> = {}) => ({ id: "t1", title: "Old issue", status: "TODO", reviewerId: null as string | null, findingId: "gone", findingUrls: [] as string[], ...o });
const updateIds = () => {
  const call = db.$queryRaw.mock.calls.find((c) => (c[0] as string[]).join("?").includes(`UPDATE "Task"`));
  return call ? (call as unknown[]).slice(1).find(Array.isArray) : undefined;
};
const comments = () => db.taskComment.createMany.mock.calls.flatMap((c) => c[0].data as { taskId: string; kind: string; body: string }[]);

beforeEach(() => {
  vi.clearAllMocks();
  scope = { workspaceId: "w1", brandId: "b1", userId: "u1", perms: new Set<PermissionKey>(MANAGER), clientReviewer: false };
  db.auditReport.findFirst.mockResolvedValue(report());
  db.task.findFirst.mockResolvedValue(null);
  db.task.findMany.mockResolvedValue([]);
  db.task.create.mockImplementation(async ({ data }: { data: object }) => ({ id: "t1", ...data }));
  db.task.findUnique.mockResolvedValue(taskRow());
  db.$queryRaw.mockImplementation(async (strings: string[], ...vals: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes(`UPDATE "Task"`)) return (vals.find(Array.isArray) as string[]).map((id) => ({ id }));
    return [{ id: "t1" }];
  });
  db.auditEvent.create.mockResolvedValue({ id: "a1" });
  m.authorize.mockImplementation(async (_r: Request, _p: unknown, key: PermissionKey) => {
    if (!scope.perms.has(key)) throw new AccessDeniedError(`Missing permission ${key}`);
    return scope;
  });
});

describe("taskFromFinding", () => {
  it("makes an SEO + website task with the finding's pages", async () => {
    const { existed } = await taskFromFinding(scope, v(), "r1", "title-missing");
    expect(existed).toBe(false);
    const data = db.task.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      workspaceId: "w1", brandId: "b1", title: "Pages without a title", areas: ["SEO", "WEBSITE"], findingKind: "SEO", findingId: "title-missing",
      findingUrls: ["https://x.com/a"], url: "https://x.com/a", auditReportId: "r1", createdById: "u1",
    });
    expect(data.description).toContain("The title matters.");
    expect(data.description).toContain("Add a title.");
    expect(data.description).toContain("https://x.com/a");
    expect(db.auditEvent.create.mock.calls[0]![0].data).toMatchObject({ action: "task.create", entityId: "t1" });
  });

  it("a site-wide finding is SEO only, with no pages", async () => {
    db.auditReport.findFirst.mockResolvedValue(report({ findings: [finding({ id: "sitemap-missing" })] }));
    await taskFromFinding(scope, v(), "r1", "sitemap-missing");
    expect(db.task.create.mock.calls[0]![0].data).toMatchObject({ areas: ["SEO"], findingUrls: [], url: null, findingKind: "SEO", findingId: "sitemap-missing" });
  });

  it("second click opens the existing task", async () => {
    db.task.findFirst.mockResolvedValue({ id: "t7" });
    db.task.findUnique.mockResolvedValue(taskRow({ id: "t7" }));
    const { task, existed } = await taskFromFinding(scope, v(), "r1", "title-missing");
    expect(existed).toBe(true);
    expect(task.id).toBe("t7");
    expect(db.task.create).not.toHaveBeenCalled();
    expect(db.task.findFirst.mock.calls[0]![0].where).toMatchObject({ workspaceId: "w1", brandId: "b1", findingKind: "SEO", findingId: "title-missing", status: { in: ["TODO", "IN_PROGRESS", "IN_REVIEW"] } });
  });

  it("a race on the unique index returns the winner", async () => {
    db.task.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("Unique", { code: "P2002", clientVersion: "x" }));
    db.task.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "t8" });
    db.task.findUnique.mockResolvedValue(taskRow({ id: "t8" }));
    const { task, existed } = await taskFromFinding(scope, v(), "r1", "title-missing");
    expect({ id: task.id, existed }).toEqual({ id: "t8", existed: true });
  });

  it("a positional finding only reuses an open task made from the same report", async () => {
    db.auditReport.findFirst.mockResolvedValue(report({ kind: "GEO", findings: [finding({ id: "content-1" })] }));
    await taskFromFinding(scope, v(), "r1", "content-1");
    expect(db.task.findFirst.mock.calls[0]![0].where).toMatchObject({ findingKind: "GEO", findingId: "content-1", auditReportId: "r1" });
    expect(db.task.create).toHaveBeenCalled();
  });

  it("a stable finding reuses an open task from any report", async () => {
    await taskFromFinding(scope, v(), "r1", "title-missing");
    expect(db.task.findFirst.mock.calls[0]![0].where).not.toHaveProperty("auditReportId");
  });

  it("a positional finding held by an older report's open task → 409", async () => {
    db.auditReport.findFirst.mockResolvedValue(report({ kind: "GEO", findings: [finding({ id: "content-1" })] }));
    db.task.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("Unique", { code: "P2002", clientVersion: "x" }));
    const err = await taskFromFinding(scope, v(), "r1", "content-1").catch((e) => e);
    expect(err).toMatchObject({ status: 409 });
  });

  it("another brand's report → 404", async () => {
    db.auditReport.findFirst.mockResolvedValue(null);
    const err = await taskFromFinding(scope, v(), "r9", "title-missing").catch((e) => e);
    expect(err).toMatchObject({ status: 404 });
    expect(db.auditReport.findFirst.mock.calls[0]![0].where).toEqual({ id: "r9", workspaceId: "w1", brandId: "b1" });
    expect(db.task.create).not.toHaveBeenCalled();
  });

  it("an unknown finding → 404", async () => {
    const err = await taskFromFinding(scope, v(), "r1", "nope").catch((e) => e);
    expect(err).toMatchObject({ status: 404 });
  });

  it("route needs tasks.manage → 403", async () => {
    scope = { ...scope, perms: new Set<PermissionKey>(["brand.read", "tasks.read"]) };
    const res = await makeTask(new Request("http://x/api", { method: "POST" }), { params: Promise.resolve({ workspaceId: "w1", brandId: "b1", reportId: "r1", findingId: "title-missing" }) });
    expect(res.status).toBe(403);
  });
});

describe("finding id rules", () => {
  it("only the old numbered AI-review ids are positional", () => {
    expect(isPositionalFindingId("content-1")).toBe(true);
    expect(isPositionalFindingId("content-12")).toBe(true);
    expect(isPositionalFindingId("content-missing-faq")).toBe(false);
    expect(isPositionalFindingId("title-missing")).toBe(false);
  });

  it("no AI-review id is cleared by a later audit", () => {
    expect(isAutoClearable("content-1")).toBe(false);
    expect(isAutoClearable("content-missing-faq")).toBe(false);
    expect(isAutoClearable("title-missing")).toBe(true);
    expect(isAutoClearable("not-recommended")).toBe(true);
  });
});

describe("clearFindings", () => {
  const payload = { workspaceId: "w1", brandId: "b1", reportId: "r1" };

  it("closes when the finding is gone and pages were re-read", async () => {
    db.task.findMany.mockResolvedValue([candidate({ findingUrls: ["https://x.com/a"] }), candidate({ id: "t2", findingId: "sitemap-missing", findingUrls: [] })]);
    await clearFindings(payload);
    expect(db.task.findMany.mock.calls[0]![0].where).toMatchObject({ workspaceId: "w1", brandId: "b1", findingKind: "SEO", status: { in: ["TODO", "IN_PROGRESS", "IN_REVIEW"] } });
    expect(updateIds()).toEqual(["t1", "t2"]);
    expect(comments().map((c) => [c.taskId, c.kind, c.body])).toEqual([
      ["t1", "SYSTEM", "The 2026-11-23 audit no longer finds this"],
      ["t2", "SYSTEM", "The 2026-11-23 audit no longer finds this"],
    ]);
    const audits = db.auditEvent.createMany.mock.calls[0]![0].data as { action: string; entityId: string; actorUserId: string | null }[];
    expect(audits.map((a) => [a.action, a.entityId, a.actorUserId])).toEqual([
      ["task.cleared-by-audit", "t1", null],
      ["task.cleared-by-audit", "t2", null],
    ]);
  });

  it("keeps tasks whose pages were not re-read", async () => {
    db.task.findMany.mockResolvedValue([candidate({ findingUrls: ["https://x.com/a", "https://x.com/b"] })]);
    await clearFindings(payload);
    expect(updateIds()).toBeUndefined();
    expect(db.taskComment.createMany).not.toHaveBeenCalled();
  });

  it("keeps tasks whose finding is still reported", async () => {
    db.task.findMany.mockResolvedValue([candidate({ findingId: "title-missing", findingUrls: ["https://x.com/a"] })]);
    await clearFindings(payload);
    expect(updateIds()).toBeUndefined();
  });

  it("never closes a task in review", async () => {
    db.task.findMany.mockResolvedValue([candidate({ status: "IN_REVIEW" })]);
    await clearFindings(payload);
    expect(updateIds()).toBeUndefined();
    expect(comments()).toEqual([expect.objectContaining({ taskId: "t1", kind: "SYSTEM" })]);
    expect(db.auditEvent.createMany).not.toHaveBeenCalled();
  });

  it("never closes a task with a reviewer: comment only, it finishes by approval", async () => {
    db.task.findMany.mockResolvedValue([candidate({ reviewerId: "u2" }), candidate({ id: "t2", status: "IN_PROGRESS", reviewerId: "u3" })]);
    await clearFindings(payload);
    expect(updateIds()).toBeUndefined();
    expect(comments().map((c) => [c.taskId, c.kind, c.body])).toEqual([
      ["t1", "SYSTEM", "The 2026-11-23 audit no longer finds this. It stays open until the reviewer approves it."],
      ["t2", "SYSTEM", "The 2026-11-23 audit no longer finds this. It stays open until the reviewer approves it."],
    ]);
    expect(db.auditEvent.createMany).not.toHaveBeenCalled();
  });

  it("the close re-checks that no reviewer was set since the read", async () => {
    db.task.findMany.mockResolvedValue([candidate()]);
    await clearFindings(payload);
    expect((db.$queryRaw.mock.calls[0]![0] as string[]).join("?")).toContain('"reviewerId" IS NULL');
  });

  it("locks each task in id order and decides from a second read under the locks", async () => {
    db.task.findMany.mockResolvedValueOnce([candidate({ id: "t2" }), candidate({ id: "t1" })]).mockResolvedValueOnce([candidate({ id: "t1", status: "IN_REVIEW", reviewerId: "u2" }), candidate({ id: "t2" })]);
    await clearFindings(payload);
    const locks = db.$executeRaw.mock.calls.map((c) => (c as unknown[]).slice(1).join());
    expect(locks).toEqual(["task:t1", "task:t2"]);
    expect(db.task.findMany.mock.calls[1]![0].where).toMatchObject({ id: { in: ["t1", "t2"] } });
    expect(updateIds()).toEqual(["t2"]);
    expect(comments().map((c) => [c.taskId, c.body])).toEqual([
      ["t2", "The 2026-11-23 audit no longer finds this"],
      ["t1", "The 2026-11-23 audit no longer finds this. It stays in review until the reviewer decides."],
    ]);
  });

  it("a task finished since the first read gets nothing", async () => {
    db.task.findMany.mockResolvedValueOnce([candidate({ status: "IN_REVIEW" })]).mockResolvedValueOnce([]);
    await clearFindings(payload);
    expect(updateIds()).toBeUndefined();
    expect(db.taskComment.createMany).not.toHaveBeenCalled();
  });

  it("only the tasks the update returned get comments and audits", async () => {
    db.task.findMany.mockResolvedValue([candidate(), candidate({ id: "t2" })]);
    db.$queryRaw.mockResolvedValue([{ id: "t2" }]);
    await clearFindings(payload);
    expect(comments().map((c) => c.taskId)).toEqual(["t2"]);
    expect((db.auditEvent.createMany.mock.calls[0]![0].data as { entityId: string }[]).map((a) => a.entityId)).toEqual(["t2"]);
  });

  it("a GEO AI-review task (title id) is never cleared", async () => {
    db.auditReport.findFirst.mockResolvedValue(report({ kind: "GEO", findings: [], metrics: { pagesChecked: ["https://x.com/"], visibilityMeasured: true } }));
    db.task.findMany.mockResolvedValue([candidate({ findingId: "content-missing-faq" })]);
    await clearFindings(payload);
    expect(updateIds()).toBeUndefined();
    expect(db.taskComment.createMany).not.toHaveBeenCalled();
  });

  it("keeps GEO's not-recommended task when visibility wasn't measured", async () => {
    db.auditReport.findFirst.mockResolvedValue(report({ kind: "GEO", findings: [], metrics: { pagesChecked: ["https://x.com/"] } }));
    db.task.findMany.mockResolvedValue([candidate({ findingId: "not-recommended" })]);
    await clearFindings(payload);
    expect(updateIds()).toBeUndefined();
  });

  it("closes GEO's not-recommended task once a measured report no longer finds it", async () => {
    db.auditReport.findFirst.mockResolvedValue(report({ kind: "GEO", findings: [], metrics: { pagesChecked: ["https://x.com/"], visibilityMeasured: true } }));
    db.task.findMany.mockResolvedValue([candidate({ findingId: "not-recommended" })]);
    await clearFindings(payload);
    expect(updateIds()).toEqual(["t1"]);
  });

  it("positional ids never clear", async () => {
    db.task.findMany.mockResolvedValue([candidate({ findingId: "content-1" })]);
    await clearFindings(payload);
    expect(updateIds()).toBeUndefined();
    expect(db.taskComment.createMany).not.toHaveBeenCalled();
  });

  it("keeps PageSpeed tasks when PageSpeed didn't run", async () => {
    db.auditReport.findFirst.mockResolvedValue(report({ findings: [], metrics: { pagesChecked: ["https://x.com/"], pageSpeed: null, pageSpeedError: "quota" } }));
    const t2 = candidate({ id: "t2", findingId: "sitemap-missing" });
    // The second read (under the locks) is of the tasks to clear only.
    db.task.findMany.mockResolvedValueOnce([candidate({ findingId: "pagespeed-performance" }), t2]).mockResolvedValueOnce([t2]);
    await clearFindings(payload);
    expect(db.task.findMany.mock.calls[1]![0].where.id).toEqual({ in: ["t2"] });
    expect(updateIds()).toEqual(["t2"]);
  });

  it("closes PageSpeed tasks when PageSpeed ran and no longer finds them", async () => {
    db.auditReport.findFirst.mockResolvedValue(report({ findings: [], metrics: { pagesChecked: ["https://x.com/"], pageSpeed: { performance: 95, seo: 100 } } }));
    db.task.findMany.mockResolvedValue([candidate({ findingId: "pagespeed-performance" })]);
    await clearFindings(payload);
    expect(updateIds()).toEqual(["t1"]);
  });

  it("a report that is gone does nothing", async () => {
    db.auditReport.findFirst.mockResolvedValue(null);
    await clearFindings(payload);
    expect(db.task.findMany).not.toHaveBeenCalled();
  });
});

describe("saveAuditReport", () => {
  const input = (kind: "SEO" | "GEO") => ({ workspaceId: "w1", brandId: "b1", kind, score: 80, summary: "s", findings: [], metrics: {}, agentRunId: "run1" });

  it.each(["SEO", "GEO"] as const)("a %s report queues the clear job and the make-tasks job", async (kind) => {
    db.auditReport.create.mockResolvedValue({ id: "r1" });
    await saveAuditReport(input(kind));
    const jobs = db.job.upsert.mock.calls.map((c) => c[0].create);
    const payload = { workspaceId: "w1", brandId: "b1", reportId: "r1" };
    expect(jobs).toEqual([
      expect.objectContaining({ type: FINDING_CLEAR_JOB, workspaceId: "w1", brandId: "b1", payload, idempotencyKey: "finding-clear:r1" }),
      expect.objectContaining({ type: FINDING_TASKS_JOB, workspaceId: "w1", brandId: "b1", payload, idempotencyKey: "finding-tasks:r1" }),
    ]);
  });
});
