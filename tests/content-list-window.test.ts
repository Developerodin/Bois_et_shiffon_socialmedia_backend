import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; workspaceId: string; brandId: string; status: string; channel: string; scheduledFor: Date | null; createdAt: Date; updatedAt: Date };
const db = vi.hoisted(() => ({ rows: [] as Row[], contentItem: { findMany: vi.fn() }, publicationAttempt: { findMany: vi.fn(async () => []) }, job: { findMany: vi.fn(async () => []) } }));

vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: async () => ({ userId: "u1", workspaceId: "w1", brandId: "b1" }) }));
vi.mock("@/server/agents/engine", () => ({ startAgentRun: vi.fn() }));
vi.mock("@/server/jobs/runner", () => ({ kickRunner: vi.fn() }));
vi.mock("@/server/services/publishing", () => ({ createPost: vi.fn(), ownMediaKey: () => true, postAiAllowed: vi.fn(), PublishingError: class extends Error {} }));
vi.mock("@/server/storage/media", () => ({ signedMediaUrl: vi.fn() }));
vi.mock("@/server/stories/service", () => ({ coverUrl: vi.fn(), createStory: vi.fn(), failStoryStart: vi.fn(), STORY_RENDER_JOB: "story.render", STORY_START_NOTE: "", storyForRequest: vi.fn(), storyTab: vi.fn() }));

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

  it("answers 404 for a post of another brand", async () => {
    db.rows.push(row("other", "PUBLISHED", { brandId: "b2" }));
    expect((await call("?id=other")).status).toBe(404);
  });
});
