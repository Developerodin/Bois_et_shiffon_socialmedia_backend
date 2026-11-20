import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const d = {
    contentItem: { create: vi.fn(), findFirst: vi.fn() },
    auditEvent: { create: vi.fn() },
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(),
  };
  d.$transaction.mockImplementation(async (fn: (tx: typeof d) => unknown) => fn(d));
  return d;
});
const m = vi.hoisted(() => ({ run: vi.fn(), allowed: vi.fn() }));

vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: vi.fn(async () => ({ workspaceId: "w1", brandId: "b1", userId: "u1" })) }));
vi.mock("@/server/agents/engine", () => ({ startAgentRun: m.run, NothingToDoError: class extends Error {} }));
vi.mock("@/server/jobs/runner", () => ({ kickRunner: vi.fn() }));
vi.mock("@/server/content/knowledge", () => ({ productIdsForPhoto: vi.fn(async () => []), liveOfferFor: vi.fn(async () => null) }));
vi.mock("@/server/services/publishing", async (orig) => ({ ...(await orig<object>()), postAiAllowed: m.allowed }));

import { POST } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/content/route";
import { itemForRequest } from "@/server/stories/service";

const RID = "6f1c2c1e-6a43-4c1b-9a3e-2f1d5b7c8a90";
const body = (extra: object = {}) => ({ channel: "INSTAGRAM_POST", goal: "newArrival", product: { title: "Milo", photoKey: "w1/b1/a.jpg" }, ...extra });
const post = (b: object) => POST(new Request("http://x", { method: "POST", body: JSON.stringify(b) }), { params: Promise.resolve({ workspaceId: "w1", brandId: "b1" }) });

// A tiny in-memory brand: create stores the row, findFirst matches on channel and brief.requestId like the real query.
const rows: { id: string; channel: string; brief: { requestId?: string } }[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  rows.length = 0;
  m.allowed.mockResolvedValue(true);
  m.run.mockResolvedValue(null);
  db.contentItem.create.mockImplementation(async ({ data }: { data: { channel: string; brief: { requestId?: string } } }) => {
    const row = { id: `i${rows.length + 1}`, ...data };
    rows.push(row);
    return row;
  });
  db.contentItem.findFirst.mockImplementation(async ({ where }: { where: { channel?: string | { in: string[] }; brief: { equals: string } } }) => {
    const ch = where.channel;
    return rows.find((r) => r.brief.requestId === where.brief.equals && (!ch || (typeof ch === "string" ? r.channel === ch : ch.in.includes(r.channel)))) ?? null;
  });
});

describe("new post requests", () => {
  it("same requestId returns the same post", async () => {
    const first = await post(body({ requestId: RID }));
    expect(first.status).toBe(201);
    const id = (await first.json()).id;
    m.allowed.mockClear();
    m.run.mockClear();
    const again = await post(body({ requestId: RID }));
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe(id);
    expect(rows).toHaveLength(1);
    expect(m.run).not.toHaveBeenCalled();
    expect(m.allowed).not.toHaveBeenCalled();
  });

  it("a post's requestId is not a story's", async () => {
    await post(body({ requestId: RID }));
    expect(await itemForRequest({ workspaceId: "w1", brandId: "b1" }, RID, { channel: "INSTAGRAM_STORY" })).toBeNull();
    expect(await itemForRequest({ workspaceId: "w1", brandId: "b1" }, RID)).toMatchObject({ id: "i1" });
  });

  it("no requestId keeps today's behaviour", async () => {
    const a = await post(body());
    const b = await post(body());
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(rows).toHaveLength(2);
    expect(db.contentItem.findFirst).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(m.run).toHaveBeenCalledTimes(2);
  });
});
