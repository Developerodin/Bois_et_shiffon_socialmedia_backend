import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; workspaceId: string; brandId: string; channel: string; status: string; title: string; scheduledFor: Date | null; createdAt: Date };
type Where = { workspaceId: string; brandId: string; channel?: string; status: { in: string[] }; scheduledFor?: { gte: Date } };
const db = vi.hoisted(() => ({ rows: [] as Row[], asked: [] as string[], contentItem: { groupBy: vi.fn(), findMany: vi.fn() } }));

vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/api/brand-route", () => ({
  authorizeBrandRoute: async (_r: Request, _p: unknown, perm: string) => {
    db.asked.push(perm);
    return { userId: "u1", workspaceId: "w1", brandId: "b1", perms: new Set(["brand.read"]) };
  },
}));

import { GET } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/content/summary/route";

const matches = (r: Row, w: Where) =>
  r.workspaceId === w.workspaceId &&
  r.brandId === w.brandId &&
  (w.channel === undefined || r.channel === w.channel) &&
  w.status.in.includes(r.status) &&
  (!w.scheduledFor || (!!r.scheduledFor && r.scheduledFor >= w.scheduledFor.gte));

const DAY = 86_400_000;
const now = Date.now();
let n = 0;
const row = (over: Partial<Row>): Row => ({ id: `r${n++}`, workspaceId: "w1", brandId: "b1", channel: "INSTAGRAM_POST", status: "SCHEDULED", title: "Post", scheduledFor: null, createdAt: new Date(now - DAY), ...over });
const call = async () => (await GET(new Request("http://x/content/summary"), { params: Promise.resolve({ workspaceId: "w1", brandId: "b1" }) })).json();
type Answer = { channels: { channel: string; awaiting: number; next: { id: string; title: string; status: string } | null }[] };
const of = (a: Answer, channel: string) => a.channels.find((c) => c.channel === channel)!;

beforeEach(() => {
  db.rows = [];
  db.contentItem.findMany.mockClear();
  db.asked = [];
  db.contentItem.groupBy.mockImplementation(async (a: { where: Where }) => {
    const counts = new Map<string, number>();
    for (const r of db.rows.filter((r) => matches(r, a.where))) counts.set(r.channel, (counts.get(r.channel) ?? 0) + 1);
    return [...counts].map(([channel, c]) => ({ channel, _count: { _all: c } }));
  });
  db.contentItem.findMany.mockImplementation(async (a: { where: Where }) =>
    db.rows
      .filter((r) => matches(r, a.where))
      .sort((x, y) => x.scheduledFor!.getTime() - y.scheduledFor!.getTime() || x.createdAt.getTime() - y.createdAt.getTime())
      .map((r) => ({ id: r.id, title: r.title, scheduledFor: r.scheduledFor, status: r.status, channel: r.channel })),
  );
});

describe("GET content/summary", () => {
  it("asks for brand.read and lists every channel, empty ones with 0 and null", async () => {
    const a: Answer = await call();
    expect(db.asked).toEqual(["brand.read"]);
    expect(a.channels.map((c) => c.channel)).toEqual(["INSTAGRAM_POST", "INSTAGRAM_CAROUSEL", "INSTAGRAM_REEL", "INSTAGRAM_STORY", "FACEBOOK_POST", "PINTEREST_PIN", "THREADS_POST", "LINKEDIN_POST", "X_POST"]);
    for (const c of a.channels) expect(c).toMatchObject({ awaiting: 0, next: null });
  });

  it("asks the database for the brand's awaiting posts, and its open, unblocked posts dated from now", async () => {
    await call();
    const g = db.contentItem.groupBy.mock.calls.at(-1)![0] as { where: Where };
    expect(g.where).toEqual({ workspaceId: "w1", brandId: "b1", status: { in: ["AWAITING_APPROVAL"] } });
    const f = db.contentItem.findMany.mock.calls.at(-1)![0] as { where: Where };
    expect(f.where.status.in.sort()).toEqual(["APPROVED", "AWAITING_APPROVAL", "BRIEF_READY", "DRAFT_REVIEW", "PLANNED", "SCHEDULED"]);
    expect(f.where).toMatchObject({ workspaceId: "w1", brandId: "b1" });
    expect(Math.abs(f.where.scheduledFor!.gte.getTime() - Date.now())).toBeLessThan(5_000);
  });

  it("counts only posts awaiting approval, per channel and brand", async () => {
    db.rows.push(
      row({ status: "AWAITING_APPROVAL" }),
      row({ status: "AWAITING_APPROVAL", scheduledFor: new Date(now - DAY) }),
      row({ status: "APPROVED" }),
      row({ status: "CANCELLED" }),
      row({ status: "AWAITING_APPROVAL", channel: "PINTEREST_PIN" }),
      row({ status: "AWAITING_APPROVAL", brandId: "b2" }),
    );
    const a: Answer = await call();
    expect(of(a, "INSTAGRAM_POST").awaiting).toBe(2);
    expect(of(a, "PINTEREST_PIN").awaiting).toBe(1);
    expect(of(a, "FACEBOOK_POST").awaiting).toBe(0);
  });

  it("next is the earliest open, unblocked post dated from now on that channel", async () => {
    db.rows.push(
      row({ title: "past", scheduledFor: new Date(now - DAY) }),
      row({ title: "undated" }),
      row({ title: "blocked", status: "BLOCKED", scheduledFor: new Date(now + DAY) }),
      row({ title: "published", status: "PUBLISHED", scheduledFor: new Date(now + DAY) }),
      row({ title: "cancelled", status: "CANCELLED", scheduledFor: new Date(now + DAY) }),
      row({ title: "other brand", brandId: "b2", scheduledFor: new Date(now + DAY) }),
      row({ title: "later", scheduledFor: new Date(now + 3 * DAY) }),
      row({ title: "draft", status: "DRAFT_REVIEW", scheduledFor: new Date(now + 2 * DAY) }),
      row({ title: "facebook", channel: "FACEBOOK_POST", scheduledFor: new Date(now + DAY / 2) }),
    );
    const a: Answer = await call();
    expect(of(a, "INSTAGRAM_POST").next).toMatchObject({ title: "draft", status: "DRAFT_REVIEW" });
    expect(of(a, "FACEBOOK_POST").next).toMatchObject({ title: "facebook" });
    // One read, scoped to the brand.
    expect(db.contentItem.findMany).toHaveBeenCalledTimes(1);
    expect((db.contentItem.findMany.mock.calls[0][0] as { where: Where }).where).toMatchObject({ workspaceId: "w1", brandId: "b1" });
  });
});
