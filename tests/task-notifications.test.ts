import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const db = vi.hoisted(() => {
  const del = () => ({ deleteMany: vi.fn(async () => ({ count: 0 })) });
  return {
    notification: { updateMany: vi.fn(), deleteMany: vi.fn() },
    workspaceMember: { findUnique: vi.fn() },
    // pruneOldRows and the daily agents, for the sweep test
    rateLimitBucket: del(), transientEntry: del(), oAuthStateTransaction: del(), job: del(), emailOutbox: del(), digest: del(), agentEvent: del(), pageView: del(), searchQueryDay: del(),
    brand: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(async () => 0),
  };
});
const m = vi.hoisted(() => ({ userId: vi.fn(), visible: vi.fn() }));
const sweep = vi.hoisted(() => ({
  claim: vi.fn(), complete: vi.fn(), renew: vi.fn(), overdue: vi.fn(), rechecks: vi.fn(), prune: vi.fn(), noop: vi.fn(async () => undefined),
}));
vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/auth/request-user", () => ({ requestUserId: m.userId }));
vi.mock("@/server/tasks/access", async (orig) => ({ clientMemberSql: (await orig<typeof import("@/server/tasks/access")>()).clientMemberSql, visibleNotificationsSql: m.visible }));
vi.mock("next/server", async (orig) => ({ ...(await orig<object>()), after: vi.fn() }));
vi.mock("@/server/jobs/queue", async (orig) => ({ ...(await orig<object>()), claimNextJob: sweep.claim, completeJob: sweep.complete, holdLease: () => () => {} }));
vi.mock("@/server/services/subscriptions", () => ({ renewDuePlans: sweep.renew }));
vi.mock("@/server/services/connections", async (orig) => ({ ...(await orig<object>()), refreshExpiringTokens: sweep.noop }));
vi.mock("@/server/services/automations", () => ({ runMonthlyPlans: sweep.noop }));
vi.mock("@/server/catalog/sync", async (orig) => ({ ...(await orig<object>()), enqueueDailyCatalogSyncs: sweep.noop }));
vi.mock("@/server/reels/recordings", async (orig) => ({ ...(await orig<object>()), purgeOldRecordings: sweep.noop }));
vi.mock("@/server/stories/uploads", async (orig) => ({ ...(await orig<object>()), purgeStaleUploads: sweep.noop }));
vi.mock("@/server/reels/clones", async (orig) => ({ ...(await orig<object>()), reclaimAbandonedClones: sweep.noop }));
vi.mock("@/server/notifications/daily-tasks", () => ({ notifyOverdueTasks: sweep.overdue, notifyRechecks: sweep.rechecks, pruneNotifications: sweep.prune }));

import { countUnread, markRead } from "@/server/notifications/list";
import { GET as countGet } from "@/app/api/v1/me/notifications/count/route";
import { GET as listGet } from "@/app/api/v1/me/notifications/route";
import { POST as readPost } from "@/app/api/v1/me/notifications/read/route";
import { DAILY_SWEEP_JOB, runDueJobs } from "@/server/jobs/runner";

const req = (path: string, init: RequestInit & { ws?: string | null } = {}) => {
  const headers = new Headers(init.headers);
  if (init.ws !== null) headers.set("X-Workspace-Id", init.ws ?? "w1");
  return new Request(`http://localhost:3100/api/v1/me/notifications${path}`, { ...init, headers });
};
const sqlOf = (call: unknown[]) => (call[0] as Prisma.Sql).sql;

beforeEach(() => {
  vi.clearAllMocks();
  m.userId.mockResolvedValue("u1");
  m.visible.mockResolvedValue(Prisma.sql`TRUE`);
  db.workspaceMember.findUnique.mockResolvedValue({ id: "wm1" });
  db.notification.updateMany.mockResolvedValue({ count: 0 });
});

describe("notification API", () => {
  it("markRead with another user's ids changes nothing", async () => {
    await markRead("u1", "w1", ["n-of-u2"]);
    const { where } = db.notification.updateMany.mock.calls[0]![0];
    expect(where).toEqual({ userId: "u1", workspaceId: "w1", readAt: null, id: { in: ["n-of-u2"] } });

    await markRead("u1", "w1", "all");
    expect(db.notification.updateMany.mock.calls[1]![0].where).toEqual({ userId: "u1", workspaceId: "w1", readAt: null });

    const res = await readPost(req("/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: ["n-of-u2"] }) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 0 });
    expect(db.notification.updateMany.mock.calls[2]![0].where).toMatchObject({ userId: "u1", workspaceId: "w1" });
  });

  it("non-member workspace → 403", async () => {
    db.workspaceMember.findUnique.mockResolvedValue(null);
    for (const res of [await countGet(req("/count", { ws: "w9" })), await listGet(req("", { ws: "w9" })), await readPost(req("/read", { ws: "w9", method: "POST", body: JSON.stringify({ all: true }) }))]) {
      expect(res.status).toBe(403);
    }
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.notification.updateMany).not.toHaveBeenCalled();
  });

  it("is 400 without the workspace header and 401 signed out", async () => {
    expect((await countGet(req("/count", { ws: null }))).status).toBe(400);
    m.userId.mockResolvedValue(null);
    expect((await countGet(req("/count"))).status).toBe(401);
  });

  it("count caps at 100", async () => {
    db.$queryRaw.mockResolvedValue([{ count: 100 }]);
    expect(await countUnread("u1", "w1")).toBe(100);
    const sql = sqlOf(db.$queryRaw.mock.calls[0]!);
    expect(sql).toMatch(/LIMIT 100/);
    expect(sql).toMatch(/"readAt" IS NULL OFFSET 0/);
    expect(m.visible).toHaveBeenCalledWith("u1", "w1");

    const res = await countGet(req("/count"));
    expect(await res.json()).toEqual({ count: 100 });
  });

  it("list and count filter through the same where", async () => {
    db.$queryRaw.mockResolvedValueOnce([{ count: 0 }]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await countUnread("u1", "w1");
    const res = await listGet(req(""));
    expect(await res.json()).toEqual({ notifications: [], nextCursor: null });
    const [count, groups, list] = db.$queryRaw.mock.calls.map(sqlOf);
    // Unread come as one row per kind and business with its count; the page itself is read ones only.
    const where = /FROM "Notification" n LEFT JOIN "Task" t ON t\.id = n\."taskId"[\s\S]*LEFT JOIN "AdAlert" al ON al\.id = n\."adAlertId" AND al\."brandId" = n\."brandId"[\s\S]*n\."userId" = \? AND n\."workspaceId" = \? AND TRUE/;
    // The groups pick one id per group from the fenced unread rows, visibility checked there, then join for those ids.
    expect(groups).toMatch(/DISTINCT ON \(n\.kind, n\."brandId"\) n\.id, \(count\(\*\) OVER \(PARTITION BY n\.kind, n\."brandId"\)\)/);
    expect(groups).toMatch(/"readAt" IS NULL OFFSET 0\s*\) n LEFT JOIN "Task" t ON t\.id = n\."taskId"\s*WHERE n\."userId" = \? AND n\."workspaceId" = \? AND TRUE/);
    expect(groups).toMatch(/\) g JOIN "Notification" n ON n\.id = g\.id LEFT JOIN "Task" t ON t\.id = n\."taskId"[\s\S]*LEFT JOIN "AdAlert" al ON al\.id = n\."adAlertId" AND al\."brandId" = n\."brandId"/);
    expect(list).toMatch(/n\."readAt" IS NOT NULL/);
    // The count reads the unread rows through a fenced subquery aliased n, then applies the same where.
    expect(count).toMatch(/kind, "brandId", "adAlertId", "seoAlertId", "createdAt" FROM "Notification"[\s\S]*\) n LEFT JOIN "Task" t ON t\.id = n\."taskId"[\s\S]*n\."userId" = \? AND n\."workspaceId" = \? AND TRUE/);
    expect(list).toMatch(where);
    expect(list).toMatch(/LIMIT 21/);
  });

  it("the actor says whether they are a client on the notification's brand", async () => {
    const at = new Date("2026-11-23T10:00:00Z");
    const base = { id: "n1", kind: "REVIEW_REQUESTED", brandId: "b1", taskId: "t1", taskTitle: "Fix", actorId: "u5", actorName: "Cli", actorEmail: "c@x.com", actorGone: false, readAt: null, createdAt: at };
    db.$queryRaw.mockResolvedValueOnce([{ ...base, actorClient: true, count: 3 }]).mockResolvedValueOnce([{ ...base, id: "n2", actorId: "u2", actorName: "Bob", actorClient: false, readAt: at }]);
    const body = await (await listGet(req(""))).json();
    // The unread group comes first with its count; a read row counts as one.
    expect(body.notifications.map((n: { count: number }) => n.count)).toEqual([3, 1]);
    expect(body.notifications.map((n: { actor: unknown }) => n.actor)).toEqual([
      { id: "u5", name: "Cli", gone: false, client: true },
      { id: "u2", name: "Bob", gone: false, client: false },
    ]);
    const sql = sqlOf(db.$queryRaw.mock.calls[0]!);
    expect(sql).toMatch(/cm\."brandId" = n\."brandId" AND cm\."userId" = n\."actorId"[\s\S]*'content\.approve' = ANY[\s\S]*AS "actorClient"/);
  });

  it("refuses a bad cursor with 400", async () => {
    expect((await listGet(req("?cursor=nope"))).status).toBe(400);
  });
});

describe("daily sweep", () => {
  it("sweep failure doesn't stop renewals", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    sweep.claim.mockResolvedValueOnce({ id: "j1", type: DAILY_SWEEP_JOB, payload: {}, attempts: 1, maxAttempts: 3, leasedBy: "w" }).mockResolvedValue(null);
    sweep.overdue.mockRejectedValue(new Error("bad time zone"));
    sweep.rechecks.mockResolvedValue(0);
    sweep.prune.mockResolvedValue(0);
    await runDueJobs({ budgetMs: 5_000 });
    expect(sweep.renew).toHaveBeenCalledTimes(1);
    // Renewals run before the task steps, and one failing step leaves the others and the sweep itself standing.
    expect(sweep.renew.mock.invocationCallOrder[0]).toBeLessThan(sweep.overdue.mock.invocationCallOrder[0]!);
    expect(sweep.rechecks).toHaveBeenCalledTimes(1);
    expect(sweep.prune).toHaveBeenCalledTimes(1);
    expect(sweep.complete).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("overdue"), expect.any(Error));
  });
});
