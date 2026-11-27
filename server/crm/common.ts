import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { ModelNotConfiguredError } from "@/server/ai/models";
import { AiProviderError } from "@/server/ai/provider";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { brandMemberPerms } from "@/server/auth/permissions";
import { prisma } from "@/server/db/prisma";
import { PublishingError } from "@/server/services/publishing";
import { taskProblem } from "@/server/tasks/errors";
import type { PermissionKey } from "@/shared";

/**
 * What every CRM module shares (plan 2026-11-27-crm). server/crm/ holds the stored records; server/customers/ stays the
 * live Meta inbox and the reply drafts until Phase B. Customer data (names, identity values, note, message and deal
 * text) never goes into an error message, a log line or audit metadata: errors here are fixed strings.
 */
export type CrmScope = { workspaceId: string; brandId: string; userId: string; perms: Set<PermissionKey>; clientReviewer?: boolean };
export type Db = Prisma.TransactionClient | typeof prisma;

export const notFound = (what: string) => new PublishingError(`${what} not found`, 404);
export const changed = (what = "This record") => new PublishingError(`${what} changed since you opened it. Reload it and try again.`, 409, "crm.changed");
export const invalid = (message: string, code?: string) => new PublishingError(message, 400, code);

/** PublishingError (CRM refusals), TaskError (the shared cursor helper), then access errors. Never echoes input. */
export function crmProblem(error: unknown) {
  // The AI failures the other AI routes map (tasks/from-note, translate): not set up 503, failed or answered badly 502.
  if (error instanceof ModelNotConfiguredError) return problemResponse({ type: "https://api.brandpilot/errors/ai-not-configured", title: "AI isn't set up", status: 503, detail: error.message });
  if (error instanceof AiProviderError) return problemResponse({ type: "https://api.brandpilot/errors/ai-failed", title: "The AI couldn't answer", status: 502, detail: "The AI couldn't answer right now, try again." });
  if (error instanceof PublishingError) {
    return problemResponse({ type: "https://api.brandpilot/errors/crm", title: error.message, status: error.status, detail: error.message, code: error.code, ...error.data });
  }
  return taskProblem(error) ?? fromAccessError(error);
}

/** A 400 for a body that failed its schema: the field's message only (zod messages here are fixed strings, never values). */
export const invalidBody = (detail?: string) => problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid request", status: 400, detail });

export const brandWhere = (s: { workspaceId: string; brandId: string }) => ({ workspaceId: s.workspaceId, brandId: s.brandId });

/** Audit with ids, counts, field names and lengths only. */
export const crmAudit = (db: Db, s: { workspaceId: string; brandId: string; userId: string | null }, action: string, entityType: string, entityId: string, metadata: Prisma.InputJsonObject = {}) =>
  db.auditEvent.create({ data: { workspaceId: s.workspaceId, brandId: s.brandId, actorUserId: s.userId, action, entityType, entityId, metadata } });

/** An owner must hold `key` on the brand through a staff role (client grants never count, server/auth/permissions.ts). */
export async function checkOwner(db: Db, s: { workspaceId: string; brandId: string }, userId: string | null | undefined, key: PermissionKey) {
  if (!userId) return;
  if (!(await brandMemberPerms(db, s, userId, key))) throw invalid(`The owner must be someone on this business who can ${key === "inbox.read" ? "read customer messages" : "manage customer records"}`, "crm.owner");
}

/**
 * Every id a write links to is this brand's (Security 3 of the plan review): a missing or another brand's id is 404,
 * the same answer for both.
 */
export async function checkCrmLinks(db: Db, s: { workspaceId: string; brandId: string }, ids: { customerId?: string | null; companyId?: string | null; conversationId?: string | null; dealId?: string | null }) {
  const w = brandWhere(s);
  const select = { id: true } as const;
  if (ids.customerId && !(await db.customer.findFirst({ where: { id: ids.customerId, ...w }, select }))) throw notFound("Customer");
  if (ids.companyId && !(await db.company.findFirst({ where: { id: ids.companyId, ...w }, select }))) throw notFound("Company");
  if (ids.conversationId && !(await db.conversation.findFirst({ where: { id: ids.conversationId, ...w }, select }))) throw notFound("Conversation");
  if (ids.dealId && !(await db.deal.findFirst({ where: { id: ids.dealId, ...w }, select }))) throw notFound("Deal");
}

/**
 * Bumps the customer's activity (the retention hint) inside the caller's transaction; never moves it back. Raw SQL so
 * `updatedAt` stays: activity elsewhere must not make someone's open edit of the customer a 409.
 */
export async function touchCustomer(db: Db, customerId: string | null | undefined, at = new Date()) {
  if (!customerId) return;
  await db.$executeRaw`UPDATE "Customer" SET "lastActivityAt" = ${at} WHERE id = ${customerId} AND "lastActivityAt" < ${at}`;
}

/** "YYYY-MM-DD" that is a real day (2026-02-31 and 2026-13-01 are refused, not a 500 or a shifted date). */
export const zDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates are YYYY-MM-DD")
  .refine((d) => {
    const t = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
  }, "That date doesn't exist");

/** "2026-11-27" → a Date at UTC midnight (a @db.Date column); null clears. */
export const dayOf = (d: string | null | undefined) => (d === undefined ? undefined : d ? new Date(`${d}T00:00:00Z`) : null);
export const dayString = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
