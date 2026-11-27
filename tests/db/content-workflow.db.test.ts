import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const who = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/server/auth/request-user", () => ({ requestUserId: vi.fn(async () => who.userId) }));
vi.mock("@/server/jobs/runner", () => ({ kickRunner: vi.fn(), kickIfDue: vi.fn(async () => {}) }));
vi.mock("@/server/services/subscriptions", async (orig) => ({ ...(await orig<object>()), requirePlan: vi.fn(async () => {}) }));

import { prisma } from "@/server/db/prisma";
import { POST as start } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/content-workflows/route";
import { PATCH as patch } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/content-workflows/[workflowId]/route";
import { POST as startRun } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/agents/[agentKey]/runs/route";
import { briefAgent } from "@/server/agents/definitions/brief";
import { creatorAgent } from "@/server/agents/definitions/creator";
import { plannerAgent } from "@/server/agents/definitions/planner";
import { NothingToDoError } from "@/server/agents/engine";
import { creditBalance } from "@/server/services/credits";
import { linkedIds } from "@/server/content/product-checks";
import { workflowStatus } from "@/server/content/workflow";

/**
 * Content workflows on a real database: the API's checks, idempotency and charge, then the Planner → Brief writer →
 * Creator with a scripted model, checking a workflow's chosen products survive to the draft. Also the Planner's
 * per-brand lock, which until now was only tested with mocks.
 */
let ws: string;
let brand: string;
let other: { ws: string; brand: string; product: string; connection: string; idea: string };
let products: string[];
let ig: string;
let ideas: string[];
const owner = { id: "" };

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-workflow" } })).id;
  brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "Oak & Co" } })).id;
  const role = await prisma.role.create({ data: { workspaceId: ws, slug: "owner", name: "owner", permissions: ["brand.read", "agents.read", "agents.run"] } });
  owner.id = (await prisma.user.create({ data: { email: "owner@workflow.test", name: "Owner" } })).id;
  await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: owner.id, roleId: role.id } });
  await prisma.creditEntry.create({ data: { workspaceId: ws, delta: 100, reason: "plan-credits", refId: "test" } });
  products = [];
  for (const title of ["Oak table", "Oak chair", "Walnut shelf"]) {
    products.push((await prisma.product.create({ data: { workspaceId: ws, brandId: brand, source: "MANUAL", title, url: null, inStock: true } })).id);
  }
  ig = (await prisma.integrationConnection.create({
    data: { workspaceId: ws, brandId: brand, provider: "INSTAGRAM", externalAccountId: "ig1", displayName: "@oak", scopes: [], credentialKeyVersion: 1, connectedByUserId: owner.id },
  })).id;
  ideas = [];
  for (const [n, title] of ["Care for oak", "Dining room ideas"].entries()) {
    ideas.push((await prisma.opportunity.create({ data: { workspaceId: ws, brandId: brand, dedupeKey: `k${n}`, title, summary: "s", angle: "a", channels: ["INSTAGRAM_POST"], decision: "RECOMMEND", reason: "r", score: 50 } })).id);
  }
  const ows = (await prisma.workspace.create({ data: { name: "O", slug: "o-workflow" } })).id;
  const ob = (await prisma.brand.create({ data: { workspaceId: ows, slug: "o", displayName: "Other" } })).id;
  other = {
    ws: ows,
    brand: ob,
    product: (await prisma.product.create({ data: { workspaceId: ows, brandId: ob, source: "MANUAL", title: "Theirs", inStock: true } })).id,
    connection: (await prisma.integrationConnection.create({
      data: { workspaceId: ows, brandId: ob, provider: "INSTAGRAM", externalAccountId: "ig2", displayName: "@other", scopes: [], credentialKeyVersion: 1, connectedByUserId: owner.id },
    })).id,
    idea: (await prisma.opportunity.create({ data: { workspaceId: ows, brandId: ob, dedupeKey: "o", title: "Theirs", summary: "s", angle: "a", channels: [], decision: "RECOMMEND", reason: "r", score: 1 } })).id,
  };
});

beforeEach(() => {
  who.userId = owner.id;
});

const base = () => `http://x/api/v1/workspaces/${ws}/brands/${brand}`;
const json = (body: unknown, method = "POST") => ({ method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const post = (body: unknown) => start(new Request(`${base()}/content-workflows`, json(body)), { params: Promise.resolve({ workspaceId: ws, brandId: brand }) });
const act = (id: string, body: unknown) =>
  patch(new Request(`${base()}/content-workflows/${id}`, json(body, "PATCH")), { params: Promise.resolve({ workspaceId: ws, brandId: brand, workflowId: id }) });
let n = 0;
const request = (over: object = {}) => ({
  requestId: `request-${++n}-${Date.now()}`, source: "web-wizard", targets: [{ channel: "INSTAGRAM_POST", connectionId: ig }], productMode: "manual", productIds: [products[0], products[1]],
  ideaIds: [ideas[0]], ...over,
});
type View = { id: string; status: string; stages: { stage: string; state: string; runId: string | null }[]; posts: Record<string, number> };
const ctx = (ai: (input: { mock: unknown; prompt: string }) => Promise<unknown>) =>
  ({ runId: "test-run", userId: owner.id, brand: { workspaceId: ws, brandId: brand, displayName: "Oak & Co" }, log: vi.fn(async () => {}), ai: { generateObject: ai } }) as never;

describe("starting a workflow", () => {
  it("refuses another brand's product, account or idea, and a channel's wrong network", async () => {
    for (const over of [
      { productIds: [other.product] },
      { targets: [{ channel: "INSTAGRAM_POST", connectionId: other.connection }] },
      { ideaIds: [other.idea] },
      { targets: [{ channel: "FACEBOOK_POST", connectionId: ig }] },
      { productMode: "none" },
      { productMode: "manual", productIds: [] },
      { targets: [{ channel: "INSTAGRAM_REEL", connectionId: null }] },
      { extra: true },
    ]) {
      const res = await post(request(over));
      expect(res.status, JSON.stringify(over)).toBe(422);
    }
    expect(await prisma.contentWorkflow.count({ where: { brandId: brand } })).toBe(0);
    expect(await prisma.agentRun.count({ where: { brandId: brand } })).toBe(0);
  });

  it("charges the Planner once and starts it with only the workflow's id; a repeat gets the same workflow", async () => {
    const before = (await creditBalance(ws)) + 20; // the starter grant lands on the first spend
    const body = request();
    const first = await post(body);
    expect(first.status, await first.clone().text()).toBe(201);
    const { workflow } = (await first.json()) as { workflow: View };
    const again = await post(body);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { workflow: View; repeated: boolean })).toMatchObject({ workflow: { id: workflow.id }, repeated: true });
    const runs = await prisma.agentRun.findMany({ where: { workflowId: workflow.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agentKey: "planner", trigger: "manual", workflowId: workflow.id });
    expect(runs[0]!.input).toMatchObject({ chain: true, workflowId: workflow.id });
    expect(Object.keys(runs[0]!.input as object).sort()).toEqual(["chain", "chargeId", "workflowId"]);
    expect(await creditBalance(ws)).toBe(before - 5);
    const stored = await prisma.contentWorkflow.findUniqueOrThrow({ where: { id: workflow.id } });
    expect(stored.chargeIds).toEqual([`workflow:${workflow.id}:planner`]);
    expect(workflow.stages[0]).toMatchObject({ stage: "planner", state: "queued" });
    await prisma.agentRun.updateMany({ where: { workflowId: workflow.id }, data: { status: "FAILED" } }); // out of the way
  });

  it("the runs route won't start a stage with a workflow's id", async () => {
    const res = await startRun(new Request(`${base()}/agents/planner/runs`, json({ input: { workflowId: "x" } })), { params: Promise.resolve({ workspaceId: ws, brandId: brand, agentKey: "planner" }) });
    expect(res.status, await res.clone().text()).toBe(422);
  });
});

/** What the engine does when a run's job ends: here the agents are run by hand, so their queued runs are closed. */
const finish = (workflowId: string) => prisma.agentRun.updateMany({ where: { workflowId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "SUCCEEDED" } });
const runsOf = async (workflowId: string) => (await prisma.agentRun.findMany({ where: { workflowId }, orderBy: { createdAt: "asc" } })).map((r) => r.agentKey);
const statusOf = async (workflowId: string) => (await prisma.contentWorkflow.findUniqueOrThrow({ where: { id: workflowId } })).status;

describe("a workflow's posts through the chain", () => {
  it("waits for one approval after the Planner and the Brief writer, and keeps the chosen products to the draft", async () => {
    const res = await post(request({ ideaIds: [ideas[1]] }));
    const { workflow } = (await res.json()) as { workflow: View };
    // The model names one chosen product, and one it wasn't given.
    await plannerAgent.run(
      ctx(async ({ mock }) => ({ posts: (mock as { posts: object[] }).posts.map((p) => ({ ...p, productIds: [products[1], products[2]] })) })),
      { chain: true, workflowId: workflow.id },
    );
    await finish(workflow.id);
    const planned = await prisma.contentItem.findMany({ where: { workflowId: workflow.id } });
    expect(planned.length).toBeGreaterThan(0);
    for (const item of planned) {
      expect(item).toMatchObject({ channel: "INSTAGRAM_POST", connectionId: ig, productIds: [products[1]], status: "PLANNED" });
    }
    // Gate 1: the plan waits for a person; nothing was chained.
    expect(await statusOf(workflow.id)).toBe("REVIEW_PLAN");
    expect(await runsOf(workflow.id)).toEqual(["planner"]);
    expect((await act(workflow.id, { action: "approve", stage: "briefs" })).status).toBe(409);
    // A double click approves once: one Brief writer run.
    const clicks = await Promise.all([act(workflow.id, { action: "approve", stage: "plan" }), act(workflow.id, { action: "approve", stage: "plan" })]);
    expect(clicks.map((r) => r.status).sort()).toEqual([200, 202]);
    expect(await runsOf(workflow.id)).toEqual(["planner", "brief"]);
    expect(await statusOf(workflow.id)).toBe("RUNNING");

    // The Brief writer's model picks another product: the post keeps its own. Gate 2: no Creator until approved.
    await briefAgent.run(ctx(async ({ mock }) => ({ ...(mock as object), productIds: [products[2]] })), { chain: true, workflowId: workflow.id });
    await finish(workflow.id);
    for (const item of await prisma.contentItem.findMany({ where: { workflowId: workflow.id } })) {
      expect(item).toMatchObject({ status: "BRIEF_READY", productIds: [products[1]] });
      expect((item.brief as { products: string[] }).products).toEqual(["Oak chair"]);
    }
    expect(await statusOf(workflow.id)).toBe("REVIEW_BRIEFS");
    expect(await runsOf(workflow.id)).toEqual(["planner", "brief"]);
    const approved = await act(workflow.id, { action: "approve", stage: "briefs" });
    expect(approved.status).toBe(202);
    expect(((await approved.json()) as { workflow: View }).workflow.status).toBe("RUNNING");
    expect(await runsOf(workflow.id)).toEqual(["planner", "brief", "creator"]);
    expect((await act(workflow.id, { action: "approve", stage: "briefs" })).status).toBe(200);
    expect(await runsOf(workflow.id)).toEqual(["planner", "brief", "creator"]);

    await creatorAgent.run(ctx(async ({ mock }) => mock), { workflowId: workflow.id });
    const drafted = await prisma.contentItem.findMany({ where: { workflowId: workflow.id }, include: { versions: true } });
    for (const item of drafted) {
      expect(item.status).toBe("DRAFT_REVIEW");
      expect(linkedIds(item.versions[0]!.body)).toEqual([products[1]]);
    }
  });

  it("a cancel at a gate cancels the posts not yet written, and the gate can't be approved after", async () => {
    const res = await post(request({ ideaIds: undefined, productMode: "catalogue", productIds: [] }));
    const { workflow } = (await res.json()) as { workflow: View };
    await prisma.opportunity.updateMany({ where: { id: ideas[0] }, data: { status: "SHORTLISTED" } });
    await plannerAgent.run(ctx(async ({ mock }) => mock), { chain: true, workflowId: workflow.id });
    await finish(workflow.id);
    expect(await statusOf(workflow.id)).toBe("REVIEW_PLAN");
    expect(await prisma.contentItem.count({ where: { workflowId: workflow.id, status: "PLANNED" } })).toBeGreaterThan(0);
    const cancelled = await act(workflow.id, { action: "cancel" });
    expect(((await cancelled.json()) as { workflow: View }).workflow.status).toBe("CANCELLED");
    expect(await prisma.contentItem.count({ where: { workflowId: workflow.id, status: { not: "CANCELLED" } } })).toBe(0);
    expect((await act(workflow.id, { action: "approve", stage: "plan" })).status).toBe(409);
    expect(await runsOf(workflow.id)).toEqual(["planner"]);
    await expect(briefAgent.run(ctx(async ({ mock }) => mock), { chain: true, workflowId: workflow.id })).rejects.toThrow(NothingToDoError);
    expect((await act(workflow.id, { action: "retry", stage: "brief" })).status).toBe(409);
  });

  it("retrying a stage restarts only that stage, never past a gate; the Planner only after it failed", async () => {
    const res = await post(request({ ideaIds: undefined, productMode: "none", productIds: [] }));
    const { workflow } = (await res.json()) as { workflow: View };
    // Still running: nothing can be retried.
    expect((await act(workflow.id, { action: "retry", stage: "brief" })).status).toBe(409);
    await finish(workflow.id);
    // The Planner planned (a post written by hand here) and waits at the plan's gate.
    await prisma.contentItem.create({ data: { workspaceId: ws, brandId: brand, title: "t", channel: "INSTAGRAM_POST", workflowId: workflow.id } });
    await prisma.contentWorkflow.update({ where: { id: workflow.id }, data: { status: "REVIEW_PLAN" } });
    expect((await act(workflow.id, { action: "retry", stage: "planner" })).status).toBe(409);
    expect((await act(workflow.id, { action: "retry", stage: "brief" })).status).toBe(409); // the plan isn't approved
    expect((await act(workflow.id, { action: "approve", stage: "plan" })).status).toBe(202);
    // Its Brief writer run died; the retry starts that stage again, and nothing else.
    await prisma.agentRun.updateMany({ where: { workflowId: workflow.id, agentKey: "brief" }, data: { status: "FAILED" } });
    expect((await act(workflow.id, { action: "retry", stage: "creator" })).status).toBe(409); // the briefs aren't approved
    const retried = await act(workflow.id, { action: "retry", stage: "brief" });
    expect(retried.status).toBe(202);
    const { runId } = (await retried.json()) as { runId: string };
    const runs = await prisma.agentRun.findMany({ where: { workflowId: workflow.id }, orderBy: { createdAt: "asc" } });
    expect(runs.map((r) => r.agentKey)).toEqual(["planner", "brief", "brief"]);
    expect(runs[2]).toMatchObject({ id: runId, trigger: "event", input: { chain: true, workflowId: workflow.id } });
  });

  it("a failed Planner is retried with a new charge, the earlier one given back", async () => {
    const res = await post(request({ ideaIds: undefined, productMode: "none", productIds: [] }));
    const { workflow } = (await res.json()) as { workflow: View };
    const balance = await creditBalance(ws);
    // The engine refunds a failed Planner; here the run just ends FAILED, so the retry gives the charge back.
    await prisma.agentRun.updateMany({ where: { workflowId: workflow.id }, data: { status: "FAILED" } });
    const retried = await act(workflow.id, { action: "retry", stage: "planner" });
    expect(retried.status).toBe(202);
    expect(await creditBalance(ws)).toBe(balance); // +5 back, −5 again
    const stored = await prisma.contentWorkflow.findUniqueOrThrow({ where: { id: workflow.id } });
    expect(stored.chargeIds).toEqual([`workflow:${workflow.id}:planner`, `workflow:${workflow.id}:planner:2`]);
  });
});

describe("review findings", () => {
  it("a run without a workflow (the phone's Generate calendar, a plain Plan) leaves a workflow's posts at its gate", async () => {
    const fresh = await prisma.opportunity.create({ data: { workspaceId: ws, brandId: brand, dedupeKey: "gate", title: "Gate idea", summary: "s", angle: "a", channels: [], decision: "RECOMMEND", reason: "r", score: 10 } });
    const res = await post(request({ ideaIds: [fresh.id], productMode: "catalogue", productIds: [] }));
    const { workflow } = (await res.json()) as { workflow: View };
    await plannerAgent.run(ctx(async ({ mock }) => mock), { chain: true, workflowId: workflow.id });
    await finish(workflow.id);
    expect(await statusOf(workflow.id)).toBe("REVIEW_PLAN");
    expect(await prisma.contentItem.count({ where: { brandId: brand, status: "PLANNED", workflowId: null } })).toBe(0);
    await expect(briefAgent.run(ctx(async ({ mock }) => mock), { chain: true })).rejects.toThrow(NothingToDoError);
    expect(await prisma.contentItem.count({ where: { workflowId: workflow.id, status: { not: "PLANNED" } } })).toBe(0);
    expect((await act(workflow.id, { action: "approve", stage: "plan" })).status).toBe(202);
  });

  it("two Planner retries at once: one starts and is paid, the other is refused and refunds nothing", async () => {
    const res = await post(request({ ideaIds: undefined, productMode: "none", productIds: [] }));
    const { workflow } = (await res.json()) as { workflow: View };
    await prisma.agentRun.updateMany({ where: { workflowId: workflow.id }, data: { status: "FAILED" } });
    const balance = await creditBalance(ws);
    const both = await Promise.all([act(workflow.id, { action: "retry", stage: "planner" }), act(workflow.id, { action: "retry", stage: "planner" })]);
    expect(both.map((r) => r.status).sort()).toEqual([202, 409]);
    const planners = await prisma.agentRun.findMany({ where: { workflowId: workflow.id, agentKey: "planner" }, orderBy: { createdAt: "asc" } });
    expect(planners).toHaveLength(2);
    const live = (planners[1]!.input as { chargeId: string }).chargeId;
    expect(await prisma.creditEntry.count({ where: { workspaceId: ws, reason: "refund", refId: live } })).toBe(0);
    expect(await creditBalance(ws)).toBe(balance); // the first charge back, one new charge
  });

  it("a Planner that found nothing to plan and made no posts needs attention, not done", async () => {
    const res = await post(request({ ideaIds: undefined, productMode: "none", productIds: [] }));
    const { workflow } = (await res.json()) as { workflow: View };
    const run = await prisma.agentRun.findFirstOrThrow({ where: { workflowId: workflow.id } });
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "FAILED" } });
    await prisma.agentEvent.create({ data: { workspaceId: ws, brandId: brand, runId: run.id, agentKey: "planner", level: "INFO", message: "No ideas to plan" } });
    expect((await workflowStatus({ workspaceId: ws, brandId: brand }, workflow.id)).status).toBe("NEEDS_ATTENTION");
  });
});

describe("the Planner's per-brand lock", () => {
  it("two Planner runs for one brand take turns: the second sees the first's posts and plans nothing twice", async () => {
    await prisma.contentItem.deleteMany({ where: { brandId: brand } });
    await prisma.opportunity.updateMany({ where: { brandId: brand }, data: { status: "DISMISSED" } });
    const idea = await prisma.opportunity.create({ data: { workspaceId: ws, brandId: brand, dedupeKey: "lock", title: "Lock idea", summary: "s", angle: "a", channels: [], decision: "RECOMMEND", reason: "r", score: 99, status: "SHORTLISTED" } });
    const calls: { at: number; done?: number }[] = [];
    const slowAi = async ({ mock }: { mock: unknown }) => {
      const call: { at: number; done?: number } = { at: Date.now() };
      calls.push(call);
      await new Promise((r) => setTimeout(r, 400));
      call.done = Date.now();
      return mock;
    };
    const results = await Promise.allSettled([plannerAgent.run(ctx(slowAi), {}), plannerAgent.run(ctx(slowAi), {})]);
    // One planned the idea; the other waited, then found it planned and had nothing to do.
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(NothingToDoError);
    expect(calls).toHaveLength(1);
    const items = await prisma.contentItem.findMany({ where: { brandId: brand, opportunityId: idea.id } });
    expect(items.length).toBeGreaterThan(0);
    expect(new Set(items.map((i) => i.channel)).size).toBe(items.length); // one post per channel, none twice
  });
});
