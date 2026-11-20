import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; workspaceId: string; brandId: string; status: string; channel: string; scheduledFor: Date | null; ownerId?: string | null; createdAt: Date; updatedAt: Date };
const db = vi.hoisted(() => ({ perms: new Set<string>(["brand.read"]), rows: [] as Row[], contentItem: { findMany: vi.fn() }, users: [] as { id: string; name: string | null; email: string }[], user: { findMany: vi.fn() }, publicationAttempt: { findMany: vi.fn(async () => []) }, job: { findMany: vi.fn(async () => []) } }));

vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: async () => ({ userId: "u1", workspaceId: "w1", brandId: "b1", perms: db.perms }) }));
vi.mock("@/server/agents/engine", () => ({ startAgentRun: vi.fn() }));
vi.mock("@/server/jobs/runner", () => ({ kickRunner: vi.fn() }));
vi.mock("@/server/services/publishing", () => ({ createPost: vi.fn(), ownMediaKey: () => true, postAiAllowed: vi.fn(), PublishingError: class extends Error {} }));
vi.mock("@/server/storage/media", () => ({ signedMediaUrl: vi.fn() }));
vi.mock("@/server/stories/service", () => ({ coverUrl: vi.fn(), createStory: vi.fn(), failStoryStart: vi.fn(), STORY_RENDER_JOB: "story.render", STORY_START_NOTE: "", itemForRequest: vi.fn(), storyTab: vi.fn() }));

import { GET } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/content/route";
import { contentRange } from "@/server/content/window";

type Where = { id?: string; workspaceId?: string; brandId?: string; status?: { in?: string[]; not?: string }; OR?: Where[]; NOT?: Where; updatedAt?: { gte: Date }; scheduledFor?: { gte: Date; lt: Date } };
const matches = (r: Row, w: Where): boolean =>
  (w.id === undefined || r.id === w.id) &&
  (w.workspaceId === undefined || r.workspaceId === w.workspaceId) &&
  (w.brandId === undefined || r.brandId === w.brandId) &&
  (!w.status?.in || w.status.in.includes(r.status)) &&
  (w.status?.not === undefined || r.status !== w.status.not) &&
  (!w.updatedAt || r.updatedAt >= w.updatedAt.gte) &&
  (!w.scheduledFor || (!!r.scheduledFor && r.scheduledFor >= w.scheduledFor.gte && r.scheduledFor < w.scheduledFor.lt)) &&
  (!w.NOT || !matches(r, w.NOT)) &&
  (!w.OR || w.OR.some((o) => matches(r, o)));
const time = (r: Row) => r.scheduledFor?.getTime() ?? -Infinity; // nulls first

const DAY = 86_400_000;
const now = Date.now();
const row = (id: string, status: string, over: Partial<Row> = {}): Row => ({ id, workspaceId: "w1", brandId: "b1", status, channel: "INSTAGRAM_POST", scheduledFor: null, createdAt: new Date(now - DAY), updatedAt: new Date(now - DAY), ...over });
const call = (qs = "") => GET(new Request(`http://x/content${qs}`), { params: Promise.resolve({ workspaceId: "w1", brandId: "b1" }) });

beforeEach(() => {
  db.rows = [];
  db.users = [];
  db.user.findMany.mockClear();
  // Honours the one other order the route asks for: newest change first.
  db.contentItem.findMany.mockImplementation(async (a: { where: Where; take?: number; orderBy?: object[] }) =>
    db.rows
      .filter((r) => matches(r, a.where))
      .sort(JSON.stringify(a.orderBy?.[0]) === '{"updatedAt":"desc"}' ? (x, y) => y.updatedAt.getTime() - x.updatedAt.getTime() : (x, y) => time(x) - time(y) || x.createdAt.getTime() - y.createdAt.getTime())
      .slice(0, a.take)
      .map((r) => ({ ...r, owner: db.users.find((u) => u.id === r.ownerId) ?? null, opportunity: null, versions: [], decisions: [], publications: [] })),
  );
});

describe("GET /content window", () => {
  it("keeps upcoming posts when history is long", async () => {
    for (let n = 0; n < 250; n++) db.rows.push(row(`h${n}`, "PUBLISHED", { updatedAt: new Date(now - 7 * DAY + n) }));
    for (let n = 0; n < 5; n++) db.rows.push(row(`s${n}`, "SCHEDULED", { scheduledFor: new Date(now + (n + 1) * DAY) }));
    const { items } = await (await call()).json();
    const ids = items.map((i: { id: string }) => i.id);
    for (let n = 0; n < 5; n++) expect(ids).toContain(`s${n}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the owner comes with the item read: no separate read of users", async () => {
    db.rows.push(row("a", "SCHEDULED", { ownerId: "u2" }), row("c", "SCHEDULED", { ownerId: "u3" }), row("d", "SCHEDULED"));
    db.users = [{ id: "u2", name: "Bea", email: "bea@x.com" }];
    const { items } = await (await call()).json();
    expect(db.user.findMany).not.toHaveBeenCalled();
    const owner = (id: string) => items.find((i: { id: string }) => i.id === id).owner;
    expect(owner("a")).toEqual({ id: "u2", name: "Bea" });
    expect(owner("c")).toBeNull();
    expect(owner("d")).toBeNull();
    // Both halves ask for the owner with only the fields needed to name them.
    for (const c of db.contentItem.findMany.mock.calls) expect((c[0] as { include: { owner: object } }).include.owner).toEqual({ select: { id: true, name: true, email: true } });
  });

  it("opens one post by id even when it is 90 days old", async () => {
    db.rows.push(row("old", "PUBLISHED", { updatedAt: new Date(now - 90 * DAY) }));
    const res = await call("?id=old");
    expect(res.status).toBe(200);
    expect((await res.json()).items.map((i: { id: string }) => i.id)).toEqual(["old"]);
  });

  it("names an owner without a name by their email's local part to people who manage members, else \"A team member\"; never the email", async () => {
    db.rows.push(row("named", "PLANNED"), row("unnamed", "PLANNED", { createdAt: new Date(now) }), row("nobody", "PLANNED", { createdAt: new Date(now + 1) }));
    db.rows[0]!.ownerId = "u1";
    db.rows[1]!.ownerId = "u2";
    db.users = [{ id: "u1", name: "Ann", email: "ann@x.com" }, { id: "u2", name: null, email: "bo@x.com" }];
    const { items } = await (await call()).json();
    expect(items.map((i: { owner: unknown }) => i.owner)).toEqual([{ id: "u1", name: "Ann" }, { id: "u2", name: "A team member" }, null]);
    expect(JSON.stringify(items)).not.toMatch(/@|"bo"/);
    db.perms = new Set(["brand.read", "project.members.manage"]);
    const managed = (await (await call()).json()).items;
    db.perms = new Set(["brand.read"]);
    expect(managed.map((i: { owner: unknown }) => i.owner)).toEqual([{ id: "u1", name: "Ann" }, { id: "u2", name: "bo" }, null]);
    expect(JSON.stringify(managed)).not.toContain("@");
  });

  it("answers 404 for a post of another brand", async () => {
    db.rows.push(row("other", "PUBLISHED", { brandId: "b2" }));
    expect((await call("?id=other")).status).toBe(404);
  });
  it("returns one global order across open and recent posts", async () => {
    db.rows.push(row("future", "SCHEDULED", { scheduledFor: new Date(now + 2 * DAY) }));
    db.rows.push(row("past", "PUBLISHED", { scheduledFor: new Date(now - 3 * DAY) }));
    db.rows.push(row("undated", "PLANNED"));
    db.rows.push(row("undatedPublished", "PUBLISHED", { createdAt: new Date(now - 2 * DAY) }));
    const { items } = await (await call()).json();
    expect(items.map((i: { id: string }) => i.id)).toEqual(["undatedPublished", "undated", "past", "future"]);
  });

  it("reads the open and recent halves at once, not one after the other", async () => {
    let running = 0, most = 0;
    const plain = db.contentItem.findMany.getMockImplementation()!;
    db.contentItem.findMany.mockImplementation(async (a: never) => {
      most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return plain(a);
    });
    db.rows.push(row("open", "PLANNED"), row("hist", "PUBLISHED"));
    const { items } = await (await call()).json();
    expect(items.map((i: { id: string }) => i.id).sort()).toEqual(["hist", "open"]);
    expect(db.contentItem.findMany).toHaveBeenCalledTimes(2);
    expect(most).toBe(2);
  });

  it("reads story attempts and in-flight renders at once, after the rows and not one by one", async () => {
    let running = 0, most = 0;
    const slow = (value: unknown) => async () => {
      most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return value;
    };
    db.publicationAttempt.findMany.mockImplementation(slow([]) as never);
    db.job.findMany.mockImplementation(slow([]) as never);
    db.users = [{ id: "u2", name: "Bea", email: "bea@x.com" }];
    db.rows.push(row("s1", "PLANNED", { channel: "INSTAGRAM_STORY", ownerId: "u2" }));
    const { items } = await (await call()).json();
    expect(items[0].owner).toEqual({ id: "u2", name: "Bea" });
    expect(db.publicationAttempt.findMany).toHaveBeenCalledTimes(1);
    expect(db.job.findMany).toHaveBeenCalledTimes(1);
    expect(most).toBe(2);
    db.publicationAttempt.findMany.mockImplementation(async () => []);
    db.job.findMany.mockImplementation(async () => []);
  });

  it("recent history keeps the newest at the ceiling", async () => {
    // Made in the order of their last change: by creation the oldest changes would come first.
    for (let n = 0; n < 250; n++) db.rows.push(row(`h${n}`, "PUBLISHED", { createdAt: new Date(now - 60 * DAY + n), updatedAt: new Date(now - 20 * DAY + n * 60_000) }));
    db.rows.push(row("open", "PLANNED"));
    const { items } = await (await call()).json();
    const ids = new Set(items.map((i: { id: string }) => i.id));
    expect(items).toHaveLength(200);
    expect(ids.has("open")).toBe(true);
    // The 199 most recently changed (h51..h249) stay; the oldest changes drop.
    for (let n = 51; n < 250; n++) expect(ids.has(`h${n}`)).toBe(true);
    expect(ids.has("h50")).toBe(false);
  });

  it("fills the 200 rows with open posts when there are more, with no recent rows", async () => {
    for (let n = 0; n < 230; n++) db.rows.push(row(`o${n}`, "PLANNED", { scheduledFor: new Date(now + n * DAY) }));
    db.rows.push(row("hist", "PUBLISHED"));
    const { items } = await (await call()).json();
    expect(items).toHaveLength(200);
    expect(items.some((i: { id: string }) => i.id === "hist")).toBe(false);
  });
});

describe("GET /content?from&to", () => {
  it("returns the posts dated in [from, to), past ones included, never cancelled or undated, in one read", async () => {
    const at = (d: string) => new Date(d);
    db.rows.push(
      row("old", "PUBLISHED", { scheduledFor: at("2026-08-03T09:00:00Z"), updatedAt: new Date(now - 120 * DAY) }),
      row("edge", "PUBLISHED", { scheduledFor: at("2026-08-01T00:00:00Z") }),
      row("after", "PUBLISHED", { scheduledFor: at("2026-09-01T00:00:00Z") }),
      row("gone", "CANCELLED", { scheduledFor: at("2026-08-04T00:00:00Z") }),
      row("undated", "PLANNED"),
    );
    db.contentItem.findMany.mockClear();
    const res = await call("?from=2026-08-01T00:00:00.000Z&to=2026-09-01T00:00:00.000Z");
    expect(res.status).toBe(200);
    expect((await res.json()).items.map((i: { id: string }) => i.id)).toEqual(["edge", "old"]);
    expect(db.contentItem.findMany).toHaveBeenCalledTimes(1);
    expect((db.contentItem.findMany.mock.calls[0]![0] as { take: number }).take).toBe(500);
  });

  it("answers 400 for a bad range", async () => {
    for (const qs of ["?from=2026-08-01", "?from=nope&to=2026-08-02", "?from=2026-08-02&to=2026-08-01", "?from=2026-08-01&to=2026-08-01", "?from=2026-01-01&to=2026-04-01"])
      expect((await call(qs)).status, qs).toBe(400);
  });
});

describe("contentRange", () => {
  it("is null without from and to, the dates for a good range, a reason otherwise", () => {
    expect(contentRange(null, null)).toBeNull();
    expect(contentRange("2026-10-26", "2026-12-07")).toEqual({ from: new Date("2026-10-26"), to: new Date("2026-12-07") });
    expect(contentRange("2026-10-26T00:00:00+01:00", "2026-12-07T00:00:00+01:00")).toMatchObject({ from: new Date("2026-10-25T23:00:00Z") });
    expect(contentRange("2026-01-01", "2026-03-04")).toEqual({ from: new Date("2026-01-01"), to: new Date("2026-03-04") }); // 62 days
    expect(typeof contentRange("2026-01-01", "2026-03-05")).toBe("string"); // 63 days
    expect(typeof contentRange("2026-01-01", null)).toBe("string");
    expect(typeof contentRange("2026-01-02", "2026-01-01")).toBe("string");
  });
});
