import "server-only";
import type { AuditKind, Prisma, TaskArea } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/prisma";
import type { Finding } from "@/server/seo/checks";
import { TX } from "@/server/services/publishing";
import type { TaskViewer } from "@/server/tasks/access";
import { taskAudit } from "@/server/tasks/audit";
import { isUniqueViolation, TaskError } from "@/server/tasks/errors";
import { getTask, type TaskScope } from "@/server/tasks/service";
import { OPEN_TASK_STATUSES, safeHttpUrl, type TaskDto } from "@/shared";

/** Runs after each SEO report is saved: closes the tasks of findings that audit no longer reports. */
export const FINDING_CLEAR_JOB = "tasks.clear-findings";

/**
 * Does this finding id name the same check in every audit? GEO's AI content review numbers its findings by position
 * (`content-1`, `content-2`), so the same id means a different finding next time: those never clear a task.
 */
export function isStableFindingId(_kind: AuditKind, id: string): boolean {
  return !/^content-\d+$/.test(id);
}

const OPEN = [...OPEN_TASK_STATUSES];
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
  const openTask = () =>
    prisma.task.findFirst({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId, findingKind: report.kind, findingId, status: { in: OPEN } }, select: { id: true } });
  const found = await openTask();
  if (found) return { task: await getTask(scope, v, found.id), existed: true };
  try {
    const id = await prisma.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: { ...taskData(finding), workspaceId: scope.workspaceId, brandId: scope.brandId, createdById: scope.userId, auditReportId: report.id, findingKind: report.kind, findingId },
        select: { id: true, title: true },
      });
      await taskAudit(tx, scope, "task.create", { type: "Task", id: task.id, title: task.title }, { auditReportId: report.id, findingId });
      return task.id;
    }, TX);
    return { task: await getTask(scope, v, id), existed: false };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const winner = await openTask();
    if (!winner) throw e;
    return { task: await getTask(scope, v, winner.id), existed: true };
  }
}

const ClearPayload = z.object({ workspaceId: z.string().min(1), brandId: z.string().min(1), reportId: z.string().min(1) });

/**
 * FINDING_CLEAR_JOB: open tasks of the report's kind whose finding (a stable id) the report no longer lists, and whose
 * pages it re-read (all of `findingUrls` in metrics.pagesChecked; a site-wide finding needs none), move to DONE with a
 * SYSTEM comment and an audit event, in one transaction. The UPDATE re-checks the status, so a task moved to review
 * since the read is left alone. Tasks in review get the comment only (a client approval may be pending).
 * A finding that comes back later reopens nothing.
 * ponytail: a task in review is told again by every later audit that still misses its finding; dedupe if that's noisy.
 */
export async function clearFindings(payload: unknown): Promise<void> {
  const { workspaceId, brandId, reportId } = ClearPayload.parse(payload);
  const report = await prisma.auditReport.findFirst({ where: { id: reportId, workspaceId, brandId } });
  if (!report) return;
  const present = new Set(findingsOf(report.findings).map((f) => f.id));
  const checked = (report.metrics as { pagesChecked?: unknown } | null)?.pagesChecked;
  const pages = new Set(Array.isArray(checked) ? checked.filter((u): u is string => typeof u === "string") : []);
  const open = await prisma.task.findMany({
    where: { workspaceId, brandId, findingKind: report.kind, findingId: { not: null }, status: { in: OPEN } },
    select: { id: true, title: true, status: true, findingId: true, findingUrls: true },
  });
  const cleared = open.filter((t) => isStableFindingId(report.kind, t.findingId!) && !present.has(t.findingId!) && t.findingUrls.every((u) => pages.has(u)));
  if (!cleared.length) return;
  const toClose = cleared.filter((t) => t.status !== "IN_REVIEW").map((t) => t.id);
  const inReview = cleared.filter((t) => t.status === "IN_REVIEW").map((t) => t.id);
  const day = report.createdAt.toISOString().slice(0, 10);
  const titleOf = new Map(cleared.map((t) => [t.id, t.title]));
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const closed = toClose.length
      ? await tx.$queryRaw<{ id: string }[]>`UPDATE "Task" SET status = 'DONE', "completedAt" = ${now}, "findingClearedAt" = ${now}, "blockedReason" = NULL, "blockedOnId" = NULL, "updatedAt" = ${now} WHERE id = ANY(${toClose}) AND status IN ('TODO', 'IN_PROGRESS') RETURNING id`
      : [];
    const ids = closed.map((r) => r.id);
    const comment = (taskId: string, body: string) => ({ workspaceId, brandId, taskId, authorId: null, kind: "SYSTEM" as const, body, byClient: false, internal: false });
    const comments = [
      ...ids.map((id) => comment(id, `The ${day} audit no longer finds this`)),
      ...inReview.map((id) => comment(id, `The ${day} audit no longer finds this. It stays in review until the reviewer decides.`)),
    ];
    if (comments.length) await tx.taskComment.createMany({ data: comments });
    if (ids.length) {
      await tx.auditEvent.createMany({
        data: ids.map((id) => ({ workspaceId, brandId, actorUserId: null, action: "task.cleared-by-audit", entityType: "Task", entityId: id, metadata: { title: titleOf.get(id), auditReportId: reportId } })),
      });
    }
  }, TX);
}
