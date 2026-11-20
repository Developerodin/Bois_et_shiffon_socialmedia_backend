import { beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const db = vi.hoisted(() => ({ items: [] as Row[], versions: [] as Row[], decisions: [] as Row[], attempts: [] as Row[], audits: [] as Row[], inTx: false, accountReads: [] as boolean[] }));
const gate = vi.hoisted(() => ({ issue: null as null | { refuses: boolean; message: string }, calls: 0 }));

vi.mock("@/server/db/prisma", () => {
  const match = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([k, v]) => v === undefined || (v && typeof v === "object" && "in" in v ? v.in.includes(row[k]) : row[k] === v));
  const copy = <T,>(x: T): T => (x == null ? x : structuredClone(x));
  const prisma: Row = {
    $executeRaw: async () => 0,
    contentItem: {
      findFirst: async ({ where }: Row) => {
        const i = db.items.find((r) => match(r, where));
        const latest = i && db.versions.filter((v) => v.contentItemId === i.id).sort((a, b) => b.version - a.version)[0];
        return i ? copy({ ...i, versions: latest ? [{ ...latest, checks: [] }] : [] }) : null;
      },
      update: async ({ where, data }: Row) => copy(Object.assign(db.items.find((i) => i.id === where.id)!, copy(data))),
    },
    approvalDecision: { findFirst: async ({ where }: Row) => copy(db.decisions.filter((d) => match(d, where)).at(-1) ?? null) },
    publicationAttempt: { findFirst: async ({ where }: Row) => copy(db.attempts.find((a) => match(a, where)) ?? null) },
    auditEvent: { create: async ({ data }: Row) => { db.audits.push(copy(data)); return {}; } },
    // The story link check's account read; records whether it ran inside the transaction.
    integrationConnection: { findMany: async () => { db.accountReads.push(db.inTx); return [{ displayName: "@shop" }]; } },
  };
  prisma.$transaction = async (f: (tx: Row) => unknown) => {
    db.inTx = true;
    try {
      return await f(prisma);
    } finally {
      db.inTx = false;
    }
  };
  return { prisma };
});
vi.mock("@/server/services/publishing", async (orig) => {
  const real = await orig<typeof import("@/server/services/publishing")>();
  return { ...real, productGate: vi.fn(async () => { gate.calls++; return gate.issue ? [gate.issue] : []; }) };
});

import { packageHash } from "@/server/services/publishing";
import { postLinkFor, registerManualPost } from "@/server/services/manual-post";

const scope = { workspaceId: "w1", brandId: "b1" };
const user = { ...scope, userId: "u1" };
function seed(over: Row = {}) {
  const channel = over.channel ?? "FACEBOOK_POST";
  const body = { caption: "hi" };
  db.items.push({ id: "p1", ...scope, channel, status: "APPROVED", studio: false, byHand: true, postUrl: null, ...over });
  db.versions.push({ id: "v1", contentItemId: "p1", version: 1, body });
  db.decisions.push({ id: "d1", contentItemId: "p1", verdict: "APPROVED", contentVersionId: "v1", packageHash: packageHash({ id: "p1", channel }, { id: "v1", body }), productOverride: null });
}
const item = () => db.items[0];

beforeEach(() => {
  Object.assign(db, { items: [], versions: [], decisions: [], attempts: [], audits: [], inTx: false, accountReads: [] });
  Object.assign(gate, { issue: null, calls: 0 });
});

describe("registerManualPost on any channel", () => {
  it("marks an approved Facebook post published with its link", async () => {
    seed();
    await registerManualPost(user, "p1", "https://www.facebook.com/shop/posts/123456?utm=x#c");
    expect(item()).toMatchObject({ status: "PUBLISHED", byHand: false, postUrl: "https://www.facebook.com/shop/posts/123456" });
    expect(db.audits.at(-1)).toMatchObject({ action: "content.publish.manual", metadata: { channel: "FACEBOOK_POST", url: "https://www.facebook.com/shop/posts/123456" } });
  });
  it("link is optional except for studio reels", async () => {
    seed();
    await registerManualPost(user, "p1", undefined);
    expect(item()).toMatchObject({ status: "PUBLISHED", postUrl: null });
    db.items.length = db.versions.length = db.decisions.length = 0;
    seed({ channel: "INSTAGRAM_REEL", studio: true });
    await expect(registerManualPost(user, "p1", "  ")).rejects.toMatchObject({ status: 400 });
    expect(item().status).toBe("APPROVED");
  });
  it.each([
    "https://facebook.com.evil.io/shop/posts/123",
    "https://evilfacebook.com/shop/posts/123",
    "https://www.facebook.com/l.php?u=x",
    "https://www.facebook.com/login/",
    "http://www.facebook.com/shop/posts/123",
    "https://user@www.facebook.com/shop/posts/123",
    "https://www.facebook.com:8443/shop/posts/123",
    "https://www.facebook.com/shop/posts/123/../../l.php",
  ])("rejects look-alike %s", async (u) => {
    seed();
    await expect(registerManualPost(user, "p1", u)).rejects.toMatchObject({ status: 400 });
    expect(item().status).toBe("APPROVED");
  });
  it.each(["http://instagram.com/p/x", "https://user@instagram.com/p/x", "https://www.facebook.com/l.php?u=x"])("rejects %s on an Instagram post", async (u) => {
    seed({ channel: "INSTAGRAM_POST" });
    await expect(registerManualPost(user, "p1", u)).rejects.toMatchObject({ status: 400 });
  });
  it.each(["SCHEDULED", "PUBLISHING", "PENDING_VERIFY", "PARTIAL"])("refuses while an attempt is %s", async (status) => {
    seed();
    db.attempts.push({ id: "a1", contentItemId: "p1", status });
    await expect(registerManualPost(user, "p1", undefined)).rejects.toMatchObject({ status: 409 });
    expect(item().status).toBe("APPROVED");
  });
  it("allows a post whose earlier attempt failed or was cancelled", async () => {
    seed();
    db.attempts.push({ id: "a1", contentItemId: "p1", status: "FAILED" }, { id: "a2", contentItemId: "p1", status: "CANCELLED" });
    await registerManualPost(user, "p1", undefined);
    expect(item().status).toBe("PUBLISHED");
  });
  it("refuses when the approval no longer holds", async () => {
    seed();
    db.versions.push({ id: "v2", contentItemId: "p1", version: 2, body: { caption: "changed" } });
    await expect(registerManualPost(user, "p1", undefined)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/approval no longer holds/) });
  });
  it("refuses a post that isn't approved or is scheduled", async () => {
    seed({ status: "AWAITING_APPROVAL" });
    await expect(registerManualPost(user, "p1", undefined)).rejects.toMatchObject({ status: 409 });
    item().status = "SCHEDULED";
    await expect(registerManualPost(user, "p1", undefined)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/scheduled/) });
  });
  it("refuses when the product gate refuses", async () => {
    seed();
    gate.issue = { refuses: true, message: "Oak table is out of stock" };
    await expect(registerManualPost(user, "p1", undefined)).rejects.toMatchObject({ status: 409, message: "Oak table is out of stock" });
    expect(item().status).toBe("APPROVED");
  });
  it("a studio reel already approved at download is recorded even if a product went out of stock", async () => {
    seed({ channel: "INSTAGRAM_REEL", studio: true });
    gate.issue = { refuses: true, message: "Oak table is out of stock" };
    await registerManualPost(user, "p1", "https://www.instagram.com/reel/abc_1/");
    expect(item()).toMatchObject({ status: "PUBLISHED", postUrl: "https://www.instagram.com/reel/abc_1/" });
    expect(gate.calls).toBe(0);
  });
  it("a studio reel still needs a current approval", async () => {
    seed({ channel: "INSTAGRAM_REEL", studio: true });
    db.decisions.length = 0;
    await expect(registerManualPost(user, "p1", "https://www.instagram.com/reel/abc/")).rejects.toMatchObject({ status: 409 });
  });
  it("checks a story's link against the account before the transaction, not inside it", async () => {
    seed({ channel: "INSTAGRAM_STORY" });
    await registerManualPost(user, "p1", "https://www.instagram.com/stories/shop/1234567890/");
    expect(db.accountReads).toEqual([false]);
    expect(item()).toMatchObject({ status: "PUBLISHED", postUrl: "https://www.instagram.com/stories/shop/1234567890/" });
  });
  it.each([
    ["future", new Date(Date.now() + 5 * 86_400_000)],
    ["past", new Date(Date.now() - 5 * 86_400_000)],
    ["no", null],
  ])("posting by hand dates the post (%s date before)", async (_label, scheduledFor) => {
    seed({ scheduledFor });
    const before = Date.now();
    await registerManualPost(user, "p1", undefined);
    const at = (item().scheduledFor as Date).getTime();
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });
  it("is 404 for another brand's post", async () => {
    seed({ brandId: "other" });
    await expect(registerManualPost(user, "p1", undefined)).rejects.toMatchObject({ status: 404 });
  });
});

describe("postLinkFor", () => {
  it.each([
    ["INSTAGRAM_POST", "https://instagram.com/p/Abc-_9/?igsh=1", "https://instagram.com/p/Abc-_9/"],
    ["INSTAGRAM_CAROUSEL", "https://www.instagram.com/reel/Abc/", "https://www.instagram.com/reel/Abc/"],
    ["FACEBOOK_POST", "https://m.facebook.com/share/p/1AbC/", "https://m.facebook.com/share/p/1AbC/"],
    ["PINTEREST_PIN", "https://www.pinterest.com/pin/123456/", "https://www.pinterest.com/pin/123456/"],
    ["PINTEREST_PIN", "https://fr.pinterest.com/pin/123456", "https://fr.pinterest.com/pin/123456"],
    ["PINTEREST_PIN", "https://pin.it/4AbCdE", "https://pin.it/4AbCdE"],
    ["THREADS_POST", "https://www.threads.net/@shop/post/C8abc", "https://www.threads.net/@shop/post/C8abc"],
    ["THREADS_POST", "https://threads.com/t/C8abc?x=1", "https://threads.com/t/C8abc"],
  ] as const)("accepts %s %s", (channel, url, out) => expect(postLinkFor(channel, url)).toBe(out));
  it.each([
    ["PINTEREST_PIN", "https://pinterest.com.evil.io/pin/1/"],
    ["PINTEREST_PIN", "https://www.pinterest.com/shop/"],
    ["PINTEREST_PIN", "https://pin.it/pin/123"],
    ["THREADS_POST", "https://threads.net.evil.io/@a/post/b"],
    ["THREADS_POST", "https://www.instagram.com/p/abc/"],
    ["INSTAGRAM_POST", "https://www.instagram.com/stories/a/12345/"],
    ["INSTAGRAM_POST", `https://www.instagram.com/p/${"a".repeat(300)}/`],
    ["INSTAGRAM_STORY", "https://www.instagram.com/stories/a/12345/"],
    ["INSTAGRAM_POST", "not a url"],
  ] as const)("refuses %s %s", (channel, url) => expect(postLinkFor(channel, url)).toBeNull());
});
