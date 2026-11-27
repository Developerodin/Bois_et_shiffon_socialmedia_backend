import type { ContentChannel, ContentWorkflowStatus } from "@prisma/client";
import { z } from "zod";
import { NothingToDoError } from "@/server/agents/engine";
import { prisma } from "@/server/db/prisma";
import type { WorkflowProductMode, WorkflowSource } from "@/shared";

/**
 * What the agents read of a content workflow. Its stored input was checked against the workspace and brand when the
 * workflow started (server/content/workflow.ts), so it is the truth; agent input carries only the workflow's id, never
 * its ids (the runs route forwards a client's input as sent). Kept apart from workflow.ts, which starts runs.
 */
export type WorkflowInput = {
  requestId: string;
  source: WorkflowSource;
  start: "planner";
  targets: { channel: ContentChannel; connectionId: string | null }[];
  productMode: WorkflowProductMode;
  productIds: string[];
  campaignId?: string;
  ideaIds?: string[];
};
export type WorkflowContext = { id: string; status: ContentWorkflowStatus; input: WorkflowInput };
type Scope = { workspaceId: string; brandId: string };

/** The optional workflowId on a stage's input schema. */
export const workflowIdInput = z.string().min(1).max(100).optional();

export async function workflowContext(scope: Scope, id: string): Promise<WorkflowContext | null> {
  const row = await prisma.contentWorkflow.findFirst({ where: { id, workspaceId: scope.workspaceId, brandId: scope.brandId }, select: { id: true, status: true, input: true } });
  return row ? { id: row.id, status: row.status, input: row.input as WorkflowInput } : null;
}

/** A stage's workflow, or a "nothing to do" end when it is gone (another brand's id reads as gone) or cancelled. */
export async function activeWorkflow(scope: Scope, id: string): Promise<WorkflowContext> {
  const wf = await workflowContext(scope, id);
  if (!wf) throw new NothingToDoError("This workflow no longer exists");
  if (wf.status === "CANCELLED") throw new NothingToDoError("This workflow was cancelled");
  return wf;
}

/** The product mode of each workflow named (a sweep may take posts of several), by workflow id. */
export async function workflowProductModes(scope: Scope, ids: (string | null)[]): Promise<Map<string, WorkflowProductMode>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (!wanted.length) return new Map();
  const rows = await prisma.contentWorkflow.findMany({ where: { id: { in: wanted }, workspaceId: scope.workspaceId, brandId: scope.brandId }, select: { id: true, input: true } });
  return new Map(rows.map((r) => [r.id, (r.input as WorkflowInput).productMode]));
}

/** Checked before each paid step and before chaining: a cancel stops the workflow's next AI call. */
export async function workflowCancelled(scope: Scope, id: string) {
  return (await workflowContext(scope, id))?.status === "CANCELLED";
}
