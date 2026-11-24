import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mail = vi.hoisted(() => ({ sendMail: vi.fn() }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => mail } }));
vi.mock("@/server/auth/request-user", () => ({ requestUserId: vi.fn() }));

import { prisma } from "@/server/db/prisma";
import { requestUserId } from "@/server/auth/request-user";
import { ensureSystemRoles } from "@/server/auth/permissions";
import { runDigest } from "@/server/digest/job";
import { unsubscribeToken } from "@/server/digest/unsubscribe";
import { sendOutboxEmail } from "@/server/email/outbox";
import { claimNextJob } from "@/server/jobs/queue";
import { pruneOldRows } from "@/server/jobs/runner";
import { removeMember } from "@/server/services/workspace-admin";
import { GET as getDigests } from "@/app/api/v1/workspaces/[workspaceId]/digests/route";
import { POST as unsubscribe } from "@/app/api/v1/digest/unsubscribe/route";

/**
 * The digest job, its email and its page against Postgres. `admin` (workspace Admin) builds a digest with sales and ads;
 * `member` holds a custom project role whose crm.read the tests take away. Email goes through a mocked nodemailer.
 */
let ws: string;
let brand: string;
let memberRole: string;
const user: Record<string, string> = {};
const WEEK = "2026-11-16";
const job = (name: string) => ({ workspaceId: ws, userId: user[name]!, weekStart: WEEK });
const outboxOf = (name: string) => prisma.emailOutbox.findMany({ where: { to: `${name}@digest-job.test` } });
const digestsOf = (name: string) => prisma.digest.findMany({ where: { userId: user[name]!, workspaceId: ws } });
const sendAll = async () => {
  for (const row of await prisma.emailOutbox.findMany({ where: { status: "PENDING" } })) await sendOutboxEmail({ outboxId: row.id });
};

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-digest-job" } })).id;
  brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "B" } })).id;
  await ensureSystemRoles(ws);
  const roles = Object.fromEntries((await prisma.role.findMany({ where: { workspaceId: ws } })).map((r) => [r.slug, r.id]));
  memberRole = (await prisma.role.create({ data: { workspaceId: ws, slug: "seller", name: "Seller", scope: "PROJECT", permissions: ["brand.read", "crm.read"] } })).id;
  for (const name of ["admin", "member", "quiet", "outsider"]) {
    user[name] = (await prisma.user.create({ data: { email: `${name}@digest-job.test`, name, digestEmail: name !== "quiet" } })).id;
  }
  for (const name of ["admin", "member", "quiet"]) {
    await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: user[name]!, roleId: roles[name === "admin" ? "admin" : "member"]! } });
  }
  for (const name of ["member", "quiet"]) await prisma.brandMember.create({ data: { workspaceId: ws, brandId: brand, userId: user[name]!, roleId: memberRole } });
  await prisma.dataSource.create({ data: { workspaceId: ws, brandId: brand, kind: "SHOPIFY_ORDERS", externalId: "b.myshopify.com", syncedThrough: new Date("2026-11-22T00:00:00Z") } });
  await prisma.contentItem.create({ data: { workspaceId: ws, brandId: brand, title: "Post", channel: "INSTAGRAM_POST", status: "AWAITING_APPROVAL" } });
});

beforeEach(() => {
  vi.stubEnv("SMTP_HOST", "smtp.test");
  vi.stubEnv("EMAIL_FROM", "digest@test");
  vi.stubEnv("AUTH_URL", "https://app.test");
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", Buffer.alloc(32, 5).toString("base64"));
  mail.sendMail.mockReset().mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());

describe("digest job and email", () => {
  it("the same job twice → one row, one email; the outbox keeps only [digest] after sending", async () => {
    await runDigest(job("admin"));
    await runDigest(job("admin"));
    expect(await digestsOf("admin")).toHaveLength(1);
    expect(await outboxOf("admin")).toHaveLength(1);
    await sendAll();
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    const sent = mail.sendMail.mock.calls[0]![0];
    expect(sent.to).toBe("admin@digest-job.test");
    expect(sent.text).toContain("Sales: no orders");
    expect(sent.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/app\.test\/api\/v1\/digest\/unsubscribe\?token=[\w-]+\.[\w-]+>$/);
    expect(sent.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const row = await prisma.emailOutbox.findFirst({ where: { ref: `digest:${(await digestsOf("admin"))[0]!.id}` } });
    expect(row).toMatchObject({ status: "SENT", to: "", text: "[digest]", html: null });
    expect(sent.subject).toBe("Your weekly digest: 2026-11-16 to 2026-11-22");
  });

  it("opted out by default → a row in the app, no email", async () => {
    await runDigest(job("quiet"));
    expect(await digestsOf("quiet")).toHaveLength(1);
    expect(await outboxOf("quiet")).toHaveLength(0);
  });

  it("email not configured → row only", async () => {
    vi.stubEnv("SMTP_HOST", "");
    await runDigest(job("member"));
    expect(await digestsOf("member")).toHaveLength(1);
    expect(await outboxOf("member")).toHaveLength(0);
    await prisma.digest.deleteMany({ where: { userId: user.member } });
  });

  it("a section whose key was lost is dropped from the page and from a queued email", async () => {
    await runDigest(job("member"));
    vi.mocked(requestUserId).mockResolvedValue(user.member!);
    const kinds = async () => {
      const res = await getDigests(new Request("http://x"), { params: Promise.resolve({ workspaceId: ws }) });
      return ((await res.json()) as { digests: { body: { brands: { sections: { kind: string }[] }[] } }[] }).digests[0]!.body.brands[0]?.sections.map((s) => s.kind);
    };
    expect(await kinds()).toEqual(["content", "sales"]);
    await prisma.role.update({ where: { id: memberRole }, data: { permissions: ["brand.read"] } });
    try {
      expect(await kinds()).toEqual(["content"]);
      await sendAll();
      expect(mail.sendMail.mock.calls[0]![0].text).not.toContain("Sales");
    } finally {
      await prisma.role.update({ where: { id: memberRole }, data: { permissions: ["brand.read", "crm.read"] } });
    }
  });

  it("GET by a non-member → 403", async () => {
    vi.mocked(requestUserId).mockResolvedValue(user.outsider!);
    expect((await getDigests(new Request("http://x"), { params: Promise.resolve({ workspaceId: ws }) })).status).toBe(403);
  });

  it("a removed member's digests are deleted and a queued email is not sent", async () => {
    await prisma.digest.updateMany({ where: { userId: user.member }, data: { emailedAt: null } });
    await prisma.emailOutbox.deleteMany({ where: { to: "member@digest-job.test" } });
    await runDigest(job("member")); // the row exists: only queues the email
    expect(await outboxOf("member")).toHaveLength(1);
    const member = await prisma.workspaceMember.findFirstOrThrow({ where: { workspaceId: ws, userId: user.member } });
    await removeMember(ws, user.admin!, member.id);
    expect(await digestsOf("member")).toHaveLength(0);
    await sendAll();
    expect(mail.sendMail).not.toHaveBeenCalled();
    expect(await outboxOf("member")).toHaveLength(0);
  });
});

describe("unsubscribe", () => {
  const post = (token: string) => unsubscribe(new Request(`https://app.test/api/v1/digest/unsubscribe?token=${token}`, { method: "POST", body: "List-Unsubscribe=One-Click" }));

  it("a valid one-click POST opts out; a forged token → 400", async () => {
    const token = unsubscribeToken(user.admin!, ws);
    expect((await post(`${token.split(".")[0]}.forged`)).status).toBe(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.admin } })).digestEmail).toBe(true);
    expect((await post(token)).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.admin } })).digestEmail).toBe(false);
  });
});

describe("pruning and the queue", () => {
  it("FAILED outbox rows and digests past 12 weeks are pruned", async () => {
    const kept = (await digestsOf("quiet"))[0]!;
    const old = new Date(Date.now() - 85 * 86_400_000);
    const failed = await prisma.emailOutbox.create({ data: { to: "x@test", subject: "s", text: "t", status: "FAILED", createdAt: old } });
    const stale = await prisma.digest.create({ data: { userId: user.quiet!, workspaceId: ws, weekStart: new Date("2026-08-24T00:00:00Z"), body: { brands: [] }, createdAt: old } });
    await pruneOldRows();
    expect(await prisma.emailOutbox.findUnique({ where: { id: failed.id } })).toBeNull();
    expect(await prisma.digest.findUnique({ where: { id: stale.id } })).toBeNull();
    expect(await prisma.digest.findUnique({ where: { id: kept.id } })).not.toBeNull();
  });

  it("one digest job runs at a time; other work is still claimed", async () => {
    await prisma.job.deleteMany({});
    const past = new Date(Date.now() - 60_000);
    await prisma.job.create({ data: { type: "digest.build", payload: {}, status: "RUNNING", leasedBy: "w0", leasedUntil: new Date(Date.now() + 60_000) } });
    await prisma.job.create({ data: { type: "digest.build", payload: {}, runAt: past } });
    const other = await prisma.job.create({ data: { type: "publish.execute", payload: {}, runAt: new Date(Date.now() - 1_000) } });
    expect((await claimNextJob("w1"))?.id).toBe(other.id);
    expect(await claimNextJob("w1")).toBeNull();
  });
});
