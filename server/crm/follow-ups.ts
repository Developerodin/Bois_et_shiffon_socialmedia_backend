import { Prisma } from "@prisma/client";
import { z } from "zod";
import { brandWhere, type CrmScope } from "@/server/crm/common";
import { brandToday, lockConversation, toConversationRow, withCustomer } from "@/server/crm/conversations";
import { FollowUpOwners, REPLY_AFTER_MS, syncFollowUp, WAITING_AFTER_MS } from "@/server/crm/follow-up-tasks";
import { prisma } from "@/server/db/prisma";
import { TX } from "@/server/services/publishing";
import { fromCursor, toCursor } from "@/server/tasks/cursor";
import { CRM_LIMITS, type ConversationRow, type FollowUpCounts, type FollowUpFilter } from "@/shared";

/**
 * The follow-up queue (plan 2026-11-27-crm, Task A6), inbox.read: who needs a reply, what is overdue, what waits on the
 * customer. States are derived on read from the stored columns, so the queue is never stale even if the daily sweep
 * that makes follow-up tasks is late. The customer shows by name and id only (no identities, notes or deals).
 * ponytail: past ~20k open conversations per brand the overdue filter and counts want a stored state column kept by a
 * trigger; until then the queue index (brandId, closedAt, lastMessageAt desc, id) carries them.
 */
export const FOLLOW_UP_FILTERS = ["open", "mine", "needsReply", "overdue", "waiting", "closed"] as const satisfies readonly FollowUpFilter[];
export const QueueQuery = z.object({ filter: z.enum(FOLLOW_UP_FILTERS).default("open"), cursor: z.string().max(400).optional() });
const Cursor = z.object({ at: z.string().datetime(), id: z.string() });

/** The overdue rule (followUpState) as a filter: needs a reply for 24 h, waiting 7 days, or a next action passed. */
function overdueWhere(now: Date, today: string): Prisma.ConversationWhereInput {
  const reply = new Date(now.getTime() - REPLY_AFTER_MS);
  return {
    OR: [
      { waitingSince: null, OR: [{ episodeAt: { lt: reply } }, { episodeAt: null, lastMessageAt: { lt: reply } }] },
      { waitingSince: { lt: new Date(now.getTime() - WAITING_AFTER_MS) } },
      { nextActionDue: { lt: new Date(`${today}T00:00:00Z`) } },
    ],
  };
}

export async function listFollowUps(s: CrmScope, query: z.infer<typeof QueueQuery>, now = new Date()): Promise<{ conversations: ConversationRow[]; nextCursor: string | null }> {
  const today = await brandToday(s, now);
  const open = { closedAt: null };
  const by: Record<FollowUpFilter, Prisma.ConversationWhereInput> = {
    open,
    mine: { ...open, ownerId: s.userId },
    needsReply: { ...open, waitingSince: null },
    waiting: { ...open, waitingSince: { not: null } },
    overdue: { ...open, ...overdueWhere(now, today) },
    closed: { closedAt: { not: null } },
  };
  const after = query.cursor ? fromCursor(Cursor, query.cursor) : null;
  const rows = await prisma.conversation.findMany({
    where: {
      ...brandWhere(s),
      AND: [by[query.filter], ...(after ? [{ OR: [{ lastMessageAt: { lt: new Date(after.at) } }, { lastMessageAt: new Date(after.at), id: { lt: after.id } }] }] : [])],
    },
    include: withCustomer,
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    take: CRM_LIMITS.queuePage + 1,
  });
  const page = rows.slice(0, CRM_LIMITS.queuePage);
  const last = page.at(-1);
  return { conversations: page.map((c) => toConversationRow(c, now, today)), nextCursor: rows.length > page.length && last ? toCursor({ at: last.lastMessageAt.toISOString(), id: last.id }) : null };
}

/** The Overview's counts for the viewer, in one query (performance review 5). */
export async function followUpCounts(s: CrmScope, now = new Date()): Promise<FollowUpCounts> {
  const today = new Date(`${await brandToday(s, now)}T00:00:00Z`);
  const reply = new Date(now.getTime() - REPLY_AFTER_MS);
  const waiting = new Date(now.getTime() - WAITING_AFTER_MS);
  const [r] = await prisma.$queryRaw<{ needsReply: bigint; overdue: bigint; waiting: bigint; mine: bigint }[]>`
    SELECT
      count(*) FILTER (WHERE "waitingSince" IS NULL) AS "needsReply",
      count(*) FILTER (WHERE ("waitingSince" IS NULL AND COALESCE("episodeAt", "lastMessageAt") < ${reply}) OR "waitingSince" < ${waiting} OR "nextActionDue" < ${today}) AS overdue,
      count(*) FILTER (WHERE "waitingSince" IS NOT NULL) AS waiting,
      count(*) FILTER (WHERE "ownerId" = ${s.userId}) AS mine
    FROM "Conversation"
    WHERE "workspaceId" = ${s.workspaceId} AND "brandId" = ${s.brandId} AND "closedAt" IS NULL`;
  return { needsReply: Number(r?.needsReply ?? 0), overdue: Number(r?.overdue ?? 0), waiting: Number(r?.waiting ?? 0), mine: Number(r?.mine ?? 0) };
}

/** At most this many new follow-up tasks per brand per sweep, and conversations looked at per sweep. */
export const TASKS_PER_BRAND = 50;
const SCAN = 5_000;

/**
 * Daily: every open conversation whose follow-up is due and has no task yet gets one (one cross-brand query, then per
 * brand at most TASKS_PER_BRAND, each under its conversation's row lock). A retried sweep makes nothing twice (the
 * task key is unique). Returns the number of tasks made.
 */
export async function queueFollowUps(now = new Date()) {
  const reply = new Date(now.getTime() - REPLY_AFTER_MS);
  // At most TASKS_PER_BRAND candidates per brand (oldest first), so one brand's backlog never starves the others.
  const due = await prisma.$queryRaw<{ id: string; workspaceId: string; brandId: string }[]>`
    SELECT id, "workspaceId", "brandId" FROM (
      SELECT id, "workspaceId", "brandId", row_number() OVER (PARTITION BY "brandId" ORDER BY "lastMessageAt") AS n
      FROM "Conversation"
      WHERE "closedAt" IS NULL AND "followUpTaskId" IS NULL
        AND (("waitingSince" IS NULL AND COALESCE("episodeAt", "lastMessageAt") < ${reply}) OR "waitingSince" < ${new Date(now.getTime() - WAITING_AFTER_MS)})
    ) d WHERE n <= ${TASKS_PER_BRAND} LIMIT ${SCAN}`;
  const byBrand = new Map<string, typeof due>();
  for (const c of due) byBrand.set(c.brandId, [...(byBrand.get(c.brandId) ?? []), c]);
  let made = 0;
  for (const list of byBrand.values()) {
    const s = { workspaceId: list[0]!.workspaceId, brandId: list[0]!.brandId };
    let brandMade = 0;
    // The inbox role and each owner's answer, read once per brand (outside the per-conversation transactions).
    const owners = new FollowUpOwners(prisma, s);
    for (const c of list) {
      if (brandMade >= TASKS_PER_BRAND) break;
      try {
        const created = await prisma.$transaction(async (tx) => {
          await lockConversation(tx, s, c.id);
          return syncFollowUp(tx, s, c.id, now, owners);
        }, TX);
        if (created) brandMade++;
      } catch (e) {
        // That conversation only; ids and the error's name, never its text (it may quote a row).
        console.error("[crm] follow-up failed", c.id, e instanceof Error ? e.name : "error");
      }
    }
    made += brandMade;
  }
  return made;
}
