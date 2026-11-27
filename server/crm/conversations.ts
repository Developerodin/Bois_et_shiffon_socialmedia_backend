import type { Conversation, Prisma } from "@prisma/client";
import { z } from "zod";
import { brandWhere, changed, checkCrmLinks, checkOwner, crmAudit, type CrmScope, type Db, dayOf, dayString, invalid, notFound } from "@/server/crm/common";
import { syncFollowUp } from "@/server/crm/follow-up-tasks";
import { brandTimeZone, zoneToday } from "@/server/data/sources";
import { prisma } from "@/server/db/prisma";
import { AccessDeniedError } from "@/server/auth/errors";
import { TX } from "@/server/services/publishing";
import { CRM_LIMITS, MESSAGE_MEDIA, type ConversationDto, type ConversationMessageDto, type ConversationRow, type FollowUpState } from "@/shared";

/**
 * Conversations and logged messages (plan 2026-11-27-crm, Task A5). inbox.read for everything; anything that sets or
 * changes the customer also needs crm.manage (Decision 17), so logging a conversation (always with a customer) needs
 * both. A logged message is typed in by a person and never sent anywhere. The follow-up state is derived from the
 * stored columns (followUpState); the stored ones are recomputed from the latest message on every log, under the
 * conversation's row lock, so a back-dated message never becomes the "latest".
 */
const DAY = 86_400_000;
export const NEEDS_REPLY_MS = DAY;
/** O4 (owner): waiting on the customer returns to the queue after 7 days. */
export const WAITING_MS = 7 * DAY;
/** Stored messages are kept 13 months (owner, 2026-11-24): an older date can't be logged. */
export const MESSAGE_KEEP_MS = 396 * DAY;

const id = z.string().min(1).max(40);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates are YYYY-MM-DD");
export const MessageInput = z.object({
  fromCustomer: z.boolean(),
  medium: z.enum(MESSAGE_MEDIA),
  text: z.string().trim().min(1, "Write what was said").max(CRM_LIMITS.message, `A message is at most ${CRM_LIMITS.message} characters`),
  sentAt: z.string().datetime({ offset: true }),
});
export const ConversationCreate = z.object({ customerId: id, subject: z.string().trim().max(CRM_LIMITS.subject).nullable().optional(), ownerId: id.nullable().optional(), message: MessageInput });
export const ConversationPatch = z.object({
  updatedAt: z.string().datetime(),
  subject: z.string().trim().max(CRM_LIMITS.subject).nullable().optional(),
  customerId: id.nullable().optional(),
  ownerId: id.nullable().optional(),
  nextAction: z.string().trim().max(CRM_LIMITS.nextAction).nullable().optional(),
  nextActionDue: day.nullable().optional(),
  /** true: waiting on the customer from now; false: back to needing our reply */
  waiting: z.boolean().optional(),
  /** true: close; false: reopen */
  closed: z.boolean().optional(),
});

type Stored = Pick<Conversation, "closedAt" | "waitingSince" | "lastMessageAt" | "lastFromCustomer" | "nextActionDue" | "episodeAt">;

/**
 * Decision 5: CLOSED when closed; WAITING when waiting is set (overdue after 7 days); else NEEDS_REPLY (overdue 24 h
 * after the episode's first unanswered message). A next action whose day has passed is overdue too. `today`: the brand's day "YYYY-MM-DD".
 */
export function followUpState(c: Stored, now: Date, today: string): { state: FollowUpState; overdue: boolean } {
  if (c.closedAt) return { state: "CLOSED", overdue: false };
  const actionLate = !!c.nextActionDue && dayString(c.nextActionDue)! < today;
  if (c.waitingSince) return { state: "WAITING", overdue: actionLate || now.getTime() - c.waitingSince.getTime() > WAITING_MS };
  return { state: "NEEDS_REPLY", overdue: actionLate || now.getTime() - (c.episodeAt ?? c.lastMessageAt).getTime() > NEEDS_REPLY_MS };
}

export type ConversationWithCustomer = Conversation & { customer: { id: string; displayName: string } | null };
export const withCustomer = { customer: { select: { id: true, displayName: true } } } as const;

export function toConversationRow(c: ConversationWithCustomer, now: Date, today: string): ConversationRow {
  return {
    id: c.id,
    channel: c.channel,
    subject: c.subject,
    customer: c.customer,
    ownerId: c.ownerId,
    nextAction: c.nextAction,
    nextActionDue: dayString(c.nextActionDue),
    lastMessageAt: c.lastMessageAt.toISOString(),
    lastFromCustomer: c.lastFromCustomer,
    waitingSince: c.waitingSince?.toISOString() ?? null,
    closedAt: c.closedAt?.toISOString() ?? null,
    updatedAt: c.updatedAt.toISOString(),
    ...followUpState(c, now, today),
  };
}

const toMessage = (m: { id: string; medium: ConversationMessageDto["medium"]; fromCustomer: boolean; text: string; sentAt: Date; loggedById: string | null }): ConversationMessageDto => ({
  id: m.id,
  medium: m.medium,
  fromCustomer: m.fromCustomer,
  text: m.text,
  sentAt: m.sentAt.toISOString(),
  loggedById: m.loggedById,
});

/** The brand's local day (for "next action passed"). */
export async function brandToday(s: { workspaceId: string; brandId: string }, now = new Date()) {
  return zoneToday(await brandTimeZone(s), now);
}

export async function loadConversation(db: Db, s: { workspaceId: string; brandId: string }, conversationId: string) {
  const c = await db.conversation.findFirst({ where: { id: conversationId, ...brandWhere(s) } });
  if (!c) throw notFound("Conversation");
  return c;
}

/** Locks the conversation row for the rest of the transaction (logging, state changes and follow-up tasks queue on it). */
export async function lockConversation(tx: Prisma.TransactionClient, s: { workspaceId: string; brandId: string }, conversationId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Conversation" WHERE id = ${conversationId} AND "workspaceId" = ${s.workspaceId} AND "brandId" = ${s.brandId} FOR UPDATE`;
  if (!rows.length) throw notFound("Conversation");
}

function checkSentAt(sentAt: string, now: Date) {
  const t = new Date(sentAt).getTime();
  if (t > now.getTime() + 5 * 60_000) throw invalid("A message can't be dated in the future", "crm.messageDate");
  if (now.getTime() - t > MESSAGE_KEEP_MS) throw invalid("Messages older than 13 months aren't kept", "crm.messageDate");
}

/**
 * The stored follow-up columns from the messages themselves: the latest (by sentAt, then createdAt) decides who wrote
 * last. Our message last: waiting since it. The customer's last: needing a reply, the episode starting at their first
 * message after our last one (so a second customer message doesn't start a new episode), and a closed one reopens.
 */
export async function recompute(tx: Prisma.TransactionClient, conversationId: string) {
  const [latest] = await tx.conversationMessage.findMany({ where: { conversationId }, orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }], take: 1, select: { sentAt: true, fromCustomer: true } });
  if (!latest) return;
  if (!latest.fromCustomer) {
    await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: latest.sentAt, lastFromCustomer: false, waitingSince: latest.sentAt, episodeAt: null } });
    return;
  }
  const ours = await tx.conversationMessage.findFirst({ where: { conversationId, fromCustomer: false }, orderBy: { sentAt: "desc" }, select: { sentAt: true } });
  const first = await tx.conversationMessage.findFirst({
    where: { conversationId, fromCustomer: true, ...(ours ? { sentAt: { gt: ours.sentAt } } : {}) },
    orderBy: { sentAt: "asc" },
    select: { sentAt: true },
  });
  await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: latest.sentAt, lastFromCustomer: true, waitingSince: null, closedAt: null, episodeAt: first?.sentAt ?? latest.sentAt } });
}

/** After every change: the conversation's follow-up task follows its state (server/crm/follow-up-tasks.ts). */
const afterChange = async (tx: Prisma.TransactionClient, s: { workspaceId: string; brandId: string }, conversationId: string, now: Date) => {
  await syncFollowUp(tx, s, conversationId, now);
};

export async function getConversation(s: CrmScope, conversationId: string, now = new Date()): Promise<ConversationDto> {
  const c = await prisma.conversation.findFirst({ where: { id: conversationId, ...brandWhere(s) }, include: withCustomer });
  if (!c) throw notFound("Conversation");
  const messages = await prisma.conversationMessage.findMany({ where: { conversationId: c.id }, orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }], take: 200 });
  // The summary is stale when any message was stored after it (a back-dated log included: createdAt, not sentAt).
  const newer = c.summaryThrough ? await prisma.conversationMessage.count({ where: { conversationId: c.id, createdAt: { gt: c.summaryThrough } } }) : 0;
  return {
    ...toConversationRow(c, now, await brandToday(s, now)),
    messages: messages.map(toMessage),
    summary: c.summary,
    summaryThrough: c.summaryThrough?.toISOString() ?? null,
    summaryStale: !!c.summary && newer > 0,
  };
}

/** A logged conversation with its first message; the customer (this brand's) is required (Decision 11). */
export async function createConversation(s: CrmScope, input: z.infer<typeof ConversationCreate>, now = new Date()) {
  if (!s.perms.has("crm.manage")) throw new AccessDeniedError("Missing permission crm.manage");
  checkSentAt(input.message.sentAt, now);
  const conv = await prisma.$transaction(async (tx) => {
    await checkCrmLinks(tx, s, { customerId: input.customerId });
    await checkOwner(tx, s, input.ownerId, "inbox.read");
    const sentAt = new Date(input.message.sentAt);
    const c = await tx.conversation.create({
      data: { ...brandWhere(s), channel: "LOGGED", customerId: input.customerId, subject: input.subject || null, ownerId: input.ownerId ?? null, lastMessageAt: sentAt, lastFromCustomer: input.message.fromCustomer },
    });
    await tx.conversationMessage.create({ data: { ...brandWhere(s), conversationId: c.id, medium: input.message.medium, fromCustomer: input.message.fromCustomer, text: input.message.text, sentAt, loggedById: s.userId } });
    await recompute(tx, c.id);
    await tx.customer.updateMany({ where: { id: input.customerId, lastActivityAt: { lt: now } }, data: { lastActivityAt: now } });
    await afterChange(tx, s, c.id, now);
    await crmAudit(tx, s, "conversation.created", "Conversation", c.id, { customerId: input.customerId, medium: input.message.medium, fromCustomer: input.message.fromCustomer, length: input.message.text.length });
    return c;
  }, TX);
  return getConversation(s, conv.id, now);
}

/** One logged message (in or out, any medium, dated by the person). */
export async function logMessage(s: CrmScope, conversationId: string, input: z.infer<typeof MessageInput>, now = new Date()) {
  checkSentAt(input.sentAt, now);
  await prisma.$transaction(async (tx) => {
    await lockConversation(tx, s, conversationId);
    const c = await loadConversation(tx, s, conversationId);
    if (c.channel !== "LOGGED") throw invalid("Messages are logged on logged conversations only", "crm.notLogged");
    const m = await tx.conversationMessage.create({ data: { ...brandWhere(s), conversationId, medium: input.medium, fromCustomer: input.fromCustomer, text: input.text, sentAt: new Date(input.sentAt), loggedById: s.userId } });
    await recompute(tx, conversationId);
    await tx.customer.updateMany({ where: { id: c.customerId ?? "", lastActivityAt: { lt: now } }, data: { lastActivityAt: now } });
    await afterChange(tx, s, conversationId, now);
    await crmAudit(tx, s, "conversation.message.logged", "Conversation", conversationId, { messageId: m.id, medium: input.medium, fromCustomer: input.fromCustomer, length: input.text.length });
  }, TX);
  return getConversation(s, conversationId, now);
}

/** Owner, next action, subject, customer link, waiting on/off, close/reopen, on the `updatedAt` read. */
export async function updateConversation(s: CrmScope, conversationId: string, patch: z.infer<typeof ConversationPatch>, now = new Date()) {
  const { updatedAt, waiting, closed, ...rest } = patch;
  if (rest.customerId !== undefined && !s.perms.has("crm.manage")) throw new AccessDeniedError("Missing permission crm.manage");
  await prisma.$transaction(async (tx) => {
    await lockConversation(tx, s, conversationId);
    const c = await loadConversation(tx, s, conversationId);
    if (c.updatedAt.toISOString() !== new Date(updatedAt).toISOString()) throw changed("This conversation");
    if (rest.customerId === null && c.channel === "LOGGED") throw invalid("A logged conversation keeps a customer", "crm.needsCustomer");
    await checkCrmLinks(tx, s, { customerId: rest.customerId });
    await checkOwner(tx, s, rest.ownerId, "inbox.read");
    const blank = (v: string | null | undefined) => (v === undefined ? undefined : v || null);
    await tx.conversation.update({
      where: { id: conversationId },
      data: {
        subject: blank(rest.subject), customerId: rest.customerId, ownerId: rest.ownerId, nextAction: blank(rest.nextAction), nextActionDue: dayOf(rest.nextActionDue),
        ...(waiting === true ? { waitingSince: now, episodeAt: null } : waiting === false ? { waitingSince: null, episodeAt: c.episodeAt ?? now } : {}),
        ...(closed === true ? { closedAt: now } : closed === false ? { closedAt: null } : {}),
      },
    });
    if (rest.customerId) await tx.customer.updateMany({ where: { id: rest.customerId, lastActivityAt: { lt: now } }, data: { lastActivityAt: now } });
    await afterChange(tx, s, conversationId, now);
    await crmAudit(tx, s, "conversation.updated", "Conversation", conversationId, { fields: Object.keys(rest), ...(waiting !== undefined ? { waiting } : {}), ...(closed !== undefined ? { closed } : {}) });
  }, TX);
  return getConversation(s, conversationId, now);
}

/** A customer's conversations, latest first (the customer page; inbox.read holders only). */
export async function customerConversations(s: CrmScope, customerId: string, now = new Date()) {
  const rows = await prisma.conversation.findMany({ where: { customerId, ...brandWhere(s) }, include: withCustomer, orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }], take: 50 });
  const today = await brandToday(s, now);
  return rows.map((c) => toConversationRow(c, now, today));
}
