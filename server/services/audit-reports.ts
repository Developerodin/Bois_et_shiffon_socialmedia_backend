import type { AuditKind, AuditReport, Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { enqueueJob } from "@/server/jobs/queue";
import type { Finding } from "@/server/seo/checks";
import { FINDING_CLEAR_JOB, FINDING_TASKS_JOB } from "@/server/seo/finding-tasks";

export async function saveAuditReport(input: {
  workspaceId: string;
  brandId: string;
  kind: AuditKind;
  score: number;
  summary: string;
  findings: Finding[];
  metrics: Prisma.InputJsonValue;
  agentRunId: string;
}) {
  // A report queues the jobs that close the tasks of findings it no longer lists and make tasks of the new ones, in the
  // same transaction (so a saved report always gets its jobs); the agent run never waits for them.
  return prisma.$transaction(async (tx) => {
    const report = await tx.auditReport.create({
      data: { ...input, score: Math.round(Math.min(100, Math.max(0, input.score))), findings: input.findings as Prisma.InputJsonValue },
    });
    const scope = { workspaceId: input.workspaceId, brandId: input.brandId };
    const payload = { ...scope, reportId: report.id };
    await enqueueJob({ type: FINDING_CLEAR_JOB, ...scope, payload, idempotencyKey: `finding-clear:${report.id}` }, tx);
    await enqueueJob({ type: FINDING_TASKS_JOB, ...scope, payload, idempotencyKey: `finding-tasks:${report.id}` }, tx);
    return report;
  });
}

/** Latest report per kind for one brand. */
export async function latestAuditReports(workspaceId: string, brandId: string) {
  const [seo, geo] = await Promise.all(
    (["SEO", "GEO"] as const).map((kind) =>
      prisma.auditReport.findFirst({ where: { workspaceId, brandId, kind }, orderBy: { createdAt: "desc" } }),
    ),
  );
  return { seo, geo };
}

export const toAuditDto = (r: AuditReport | null) =>
  r && {
    id: r.id,
    kind: r.kind,
    score: r.score,
    summary: r.summary,
    findings: r.findings,
    metrics: r.metrics,
    agentRunId: r.agentRunId,
    createdAt: r.createdAt.toISOString(),
  };
