import { beforeAll, describe, expect, it, vi } from "vitest";

const who = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/server/auth/request-user", () => ({ requestUserId: vi.fn(async () => who.userId) }));

import { prisma } from "@/server/db/prisma";
import { GET as followUps } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/crm/follow-ups/route";
import { GET as counts } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/crm/follow-ups/counts/route";
import { GET as customers, POST as createCustomer } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/crm/customers/route";
import { POST as search } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/crm/customers/search/route";
import { GET as deals } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/crm/deals/route";
import { POST as createConversation } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/crm/conversations/route";
import { GET as conversation } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/crm/conversations/[conversationId]/route";
import { POST as draft } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/crm/conversations/[conversationId]/draft/route";
import { POST as erase } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/crm/customers/[customerId]/erase/route";

/** Plan 2026-11-27-crm: the CRM routes' permission gates and input errors, through the real brand guard. */
let ws: string;
let brand: string;
const users: Record<string, string> = {};
let conv: string;
let cust: string;

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-crm-routes" } })).id;
  brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "B" } })).id;
  const roles: Record<string, string[]> = {
    inbox: ["brand.read", "inbox.read"],
    records: ["brand.read", "crm.manage"],
    both: ["brand.read", "crm.manage", "inbox.read"],
    viewer: ["brand.read", "analytics.read"],
  };
  for (const [slug, permissions] of Object.entries(roles)) {
    const role = await prisma.role.create({ data: { workspaceId: ws, slug, name: slug, permissions } });
    const u = await prisma.user.create({ data: { email: `${slug}@crm-routes.test`, name: slug } });
    await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: u.id, roleId: role.id } });
    users[slug] = u.id;
  }
  who.userId = users.both!;
  const made = await createCustomer(post("crm/customers", { displayName: "Jeanne" }), ctx());
  cust = ((await made.json()) as { customer: { id: string } }).customer.id;
  const c = await createConversation(post("crm/conversations", { customerId: cust, message: { fromCustomer: true, medium: "EMAIL", text: "Hello", sentAt: new Date().toISOString() } }), ctx());
  conv = ((await c.json()) as { conversation: { id: string } }).conversation.id;
});

const base = () => `http://x/api/v1/workspaces/${ws}/brands/${brand}`;
const get = (path: string) => new Request(`${base()}/${path}`);
const post = (path: string, body: unknown) => new Request(`${base()}/${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } });
const ctx = <T extends object>(extra?: T) => ({ params: Promise.resolve({ workspaceId: ws, brandId: brand, ...(extra ?? {}) }) as Promise<{ workspaceId: string; brandId: string } & T> });
const as = (slug: string) => (who.userId = users[slug]!);

describe("CRM routes", () => {
  it("inbox.read only: the queue and counts, not customers or deals", async () => {
    as("inbox");
    expect((await followUps(get("crm/follow-ups"), ctx())).status).toBe(200);
    expect((await counts(get("crm/follow-ups/counts"), ctx())).status).toBe(200);
    expect((await conversation(get(`crm/conversations/${conv}`), ctx({ conversationId: conv }))).status).toBe(200);
    expect((await customers(get("crm/customers"), ctx())).status).toBe(403);
    expect((await deals(get("crm/deals"), ctx())).status).toBe(403);
    // Starting a conversation links a customer: both keys.
    expect((await createConversation(post("crm/conversations", { customerId: cust, message: { fromCustomer: true, medium: "EMAIL", text: "x", sentAt: new Date().toISOString() } }), ctx())).status).toBe(403);
  });

  it("crm.manage only: records, not the queue or a conversation; a viewer gets nothing", async () => {
    as("records");
    expect((await customers(get("crm/customers"), ctx())).status).toBe(200);
    expect((await followUps(get("crm/follow-ups"), ctx())).status).toBe(403);
    expect((await conversation(get(`crm/conversations/${conv}`), ctx({ conversationId: conv }))).status).toBe(403);
    as("viewer");
    expect((await customers(get("crm/customers"), ctx())).status).toBe(403);
    expect((await counts(get("crm/follow-ups/counts"), ctx())).status).toBe(403);
  });

  it("a draft needs content.create; erase needs a workspace owner or admin", async () => {
    as("both");
    expect((await draft(post(`crm/conversations/${conv}/draft`, {}), ctx({ conversationId: conv }))).status).toBe(403);
    expect((await erase(post(`crm/customers/${cust}/erase`, {}), ctx({ customerId: cust }))).status).toBe(403);
  });

  it("bad input is a 400, never a 500, and never repeats the value", async () => {
    as("both");
    expect((await search(post("crm/customers/search", { q: "j" }), ctx())).status).toBe(400);
    expect((await search(post("crm/customers/search", "{not json"), ctx())).status).toBe(400);
    expect((await search(post("crm/customers/search", { q: "je" }), ctx())).status).toBe(200);
    const bad = await createCustomer(post("crm/customers", { displayName: "X", identities: [{ kind: "PHONE", value: "call 0612 maybe" }] }), ctx());
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("0612");
    expect((await customers(get("crm/customers?cursor=%%%"), ctx())).status).toBe(400);
  });
});
