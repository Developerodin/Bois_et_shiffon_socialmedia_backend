import { beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { CrmScope } from "@/server/crm/common";
import { ConversationCreate, createConversation, logMessage, updateConversation } from "@/server/crm/conversations";
import { createCustomer, CustomerCreate } from "@/server/crm/customers";
import { followUpCounts, listFollowUps, queueFollowUps, TASKS_PER_BRAND } from "@/server/crm/follow-ups";
import type { PermissionKey } from "@/shared";

/** Plan 2026-11-27-crm, Task A6: the follow-up queue and its tasks (O3, O4, Decisions 19 and 20). */
let s: CrmScope;
let ws: string;
let customer: string;
let inboxRole: string;
let approver: string;
const H = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * H).toISOString();
const tasksOf = (id: string) => prisma.task.findMany({ where: { requestId: { startsWith: `followup:${id}:` } }, orderBy: { createdAt: "asc" } });
const fresh = async (id: string) => (await prisma.conversation.findUniqueOrThrow({ where: { id } })).updatedAt.toISOString();

async function brandWith(slug: string) {
  const brandId = (await prisma.brand.create({ data: { workspaceId: ws, slug, displayName: slug } })).id;
  return { ...s, brandId };
}

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-crm-fu" } })).id;
  const brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "B" } })).id;
  const u = await prisma.user.create({ data: { email: "a@crm-fu.test", name: "a" } });
  const admin = await prisma.role.create({ data: { workspaceId: ws, slug: "adm", name: "Adm", permissions: ["brand.read", "crm.manage", "inbox.read", "tasks.read", "tasks.all"] } });
  await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: u.id, roleId: admin.id } });
  // The inbox role: a project role with inbox.read and tasks.read, held by one active person on the brand.
  inboxRole = (await prisma.role.create({ data: { workspaceId: ws, slug: "approver", name: "Approver", scope: "PROJECT", permissions: ["brand.read", "inbox.read", "tasks.read"] } })).id;
  const member = await prisma.role.create({ data: { workspaceId: ws, slug: "member", name: "Member", permissions: [] } });
  approver = (await prisma.user.create({ data: { email: "p@crm-fu.test", name: "p" } })).id;
  await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: approver, roleId: member.id } });
  await prisma.brandMember.create({ data: { workspaceId: ws, brandId: brand, userId: approver, roleId: inboxRole } });
  s = { workspaceId: ws, brandId: brand, userId: u.id, perms: new Set<PermissionKey>(["brand.read", "crm.manage", "inbox.read"]) };
  customer = (await createCustomer(s, CustomerCreate.parse({ displayName: "Jeanne Martin" }))).id;
});

const start = (scope: CrmScope, cust: string, fromCustomer: boolean, sentAt: string) =>
  createConversation(scope, ConversationCreate.parse({ customerId: cust, message: { fromCustomer, medium: "EMAIL", text: "Bonjour, about the sofa", sentAt } }));

describe("follow-up tasks", () => {
  it("none before 24 h; after, one CRM task for the inbox role, made once, its title without customer text", async () => {
    const c = await start(s, customer, true, ago(23));
    expect(await tasksOf(c.id)).toEqual([]);
    await queueFollowUps(new Date(Date.now() + 2 * H));
    await queueFollowUps(new Date(Date.now() + 3 * H));
    const [t, ...more] = await tasksOf(c.id);
    expect(more).toEqual([]);
    expect(t).toMatchObject({ areas: ["CRM"], ownerId: null, ownerRoleId: inboxRole, status: "TODO", title: "Reply to a customer conversation" });
    expect(`${t!.title} ${t!.description}`).not.toMatch(/Jeanne|sofa/);
    expect(await prisma.notification.count({ where: { taskId: t!.id, userId: approver } })).toBe(1);
  });

  it("a customer message logged more than 24 h after it was sent makes the task at once; our reply closes it", async () => {
    const c = await start(s, customer, true, ago(30));
    const [t] = await tasksOf(c.id);
    expect(t?.status).toBe("TODO");
    // A second customer message doesn't start another episode.
    await logMessage(s, c.id, { fromCustomer: true, medium: "PHONE", text: "Called again", sentAt: ago(26) });
    expect(await tasksOf(c.id)).toHaveLength(1);
    await logMessage(s, c.id, { fromCustomer: false, medium: "EMAIL", text: "Answered", sentAt: ago(0) });
    const after = await tasksOf(c.id);
    expect(after.map((x) => x.status)).toEqual(["DONE"]);
    expect(await prisma.taskComment.count({ where: { taskId: after[0]!.id, kind: "SYSTEM" } })).toBe(1);
  });

  it("the conversation owner gets it while they may hold a CRM task", async () => {
    const c = await start(s, customer, true, ago(2));
    await updateConversation(s, c.id, { updatedAt: await fresh(c.id), ownerId: s.userId });
    await queueFollowUps(new Date(Date.now() + 23 * H));
    expect((await tasksOf(c.id))[0]).toMatchObject({ ownerId: s.userId, ownerRoleId: null });
  });

  it("waiting on the customer: a task after 7 days; closing the conversation closes it", async () => {
    const c = await start(s, customer, false, ago(1));
    await queueFollowUps(new Date(Date.now() + 6 * 24 * H));
    expect(await tasksOf(c.id)).toEqual([]);
    await queueFollowUps(new Date(Date.now() + 8 * 24 * H));
    const [t] = await tasksOf(c.id);
    expect(t?.title).toBe("Follow up: the customer hasn't answered for 7 days");
    await updateConversation(s, c.id, { updatedAt: await fresh(c.id), closed: true });
    expect((await tasksOf(c.id))[0]?.status).toBe("DONE");
    // Reopened: a new episode, so it can fall due again (here at once: it was waiting before, 7 more days later).
    await updateConversation(s, c.id, { updatedAt: await fresh(c.id), closed: false });
    await queueFollowUps(new Date(Date.now() + 8 * 24 * H));
    expect((await tasksOf(c.id)).map((t) => t.status)).toEqual(["DONE", "TODO"]);
  });

  it("the sweep's task bookkeeping doesn't make someone's open edit a 409", async () => {
    const c = await start(s, customer, true, ago(2));
    const seen = await fresh(c.id);
    await queueFollowUps(new Date(Date.now() + 23 * H));
    expect(await tasksOf(c.id)).toHaveLength(1);
    await expect(updateConversation(s, c.id, { updatedAt: seen, nextAction: "Call" })).resolves.toMatchObject({ nextAction: "Call" });
  });

  it("no inbox role on the brand: the task is unowned", async () => {
    const s2 = await brandWith("no-role");
    const cust = (await createCustomer(s2, CustomerCreate.parse({ displayName: "X" }))).id;
    const c = await start(s2, cust, true, ago(30));
    expect((await tasksOf(c.id))[0]).toMatchObject({ ownerId: null, ownerRoleId: null });
  });

  it(`at most ${TASKS_PER_BRAND} new tasks per brand per sweep`, async () => {
    const s3 = await brandWith("many");
    const cust = (await createCustomer(s3, CustomerCreate.parse({ displayName: "Y" }))).id;
    for (let i = 0; i < TASKS_PER_BRAND + 2; i++) await start(s3, cust, true, ago(2));
    await queueFollowUps(new Date(Date.now() + 23 * H));
    expect(await prisma.task.count({ where: { brandId: s3.brandId, requestId: { startsWith: "followup:" } } })).toBe(TASKS_PER_BRAND);
  });
});

describe("the queue", () => {
  it("filters and counts: needs a reply, overdue, waiting, mine", async () => {
    const s4 = await brandWith("queue");
    const cust = (await createCustomer(s4, CustomerCreate.parse({ displayName: "Z" }))).id;
    const fresh1 = await start(s4, cust, true, ago(1));
    const late = await start(s4, cust, true, ago(30));
    const waiting = await start(s4, cust, false, ago(1));
    await updateConversation(s4, fresh1.id, { updatedAt: await fresh(fresh1.id), ownerId: s.userId });
    expect(await followUpCounts(s4)).toEqual({ needsReply: 2, overdue: 1, waiting: 1, mine: 1 });
    expect((await listFollowUps(s4, { filter: "overdue" })).conversations.map((c) => c.id)).toEqual([late.id]);
    expect((await listFollowUps(s4, { filter: "waiting" })).conversations.map((c) => c.id)).toEqual([waiting.id]);
    expect((await listFollowUps(s4, { filter: "mine" })).conversations.map((c) => c.id)).toEqual([fresh1.id]);
    expect((await listFollowUps(s4, { filter: "open" })).conversations).toHaveLength(3);
  });
});
