import { beforeEach, describe, expect, it, vi } from "vitest";

// A non-story Instagram post whose attempt is declared lost while its container is still processing (releaseState's
// 10 minutes, or onPublishJobLost after a lost lease): the old runner must not reach media_publish.
const s = vi.hoisted(() => ({
  attempt: {} as Record<string, unknown>,
  // The job's lease: seconds until leasedUntil while this runner holds it, null once another runner took it.
  leaseAhead: 300 as number | null,
  queryFails: false,
  onPoll: null as null | (() => void),
  published: 0,
  audits: [] as unknown[],
}));

vi.mock("@/server/db/prisma", () => {
  const prisma = {
    $executeRaw: async () => 0,
    // holdsLease's SELECT … FOR SHARE: one row while this runner holds the job with more than the margin left.
    $queryRaw: async (sql: TemplateStringsArray, ...values: unknown[]) => {
      if (s.queryFails) throw new Error("Timed out fetching a new connection from the connection pool");
      const margin = sql.join("?").includes("1 minute") ? 60 : Number(values[2] ?? 0);
      return s.leaseAhead !== null && s.leaseAhead > margin ? [{ id: "j1" }] : [];
    },
    publicationAttempt: {
      updateMany: async ({ where, data }: { where: { id: string; status: string }; data: object }) => {
        if (s.attempt.id !== where.id || s.attempt.status !== where.status) return { count: 0 };
        Object.assign(s.attempt, data);
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ ...s.attempt }),
    },
    contentItem: {
      findFirst: async () => ({ id: "i1", workspaceId: "w1", brandId: "b1", channel: "INSTAGRAM_POST", status: "SCHEDULED", studio: false, title: "Milo", productIds: [], campaignId: null, versions: [latest] }),
      update: async () => ({}),
    },
    approvalDecision: { findFirst: async () => approval, findMany: async () => [] },
    integrationConnection: { findFirst: async () => ({ id: "c1", externalAccountId: "ig1", encryptedCredentials: "x", displayName: "Shop", status: "ACTIVE" }) },
    brandProfile: { findFirst: async () => null },
    auditEvent: { create: async ({ data }: { data: unknown }) => void s.audits.push(data) },
    $transaction: async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(prisma),
  };
  return { prisma };
});
vi.mock("@/server/catalog/linked", () => ({ linkedProducts: vi.fn(async () => []) }));
vi.mock("@/server/catalog/campaigns", () => ({ campaignsById: vi.fn(async () => ({ campaigns: new Map(), timeZone: "UTC" })) }));
vi.mock("@/server/auth/permissions", () => ({ requirePermission: vi.fn(), hasOtherApprover: vi.fn(async () => true) }));
vi.mock("@/server/services/connections", () => ({ accessToken: vi.fn(async () => "tok"), markReconnect: vi.fn(), ReconnectNeeded: class extends Error {} }));
vi.mock("@/server/storage/media", async (orig) => ({ ...(await orig<object>()), signedMediaUrl: vi.fn(async (k: string) => `https://signed.example/${k}`) }));
vi.mock("@/server/agents/engine", () => ({ startAgentRun: vi.fn() }));
vi.mock("@/server/services/automations", () => ({ autoPublish: vi.fn() }));

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
  const u = new URL(url);
  if (u.pathname.endsWith("/media") && init?.method === "POST") return json({ id: "cont1" });
  if (u.searchParams.get("fields") === "status_code") {
    s.onPoll?.(); // while the container processes, a person opens the post (or the job is reclaimed)
    return json({ status_code: "FINISHED" });
  }
  if (u.pathname.endsWith("/media_publish")) {
    s.published++;
    return json({ id: "m1" });
  }
  if (u.searchParams.get("fields") === "permalink") return json({ permalink: "https://www.instagram.com/p/m1/" });
  throw new Error(`unexpected call ${url}`);
}));

import { executePublication, packageHash } from "@/server/services/publishing";

const latest = { id: "v2", version: 2, body: { caption: "Our Milo sofa", productIds: [] }, createdBy: "writer", checks: [{ overall: "PASS", results: [] }] };
const approval = { id: "d1", verdict: "APPROVED", contentVersionId: "v2", packageHash: packageHash({ id: "i1", channel: "INSTAGRAM_POST" }, latest), productOverride: null };
const lease = { jobId: "j1", leasedBy: "runner-1" };

beforeEach(() => {
  s.attempt = {
    id: "a1", workspaceId: "w1", brandId: "b1", contentItemId: "i1", contentVersionId: "v2", packageHash: approval.packageHash,
    connectionId: "c1", provider: "INSTAGRAM", createdByUserId: "u1", status: "SCHEDULED", target: { imageUrl: "https://shop.example/milo.jpg" },
  };
  s.leaseAhead = 300;
  s.queryFails = false;
  s.onPoll = null;
  s.published = 0;
  s.audits = [];
});

describe("a non-story publish re-checks its attempt just before media_publish", () => {
  it("posts once when the attempt is still live", async () => {
    await executePublication({ attemptId: "a1" }, lease);
    expect(s.published).toBe(1);
    expect(s.attempt.status).toBe("PUBLISHED");
  });

  it("posts nothing once the attempt was declared lost (PENDING_VERIFY) while the container processed", async () => {
    s.onPoll = () => void (s.attempt.status = "PENDING_VERIFY"); // releaseState's 10-minute rule
    await executePublication({ attemptId: "a1" }, lease);
    expect(s.published).toBe(0);
    expect(s.attempt.status).toBe("PENDING_VERIFY"); // nothing overwritten: the person's check stands
    expect(s.audits).toEqual([]);
  });

  it("posts nothing after a person settled it as not posted and it was booked again", async () => {
    s.onPoll = () => void (s.attempt.status = "FAILED");
    await executePublication({ attemptId: "a1" }, lease);
    expect(s.published).toBe(0);
    expect(s.attempt.status).toBe("FAILED");
  });

  it("posts nothing when this runner lost the job's lease, and says nothing was posted", async () => {
    s.onPoll = () => void (s.leaseAhead = null); // reclaimed by another loop
    await executePublication({ attemptId: "a1" }, lease);
    expect(s.published).toBe(0);
    expect(s.attempt).toMatchObject({ status: "FAILED", error: expect.stringContaining("Nothing was posted") });
  });

  it("a lease that is late, not lost (renewals failed, 30 s left), posts nothing and isn't left PUBLISHING", async () => {
    s.onPoll = () => void (s.leaseAhead = 30); // less than the minute the last call needs
    await executePublication({ attemptId: "a1" }, lease);
    expect(s.published).toBe(0);
    expect(s.attempt).toMatchObject({ status: "FAILED", error: expect.stringContaining("Nothing was posted") });
  });

  it("a database error during the re-check is FAILED (nothing sent), not \"couldn't confirm whether it posted\"", async () => {
    s.onPoll = () => void (s.queryFails = true);
    await executePublication({ attemptId: "a1" }, lease);
    expect(s.published).toBe(0);
    expect(s.attempt.status).toBe("FAILED");
    expect(String(s.attempt.error)).not.toContain("couldn't confirm");
  });
});
