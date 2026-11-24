import "server-only";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/prisma";
import { spreadSecs } from "@/server/data/sources";
import { buildDigest, digestWeekStart, sweepAt } from "@/server/digest/build";
import { emailConfigured, queueEmail } from "@/server/email/outbox";
import { enqueueJob } from "@/server/jobs/queue";

/**
 * The weekly digest job (plan 2026-11-24-phase-3-crm.md, Task 3): one per (workspace, active member) each Monday.
 * Runs 3 h after the 05:00 sweep, spread over an hour, so the Monday data syncs the same sweep queued (spread over 2 h)
 * have finished; queue.ts lets one digest.% job run at a time, so digests never hold up publishing or data runners.
 * ponytail: one job per member and one SMTP send per opted-in reader; past ~500 emails per Monday use a bulk provider.
 */
export const DIGEST_JOB = "digest.build";
const AFTER_SWEEP_MS = 3 * 60 * 60_000;
const SPREAD_SECS = 60 * 60;

const Payload = z.object({ workspaceId: z.string(), userId: z.string(), weekStart: z.iso.date() });

/** Daily sweep step: on Mondays (UTC) only, queue every active member's digest. A double sweep queues each once (key). */
export async function enqueueWeeklyDigests(now = new Date()) {
  if (now.getUTCDay() !== 1) return;
  const weekStart = digestWeekStart(now);
  const members = await prisma.workspaceMember.findMany({
    where: { user: { status: "ACTIVE", deletedAt: null } },
    select: { workspaceId: true, userId: true },
  });
  for (const m of members) {
    await enqueueJob({
      type: DIGEST_JOB,
      workspaceId: m.workspaceId,
      payload: { workspaceId: m.workspaceId, userId: m.userId, weekStart },
      runAt: new Date(now.getTime() + AFTER_SWEEP_MS + (spreadSecs(m.userId) % SPREAD_SECS) * 1000),
      maxAttempts: 3,
      idempotencyKey: `digest:${m.workspaceId}:${m.userId}:${weekStart}`,
    });
  }
}

/**
 * Build and keep the reader's digest, then queue its email if they opted in. A retry finds the row and never emails
 * twice: emailedAt is set in the same transaction as the outbox row, and only while still null. The email itself is
 * built at send time from the row (server/digest/email.ts), which re-checks the reader.
 */
export async function runDigest(raw: unknown) {
  const { workspaceId, userId, weekStart } = Payload.parse(raw);
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { user: { select: { email: true, digestEmail: true, status: true, deletedAt: true } } },
  });
  if (!member || member.user.status !== "ACTIVE" || member.user.deletedAt) return;
  const key = { userId_workspaceId_weekStart: { userId, workspaceId, weekStart: new Date(`${weekStart}T00:00:00Z`) } };
  let digest = await prisma.digest.findUnique({ where: key });
  if (!digest) {
    // Weeks are read at the sweep (not whenever a retry runs), so every brand gets its last fully synced week.
    const body = await buildDigest(userId, workspaceId, new Date(), sweepAt(weekStart));
    if (!body) return; // nothing to say this week
    digest = await prisma.digest.upsert({ where: key, update: {}, create: { userId, workspaceId, weekStart: key.userId_workspaceId_weekStart.weekStart, body: body as Prisma.InputJsonValue } });
  }
  if (digest.emailedAt || !member.user.digestEmail || !emailConfigured()) return;
  const id = digest.id;
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.digest.updateMany({ where: { id, emailedAt: null }, data: { emailedAt: new Date() } });
    if (claimed.count === 0) return;
    // Subject and text are placeholders: the send path builds both from the Digest row (ref) and reads the address then.
    await queueEmail(tx, { to: member.user.email, subject: "Your weekly digest", text: "[digest]", ref: `digest:${id}` });
  });
}
