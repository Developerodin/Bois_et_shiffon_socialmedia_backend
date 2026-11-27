import { ContentChannel, Prisma, type AgentRunStatus } from "@prisma/client";
import { z } from "zod";
import { plannableChannels } from "@/server/agents/definitions/planner";
import { AgentStartError, startAgentRun } from "@/server/agents/engine";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { linkedProducts } from "@/server/catalog/linked";
import type { WorkflowInput } from "@/server/content/workflow-context";
import { prisma } from "@/server/db/prisma";
import { CREDIT_COSTS, InsufficientCreditsError, refundCharge, spendCredits } from "@/server/services/credits";
import { CHANNEL_PROVIDER, postAiAllowed } from "@/server/services/publishing";
import {
  MAX_WORKFLOW_IDEAS, MAX_WORKFLOW_PRODUCTS, MAX_WORKFLOW_TARGETS, WORKFLOW_PRODUCT_MODES, WORKFLOW_SOURCES, WORKFLOW_STAGES,
  type WorkflowStage, type WorkflowStageView, type WorkflowStatus, type WorkflowView,
} from "@/shared";

/**
 * Content workflows ("create posts with agents"): one row holds what a person chose, and the stages stay AgentRuns
 * chained by status (Planner → Brief writer → Creator → Quality), each carrying the workflow's id. Resuming is
 * restarting a stage: work already done has moved on in status, so it is never redone.
 * Charging: the Planner is the one paid stage (flat, whatever the post count); the chained stages are free event runs,
 * capped by postAiAllowed and CHAIN_ROUNDS as today. Each Planner charge has its own refId (workflow:<id>:planner,
 * then :<n> for retries), so a repeated request can't charge twice and a retry after a refund isn't handed the
 * refunded charge back (credits.ts chargeRefunded).
 * Failure modes: a repeated POST (same requestId) gets the workflow back and starts nothing. A start refused (no
 * credits, the daily run limit, the Planner off) refunds and deletes the row, so the same requestId can try again.
 * ponytail: a process dying between the row and the Planner's start leaves a workflow with no run; its status
 * shows the Planner idle and retryStage("planner") starts it (refunding the orphaned charge first).
 */

type Scope = { workspaceId: string; brandId: string };

export class WorkflowError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 422 | 429 | 402,
    readonly credits?: { balance: number; needed: number },
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}

const id = z.string().trim().min(1).max(100);
export const StartWorkflowBody = z
  .object({
    requestId: z.string().trim().min(8).max(100),
    source: z.enum(WORKFLOW_SOURCES),
    start: z.literal("planner").default("planner"),
    targets: z.array(z.object({ channel: z.nativeEnum(ContentChannel), connectionId: id.nullable() }).strict()).min(1).max(MAX_WORKFLOW_TARGETS),
    productMode: z.enum(WORKFLOW_PRODUCT_MODES),
    productIds: z.array(id).max(MAX_WORKFLOW_PRODUCTS).default([]),
    campaignId: id.optional(),
    ideaIds: z.array(id).min(1).max(MAX_WORKFLOW_IDEAS).optional(),
  })
  .strict();

export const PatchWorkflowBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel") }).strict(),
  z.object({ action: z.literal("retry"), stage: z.enum(WORKFLOW_STAGES) }).strict(),
]);

/**
 * Every id checked against the workspace and brand: products through linkedProducts (a foreign or deleted id has no
 * live row), connections by brand and by the channel's provider, the campaign and ideas by brand. Refused, not
 * dropped: the client sent them from lists of this brand, so a stranger is a stale list or a forged request.
 */
async function validate(scope: Scope, body: z.infer<typeof StartWorkflowBody>): Promise<WorkflowInput> {
  const channels = body.targets.map((t) => t.channel);
  if (new Set(channels).size !== channels.length) throw new WorkflowError("One destination per channel for now", 422);
  const plannable = plannableChannels();
  const unplannable = channels.filter((c) => !plannable.includes(c));
  if (unplannable.length) throw new WorkflowError(`The agents can't plan ${unplannable.join(", ")}`, 422);

  const productIds = [...new Set(body.productIds)];
  if (body.productMode === "manual" && !productIds.length) throw new WorkflowError("Choose at least one product", 422);
  if (body.productMode !== "manual" && productIds.length) throw new WorkflowError("Products are chosen only in manual mode", 422);
  const linked = await linkedProducts(prisma, scope, productIds);
  if (linked.some((l) => !l.row)) throw new WorkflowError("A chosen product isn't in this brand's catalogue", 422);

  const connectionIds = body.targets.flatMap((t) => (t.connectionId ? [t.connectionId] : []));
  const connections = connectionIds.length
    ? await prisma.integrationConnection.findMany({ where: { id: { in: connectionIds }, workspaceId: scope.workspaceId, brandId: scope.brandId }, select: { id: true, provider: true } })
    : [];
  const providerOf = new Map(connections.map((c) => [c.id, c.provider]));
  for (const t of body.targets) {
    if (!t.connectionId) continue;
    // A connection of this brand for the channel's own network; a by-hand channel (no provider) has none.
    if (!providerOf.has(t.connectionId) || providerOf.get(t.connectionId) !== CHANNEL_PROVIDER[t.channel]) {
      throw new WorkflowError("A chosen account isn't connected to this brand for that channel", 422);
    }
  }

  if (body.campaignId && !(await prisma.campaign.findFirst({ where: { id: body.campaignId, workspaceId: scope.workspaceId, brandId: scope.brandId }, select: { id: true } }))) {
    throw new WorkflowError("The campaign isn't in this brand", 422);
  }
  const ideaIds = body.ideaIds ? [...new Set(body.ideaIds)] : undefined;
  if (ideaIds) {
    const ideas = await prisma.opportunity.findMany({ where: { id: { in: ideaIds }, workspaceId: scope.workspaceId, brandId: scope.brandId, status: { not: "DISMISSED" } }, select: { id: true } });
    if (ideas.length !== ideaIds.length) throw new WorkflowError("A chosen idea isn't in this brand (or was dismissed)", 422);
  }
  return {
    requestId: body.requestId, source: body.source, start: body.start, targets: body.targets, productMode: body.productMode, productIds,
    ...(body.campaignId ? { campaignId: body.campaignId } : {}),
    ...(ideaIds ? { ideaIds } : {}),
  };
}

const plannerRef = (workflowId: string, attempt?: number) => `workflow:${workflowId}:planner${attempt ? `:${attempt}` : ""}`;

/**
 * Pays for and starts a workflow's Planner (chain on, the workflow's id only). trigger "manual" keeps the daily run
 * limit; the charge is prepaid so the engine doesn't charge again. Folded into a Planner run already going (only a
 * concurrent retry of the same workflow can be): that one is paid, so this charge goes back.
 */
async function startPlanner(scope: Scope, userId: string | undefined, workflowId: string, refId: string) {
  let chargeId: string;
  try {
    chargeId = await spendCredits({ workspaceId: scope.workspaceId, amount: CREDIT_COSTS.manualRun, reason: "agent-run:planner", refId, userId });
  } catch (e) {
    if (e instanceof InsufficientCreditsError) throw new WorkflowError(`This needs ${e.needed} credits; you have ${e.balance}.`, 402, { balance: e.balance, needed: e.needed });
    throw e;
  }
  try {
    const run = await startAgentRun({ ...scope, agentKey: "planner", trigger: "manual", userId, input: { chain: true, workflowId }, prepaidChargeId: chargeId });
    if ((run.input as { chargeId?: string } | null)?.chargeId !== chargeId) await refundCharge(scope.workspaceId, chargeId);
    else await prisma.contentWorkflow.update({ where: { id: workflowId }, data: { chargeIds: { push: chargeId } } });
    return run;
  } catch (e) {
    await refundCharge(scope.workspaceId, chargeId).catch(() => null);
    throw e;
  }
}

/**
 * Starts a workflow: checks the request, stores it, pays for and starts the Planner. A repeat of a requestId returns
 * the workflow it made (repeated: true) without charging or starting anything.
 */
export async function startWorkflow(scope: Scope, userId: string | undefined, raw: unknown): Promise<{ workflow: WorkflowView; repeated: boolean }> {
  const parsed = StartWorkflowBody.safeParse(raw);
  if (!parsed.success) throw new WorkflowError(parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), 422);
  const body = parsed.data;
  const existing = () => prisma.contentWorkflow.findUnique({ where: { brandId_requestId: { brandId: scope.brandId, requestId: body.requestId } }, select: { id: true, workspaceId: true } });
  const repeat = async (row: { id: string; workspaceId: string } | null) => {
    if (!row || row.workspaceId !== scope.workspaceId) return null;
    return { workflow: await workflowStatus(scope, row.id), repeated: true };
  };
  const before = await repeat(await existing());
  if (before) return before;

  const input = await validate(scope, body);
  let row: { id: string };
  try {
    row = await prisma.contentWorkflow.create({
      data: { ...scope, requestId: body.requestId, source: body.source, status: "PLANNING", input: input as Prisma.InputJsonValue, createdByUserId: userId ?? null },
      select: { id: true },
    });
  } catch (e) {
    // The same request at the same moment: the other one made it.
    if ((e as { code?: string }).code === "P2002") {
      const raced = await repeat(await existing());
      if (raced) return raced;
    }
    throw e;
  }
  try {
    await startPlanner(scope, userId, row.id, plannerRef(row.id));
  } catch (e) {
    // Not started (refunded already): no workflow, so the same requestId can try again.
    await prisma.contentWorkflow.delete({ where: { id: row.id } }).catch(() => null);
    throw e;
  }
  return { workflow: await workflowStatus(scope, row.id), repeated: false };
}

async function load(scope: Scope, workflowId: string) {
  const wf = await prisma.contentWorkflow.findFirst({ where: { id: workflowId, workspaceId: scope.workspaceId, brandId: scope.brandId } });
  if (!wf) throw new WorkflowError("Workflow not found", 404);
  return wf;
}

const ACTIVE: AgentRunStatus[] = ["QUEUED", "RUNNING"];
/** Posts the chain still has work on: not yet briefed, written or checked. */
const UNFINISHED = ["PLANNED", "BRIEF_READY", "DRAFT_REVIEW"] as const;

/**
 * A workflow as the apps show it: each stage's latest run, its posts counted by status, and its status. The stored
 * status is written on start, cancel and Planner chaining; the rest is derived here from the runs and posts (and
 * saved back): a run going → PLANNING/RUNNING; the Planner failed → FAILED; posts still waiting with nothing running
 * (rounds or the daily AI limit ran out, a blocked draft) → NEEDS_ATTENTION; otherwise DONE.
 */
export async function workflowStatus(scope: Scope, workflowId: string): Promise<WorkflowView> {
  const wf = await load(scope, workflowId);
  const [runs, counts] = await Promise.all([
    prisma.agentRun.findMany({ where: { workflowId, brandId: scope.brandId }, orderBy: { createdAt: "desc" }, select: { id: true, agentKey: true, status: true } }),
    prisma.contentItem.groupBy({ by: ["status"], where: { workflowId, brandId: scope.brandId }, _count: { _all: true } }),
  ]);
  const latest = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if (!latest.has(r.agentKey)) latest.set(r.agentKey, r);
  // A failed run whose last event is INFO had nothing to do (NothingToDoError), as the runs route reports it.
  const failed = [...latest.values()].filter((r) => r.status === "FAILED").map((r) => r.id);
  const quiet = new Set<string>();
  for (const runId of failed) {
    const last = await prisma.agentEvent.findFirst({ where: { runId }, orderBy: { id: "desc" }, select: { level: true } });
    if (last?.level === "INFO") quiet.add(runId);
  }
  const stages: WorkflowStageView[] = WORKFLOW_STAGES.map((stage) => {
    const r = latest.get(stage);
    const state: WorkflowStageView["state"] = !r
      ? "idle"
      : r.status === "QUEUED" ? "queued" : r.status === "RUNNING" ? "running" : r.status === "SUCCEEDED" ? "completed" : quiet.has(r.id) ? "nothing-to-do" : "failed";
    return { stage, state, runId: r?.id ?? null };
  });
  const posts = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));

  let status: WorkflowStatus = wf.status;
  if (wf.status !== "CANCELLED" && runs.length) {
    const planner = stages[0]!;
    if (runs.some((r) => ACTIVE.includes(r.status))) status = planner.state === "queued" || planner.state === "running" ? "PLANNING" : "RUNNING";
    else if (planner.state === "failed") status = "FAILED";
    else if (UNFINISHED.some((s) => posts[s])) status = "NEEDS_ATTENTION";
    else status = "DONE";
    // Never over a cancel that landed meanwhile.
    if (status !== wf.status) await prisma.contentWorkflow.updateMany({ where: { id: wf.id, status: { not: "CANCELLED" } }, data: { status } });
  }
  return {
    id: wf.id, status, source: wf.source as WorkflowView["source"], createdAt: wf.createdAt.toISOString(),
    input: wf.input as WorkflowView["input"], stages, posts,
  };
}

/** The brand's latest workflows (stored status; open one for its derived status). */
export async function listWorkflows(scope: Scope, take = 20) {
  const rows = await prisma.contentWorkflow.findMany({
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId }, orderBy: { createdAt: "desc" }, take,
    select: { id: true, status: true, source: true, createdAt: true, input: true },
  });
  return rows.map((r) => ({ id: r.id, status: r.status, source: r.source, createdAt: r.createdAt.toISOString(), input: r.input }));
}

/**
 * Cancels a workflow: its posts not yet written (planned or briefed, no version) are cancelled, drafts already written
 * stay. Its running stages stop before their next AI call and chain nothing (they read the workflow's status).
 * Idempotent.
 */
export async function cancelWorkflow(scope: Scope, workflowId: string): Promise<WorkflowView> {
  const wf = await load(scope, workflowId);
  if (wf.status !== "CANCELLED") {
    await prisma.$transaction([
      prisma.contentWorkflow.update({ where: { id: wf.id }, data: { status: "CANCELLED" } }),
      prisma.contentItem.updateMany({ where: { workflowId: wf.id, brandId: scope.brandId, status: { in: ["PLANNED", "BRIEF_READY"] }, versions: { none: {} } }, data: { status: "CANCELLED" } }),
    ]);
  }
  return workflowStatus(scope, workflowId);
}

/** What each free stage needs waiting in the workflow before a retry can do anything. */
const WAITING_FOR: Record<Exclude<WorkflowStage, "planner">, Prisma.ContentItemWhereInput> = {
  brief: { status: "PLANNED", versions: { none: {} } },
  creator: { status: { in: ["BRIEF_READY", "DRAFT_REVIEW"] } },
  quality: { status: "DRAFT_REVIEW" },
};

/**
 * Restarts one stage of a workflow, chain on, so the stages after it follow; upstream work is never redone. Refused
 * while any of its runs is going or once it is cancelled. The Planner is retried only after it failed (or never
 * started) and is charged again under a new refId, after giving back any earlier Planner charge still held (one a
 * dead start never refunded; refunds are idempotent). The other stages are free event runs, needing posts waiting
 * for them and the workspace's daily AI allowance (postAiAllowed).
 */
export async function retryStage(scope: Scope, userId: string | undefined, workflowId: string, stage: WorkflowStage): Promise<{ workflow: WorkflowView; runId: string }> {
  const wf = await load(scope, workflowId);
  if (wf.status === "CANCELLED") throw new WorkflowError("This workflow was cancelled", 409);
  if (await prisma.agentRun.count({ where: { workflowId, brandId: scope.brandId, status: { in: ACTIVE } } })) throw new WorkflowError("This workflow is still running", 409);

  let runId: string;
  if (stage === "planner") {
    const last = await prisma.agentRun.findFirst({ where: { workflowId, brandId: scope.brandId, agentKey: "planner" }, orderBy: { createdAt: "desc" }, select: { status: true } });
    if (last && last.status !== "FAILED") throw new WorkflowError("The Planner already planned this workflow", 409);
    const refs = await prisma.creditEntry.findMany({ where: { workspaceId: scope.workspaceId, reason: "agent-run:planner", refId: { startsWith: plannerRef(workflowId) } }, select: { refId: true } });
    for (const r of refs) if (r.refId) await refundCharge(scope.workspaceId, r.refId);
    // One more than every charge so far, so a refunded attempt's refId is never reused.
    runId = (await startPlanner(scope, userId, workflowId, plannerRef(workflowId, refs.length + 1))).id;
  } else {
    if (!(await prisma.contentItem.count({ where: { workflowId, brandId: scope.brandId, studio: false, ...WAITING_FOR[stage] } }))) {
      throw new WorkflowError("No posts in this workflow are waiting for that step", 409);
    }
    if (!(await postAiAllowed(scope.workspaceId))) throw new WorkflowError("Today's AI allowance for posts is used up. Try again tomorrow.", 429);
    runId = (await startAgentRun({ ...scope, agentKey: stage, trigger: "event", userId, input: stage === "quality" ? { workflowId } : { chain: true, workflowId } })).id;
  }
  // The status follows from the new run (workflowStatus derives it and saves it back).
  return { workflow: await workflowStatus(scope, workflowId), runId };
}

/** A workflow error, an agent start refusal or an access error as the routes answer it (402s in the paywall shape). */
export function workflowProblem(error: unknown): Response {
  const type = "https://api.brandpilot/errors/content-workflow";
  if (error instanceof WorkflowError || error instanceof AgentStartError) {
    if (error.credits) return Response.json({ type, title: "Workflow could not start", status: 402, detail: error.message, insufficientCredits: true, ...error.credits }, { status: 402 });
    return problemResponse({ type, title: error.status === 404 ? "Workflow not found" : "Workflow could not continue", status: error.status, detail: error.message });
  }
  return fromAccessError(error);
}
