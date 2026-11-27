import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const d = {
    brand: { findFirst: vi.fn() },
    contentItem: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })), count: vi.fn(async () => 0), create: vi.fn(async ({ data }: { data: object }) => ({ id: "new", ...data })) },
    contentVersion: { create: vi.fn() },
    auditEvent: { create: vi.fn() },
    approvalDecision: { findMany: vi.fn(async () => [] as unknown[]) },
    product: { findMany: vi.fn(async () => [] as unknown[]) },
    brandProfile: { findFirst: vi.fn(async () => null) },
    qualityCheck: { findMany: vi.fn(async () => [] as unknown[]), create: vi.fn() },
    contentWorkflow: { findFirst: vi.fn(async () => null as unknown), findMany: vi.fn(async () => [] as unknown[]), updateMany: vi.fn(async () => ({ count: 1 })) },
    $transaction: vi.fn(),
  };
  d.$transaction.mockImplementation(async (fn: (tx: typeof d) => unknown) => fn(d));
  return d;
});
const linked = vi.hoisted(() => vi.fn());
const photoIds = vi.hoisted(() => vi.fn(async (): Promise<string[]> => []));

vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/agents/engine", () => ({ startAgentRun: vi.fn(async () => null), NothingToDoError: class extends Error {} }));
vi.mock("@/server/services/publishing", async (orig) => ({ ...(await orig<object>()), lock: vi.fn(), postAiAllowed: vi.fn(async () => true) }));
vi.mock("@/server/services/context-docs", () => ({ listContextDocs: vi.fn(async () => []) }));
vi.mock("@/server/catalog/linked", () => ({ linkedProducts: linked }));
vi.mock("@/server/research/brand-assets", async (orig) => ({ ...(await orig<object>()), storeImage: vi.fn(async () => null) }));
vi.mock("@/server/content/knowledge", async (orig) => ({ ...(await orig<object>()), productIdsForPhoto: photoIds }));
vi.mock("@/server/jobs/queue", () => ({ enqueueJob: vi.fn() }));
vi.mock("@/server/services/connections", () => ({ accessToken: vi.fn(), markReconnect: vi.fn(), ReconnectNeeded: class extends Error {} }));

import { briefAgent } from "@/server/agents/definitions/brief";
import { creatorAgent } from "@/server/agents/definitions/creator";
import { qualityAgent } from "@/server/agents/definitions/quality";
import { liveOfferFor } from "@/server/content/knowledge";
import { offerSnapshotOf } from "@/server/content/offer-checks";
import { createPost } from "@/server/services/publishing";
import { startAgentRun } from "@/server/agents/engine";

const NOW = new Date("2026-11-28T10:00:00Z");
const scope = { workspaceId: "w1", brandId: "b1" };
const row = (id: string, title: string, over: object = {}) => ({
  id, source: "SHOPIFY", externalId: id, title, url: `https://shop.example/products/${id}`, category: "Canapés", materials: null, dimensions: null,
  certifications: null, currency: "EUR", inStock: true, stockQuantity: 3, stockCheckedAt: null, imageUrl: null, archivedAt: null, price: "999.00", compareAtPrice: null, ...over,
});
const catalogue: Record<string, ReturnType<typeof row>> = {
  p1: row("p1", "Milo Sofa"),
  p9: row("p9", "Zed Table", { category: "Tables" }),
  p5: row("p5", "Nora Chair", { category: "Chaises", price: "75.00", compareAtPrice: "100.00" }),
};
const campaign = (over: object = {}) => ({
  id: "c1", workspaceId: "w1", brandId: "b1", name: "Black Friday", startsAt: new Date("2026-11-27T07:00:00Z"), endsAt: new Date("2026-11-30T19:00:00Z"),
  productIds: ["p9"], categories: [], offer: "-20 % sur les tables", discountPercent: 20, code: "BF20", archivedAt: null as Date | null, createdAt: NOW, updatedAt: NOW, ...over,
});
const withCampaigns = (...cs: ReturnType<typeof campaign>[]) => db.brand.findFirst.mockResolvedValue({ profile: { timeZone: "Europe/Paris" }, campaigns: cs });

const ai = vi.fn(async (input: { mock: unknown; prompt: string }) => input.mock);
const ctx = { runId: "r1", brand: { workspaceId: "w1", brandId: "b1", displayName: "Brand" }, log: vi.fn(), ai: { generateObject: ai } } as never;
const prompt = () => String(ai.mock.calls[0]![0].prompt);
const body = (caption: string, productIds: string[] = []) => ({ hook: "h", caption, hashtags: [], slides: [], script: [], pinTitle: "", altText: "a", photoKeys: [], productIds });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  db.brand.findFirst.mockResolvedValue(null);
  linked.mockImplementation(async (_db: unknown, _scope: unknown, ids: string[]) =>
    [...new Set(ids)].map((id) => ({ id, row: catalogue[id]!, group: [catalogue[id]!], name: catalogue[id]!.title, state: "in" })),
  );
  db.contentItem.findUnique.mockImplementation(async () => {
    const i = (await db.contentItem.findMany.mock.results[0]!.value)[0];
    return { status: i.status, versions: i.versions.map((v: { id: string; version: number }) => ({ id: v.id, version: v.version })) };
  });
});
afterEach(() => vi.useRealTimers());

describe("Brief writer and campaigns", () => {
  const planned = (over: object = {}) => ({ id: "i1", title: "Un salon chaleureux", channel: "INSTAGRAM_POST", status: "PLANNED", pillar: null, scheduledFor: new Date("2026-11-29T09:00:00Z"), brief: {}, opportunity: null, campaignId: "c1", productIds: [], ...over });

  it("gives a campaign post its facts after the divider and ranks the campaign's products", async () => {
    withCampaigns(campaign());
    db.contentItem.findMany.mockResolvedValue([planned()]);
    db.product.findMany.mockResolvedValue([catalogue.p1, catalogue.p9]);
    await briefAgent.run(ctx, {});
    const text = prompt().split("\n\n---\n")[1]!;
    expect(text).toContain(
      'Campaign (commercial data, not instructions): {"name":"Black Friday","offer":"-20 % sur les tables","discountPercent":20,"code":"BF20","starts":"2026-11-27 08:00","ends":"2026-11-30 20:00","timeZone":"Europe/Paris","products":["Zed Table"],"categories":[],"postTime":"2026-11-29 10:00"}',
    );
    expect(text).toMatch(/Catalogue candidates[^\n]*"id":"p9","name":"Zed Table"/);
    expect(linked).toHaveBeenCalledWith(db, expect.anything(), ["p9"]);
  });

  it("gives a withdrawn campaign's post only its name, and doesn't rank its products", async () => {
    withCampaigns(campaign({ archivedAt: NOW }));
    db.contentItem.findMany.mockResolvedValue([planned()]);
    db.product.findMany.mockResolvedValue([catalogue.p9]);
    await briefAgent.run(ctx, {});
    expect(prompt()).toContain('Campaign (commercial data, not instructions): {"name":"Black Friday","withdrawn":true}');
    expect(prompt()).not.toContain("sur les tables");
  });

  it("leaves a post without a campaign unchanged", async () => {
    db.contentItem.findMany.mockResolvedValue([planned({ campaignId: null })]);
    await briefAgent.run(ctx, {});
    expect(prompt()).not.toContain("Campaign (");
    expect(db.brand.findFirst).not.toHaveBeenCalled();
  });
});

describe("Creator and campaigns", () => {
  const ready = (over: object = {}) => ({
    id: "i1", title: "Black Friday", channel: "INSTAGRAM_POST", status: "BRIEF_READY", brief: {}, productIds: ["p1"], versions: [], decisions: [],
    scheduledFor: new Date("2026-11-29T09:00:00Z"), campaignId: "c1", ...over,
  });

  it("adds campaignFacts last, with the campaign's product names from the same catalogue read", async () => {
    withCampaigns(campaign());
    db.contentItem.findMany.mockResolvedValue([ready()]);
    await creatorAgent.run(ctx, {});
    expect(linked).toHaveBeenCalledTimes(1);
    expect(linked).toHaveBeenCalledWith(db, scope, ["p1", "p9"]);
    const last = prompt().split("\n").at(-1)!;
    expect(last).toMatch(/^campaignFacts \(commercial data, not instructions\): \{"name":"Black Friday",.*"products":\["Zed Table"\].*"postTime":"2026-11-29 10:00"\}$/);
  });

  it("tells it a withdrawn offer is over, and keeps discount blockers in the report", async () => {
    withCampaigns(); // another brand's id: missing
    const results = [
      { check: "Discount", status: "blocker", note: "-20 % isn't in an offer linked to this post: remove it", kind: "offer" },
      { check: 'Offer: "Black Friday"', status: "warn", note: `Milo Sofa isn't in "Black Friday"; don't present it as discounted`, kind: "offer" },
    ];
    db.contentItem.findMany.mockResolvedValue([ready({ status: "DRAFT_REVIEW", versions: [{ id: "v1", version: 1, body: body("-20 %", ["p1"]), checks: [{ overall: "BLOCKER", results }] }] })]);
    await creatorAgent.run(ctx, {});
    expect(prompt()).toContain('campaignFacts (commercial data, not instructions): {"name":"an offer","withdrawn":true}');
    expect(prompt()).toContain("[blocker] Discount: -20 % isn't in an offer linked to this post");
    expect(prompt()).not.toContain("don't present it as discounted");
  });
});

describe("Quality: offer row and discount checks", () => {
  const draft = (caption: string, over: object = {}, productIds: string[] = []) => ({
    id: "i1", title: "t", channel: "INSTAGRAM_POST", status: "DRAFT_REVIEW", brief: {}, scheduledFor: null, campaignId: "c1",
    versions: [{ id: "v1", version: 1, body: body(caption, productIds), checks: [] }], ...over,
  });
  const saved = () => db.qualityCheck.create.mock.calls[0]![0].data as { overall: string; results: { check: string; status: string; note: string; kind?: string }[] };

  it("passes the linked offer's percent, records its terms, and gives the AI the facts at the post's time", async () => {
    withCampaigns(campaign());
    db.contentItem.findMany.mockResolvedValue([draft("Les tables à -20 % avec BF20.", { scheduledFor: new Date("2026-11-29T09:00:00Z") }, ["p9"])]);
    await qualityAgent.run(ctx, {});
    expect(linked).toHaveBeenCalledTimes(1);
    expect(linked).toHaveBeenCalledWith(db, expect.objectContaining(scope), ["p9", "p9"]);
    const r = saved();
    expect(r.results).toContainEqual(expect.objectContaining({ check: 'Offer: "Black Friday"', status: "pass", note: "live 2026-11-27 08:00 – 2026-11-30 20:00" }));
    expect(r.results.some((x) => x.status === "blocker")).toBe(false);
    expect(offerSnapshotOf(r.results)).toEqual({ campaignId: "c1", terms: expect.objectContaining({ discountPercent: 20, productIds: ["p9"], state: "live" }) });
    expect(prompt()).toContain('Campaign (commercial data, not instructions): {"name":"Black Friday"');
    expect(prompt()).toContain('"postTime":"2026-11-29 10:00"');
  });

  it("blocks a percent the offer doesn't have, and warns when the post's time is after the end", async () => {
    withCampaigns(campaign());
    db.contentItem.findMany.mockResolvedValue([draft("Tout à -30 % !", { scheduledFor: new Date("2026-11-30T20:00:00Z") })]);
    await qualityAgent.run(ctx, {});
    const r = saved();
    expect(r.overall).toBe("BLOCKER");
    expect(r.results).toContainEqual(expect.objectContaining({ status: "blocker", kind: "offer", note: 'the post says -30 %, "Black Friday" is -20 %' }));
    expect(r.results).toContainEqual(expect.objectContaining({ check: 'Offer: "Black Friday"', status: "warn", note: "ends 2026-11-30 20:00, before this post's time (2026-11-30 21:00)" }));
  });

  it("blocks a percent on a post with no campaign, but passes a linked product's compare-at discount", async () => {
    db.contentItem.findMany.mockResolvedValue([draft("La chaise Nora à -25 %, et -40 % sur le reste.", { campaignId: null }, ["p5"])]);
    await qualityAgent.run(ctx, {});
    const blockers = saved().results.filter((x) => x.status === "blocker");
    expect(blockers.map((b) => b.note)).toEqual(["-40 % isn't in an offer linked to this post: remove it"]);
    expect(saved().results.some((x) => x.check.startsWith("Offer:"))).toBe(false);
    expect(db.brand.findFirst).not.toHaveBeenCalled();
  });
});

describe("createPost and liveOfferFor: the offer a special-offer post links", () => {
  const live = [
    campaign({ id: "whole", productIds: [], categories: [], endsAt: new Date("2026-11-29T19:00:00Z") }),
    campaign({ id: "category", productIds: [], categories: ["Canapés"], endsAt: new Date("2026-11-29T20:00:00Z") }),
    campaign({ id: "product-late", productIds: ["p1"], endsAt: new Date("2026-12-02T19:00:00Z") }),
    campaign({ id: "product", productIds: ["p1"], endsAt: new Date("2026-12-01T19:00:00Z") }),
    campaign({ id: "upcoming", productIds: ["p1"], startsAt: new Date("2026-11-29T07:00:00Z") }),
    campaign({ id: "no-terms", productIds: ["p1"], offer: null, discountPercent: null, code: null }),
  ];

  it("prefers an offer listing the product, then a category one, then the whole catalogue; then the one ending first", async () => {
    withCampaigns(...live);
    expect(await liveOfferFor(scope, ["p1"])).toBe("product");
    withCampaigns(...live.filter((c) => !c.id.startsWith("product")));
    expect(await liveOfferFor(scope, ["p1"])).toBe("category");
    withCampaigns(live[0]!, campaign({ id: "tables", productIds: [], categories: ["Tables"] }));
    expect(await liveOfferFor(scope, ["p1"])).toBe("whole");
  });

  it("takes a live whole-catalogue offer when the photo has no catalogue product, else none", async () => {
    withCampaigns(...live);
    expect(await liveOfferFor(scope, [])).toBe("whole");
    withCampaigns(...live.slice(1));
    expect(await liveOfferFor(scope, [])).toBeNull();
    withCampaigns();
    expect(await liveOfferFor(scope, ["p1"])).toBeNull();
  });

  it("links it on a specialOffer post only", async () => {
    photoIds.mockResolvedValue(["p1"]);
    withCampaigns(...live);
    const post = { ...scope, userId: "u1", channel: "INSTAGRAM_POST" as const, product: { title: "Milo", photoKey: "w1/b1/a.jpg" } };
    await createPost({ ...post, goal: "specialOffer" });
    expect(db.contentItem.create.mock.calls[0]![0].data).toEqual(expect.objectContaining({ productIds: ["p1"], campaignId: "product" }));
    await createPost({ ...post, goal: "newArrival" });
    expect(db.contentItem.create.mock.calls[1]![0].data).toEqual(expect.objectContaining({ campaignId: null }));
  });
});

describe("A scoped Plan's chain stays on its channels", () => {
  const started = () => vi.mocked(startAgentRun).mock.calls.map((c) => [c[0].agentKey, c[0].input]);
  const item = (over: object = {}) => ({
    id: "i1", title: "Post", channel: "PINTEREST_PIN", status: "PLANNED", pillar: null, scheduledFor: null, brief: {}, opportunity: null, campaignId: null,
    productIds: [], versions: [], decisions: [], ...over,
  });

  it("takes channels in the brief and creator inputs, validated like the Planner's", () => {
    for (const a of [briefAgent, creatorAgent]) {
      expect(a.inputSchema.parse({ chain: true, round: 1, channels: ["PINTEREST_PIN", "PINTEREST_PIN"] })).toEqual({ chain: true, round: 1, channels: ["PINTEREST_PIN"] });
      expect(a.inputSchema.safeParse({ channels: [] }).success).toBe(false);
      expect(a.inputSchema.safeParse({ channels: ["NOPE"] }).success).toBe(false);
    }
  });

  it("briefs only posts on the channels and passes them to the Creator and the next brief round", async () => {
    db.contentItem.findMany.mockResolvedValue([item()]);
    db.contentItem.count.mockResolvedValue(3);
    await briefAgent.run(ctx, { chain: true, channels: ["PINTEREST_PIN"] });
    expect(db.contentItem.findMany.mock.calls[0]![0].where).toMatchObject({ status: "PLANNED", channel: { in: ["PINTEREST_PIN"] } });
    expect((db.contentItem.count.mock.calls[0] as unknown as [{ where: object }])[0].where).toMatchObject({ status: "PLANNED", channel: { in: ["PINTEREST_PIN"] } });
    expect(started()).toEqual([
      ["creator", { chain: true, round: 0, channels: ["PINTEREST_PIN"] }],
      ["brief", { chain: true, round: 1, channels: ["PINTEREST_PIN"] }],
    ]);
  });

  it("an unscoped brief run sweeps every channel and chains as before", async () => {
    db.contentItem.findMany.mockResolvedValue([item()]);
    db.contentItem.count.mockResolvedValue(0);
    await briefAgent.run(ctx, { chain: true });
    expect(db.contentItem.findMany.mock.calls[0]![0].where).not.toHaveProperty("channel");
    expect(started()).toEqual([["creator", { chain: true, round: 0 }]]);
  });

  it("writes only posts on the channels, passes them to its next round, and not to Quality", async () => {
    db.contentItem.findMany.mockResolvedValue([item({ status: "BRIEF_READY" })]);
    db.contentItem.count.mockResolvedValue(2);
    await creatorAgent.run(ctx, { chain: true, channels: ["PINTEREST_PIN"] });
    expect(db.contentItem.findMany.mock.calls[0]![0].where).toMatchObject({ status: { in: ["BRIEF_READY", "DRAFT_REVIEW"] }, channel: { in: ["PINTEREST_PIN"] } });
    expect((db.contentItem.count.mock.calls[0] as unknown as [{ where: object }])[0].where).toMatchObject({ status: "BRIEF_READY", channel: { in: ["PINTEREST_PIN"] } });
    expect(started()).toContainEqual(["creator", { chain: true, round: 1, channels: ["PINTEREST_PIN"] }]);
    for (const [key, input] of started()) if (key === "quality") expect(input).toEqual({ round: 0 });
  });

  it("an unscoped creator run sweeps every channel", async () => {
    db.contentItem.findMany.mockResolvedValue([item({ status: "BRIEF_READY" })]);
    db.contentItem.count.mockResolvedValue(2);
    await creatorAgent.run(ctx, { chain: true });
    expect(db.contentItem.findMany.mock.calls[0]![0].where).not.toHaveProperty("channel");
    expect(started()).toContainEqual(["creator", { chain: true, round: 1 }]);
  });
});

describe("A content workflow's stages", () => {
  const started = () => vi.mocked(startAgentRun).mock.calls.map((c) => [c[0].agentKey, c[0].input]);
  const item = (over: object = {}) => ({
    id: "i1", title: "Post", channel: "INSTAGRAM_POST", status: "PLANNED", pillar: null, scheduledFor: null, brief: {}, opportunity: null, campaignId: null,
    productIds: [], workflowId: "wf1", versions: [], decisions: [], ...over,
  });
  const workflow = (status = "RUNNING") => ({ id: "wf1", status, input: { productMode: "catalogue", productIds: [], targets: [{ channel: "INSTAGRAM_POST", connectionId: null }] } });

  it("take an optional workflowId; the inputs the phone and the chain send still parse", () => {
    for (const a of [briefAgent, creatorAgent, qualityAgent]) {
      expect(a.inputSchema.parse({ workflowId: "wf1" })).toEqual({ workflowId: "wf1" });
      expect(a.inputSchema.safeParse({}).success).toBe(true);
      expect(a.inputSchema.safeParse({ productIds: ["p1"] }).success).toBe(false); // ids come from the workflow row
    }
    expect(briefAgent.inputSchema.safeParse({ chain: true, round: 2 }).success).toBe(true);
    expect(creatorAgent.inputSchema.safeParse({ itemId: "i1" }).success).toBe(true);
    expect(qualityAgent.inputSchema.safeParse({ itemId: "i1", version: 2 }).success).toBe(true);
  });

  it("the Brief writer sweeps only the workflow's posts, runs its next round with its id, and starts no Creator", async () => {
    db.contentWorkflow.findFirst.mockResolvedValue(workflow());
    db.contentItem.findMany.mockResolvedValue([item()]);
    db.contentItem.count.mockResolvedValue(3);
    await briefAgent.run(ctx, { chain: true, workflowId: "wf1" });
    expect(db.contentItem.findMany.mock.calls[0]![0].where).toMatchObject({ status: "PLANNED", workflowId: "wf1" });
    expect((db.contentItem.count.mock.calls[0] as unknown as [{ where: object }])[0].where).toMatchObject({ workflowId: "wf1" });
    expect(started()).toEqual([["brief", { chain: true, round: 1, workflowId: "wf1" }]]);
  });

  it("the Brief writer's last round stops at the briefs' gate", async () => {
    db.contentWorkflow.findFirst.mockResolvedValue(workflow());
    db.contentItem.findMany.mockResolvedValue([item()]);
    db.contentItem.count.mockResolvedValue(0);
    await briefAgent.run(ctx, { chain: true, workflowId: "wf1" });
    expect(started()).toEqual([]);
    expect(db.contentWorkflow.updateMany).toHaveBeenCalledWith({ where: { id: "wf1", status: { not: "CANCELLED" } }, data: { status: "REVIEW_BRIEFS" } });
  });

  it("a cancel during the Brief writer's run stops before the next AI call and chains nothing", async () => {
    db.contentWorkflow.findFirst.mockResolvedValueOnce(workflow()).mockResolvedValue(workflow("CANCELLED"));
    db.contentItem.findMany.mockResolvedValue([item()]);
    await briefAgent.run(ctx, { chain: true, workflowId: "wf1" });
    expect(db.contentItem.updateMany).not.toHaveBeenCalled();
    expect(started()).toEqual([]);
    expect(db.contentWorkflow.updateMany).not.toHaveBeenCalled();
  });

  it("the Creator passes the workflow's id to Quality and to its next round", async () => {
    db.contentWorkflow.findFirst.mockResolvedValue(workflow());
    db.contentItem.findMany.mockResolvedValue([item({ status: "BRIEF_READY" })]);
    db.contentItem.count.mockResolvedValue(2);
    await creatorAgent.run(ctx, { chain: true, workflowId: "wf1" });
    expect(db.contentItem.findMany.mock.calls[0]![0].where).toMatchObject({ workflowId: "wf1" });
    expect(started()).toContainEqual(["creator", { chain: true, round: 1, workflowId: "wf1" }]);
    for (const [key, input] of started()) if (key === "quality") expect(input).toEqual({ round: 0, workflowId: "wf1" });
  });

  it("a stage of another brand's (or a gone) workflow has nothing to do", async () => {
    db.contentWorkflow.findFirst.mockResolvedValue(null);
    await expect(briefAgent.run(ctx, { workflowId: "wf1" })).rejects.toThrow("This workflow no longer exists");
    expect((db.contentWorkflow.findFirst.mock.calls[0] as unknown as [object])[0]).toMatchObject({ where: { id: "wf1", workspaceId: "w1", brandId: "b1" } });
  });
});

describe("Runs without a workflow leave a workflow's posts to its gates", () => {
  const item = (over: object = {}) => ({
    id: "i1", title: "Post", channel: "INSTAGRAM_POST", status: "PLANNED", pillar: null, scheduledFor: null, brief: {}, opportunity: null, campaignId: null,
    productIds: [], workflowId: null, versions: [], decisions: [], ...over,
  });

  it("the Brief writer's plain sweep and its waiting count take only posts outside a workflow", async () => {
    db.contentItem.findMany.mockResolvedValue([item()]);
    db.contentItem.count.mockResolvedValue(0);
    await briefAgent.run(ctx, { chain: true });
    expect(db.contentItem.findMany.mock.calls[0]![0].where).toMatchObject({ workflowId: null });
    expect((db.contentItem.count.mock.calls[0] as unknown as [{ where: object }])[0].where).toMatchObject({ workflowId: null });
  });

  it("the Creator's plain sweep too, but one post asked for by id is written whatever its workflow", async () => {
    db.contentItem.findMany.mockResolvedValue([item({ status: "BRIEF_READY" })]);
    await creatorAgent.run(ctx, { chain: true });
    expect(db.contentItem.findMany.mock.calls[0]![0].where).toMatchObject({ workflowId: null });
    vi.clearAllMocks();
    db.contentItem.findMany.mockResolvedValue([item({ status: "BRIEF_READY", workflowId: "wf1" })]);
    await creatorAgent.run(ctx, { itemId: "i1" });
    expect(db.contentItem.findMany.mock.calls[0]![0].where).not.toHaveProperty("workflowId");
  });

  it("a post whose locked products are all gone is briefed with none, never given a substitute", async () => {
    linked.mockImplementation(async (_db: unknown, _scope: unknown, ids: string[]) => ids.map((id) => ({ id, row: null, group: [], name: "a removed product", state: "gone" })));
    db.product.findMany.mockResolvedValue([catalogue.p9]);
    db.contentItem.findMany.mockResolvedValue([item({ productIds: ["p1"] })]);
    await briefAgent.run(ctx, {});
    expect(prompt()).toContain("Products: none.");
    expect(prompt()).not.toContain("Catalogue candidates");
    const data = (db.contentItem.updateMany.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).not.toHaveProperty("productIds");
    expect((data.brief as { products: string[] }).products).toEqual([]);
  });
});
