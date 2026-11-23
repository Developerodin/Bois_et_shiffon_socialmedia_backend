import "server-only";
import type { AuditKind, Prisma, TaskArea } from "@prisma/client";
import { z } from "zod";
import type { Db } from "@/server/auth/permissions";
import { prisma } from "@/server/db/prisma";
import type { Finding } from "@/server/seo/checks";
import { lockRow, TX } from "@/server/services/publishing";
import type { TaskViewer } from "@/server/tasks/access";
import { taskAudit } from "@/server/tasks/audit";
import { taskStatusInSql } from "@/server/tasks/sql";
import { isUniqueViolation, TaskError } from "@/server/tasks/errors";
import { getTask, type TaskScope } from "@/server/tasks/service";
import { OPEN_TASK_STATUSES, safeHttpUrl, type TaskDto } from "@/shared";

/**
 * Findings a report may not have measured, whose absence says nothing: PageSpeed's (`pagespeed-*`) when PageSpeed
 * didn't run (metrics.pageSpeed null), and GEO's "not-recommended" when no real AI answered unbranded questions
 * (metrics.visibilityMeasured not true; reports from before it was stored count as not measured).
 */
function notMeasured(metrics: Prisma.JsonValue, findingId: string) {
  const m = metrics as { pageSpeed?: unknown; visibilityMeasured?: unknown } | null;
  return (findingId.startsWith("pagespeed-") && m?.pageSpeed == null) || (findingId === "not-recommended" && m?.visibilityMeasured !== true);
}

/** Runs after each SEO or GEO report is saved: closes the tasks of findings that audit no longer reports. */
export const FINDING_CLEAR_JOB = "tasks.clear-findings";
/** Runs after each SEO or GEO report is saved: a task for each finding that hasn't got one (tasksFromReport). */
export const FINDING_TASKS_JOB = "tasks.from-report";

/**
 * GEO's AI content review used to number its findings by position (`content-1`, `content-2`), so the same id named a
 * different finding in each report: such an id only matches a task made from the same report.
 */
export const isPositionalFindingId = (id: string) => /^content-\d+$/.test(id);

/**
 * May a later audit close this finding's task by not reporting it? Not the AI content review's (`content-*`): the AI
 * words its findings differently from run to run, so a missing title doesn't mean the issue is fixed.
 */
export const isAutoClearable = (id: string) => !id.startsWith("content-");

const OPEN = [...OPEN_TASK_STATUSES];
/** What the audit may close by itself: to do or in progress, never in review (a reviewer decides). */
const CLOSABLE_BY_AUDIT = taskStatusInSql(["TODO", "IN_PROGRESS"]);
const findingsOf = (json: Prisma.JsonValue) => (Array.isArray(json) ? (json as unknown as Finding[]) : []);

/** The finding as a task: detail, fix and its pages, within the task's text limits. */
function taskData(f: Finding) {
  const urls = f.urls ?? [];
  const pages = urls.length ? `\n\nPages:\n${urls.map((u) => `- ${u}`).join("\n")}` : "";
  const one = urls.length === 1 && urls[0]!.length <= 2_000 && safeHttpUrl(urls[0]!) ? urls[0]! : null;
  return {
    title: f.title.slice(0, 200),
    description: `${f.detail}\n\nFix: ${f.fix}${pages}`.slice(0, 10_000),
    areas: (urls.length ? ["SEO", "WEBSITE"] : ["SEO"]) as TaskArea[],
    findingUrls: urls,
    url: one,
  };
}

type ReportRef = { id: string; kind: AuditKind };
type FindingScope = { workspaceId: string; brandId: string };

/** The open task for (kind, findingId), if any; with `reportId`, only one made from that report. */
const openFindingTask = (db: Db, scope: FindingScope, kind: AuditKind, findingId: string, reportId?: string) =>
  db.task.findFirst({
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId, findingKind: kind, findingId, status: { in: OPEN }, ...(reportId ? { auditReportId: reportId } : {}) },
    select: { id: true },
  });

/**
 * The finding as a new task with its task.create audit event, in the caller's transaction. A null userId is the system
 * (an audit made it). Throws the unique violation of task_open_finding when the finding already has an open task.
 */
async function createFindingTask(tx: Db, scope: FindingScope & { userId: string | null }, report: ReportRef, finding: Finding, metadata?: Record<string, unknown>) {
  const task = await tx.task.create({
    data: { ...taskData(finding), workspaceId: scope.workspaceId, brandId: scope.brandId, createdById: scope.userId, auditReportId: report.id, findingKind: report.kind, findingId: finding.id },
    select: { id: true, title: true },
  });
  await taskAudit(tx, scope, "task.create", { type: "Task", id: task.id, title: task.title }, { auditReportId: report.id, findingId: finding.id, ...metadata });
  return task.id;
}

/**
 * "Make a task" on an audit finding (tasks.manage): the open task for (kind, findingId) if there is one, else a new one.
 * findingKind and findingId are always set together, so the one-open-task-per-finding index covers every such task;
 * two people clicking at once both get the task the index let through.
 */
export async function taskFromFinding(scope: TaskScope, v: TaskViewer, reportId: string, findingId: string): Promise<{ task: TaskDto; existed: boolean }> {
  const report = await prisma.auditReport.findFirst({ where: { id: reportId, workspaceId: scope.workspaceId, brandId: scope.brandId } });
  if (!report) throw new TaskError("Report not found", 404);
  const finding = findingsOf(report.findings).find((f) => f.id === findingId);
  if (!finding) throw new TaskError("Finding not found", 404);
  // A positional id names another finding in each report: only a task made from this same report is that finding's.
  const openTask = () => openFindingTask(prisma, scope, report.kind, findingId, isPositionalFindingId(findingId) ? report.id : undefined);
  const found = await openTask();
  if (found) return { task: await getTask(scope, v, found.id), existed: true };
  try {
    const id = await prisma.$transaction((tx) => createFindingTask(tx, scope, report, finding), TX);
    return { task: await getTask(scope, v, id), existed: false };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const winner = await openTask();
    // The index is per (kind, id), so an older report's open task with the same positional id blocks a new one.
    if (!winner) throw new TaskError("An open task from an earlier audit already uses this finding's number. Close it first.", 409, "task.findingTaken");
    return { task: await getTask(scope, v, winner.id), existed: true };
  }
}

const ReportPayload = z.object({ workspaceId: z.string().min(1), brandId: z.string().min(1), reportId: z.string().min(1) });

/**
 * FINDING_CLEAR_JOB: open tasks of the report's kind whose finding (one isAutoClearable) the report no longer lists, and whose
 * pages it re-read (all of `findingUrls` in metrics.pagesChecked; a site-wide finding needs none), move to DONE with a
 * SYSTEM comment and an audit event, in one transaction. Each task is locked (the lock runTaskAction and patchTask
 * take, in id order) and its status and reviewer read again under the lock, so a task moved to review since the first
 * read is left alone and told the right thing. Tasks in review, and tasks with a reviewer, get the comment only: a
 * reviewed task finishes only by approval (a client approval may be pending).
 * A finding that comes back later reopens nothing.
 * ponytail: a task in review or with a reviewer is told again by every later audit that still misses its finding; dedupe if that's noisy.
 */
export async function clearFindings(payload: unknown): Promise<void> {
  const { workspaceId, brandId, reportId } = ReportPayload.parse(payload);
  const report = await prisma.auditReport.findFirst({ where: { id: reportId, workspaceId, brandId } });
  if (!report) return;
  const present = new Set(findingsOf(report.findings).map((f) => f.id));
  const checked = (report.metrics as { pagesChecked?: unknown } | null)?.pagesChecked;
  const pages = new Set(Array.isArray(checked) ? checked.filter((u): u is string => typeof u === "string") : []);
  const open = await prisma.task.findMany({
    where: { workspaceId, brandId, findingKind: report.kind, findingId: { not: null }, status: { in: OPEN } },
    select: { id: true, title: true, status: true, reviewerId: true, findingId: true, findingUrls: true },
  });
  const cleared = open.filter((t) => isAutoClearable(t.findingId!) && !notMeasured(report.metrics, t.findingId!) && !present.has(t.findingId!) && t.findingUrls.every((u) => pages.has(u)));
  if (!cleared.length) return;
  const day = report.createdAt.toISOString().slice(0, 10);
  const titleOf = new Map(cleared.map((t) => [t.id, t.title]));
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const lockIds = cleared.map((t) => t.id).sort();
    for (const id of lockIds) await lockRow(tx, "task", id);
    const locked = await tx.task.findMany({ where: { id: { in: lockIds }, status: { in: OPEN } }, select: { id: true, status: true, reviewerId: true } });
    const toClose = locked.filter((t) => t.status !== "IN_REVIEW" && !t.reviewerId).map((t) => t.id);
    const inReview = locked.filter((t) => t.status === "IN_REVIEW").map((t) => t.id);
    const reviewed = locked.filter((t) => t.status !== "IN_REVIEW" && t.reviewerId).map((t) => t.id);
    // The same fields shared markDone writes (status, completedAt, block cleared): keep the two in step.
    const closed = toClose.length
      ? await tx.$queryRaw<{ id: string }[]>`UPDATE "Task" t SET status = 'DONE', "completedAt" = ${now}, "findingClearedAt" = ${now}, "blockedReason" = NULL, "blockedOnId" = NULL, "updatedAt" = ${now} WHERE t.id = ANY(${toClose}) AND ${CLOSABLE_BY_AUDIT} AND t."reviewerId" IS NULL RETURNING t.id`
      : [];
    const ids = closed.map((r) => r.id);
    const comment = (taskId: string, body: string) => ({ workspaceId, brandId, taskId, authorId: null, kind: "SYSTEM" as const, body, byClient: false, internal: false });
    const comments = [
      ...ids.map((id) => comment(id, `The ${day} audit no longer finds this`)),
      ...inReview.map((id) => comment(id, `The ${day} audit no longer finds this. It stays in review until the reviewer decides.`)),
      ...reviewed.map((id) => comment(id, `The ${day} audit no longer finds this. It stays open until the reviewer approves it.`)),
    ];
    if (comments.length) await tx.taskComment.createMany({ data: comments });
    if (ids.length) {
      await tx.auditEvent.createMany({
        data: ids.map((id) => ({ workspaceId, brandId, actorUserId: null, action: "task.cleared-by-audit", entityType: "Task", entityId: id, metadata: { title: titleOf.get(id), auditReportId: reportId } })),
      });
    }
  }, TX);
}

/** ponytail: at most 50 tasks from one report, in report order (most important first); the rest come with later reports. */
const TASKS_PER_REPORT = 50;

/**
 * FINDING_TASKS_JOB: a task for each finding of the report, made by the system (no creator, owner, reviewer or due day;
 * the audit event names the run and who started it). Skipped: a finding with an open task; one whose latest task was
 * cancelled (a person decided not to fix it); one whose latest task was finished since the run started, or waits for a
 * re-check. A finding whose task was done before the run but which the audit still reports gets a new task.
 * Each task in its own transaction; a "Make a task" click that wins the race is skipped, so running twice is harmless.
 * A report with a newer one of its kind does nothing: the newer report's job decides.
 */
export async function tasksFromReport(payload: unknown): Promise<void> {
  await fileFindingTasks(ReportPayload.parse(payload), null);
}

/**
 * The work of tasksFromReport, and "Make all tasks" on the reports page (tasks.manage) with the person's `userId`: their
 * tasks are theirs (creator, audit actor), like "Make a task", so a later GEO review never replaces them.
 * Returns how many tasks it made; null when the report isn't found or a newer one of its kind exists.
 */
export async function fileFindingTasks(ids: z.infer<typeof ReportPayload>, userId: string | null): Promise<number | null> {
  const report = await prisma.auditReport.findFirst({ where: { id: ids.reportId, workspaceId: ids.workspaceId, brandId: ids.brandId } });
  if (!report) return null;
  const { workspaceId, brandId, kind } = report;
  const newer = await prisma.auditReport.findFirst({ where: { workspaceId, brandId, kind, createdAt: { gt: report.createdAt } }, select: { id: true } });
  if (newer) return null;
  const run = report.agentRunId
    ? await prisma.agentRun.findFirst({ where: { id: report.agentRunId, workspaceId, brandId }, select: { id: true, triggeredByUserId: true, createdAt: true } })
    : null;
  const findings = findingsOf(report.findings);
  // Every earlier task of these findings, newest first (the (brand, kind, finding, createdAt) index).
  const history = await prisma.task.findMany({
    where: { workspaceId, brandId, findingKind: kind, findingId: { in: findings.map((f) => f.id) } },
    orderBy: { createdAt: "desc" },
    select: { id: true, findingId: true, status: true, completedAt: true, recheckOn: true },
  });
  // Cancelled by replaceReviewTasks, not by a person: that is no decision against the finding.
  const cancelledIds = history.filter((t) => t.status === "CANCELLED").map((t) => t.id);
  const replaced = new Set(
    cancelledIds.length
      ? (await prisma.auditEvent.findMany({ where: { workspaceId, brandId, entityType: "Task", entityId: { in: cancelledIds }, action: "task.replaced-by-audit" }, select: { entityId: true } })).map((e) => e.entityId)
      : [],
  );
  const started = run?.createdAt ?? report.createdAt;
  const now = new Date();
  const hasTask = (findingId: string) => {
    const past = history.filter((t) => t.findingId === findingId);
    if (past.some((t) => (OPEN as string[]).includes(t.status))) return true;
    const last = past[0];
    if (!last) return false;
    if (last.status === "CANCELLED") return !replaced.has(last.id);
    return last.status === "DONE" && ((last.completedAt !== null && last.completedAt > started) || (last.recheckOn !== null && last.recheckOn > now));
  };
  const scope = { workspaceId, brandId, userId };
  const metadata = userId ? { source: "report-page" } : { source: "audit", agentRunId: run?.id ?? null, triggeredByUserId: run?.triggeredByUserId ?? null };
  let made = 0;
  // The cap counts only findings that get a task, so findings already handled don't hold back the ones after them.
  for (const finding of findings.filter((f) => !hasTask(f.id)).slice(0, TASKS_PER_REPORT)) {
    try {
      await prisma.$transaction((tx) => createFindingTask(tx, scope, report, finding, metadata), TX);
      made++;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  if (kind === "GEO") await replaceReviewTasks(report, new Set(findings.map((f) => f.id)));
  return made;
}

/**
 * The AI content review words its findings anew each run, so last week's review tasks would pile up beside this week's.
 * Its open tasks that this report no longer lists, that an audit made and nobody has taken up (to do, no owner, no
 * reviewer), are cancelled with a SYSTEM comment. Re-checked under each task's lock, as clearFindings does.
 * ponytail: a person who only edited, commented on or dated such a task doesn't keep it; set an owner to keep one.
 */
async function replaceReviewTasks(report: { id: string; workspaceId: string; brandId: string; createdAt: Date }, present: Set<string>) {
  const { workspaceId, brandId } = report;
  const candidates = await prisma.task.findMany({
    where: { workspaceId, brandId, findingKind: "GEO", findingId: { startsWith: "content-", notIn: [...present] }, status: "TODO", ownerId: null, reviewerId: null, createdById: null },
    select: { id: true, title: true },
  });
  if (!candidates.length) return;
  const byAudit = await prisma.auditEvent.findMany({
    where: { workspaceId, brandId, entityType: "Task", entityId: { in: candidates.map((t) => t.id) }, action: "task.create", metadata: { path: ["source"], equals: "audit" } },
    select: { entityId: true },
  });
  const auto = new Set(byAudit.map((e) => e.entityId));
  const replace = candidates.filter((t) => auto.has(t.id));
  if (!replace.length) return;
  const day = report.createdAt.toISOString().slice(0, 10);
  const titleOf = new Map(replace.map((t) => [t.id, t.title]));
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const lockIds = replace.map((t) => t.id).sort();
    for (const id of lockIds) await lockRow(tx, "task", id);
    // The same fields the cancel action writes (status, block cleared).
    const cancelled = await tx.$queryRaw<{ id: string }[]>`UPDATE "Task" t SET status = 'CANCELLED', "blockedReason" = NULL, "blockedOnId" = NULL, "updatedAt" = ${now} WHERE t.id = ANY(${lockIds}) AND t.status = 'TODO' AND t."ownerId" IS NULL AND t."reviewerId" IS NULL RETURNING t.id`;
    const ids = cancelled.map((r) => r.id);
    if (!ids.length) return;
    await tx.taskComment.createMany({
      data: ids.map((taskId) => ({ workspaceId, brandId, taskId, authorId: null, kind: "SYSTEM" as const, body: `Replaced by the ${day} GEO review`, byClient: false, internal: false })),
    });
    await tx.auditEvent.createMany({
      data: ids.map((id) => ({ workspaceId, brandId, actorUserId: null, action: "task.replaced-by-audit", entityType: "Task", entityId: id, metadata: { title: titleOf.get(id), auditReportId: report.id } })),
    });
  }, TX);
}
