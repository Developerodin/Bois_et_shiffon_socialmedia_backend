import { beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { CrmScope } from "@/server/crm/common";
import { ConversationCreate, createConversation, followUpState, getConversation, logMessage, updateConversation } from "@/server/crm/conversations";
import { createCustomer, CustomerCreate, getCustomer } from "@/server/crm/customers";
import type { PermissionKey } from "@/shared";

/** Plan 2026-11-27-crm, Task A5: logged conversations, their derived follow-up state, owner and next action. */
let s: CrmScope;
let other: CrmScope;
let customer: string;
let crmOnly: string;
const H = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * H).toISOString();

beforeAll(async () => {
  const ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-crm-conv" } })).id;
  const brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "B" } })).id;
  const brand2 = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b2", displayName: "B2" } })).id;
  const u = await prisma.user.create({ data: { email: "a@crm-conv.test", name: "a" } });
  const role = await prisma.role.create({ data: { workspaceId: ws, slug: "inbox", name: "Inbox", permissions: ["brand.read", "crm.manage", "inbox.read", "tasks.read"] } });
  await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: u.id, roleId: role.id } });
  const crmRole = await prisma.role.create({ data: { workspaceId: ws, slug: "records", name: "Records", permissions: ["brand.read", "crm.manage"] } });
  crmOnly = (await prisma.user.create({ data: { email: "r@crm-conv.test", name: "r" } })).id;
  await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: crmOnly, roleId: crmRole.id } });
  s = { workspaceId: ws, brandId: brand, userId: u.id, perms: new Set<PermissionKey>(["brand.read", "crm.manage", "inbox.read"]) };
  other = { ...s, brandId: brand2 };
  customer = (await createCustomer(s, CustomerCreate.parse({ displayName: "Jeanne Martin" }))).id;
});

const start = (fromCustomer: boolean, sentAt: string, text = "Do you have the oak table in 180 cm?") =>
  createConversation(s, ConversationCreate.parse({ customerId: customer, subject: "Oak table", message: { fromCustomer, medium: "EMAIL", text, sentAt } }));

describe("follow-up state", () => {
  const base = { closedAt: null, waitingSince: null, nextActionDue: null, lastFromCustomer: true };
  const now = new Date("2026-11-27T12:00:00Z");
  it("needs a reply, overdue after 24 h; waiting, overdue after 7 days; a passed next action is overdue; closed is never overdue", () => {
    expect(followUpState({ ...base, lastMessageAt: new Date(now.getTime() - 23 * H) }, now, "2026-11-27")).toEqual({ state: "NEEDS_REPLY", overdue: false });
    expect(followUpState({ ...base, lastMessageAt: new Date(now.getTime() - 25 * H) }, now, "2026-11-27")).toEqual({ state: "NEEDS_REPLY", overdue: true });
    expect(followUpState({ ...base, lastFromCustomer: false, waitingSince: new Date(now.getTime() - 6 * 24 * H), lastMessageAt: now }, now, "2026-11-27")).toEqual({ state: "WAITING", overdue: false });
    expect(followUpState({ ...base, lastFromCustomer: false, waitingSince: new Date(now.getTime() - 8 * 24 * H), lastMessageAt: now }, now, "2026-11-27")).toEqual({ state: "WAITING", overdue: true });
    expect(followUpState({ ...base, lastMessageAt: now, nextActionDue: new Date("2026-11-26T00:00:00Z") }, now, "2026-11-27").overdue).toBe(true);
    expect(followUpState({ ...base, lastMessageAt: new Date(0), closedAt: now }, now, "2026-11-27")).toEqual({ state: "CLOSED", overdue: false });
  });
});

describe("conversations", () => {
  it("a customer message needs a reply; ours makes it wait; a back-dated message doesn't change the latest", async () => {
    const c = await start(true, ago(2));
    expect(c).toMatchObject({ state: "NEEDS_REPLY", overdue: false, lastFromCustomer: true, customer: { id: customer } });
    const replied = await logMessage(s, c.id, { fromCustomer: false, medium: "PHONE", text: "Called back, sending a quote", sentAt: ago(1) });
    expect(replied).toMatchObject({ state: "WAITING", lastFromCustomer: false });
    expect(Math.abs(Date.parse(replied.waitingSince!) - (Date.now() - H))).toBeLessThan(60_000);
    const old = await logMessage(s, c.id, { fromCustomer: true, medium: "EMAIL", text: "an older email", sentAt: ago(30) });
    expect(old).toMatchObject({ state: "WAITING", lastFromCustomer: false });
    expect(old.messages[0]!.text).toBe("Called back, sending a quote");
    const back = await logMessage(s, c.id, { fromCustomer: true, medium: "WHATSAPP", text: "Thanks!", sentAt: ago(0) });
    expect(back).toMatchObject({ state: "NEEDS_REPLY" });
  });

  it("a logged conversation needs a customer of this brand; a future date is refused", async () => {
    expect(() => ConversationCreate.parse({ message: { fromCustomer: true, medium: "EMAIL", text: "x", sentAt: ago(1) } })).toThrow();
    const foreign = await createCustomer(other, CustomerCreate.parse({ displayName: "Foreign" }));
    await expect(createConversation(s, ConversationCreate.parse({ customerId: foreign.id, message: { fromCustomer: true, medium: "EMAIL", text: "x", sentAt: ago(1) } }))).rejects.toMatchObject({ status: 404 });
    await expect(start(true, new Date(Date.now() + 2 * H).toISOString())).rejects.toMatchObject({ status: 400, code: "crm.messageDate" });
  });

  it("the owner must read customer messages; waiting, close and reopen; another brand is 404", async () => {
    const c = await start(true, ago(3));
    await expect(updateConversation(s, c.id, { updatedAt: (await prisma.conversation.findUniqueOrThrow({ where: { id: c.id } })).updatedAt.toISOString(), ownerId: crmOnly })).rejects.toMatchObject({ status: 400, code: "crm.owner" });
    const fresh = async () => (await prisma.conversation.findUniqueOrThrow({ where: { id: c.id } })).updatedAt.toISOString();
    expect(await updateConversation(s, c.id, { updatedAt: await fresh(), waiting: true, ownerId: s.userId, nextAction: "Send fabric samples", nextActionDue: "2026-12-02" })).toMatchObject({ state: "WAITING", ownerId: s.userId, nextActionDue: "2026-12-02" });
    expect(await updateConversation(s, c.id, { updatedAt: await fresh(), closed: true })).toMatchObject({ state: "CLOSED" });
    // A new customer message reopens it.
    expect(await logMessage(s, c.id, { fromCustomer: true, medium: "EMAIL", text: "One more question", sentAt: ago(0) })).toMatchObject({ state: "NEEDS_REPLY", closedAt: null });
    await expect(getConversation(other, c.id)).rejects.toMatchObject({ status: 404 });
  });

  it("the customer page shows conversations only to inbox.read holders; the audit never holds message text", async () => {
    const c = await start(true, ago(1), "My address is 12 rue des Lilas");
    expect((await getCustomer(s, customer)).conversations?.some((x) => x.id === c.id)).toBe(true);
    expect((await getCustomer({ ...s, perms: new Set<PermissionKey>(["crm.manage"]) }, customer)).conversations).toBeNull();
    expect(JSON.stringify(await prisma.auditEvent.findMany({ where: { entityId: c.id } }))).not.toContain("Lilas");
  });
});
