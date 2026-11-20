import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; workspaceId: string; brandId: string; status: string; channel: string; scheduledFor: Date | null; createdAt: Date; updatedAt: Date };
const db = vi.hoisted(() => ({ rows: [] as Row[], contentItem: { findMany: vi.fn() }, publicationAttempt: { findMany: vi.fn(async () => []) }, job: { findMany: vi.fn(async () => []) } }));

vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: async () => ({ userId: "u1", workspaceId: "w1", brandId: "b1" }) }));
vi.mock("@/server/agents/engine", () => ({ startAgentRun: vi.fn() }));
vi.mock("@/server/jobs/runner", () => ({ kickRunner: vi.fn() }));
vi.mock("@/server/services/publishing", () => ({ createPost: vi.fn(), ownMediaKey: () => true, postAiAllowed: vi.fn(), PublishingError: class extends Error {} }));
vi.mock("@/server/storage/media", () => ({ signedMediaUrl: vi.fn() }));
vi.mock("@/server/stories/service", () => ({ coverUrl: vi.fn(), createStory: vi.fn(), failStoryStart: vi.fn(), STORY_RENDER_JOB: "story.render", STORY_START_NOTE: "", itemForRequest: vi.fn(), storyTab: vi.fn() }));

import { GET } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/content/route";

type Where = { id?: string; workspaceId?: string; brandId?: string; status?: { in?: string[]; not?: string }; OR?: Where[]; NOT?: Where; updatedAt?: { gte: Date } };
const matches = (r: Row, w: Where): boolean =>
  (w.id === undefined || r.id === w.id) &&
  (w.workspaceId === undefined || r.workspaceId === w.workspaceId) &&
  (w.brandId === undefined || r.brandId === w.brandId) &&
  (!w.status?.in || w.status.in.includes(r.status)) &&
  (w.status?.not === undefined || r.status !== w.status.not) &&
  (!w.updatedAt || r.updatedAt >= w.updatedAt.gte) &&
  (!w.NOT || !matches(r, w.NOT)) &&
  (!w.OR || w.OR.some((o) => matches(r, o)));
const time = (r: Row) => r.scheduledFor?.getTime() ?? -Infinity; // nulls first

const DAY = 86_400_000;
const now = Date.now();
const row = (id: string, status: string, over: Partial<Row> = {}): Row => ({ id, workspaceId: "w1", brandId: "b1", status, channel: "INSTAGRAM_POST", scheduledFor: null, createdAt: new Date(now - DAY), updatedAt: new Date(now - DAY), ...over });
const call = (qs = "") => GET(new Request(`http://x/content${qs}`), { params: Promise.resolve({ workspaceId: "w1", brandId: "b1" }) });

beforeEach(() => {
  db.rows = [];
  db.contentItem.findMany.mockImplementation(async (a: { where: Where; take?: number }) =>
    db.rows
      .filter((r) => matches(r, a.where))
      .sort((x, y) => time(x) - time(y) || x.createdAt.getTime() - y.createdAt.getTime())
      .slice(0, a.take)
      .map((r) => ({ ...r, opportunity: null, versions: [], decisions: [], publications: [] })),
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

  it("opens one post by id even when it is 90 days old", async () => {
    db.rows.push(row("old", "PUBLISHED", { updatedAt: new Date(now - 90 * DAY) }));
    const res = await call("?id=old");
    expect(res.status).toBe(200);
    expect((await res.json()).items.map((i: { id: string }) => i.id)).toEqual(["old"]);
  });

  it("names an owner without a name by their email's local part, never the email", async () => {
    db.rows.push(row("named", "PLANNED"), row("unnamed", "PLANNED", { createdAt: new Date(now) }), row("nobody", "PLANNED", { createdAt: new Date(now + 1) }));
    const owners: Record<string, unknown> = { named: { id: "u1", name: "Ann", email: "ann@x.com" }, unnamed: { id: "u2", name: null, email: "bo@x.com" }, nobody: null };
    const plain = db.contentItem.findMany.getMockImplementation()!;
    db.contentItem.findMany.mockImplementation(async (a: never) => (await plain(a)).map((r: Row) => ({ ...r, owner: owners[r.id] })));
    const { items } = await (await call()).json();
    expect(items.map((i: { owner: unknown }) => i.owner)).toEqual([{ id: "u1", name: "Ann" }, { id: "u2", name: "bo" }, null]);
    expect(JSON.stringify(items)).not.toContain("@");
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

  it("fills the 200 rows with open posts when there are more, with no recent rows", async () => {
    for (let n = 0; n < 230; n++) db.rows.push(row(`o${n}`, "PLANNED", { scheduledFor: new Date(now + n * DAY) }));
    db.rows.push(row("hist", "PUBLISHED"));
    const { items } = await (await call()).json();
    expect(items).toHaveLength(200);
    expect(items.some((i: { id: string }) => i.id === "hist")).toBe(false);
  });
});
