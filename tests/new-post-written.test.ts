import { beforeEach, describe, expect, it, vi } from "vitest";
import { CAPTION_LIMITS, CHANNEL_IMAGES, CHANNEL_TEXT_MAX, captionMaxFor, writtenPostProblem } from "@/shared";

const db = vi.hoisted(() => {
  const d = {
    contentItem: { create: vi.fn(), findFirst: vi.fn() },
    contentVersion: { create: vi.fn() },
    auditEvent: { create: vi.fn() },
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(),
  };
  d.$transaction.mockImplementation(async (fn: (tx: typeof d) => unknown) => fn(d));
  return d;
});
const m = vi.hoisted(() => ({ run: vi.fn(), allowed: vi.fn(), products: vi.fn() }));

vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: vi.fn(async () => ({ workspaceId: "w1", brandId: "b1", userId: "u1" })) }));
vi.mock("@/server/agents/engine", () => ({ startAgentRun: m.run, NothingToDoError: class extends Error {} }));
vi.mock("@/server/jobs/runner", () => ({ kickRunner: vi.fn() }));
vi.mock("@/server/content/knowledge", () => ({ productIdsForPhoto: m.products, liveOfferFor: vi.fn(async () => null) }));
vi.mock("@/server/services/publishing", async (orig) => ({ ...(await orig<object>()), postAiAllowed: m.allowed }));

import { POST } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/content/route";
import { publishRequirements } from "@/server/services/publishing";

const RID = "0b9c3a4e-1f2d-4c5b-8a7e-6d5c4b3a2f10";
const post = (b: object) => POST(new Request("http://x", { method: "POST", body: JSON.stringify(b) }), { params: Promise.resolve({ workspaceId: "w1", brandId: "b1" }) });

const rows: { id: string; channel: string; status: string; title: string; brief: { requestId?: string } }[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  rows.length = 0;
  m.allowed.mockResolvedValue(true);
  m.run.mockResolvedValue(null);
  m.products.mockResolvedValue(["p1"]);
  db.contentItem.create.mockImplementation(async ({ data }: { data: (typeof rows)[number] }) => {
    const row = { ...data, id: `i${rows.length + 1}` };
    rows.push(row);
    return row;
  });
  db.contentItem.findFirst.mockImplementation(async ({ where }: { where: { channel: { in: string[] }; brief: { equals: string } } }) =>
    rows.find((r) => r.brief.requestId === where.brief.equals && where.channel.in.includes(r.channel)) ?? null,
  );
});

describe("writtenPostProblem (shared by the route and New post)", () => {
  const ok = { text: "Hello", photos: 0 };
  it("X counts against its 280", () => {
    expect(writtenPostProblem("X_POST", { ...ok, text: "a".repeat(CHANNEL_TEXT_MAX.X_POST) })).toBeNull();
    expect(writtenPostProblem("X_POST", { ...ok, text: "a".repeat(CHANNEL_TEXT_MAX.X_POST + 1) })).toMatch(/280/);
    // Counted trimmed, as saved.
    expect(writtenPostProblem("X_POST", { ...ok, text: ` ${"a".repeat(280)} ` })).toBeNull();
  });
  it("each channel's text limit", () => {
    expect(captionMaxFor("THREADS_POST")).toBe(500);
    expect(captionMaxFor("LINKEDIN_POST")).toBe(3000);
    expect(captionMaxFor("FACEBOOK_POST")).toBe(CAPTION_LIMITS.captionMax);
    expect(captionMaxFor("PINTEREST_PIN")).toBe(CAPTION_LIMITS.pinDescriptionMax);
    expect(writtenPostProblem("THREADS_POST", { ...ok, text: "a".repeat(501) })).toMatch(/500/);
  });
  it("needs text", () => expect(writtenPostProblem("FACEBOOK_POST", { ...ok, text: "  " })).toMatch(/Write/));
  it("one image at most where the channel takes one", () => {
    for (const c of ["FACEBOOK_POST", "THREADS_POST", "LINKEDIN_POST", "X_POST"] as const) {
      expect(writtenPostProblem(c, { ...ok, photos: 1 })).toBeNull();
      expect(writtenPostProblem(c, { ...ok, photos: 2 })).toMatch(/1 image/);
    }
  });
  it("a pin needs a title, an image and an https link if any", () => {
    const pin = { text: "Desc", pinTitle: "Title", photos: 1 };
    expect(writtenPostProblem("PINTEREST_PIN", pin)).toBeNull();
    expect(writtenPostProblem("PINTEREST_PIN", { ...pin, pinTitle: " " })).toMatch(/title/);
    expect(writtenPostProblem("PINTEREST_PIN", { ...pin, pinTitle: "a".repeat(101) })).toMatch(/100/);
    expect(writtenPostProblem("PINTEREST_PIN", { ...pin, photos: 0 })).toMatch(/image/);
    expect(writtenPostProblem("PINTEREST_PIN", { ...pin, pinLink: "http://shop.example/x" })).toMatch(/https/);
    expect(writtenPostProblem("PINTEREST_PIN", { ...pin, pinLink: "https://shop.example/x" })).toBeNull();
    expect(writtenPostProblem("PINTEREST_PIN", { ...pin, text: "a".repeat(501) })).toMatch(/500/);
  });
  it("the publish check reads the same image counts", () => {
    for (const [c, [min, max]] of Object.entries(CHANNEL_IMAGES)) {
      const req = publishRequirements(c as keyof typeof CHANNEL_IMAGES);
      expect([req.minImages, req.maxImages]).toEqual([min, max]);
    }
  });
});

describe("POST content with a written post", () => {
  it("makes the post and its first version, then starts the check (not the writer)", async () => {
    const res = await post({ channel: "FACEBOOK_POST", text: "  New table in oak\nCome and see  ", photoKeys: ["w1/b1/a.jpg"], requestId: RID });
    expect(res.status).toBe(201);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: "FACEBOOK_POST", status: "DRAFT_REVIEW", title: "New table in oak", brief: { written: true, requestId: RID }, productIds: ["p1"] });
    expect(db.contentVersion.create).toHaveBeenCalledWith({
      data: { contentItemId: "i1", version: 1, createdBy: "u1", body: { hook: "", caption: "New table in oak\nCome and see", hashtags: [], slides: [], script: [], pinTitle: "", altText: "", photoKeys: ["w1/b1/a.jpg"], productIds: ["p1"] } },
    });
    expect(m.run).toHaveBeenCalledWith(expect.objectContaining({ agentKey: "quality", input: { itemId: "i1", version: 1 } }));
  });

  it("a retry with the same requestId gets the same post", async () => {
    const first = await post({ channel: "X_POST", text: "Hi", requestId: RID });
    const again = await post({ channel: "X_POST", text: "Hi", requestId: RID });
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe((await first.json()).id);
    expect(rows).toHaveLength(1);
    expect(m.run).toHaveBeenCalledTimes(1);
  });

  it("a pin keeps its title and checked link; the title names it", async () => {
    const res = await post({ channel: "PINTEREST_PIN", text: "Desc", pinTitle: " Oak table ", pinLink: "https://shop.example/oak", photoKeys: ["w1/b1/a.png"] });
    expect(res.status).toBe(201);
    expect(rows[0]!.title).toBe("Oak table");
    expect(db.contentVersion.create.mock.calls[0]![0].data.body).toMatchObject({ pinTitle: "Oak table", pinLink: "https://shop.example/oak", caption: "Desc" });
  });

  it.each([
    [{ channel: "X_POST", text: "a".repeat(281) }, /280/],
    [{ channel: "PINTEREST_PIN", text: "Desc", pinTitle: "T" }, /image/],
    [{ channel: "FACEBOOK_POST", text: "Hi", photoKeys: ["w1/b1/a.jpg", "w1/b1/b.jpg"] }, /1 image/],
    [{ channel: "THREADS_POST", text: "Hi", photoKeys: ["w2/b9/a.jpg"] }, /Unknown image/],
    [{ channel: "PINTEREST_PIN", text: "Desc", pinTitle: "T", pinLink: "javascript:alert(1)", photoKeys: ["w1/b1/a.jpg"] }, /https/],
    [{ channel: "LINKEDIN_POST", text: "Hi", scheduledFor: "2020-01-01T10:00:00Z" }, /future/],
  ])("refuses %j", async (b, why) => {
    const res = await post(b);
    expect(res.status).toBe(400);
    expect((await res.json()).title).toMatch(why);
    expect(rows).toHaveLength(0);
  });

  it("an Instagram post without a product is still refused (NewPostInput unchanged)", async () => {
    const res = await post({ channel: "INSTAGRAM_POST", text: "Hi" });
    expect(res.status).toBe(400);
  });
});
