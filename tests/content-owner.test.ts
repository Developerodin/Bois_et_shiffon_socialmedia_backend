import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const d = {
    contentItem: { create: vi.fn(), findMany: vi.fn(async () => []), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    contentVersion: { create: vi.fn() },
    auditEvent: { create: vi.fn(), findFirst: vi.fn(async () => null) },
    product: { findFirst: vi.fn(async () => ({ id: "p1", title: "Milo Sofa" })) },
    creditEntry: { findFirst: vi.fn(async () => null) },
    opportunity: { findMany: vi.fn(async () => []), updateMany: vi.fn(), findFirst: vi.fn(async () => null) },
    brandProfile: { findFirst: vi.fn(async () => null) },
    workspaceMember: { findFirst: vi.fn(async (_a: { where: Record<string, unknown> }) => null as object | null) },
    brandMember: { findFirst: vi.fn(async (_a: { where: Record<string, unknown> }) => null as object | null) },
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(),
  };
  d.$transaction.mockImplementation(async (fn: (tx: typeof d) => unknown) => fn(d));
  return d;
});
const m = vi.hoisted(() => ({ people: vi.fn(), write: vi.fn(), direct: vi.fn(), planning: vi.fn(), perms: new Set<string>(["brand.read", "content.create"]) }));

vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/services/project-members", () => ({ listProjectPeople: m.people }));
vi.mock("@/server/content/knowledge", () => ({
  productIdsForPhoto: vi.fn(async () => []),
  liveOfferFor: vi.fn(async () => null),
  brandKnowledge: vi.fn(async () => ({ text: "" })),
  productPhotos: vi.fn(async () => [{ key: "w1/b1/p.jpg", title: "P" }]),
}));
vi.mock("@/server/services/credits", async (orig) => ({ ...(await orig<object>()), spendCredits: vi.fn(async () => undefined) }));
vi.mock("@/server/auth/rate-limit", async (orig) => ({ ...(await orig<object>()), hitRateLimit: vi.fn(async () => ({ allowed: true, count: 1 })) }));
vi.mock("@/server/agents/engine", () => ({ startAgentRun: vi.fn(async () => null), NothingToDoError: class extends Error {} }));
vi.mock("@/server/jobs/runner", () => ({ kickRunner: vi.fn() }));
vi.mock("@/server/services/context-docs", () => ({ listContextDocs: vi.fn(async () => []) }));
vi.mock("@/server/catalog/campaigns", () => ({ campaignsForPlanning: m.planning }));
vi.mock("@/server/catalog/linked", () => ({ linkedProducts: vi.fn(async () => []) }));
vi.mock("@/server/services/subscriptions", async (orig) => ({ ...(await orig<object>()), requirePlan: vi.fn(async () => undefined) }));
vi.mock("@/server/db/transient", () => ({ claimTransient: vi.fn(async () => true), dropTransient: vi.fn() }));
vi.mock("@/server/reels/agents", () => ({ writePlan: m.write, directScenes: m.direct }));
vi.mock("@/server/reels/presenters", () => ({ donePresenter: vi.fn() }));
vi.mock("@/server/reels/ownership", () => ({ planOwnershipProblems: vi.fn(async () => []) }));
vi.mock("@/server/reels/recordings", () => ({ settleRecordings: vi.fn() }));
vi.mock("@/server/reels/render", async (orig) => ({ ...(await orig<object>()), renderView: vi.fn(), renderFailure: vi.fn() }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: vi.fn(async () => ({ workspaceId: "w1", brandId: "b1", userId: "u1", perms: m.perms })) }));

import { plannerAgent } from "@/server/agents/definitions/planner";
import { GET as ownersGet } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/content/owners/route";
import { createReel } from "@/server/reels/service";
import { toVersionBody } from "@/server/reels/plan";
import { CLIENT_GRANT_WHERE, isClientGrant } from "@/server/auth/permissions";
import { brandOwners, createPost, PublishingError, setOwner } from "@/server/services/publishing";
import { createStory, duplicateStory } from "@/server/stories/service";

const scope = { workspaceId: "w1", brandId: "b1", userId: "u1" };
const RID = "6f1c2c1e-6a43-4c1b-9a3e-2f1d5b7c8a90";
const created = (n = 0) => db.contentItem.create.mock.calls[n]![0].data as Record<string, unknown>;
const people = () => ({
  viaWorkspace: [{ userId: "u1", name: "Ana", email: "ana@x.com", role: "Owner", active: true }, { userId: "u2", name: null, email: "bob.smith@x.com", role: "Admin", active: true }],
  people: [{ id: "g1", userId: "u2", name: "Bob", email: "bob.smith@x.com", role: { id: "r", name: "Creator", permissions: ["brand.read"] }, active: true }, { id: "g2", userId: "u3", name: "Cy", email: "cy@x.com", role: { id: "r", name: "Viewer", permissions: ["brand.read"] }, active: true }],
  invitations: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  db.contentItem.create.mockImplementation(async ({ data }: { data: object }) => ({ id: "i1", ...data }));
  db.contentItem.findFirst.mockResolvedValue(null);
  db.contentItem.findUnique.mockResolvedValue(null);
  m.people.mockResolvedValue(people());
  m.planning.mockResolvedValue({ campaigns: [], timeZone: "UTC" });
});

describe("post owner", () => {
  it("createPost sets the owner to the person", async () => {
    await createPost({ ...scope, channel: "INSTAGRAM_POST", goal: "newArrival", product: { title: "Milo", photoKey: "w1/b1/a.jpg" } });
    expect(created().ownerId).toBe("u1");
  });

  it("createPost dates the post with scheduledFor, leaves it undated without, and refuses a past one", async () => {
    const at = new Date(Date.now() + 86_400_000);
    await createPost({ ...scope, channel: "INSTAGRAM_POST", goal: "newArrival", product: { title: "Milo", photoKey: "w1/b1/a.jpg" }, scheduledFor: at });
    expect(created().scheduledFor).toEqual(at);
    await createPost({ ...scope, channel: "INSTAGRAM_POST", goal: "newArrival", product: { title: "Milo", photoKey: "w1/b1/a.jpg" } });
    expect(created(1)).not.toHaveProperty("scheduledFor");
    await expect(createPost({ ...scope, channel: "INSTAGRAM_POST", goal: "newArrival", product: { title: "Milo", photoKey: "w1/b1/a.jpg" }, scheduledFor: new Date(Date.now() - 86_400_000) })).rejects.toThrow("Pick a time in the future");
    expect(db.contentItem.create).toHaveBeenCalledTimes(2);
  });

  it("planner posts take the user who started the run, else none", async () => {
    m.planning.mockResolvedValue({
      campaigns: [{ id: "c1", name: "BF", startsAt: new Date("2026-11-27T07:00:00Z"), endsAt: new Date("2026-11-30T19:00:00Z"), productIds: [], categories: [], offer: "x", discountPercent: 10, code: null, archivedAt: null }],
      timeZone: "UTC",
    });
    const ai = vi.fn(async (input: { mock: unknown }) => input.mock);
    const run = (userId?: string) => plannerAgent.run({ runId: "r1", userId, brand: { workspaceId: "w1", brandId: "b1", displayName: "B" }, log: vi.fn(), ai: { generateObject: ai } } as never, {});
    await run("u9");
    await run(undefined);
    const owners = db.contentItem.create.mock.calls.map((c) => c[0].data.ownerId);
    expect(owners.length).toBeGreaterThan(1);
    expect(owners[0]).toBe("u9");
    expect(owners.at(-1)).toBeNull();
  });

  it("createReel, createStory and duplicateStory set the owner", async () => {
    const plan = { title: "T", presenter: "none", template: "", voice: "alloy", language: "en", caption: "c", hashtags: [], scenes: [{ photoKey: "w1/b1/p.jpg", shot: "s", direction: "d", voiceText: "v", onScreenText: "o", kind: "photo", prompt: "p", transition: "cut" }] };
    m.write.mockResolvedValue({ plan, reply: "ok" });
    m.direct.mockImplementation(async (_s: unknown, p: unknown) => p);
    await createReel(scope, { prompt: "x", requestId: RID }).catch(() => null);
    expect(created(0).ownerId).toBe("u1");
    expect(toVersionBody).toBeDefined();

    db.contentItem.create.mockClear();
    await createStory(scope, { goal: "newArrival", productId: "p1", requestId: RID });
    expect(created().ownerId).toBe("u1");

    db.contentItem.create.mockClear();
    db.contentItem.findFirst.mockResolvedValue({ id: "s1", title: "S", channel: "INSTAGRAM_STORY", productIds: [], opportunityId: null, versions: [] });
    await duplicateStory(scope, "s1");
    expect(created().ownerId).toBe("u1");
  });
});

describe("setOwner", () => {
  const item = { id: "i1", ownerId: "u1" };
  // A workspace member with brand.read: u1. A project grant with brand.read that is not the client-reviewer role: u3.
  // (The where clauses do the filtering in the database; here they are matched by user id.)
  beforeEach(() => {
    db.contentItem.findFirst.mockResolvedValue(item);
    db.contentItem.update.mockResolvedValue({});
    db.workspaceMember.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => (where.userId === "u1" ? { id: "m1" } : null));
    db.brandMember.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => (where.userId === "u3" ? { id: "g1" } : null));
  });

  it("assigns someone with brand access and audits from/to", async () => {
    await setOwner(scope, "i1", "u3");
    expect(db.contentItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "i1", workspaceId: "w1", brandId: "b1" } }));
    expect(db.contentItem.update).toHaveBeenCalledWith({ where: { id: "i1" }, data: { ownerId: "u3" } });
    expect(db.auditEvent.create.mock.calls[0]![0].data).toMatchObject({ action: "content.owner", entityId: "i1", metadata: { from: "u1", to: "u3" } });
  });

  it("refuses an owner without brand access and an unknown user, with the same 400 and no update", async () => {
    const errs: PublishingError[] = [];
    for (const who of ["u-no-access", "u-nobody"]) {
      await setOwner(scope, "i1", who).catch((e) => errs.push(e));
    }
    expect(errs.map((e) => e.status)).toEqual([400, 400]);
    expect(errs[0]!.message).toBe(errs[1]!.message);
    expect(db.contentItem.update).not.toHaveBeenCalled();
  });

  it("setOwner refuses a client reviewer and a no-read grant, asking the database for brand.read, an active person and not the client-reviewer role", async () => {
    db.workspaceMember.findFirst.mockResolvedValue(null);
    db.brandMember.findFirst.mockResolvedValue(null);
    db.workspaceMember.findFirst.mockClear();
    db.brandMember.findFirst.mockClear();
    await expect(setOwner(scope, "i1", "u9")).rejects.toMatchObject({ status: 400, message: "Pick someone who works on this brand." });
    expect(db.workspaceMember.findFirst.mock.calls[0]![0]!.where).toMatchObject({ workspaceId: "w1", userId: "u9", roleRef: { permissions: { has: "brand.read" } } });
    // The mock cannot filter: it only shows the question put to the database. That the filtering itself is right is the
    // Prisma query's job, not the mock's. The client-grant filter is the literal slug here on purpose: it must equal CLIENT_GRANT_WHERE.
    const active = { status: "ACTIVE", deletedAt: null };
    expect(db.workspaceMember.findFirst.mock.calls[0]![0]!.where).toMatchObject({ user: active });
    expect(db.brandMember.findFirst.mock.calls[0]![0]!.where).toMatchObject({ workspaceId: "w1", brandId: "b1", userId: "u9", user: active, role: { permissions: { has: "brand.read" }, NOT: { isSystem: true, slug: "client-reviewer" } } });
    expect(db.contentItem.update).not.toHaveBeenCalled();
    expect(m.people).not.toHaveBeenCalled();
  });

  it("setOwner leaves out client grants with the shared filter, the same rule as isClientGrant", async () => {
    await setOwner(scope, "i1", "u3");
    expect((db.brandMember.findFirst.mock.calls[0]![0]!.where as { role: { NOT: unknown } }).role.NOT).toBe(CLIENT_GRANT_WHERE);
    expect(isClientGrant(CLIENT_GRANT_WHERE)).toBe(true);
    expect(isClientGrant({ ...CLIENT_GRANT_WHERE, isSystem: false })).toBe(false);
  });

  it("setOwner null unassigns", async () => {
    await setOwner(scope, "i1", null);
    expect(db.contentItem.update).toHaveBeenCalledWith({ where: { id: "i1" }, data: { ownerId: null } });
    expect(db.auditEvent.create.mock.calls[0]![0].data).toMatchObject({ action: "content.owner", metadata: { from: "u1", to: null } });
  });

  it("is a 404 for a post of another brand", async () => {
    db.contentItem.findFirst.mockResolvedValue(null);
    await expect(setOwner(scope, "i9", "u1")).rejects.toMatchObject({ status: 404 });
  });
});

describe("owners list", () => {
  it("merges workspace and project people by id, names without emails", async () => {
    expect(await brandOwners(scope, { reveal: false })).toEqual([{ id: "u1", name: "Ana" }, { id: "u2", name: "Bob" }, { id: "u3", name: "Cy" }]);
    m.people.mockResolvedValue({ ...people(), people: [] });
    expect((await brandOwners(scope, { reveal: true })).find((o) => o.id === "u2")!.name).toBe("bob.smith");
    expect((await brandOwners(scope, { reveal: false })).find((o) => o.id === "u2")!.name).toBe("A team member");
  });

  it("numbers nameless people for someone who can't manage members, so the picker can tell them apart", async () => {
    m.people.mockResolvedValue({
      viaWorkspace: [{ userId: "u1", name: "Ana", email: "ana@x.com", role: "Owner", active: true }, { userId: "u2", name: null, email: "bob@x.com", role: "Admin", active: true }],
      people: [{ id: "g2", userId: "u3", name: "  ", email: "cy@x.com", role: { id: "r", name: "Viewer", permissions: ["brand.read"] }, active: true, client: false }],
      invitations: [],
    });
    expect(await brandOwners(scope, { reveal: false })).toEqual([{ id: "u1", name: "Ana" }, { id: "u2", name: "A team member" }, { id: "u3", name: "A team member (2)" }]);
    expect(await brandOwners(scope, { reveal: true })).toEqual([{ id: "u1", name: "Ana" }, { id: "u2", name: "bob" }, { id: "u3", name: "cy" }]);
  });

  it("client reviewers are not offered as owners", async () => {
    const p = people();
    m.people.mockResolvedValue({ ...p, people: [...p.people, { id: "g9", userId: "u9", name: "Client Carl", email: "carl@client.com", role: { id: "rc", name: "Client reviewer", permissions: ["brand.read", "content.approve"] }, active: true, client: true }] });
    expect((await brandOwners(scope, { reveal: true })).map((o) => o.id)).toEqual(["u1", "u2", "u3"]);
  });

  it("the picker leaves out grants whose role lacks brand.read and people who are disabled or deleted", async () => {
    const p = people();
    p.people.push({ id: "g3", userId: "u4", name: "Dee", email: "dee@x.com", role: { id: "r2", name: "Nothing", permissions: ["content.create"] }, active: true });
    p.people.push({ id: "g4", userId: "u5", name: "Eve", email: "eve@x.com", role: { id: "r", name: "Viewer", permissions: ["brand.read"] }, active: false });
    m.people.mockResolvedValue(p);
    expect((await brandOwners(scope, { reveal: true })).map((o) => o.id)).toEqual(["u1", "u2", "u3"]);
  });

  it("GET /content/owners lists names without emails, and local parts only for people who manage members", async () => {
    m.people.mockResolvedValue({ ...people(), people: [] });
    const get = async () => (await ownersGet(new Request("http://x"), { params: Promise.resolve({ workspaceId: "w1", brandId: "b1" }) })).json();
    const body = await get();
    expect(body.owners).toEqual([{ id: "u1", name: "Ana" }, { id: "u2", name: "A team member" }]);
    expect(JSON.stringify(body)).not.toMatch(/@|bob/);
    m.perms = new Set(["brand.read", "content.create", "project.members.manage"]);
    expect((await get()).owners).toEqual([{ id: "u1", name: "Ana" }, { id: "u2", name: "bob.smith" }]);
    m.perms = new Set(["brand.read", "content.create"]);
  });
});
