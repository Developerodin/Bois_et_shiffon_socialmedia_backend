import type { Conversation, Prisma } from "@prisma/client";
import { brandTimeZone, zoneToday } from "@/server/data/sources";
import { prisma } from "@/server/db/prisma";
import { canBeAssigned } from "@/server/tasks/access";
import { closeTasks, createKeyedTask } from "@/server/tasks/system-tasks";

/**
 * The follow-up task of a conversation (plan 2026-11-27-crm, Decisions 5, 19, 20; owner decisions O3, O4). One task per
 * episode, keyed `followup:<conversationId>:<episode ms>` on Task.requestId:
 *  - "reply": the customer's first message after ours (Conversation.episodeAt) unanswered for 24 h;
 *  - "waiting": waiting on the customer for more than 7 days (Conversation.waitingSince).
 * It goes to the conversation's owner while they may hold a CRM task, else to the inbox role, else to nobody (seen by
 * the people who see every task). Answering, waiting on the customer or closing closes it. Titles never carry customer
 * text. Callers hold the conversation's row lock (server/crm/conversations.ts lockConversation).
 */
const H = 3_600_000;
export const REPLY_AFTER_MS = 24 * H;
export const WAITING_AFTER_MS = 7 * 24 * H;

type Scope = { workspaceId: string; brandId: string };
type Due = { kind: "reply" | "waiting"; at: Date };

/** The episode a task is due for now, or null. */
export function dueEpisode(c: Pick<Conversation, "closedAt" | "waitingSince" | "episodeAt" | "lastMessageAt" | "lastFromCustomer">, now: Date): Due | null {
  if (c.closedAt) return null;
  if (c.waitingSince) return now.getTime() - c.waitingSince.getTime() > WAITING_AFTER_MS ? { kind: "waiting", at: c.waitingSince } : null;
  const since = c.episodeAt ?? c.lastMessageAt;
  return now.getTime() - since.getTime() > REPLY_AFTER_MS ? { kind: "reply", at: since } : null;
}

export const followUpKey = (conversationId: string, at: Date) => `followup:${conversationId}:${at.getTime()}`;

const TITLE = { reply: "Reply to a customer conversation", waiting: "Follow up: the customer hasn't answered for 7 days" } as const;
const DESCRIPTION = {
  reply: "A customer has been waiting more than a day for an answer. Open the conversation in Sales & CRM (Follow-ups) to reply, then log your reply.",
  waiting: "We have been waiting a week for the customer to answer. Open the conversation in Sales & CRM (Follow-ups) to nudge them or close it.",
} as const;

/**
 * Who a follow-up goes to on a brand: per run, the inbox role (the non-client PROJECT role holding inbox.read and
 * tasks.read with the most active people on the brand; ties to the oldest) and each owner's "may they hold a CRM task"
 * answer are worked out once (performance review 4).
 */
export class FollowUpOwners {
  private role: Promise<string | null> | null = null;
  private zone: Promise<string> | null = null;
  private owners = new Map<string, Promise<boolean>>();
  constructor(
    private readonly tx: Prisma.TransactionClient | typeof prisma,
    private readonly s: Scope,
  ) {}

  private inboxRole() {
    this.role ??= this.tx
      .$queryRaw<{ id: string }[]>`
        SELECT r.id FROM "Role" r
        JOIN "BrandMember" bm ON bm."roleId" = r.id AND bm."brandId" = ${this.s.brandId}
        JOIN "User" u ON u.id = bm."userId" AND u.status = 'ACTIVE' AND u."deletedAt" IS NULL
        WHERE r."workspaceId" = ${this.s.workspaceId} AND r.scope = 'PROJECT' AND 'inbox.read' = ANY(r.permissions) AND 'tasks.read' = ANY(r.permissions)
          AND NOT (r."isSystem" AND r.slug = 'client-reviewer')
        GROUP BY r.id, r."createdAt" ORDER BY count(*) DESC, r."createdAt" ASC LIMIT 1`
      .then((rows) => rows[0]?.id ?? null);
    return this.role;
  }

  /** The brand's time zone, read once per run (on this client, not inside each conversation's transaction). */
  today(now: Date) {
    this.zone ??= brandTimeZone(this.s);
    return this.zone.then((z) => zoneToday(z, now));
  }

  async for(ownerId: string | null): Promise<{ ownerId: string | null; ownerRoleId: string | null }> {
    if (ownerId) {
      let ok = this.owners.get(ownerId);
      if (!ok) this.owners.set(ownerId, (ok = canBeAssigned(this.tx, this.s, ownerId, { reviewerId: null, workProjectId: null, areas: ["CRM"] })));
      if (await ok) return { ownerId, ownerRoleId: null };
    }
    return { ownerId: null, ownerRoleId: await this.inboxRole() };
  }
}

/**
 * Brings the conversation's follow-up task in line with its state: the open one closes when its episode is over (we
 * answered, it was closed, a new episode began), and a due episode without its task gets one. Idempotent.
 */
export async function syncFollowUp(tx: Prisma.TransactionClient, s: Scope, conversationId: string, now: Date, owners = new FollowUpOwners(tx, s)) {
  const c = await tx.conversation.findFirst({ where: { id: conversationId, workspaceId: s.workspaceId, brandId: s.brandId } });
  if (!c) return false;
  const due = dueEpisode(c, now);
  const key = due ? followUpKey(c.id, due.at) : null;
  let taskId = c.followUpTaskId;
  if (taskId) {
    const t = await tx.task.findFirst({ where: { id: taskId, brandId: s.brandId }, select: { requestId: true } });
    if (!t || t.requestId !== key) {
      const why = c.closedAt ? "The conversation was closed" : !due ? "Someone answered the customer" : "A newer follow-up of the same conversation replaces this one";
      if (t) await closeTasks(tx, s, [taskId], why, { conversationId: c.id });
      taskId = null;
    }
  }
  let created = false;
  if (due && !taskId) {
    const today = await owners.today(now);
    const who = await owners.for(c.ownerId);
    const t = await createKeyedTask(tx, s, {
      requestId: key!,
      title: TITLE[due.kind],
      description: `${DESCRIPTION[due.kind]}\n\n/crm?tab=follow-ups&c=${c.id}`,
      areas: ["CRM"],
      ...who,
      dueOn: new Date(`${today}T00:00:00Z`),
    });
    taskId = t.id;
    created = t.created;
  }
  // Raw, so `updatedAt` stays: the sweep must not turn someone's open edit of the conversation into a 409.
  if (taskId !== c.followUpTaskId) await tx.$executeRaw`UPDATE "Conversation" SET "followUpTaskId" = ${taskId} WHERE id = ${c.id}`;
  return created;
}
