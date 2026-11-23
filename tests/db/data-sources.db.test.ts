import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ perms: new Set<string>(), brandId: "ds-a", userId: "u1" }));
vi.mock("@/server/api/brand-route", async () => {
  const { AccessDeniedError } = await import("@/server/auth/errors");
  return {
    authorizeBrandRoute: vi.fn(async (_r: Request, _p: unknown, key: string) => {
      if (!auth.perms.has(key)) throw new AccessDeniedError(`Missing permission ${key}`);
      return { userId: auth.userId, workspaceId: ws, brandId: auth.brandId, perms: auth.perms, clientReviewer: false };
    }),
  };
});
vi.mock("@/server/jobs/runner", () => ({ kickRunner: vi.fn() }));

import { prisma } from "@/server/db/prisma";
import { enqueueDailyCatalogSyncs, CATALOG_SYNC_JOB } from "@/server/catalog/sync";
import { claimNextJob, enqueueJob } from "@/server/jobs/queue";
import { DATA_SYNC_JOB, enqueueDailyDataSyncs, enqueueSourceSync, registerSync, runDataSync, spreadSecs, type SyncContext, type SyncOutcome } from "@/server/data/sources";
import { ReconnectNeeded } from "@/server/services/connections";
import { GET } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/data-sources/route";
import { POST } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/data-sources/[kind]/sync/route";

/**
 * Data sources against Postgres: the daily sweep step, the data.sync handler's scoping and results, the claim's
 * fairness rule, and the GET / Sync now routes' permission filtering and limits.
 */
let ws: string;
const lease = { jobId: "no-job", leasedBy: null };
const day = new Date().toISOString().slice(0, 10);

async function brand(id: string) {
  await prisma.brand.create({ data: { id, workspaceId: ws, slug: id, displayName: id } });
  await prisma.brandProfile.create({ data: { workspaceId: ws, brandId: id, websiteUrl: `https://${id}.test` } });
}
const source = (brandId: string, kind: "SEARCH_CONSOLE" | "SHOPIFY_ORDERS" | "META_ADS" | "POST_METRICS", extra: Record<string, unknown> = {}) =>
  prisma.dataSource.create({ data: { workspaceId: ws, brandId, kind, externalId: `${kind}-${Math.random()}`, label: "shop.myshopify.com", ...extra } });
const payload = (s: { id: string; workspaceId: string; brandId: string; kind: string }, extra: Record<string, unknown> = {}) =>
  ({ dataSourceId: s.id, workspaceId: s.workspaceId, brandId: s.brandId, kind: s.kind, mode: "daily", ...extra });
const dataJobs = (sourceId: string) => prisma.job.findMany({ where: { type: DATA_SYNC_JOB, payload: { path: ["dataSourceId"], equals: sourceId } }, orderBy: { createdAt: "asc" } });

// Kinds whose client is "built" for these tests.
const calls: SyncContext[] = [];
let next: (ctx: SyncContext) => Promise<SyncOutcome> = async () => ({ count: 0 });
registerSync("SEARCH_CONSOLE", async (ctx) => (calls.push(ctx), next(ctx)));

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-data-sources" } })).id;
  await brand("ds-a");
  await brand("ds-b");
});
beforeEach(async () => {
  calls.length = 0;
  next = async () => ({ count: 0 });
  await prisma.job.deleteMany({});
  await prisma.dataSource.deleteMany({});
  await prisma.rateLimitBucket.deleteMany({});
});

describe("enqueueDailyDataSyncs", () => {
  it("queues one daily run per source that isn't off, spread from the sweep time, once per day", async () => {
    const on = await source("ds-a", "SEARCH_CONSOLE");
    const failing = await source("ds-a", "META_ADS", { status: "ERROR" });
    const off = await source("ds-b", "SEARCH_CONSOLE", { status: "OFF" });
    const now = new Date();
    expect(await enqueueDailyDataSyncs(now)).toBe(2);
    expect(await enqueueDailyDataSyncs(now)).toBe(2); // a second sweep the same day
    const jobs = await prisma.job.findMany({ where: { type: DATA_SYNC_JOB } });
    expect(jobs.map((j) => j.idempotencyKey).sort()).toEqual([`data:${failing.id}:${day}`, `data:${on.id}:${day}`].sort());
    const mine = jobs.find((j) => j.idempotencyKey === `data:${on.id}:${day}`)!;
    expect(mine.runAt.getTime()).toBe(now.getTime() + spreadSecs(on.id) * 1000);
    expect(mine.maxAttempts).toBe(3);
    expect(mine.payload).toEqual(payload(on));
    expect(jobs.some((j) => (j.payload as { dataSourceId: string }).dataSourceId === off.id)).toBe(false);
  });

  it("restarts a backfill chain that died from syncedThrough; not one that's alive or done", async () => {
    const backfill = { start: "2026-08-01", end: "2026-10-29", days: 30 };
    const dead = await source("ds-a", "SEARCH_CONSOLE", { settings: { backfill }, syncedThrough: new Date("2026-08-30") });
    const done = await source("ds-a", "META_ADS", { settings: { backfill }, syncedThrough: new Date("2026-10-29") });
    const alive = await source("ds-b", "SEARCH_CONSOLE", { settings: { backfill } });
    await enqueueSourceSync(alive, "backfill", { window: { from: "2026-08-01", to: "2026-08-30", end: backfill.end }, runAt: new Date(Date.now() + 3_600_000) });
    await enqueueDailyDataSyncs();
    await enqueueDailyDataSyncs(); // a second sweep restarts it once
    const restarted = (await dataJobs(dead.id)).filter((j) => (j.payload as { mode: string }).mode === "backfill");
    expect(restarted).toHaveLength(1);
    expect(restarted[0].payload).toMatchObject({ from: "2026-08-31", to: "2026-09-29", end: "2026-10-29" });
    expect((await dataJobs(done.id)).map((j) => (j.payload as { mode: string }).mode)).toEqual(["daily"]);
    expect((await dataJobs(alive.id)).filter((j) => (j.payload as { mode: string }).mode === "backfill")).toHaveLength(1);
  });

  it("leaves the catalogue sync's jobs as they were", async () => {
    await source("ds-a", "SEARCH_CONSOLE");
    await enqueueDailyCatalogSyncs();
    await enqueueDailyDataSyncs();
    const catalog = await prisma.job.findMany({ where: { type: CATALOG_SYNC_JOB }, orderBy: { idempotencyKey: "asc" } });
    expect(catalog.map((j) => [j.idempotencyKey, j.payload, j.maxAttempts])).toEqual([
      [`catalog-sync:ds-a:${day}`, { workspaceId: ws, brandId: "ds-a" }, 5],
      [`catalog-sync:ds-b:${day}`, { workspaceId: ws, brandId: "ds-b" }, 5],
    ]);
  });
});

describe("runDataSync", () => {
  it("a payload naming another brand's source does nothing", async () => {
    const s = await source("ds-a", "SEARCH_CONSOLE");
    await runDataSync(payload(s, { brandId: "ds-b" }), lease);
    await runDataSync(payload(s, { kind: "META_ADS" }), lease);
    expect(calls).toHaveLength(0);
    expect((await prisma.dataSource.findUniqueOrThrow({ where: { id: s.id } })).lastResult).toBeNull();
  });

  it("a switched-off or deleted source does nothing", async () => {
    const s = await source("ds-a", "SEARCH_CONSOLE", { status: "OFF" });
    await runDataSync(payload(s), lease);
    await runDataSync(payload({ ...s, id: "gone" }), lease);
    expect(calls).toHaveLength(0);
  });

  it("a kind with no registered runner throws and records failed", async () => {
    const s = await source("ds-a", "SHOPIFY_ORDERS");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(runDataSync(payload(s), lease)).rejects.toThrow("no data sync registered");
    expect((await prisma.dataSource.findUniqueOrThrow({ where: { id: s.id } })).lastResult).toMatchObject({ reason: "failed" });
  });

  it("a complete window whose syncedThrough can't move queues the window after it, not itself again", async () => {
    const s = await source("ds-a", "SEARCH_CONSOLE", { syncedThrough: new Date("2026-08-01") });
    next = async () => ({ count: 1, complete: true });
    await runDataSync(payload(s, { mode: "backfill", from: "2026-08-10", to: "2026-08-16", end: "2026-09-30" }), lease);
    expect((await prisma.dataSource.findUniqueOrThrow({ where: { id: s.id } })).syncedThrough?.toISOString().slice(0, 10)).toBe("2026-08-01");
    const queued = await dataJobs(s.id);
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toMatchObject({ mode: "backfill", from: "2026-08-17", to: "2026-08-23" });
  });

  it("a complete daily run extends a held syncedThrough contiguously, and never starts one", async () => {
    const held = await source("ds-a", "SEARCH_CONSOLE", { syncedThrough: new Date("2026-11-18") });
    const none = await source("ds-b", "SEARCH_CONSOLE");
    next = async () => ({ count: 1, complete: true, window: { from: "2026-11-19", to: "2026-11-21" } });
    await runDataSync(payload(held), lease);
    await runDataSync(payload(none), lease);
    expect((await prisma.dataSource.findUniqueOrThrow({ where: { id: held.id } })).syncedThrough?.toISOString().slice(0, 10)).toBe("2026-11-21");
    expect((await prisma.dataSource.findUniqueOrThrow({ where: { id: none.id } })).syncedThrough).toBeNull();
  });

  it("a connection of another brand records reconnect and never runs the client", async () => {
    const other = await prisma.integrationConnection.create({
      data: { workspaceId: ws, brandId: "ds-b", provider: "GOOGLE", externalAccountId: "g1", displayName: "G", scopes: [], status: "ACTIVE", credentialKeyVersion: 1, connectedByUserId: (await prisma.user.create({ data: { email: "c@data-sources.test", name: "c" } })).id },
    });
    const s = await source("ds-a", "SEARCH_CONSOLE", { connectionId: other.id });
    await runDataSync(payload(s), lease);
    expect(calls).toHaveLength(0);
    const row = await prisma.dataSource.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.status).toBe("ERROR");
    expect(row.lastResult).toMatchObject({ reason: "reconnect", okAt: null });
  });

  it("records a success, then keeps okAt through a failure whose error is a fixed string", async () => {
    const s = await source("ds-a", "SEARCH_CONSOLE");
    next = async () => ({ count: 12 });
    await runDataSync(payload(s), lease);
    const ok = (await prisma.dataSource.findUniqueOrThrow({ where: { id: s.id } })).lastResult as { okAt: string; count: number; error: null };
    expect(ok).toMatchObject({ count: 12, reason: null, error: null });

    vi.spyOn(console, "warn").mockImplementation(() => {});
    next = async () => { throw new Error("403 https://example.test/?access_token=secret"); };
    await expect(runDataSync(payload(s), lease)).rejects.toThrow();
    const failed = await prisma.dataSource.findUniqueOrThrow({ where: { id: s.id } });
    expect(failed.lastResult).toMatchObject({ reason: "failed", okAt: ok.okAt });
    expect(JSON.stringify(failed.lastResult)).not.toContain("secret");

    next = async () => { throw new ReconnectNeeded("refused"); };
    await expect(runDataSync(payload(s), lease)).rejects.toBeInstanceOf(ReconnectNeeded);
    expect(await prisma.dataSource.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ status: "ERROR", lastResult: expect.objectContaining({ reason: "reconnect" }) });
  });

  it("a backfill window advances syncedThrough and chains the next; a partial one is retried later", async () => {
    const s = await source("ds-a", "SEARCH_CONSOLE");
    next = async () => ({ count: 30, complete: true });
    await runDataSync(payload(s, { mode: "backfill", from: "2026-01-01", to: "2026-01-30", end: "2026-02-15" }), lease);
    const row = await prisma.dataSource.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.syncedThrough?.toISOString().slice(0, 10)).toBe("2026-01-30");
    const [chained] = await dataJobs(s.id);
    expect(chained!.payload).toMatchObject({ mode: "backfill", from: "2026-01-31", to: "2026-02-15", end: "2026-02-15" });
    expect(chained!.idempotencyKey).toBe(`data:${s.id}:backfill:${s.updatedAt.getTime()}:2026-01-31`);

    next = async () => ({ count: 0, reason: "partial" });
    await runDataSync(chained!.payload, lease);
    expect((await prisma.dataSource.findUniqueOrThrow({ where: { id: s.id } })).syncedThrough?.toISOString().slice(0, 10)).toBe("2026-01-30");
    const retry = (await dataJobs(s.id))[1]!;
    expect(retry.payload).toMatchObject({ from: "2026-01-31", retry: 1 });
    expect(retry.runAt.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
  });

  it("a daily run waits five minutes behind a running backfill of the same source", async () => {
    const s = await source("ds-a", "SEARCH_CONSOLE");
    const backfill = await enqueueSourceSync(s, "backfill", { window: { from: "2026-01-01", to: "2026-01-30", end: "2026-01-30" } });
    await prisma.job.update({ where: { id: backfill.id }, data: { status: "RUNNING", leasedUntil: new Date(Date.now() + 60_000) } });
    await runDataSync(payload(s), { jobId: "daily-job", leasedBy: "w" });
    expect(calls).toHaveLength(0);
    const waiting = (await dataJobs(s.id)).find((j) => j.id !== backfill.id)!;
    expect(waiting.payload).toMatchObject({ mode: "daily" });
    expect(waiting.runAt.getTime()).toBeGreaterThanOrEqual(Date.now() + 4 * 60_000);
  });
});

describe("claimNextJob", () => {
  it("skips data jobs while two run, so publishing goes first", async () => {
    const live = new Date(Date.now() + 60_000);
    for (const i of [1, 2]) await prisma.job.create({ data: { type: DATA_SYNC_JOB, payload: {}, status: "RUNNING", leasedUntil: live, idempotencyKey: `running-${i}` } });
    const early = new Date(Date.now() - 60_000);
    const data = await enqueueJob({ type: DATA_SYNC_JOB, payload: {}, runAt: early });
    const publish = await enqueueJob({ type: "publish.execute", payload: {}, runAt: new Date(Date.now() - 1000) });

    expect((await claimNextJob("w1"))?.id).toBe(publish.id);
    expect(await claimNextJob("w1")).toBeNull();

    await prisma.job.updateMany({ where: { idempotencyKey: "running-1" }, data: { status: "COMPLETED" } });
    expect((await claimNextJob("w1"))?.id).toBe(data.id);
  });
});

describe("GET data-sources", () => {
  const params = Promise.resolve({ workspaceId: "w", brandId: "ds-a" });
  const get = async () => (await (await GET(new Request("http://x/api"), { params })).json()).sources as Record<string, unknown>[];

  it("shows each kind only with its read key, the label only to integration managers, and never another brand's", async () => {
    await source("ds-a", "SEARCH_CONSOLE", { lastResult: { at: "x", okAt: null, reason: "failed", count: 0, error: "Provider said: 500 secret" } });
    await source("ds-a", "SHOPIFY_ORDERS");
    await source("ds-a", "META_ADS");
    await source("ds-b", "SEARCH_CONSOLE");

    auth.perms = new Set(["brand.read"]);
    expect(await get()).toEqual([]);

    auth.perms = new Set(["brand.read", "analytics.read"]); // viewer, client reviewer
    const viewer = await get();
    expect(viewer.map((s) => s.kind)).toEqual(["SEARCH_CONSOLE"]);
    expect(viewer[0]).not.toHaveProperty("label");
    expect((viewer[0]!.lastResult as { error: string }).error).not.toContain("secret");

    auth.perms = new Set(["brand.read", "analytics.read", "crm.read", "ads.read", "integrations.manage"]);
    const manager = await get();
    expect(manager.map((s) => s.kind)).toEqual(["SEARCH_CONSOLE", "SHOPIFY_ORDERS", "META_ADS"]);
    expect(manager[1]!.label).toBe("shop.myshopify.com");
  });
});

describe("POST data-sources/:kind/sync", () => {
  const post = (kind: string) => POST(new Request("http://x/api", { method: "POST" }), { params: Promise.resolve({ workspaceId: "w", brandId: "ds-a", kind }) });
  beforeEach(() => void (auth.perms = new Set(["brand.read", "analytics.read", "crm.read"])));

  it("an unknown kind or a brand without that source is 404", async () => {
    expect((await post("SEARCH_CONSOLE")).status).toBe(404);
    expect((await post("tiktok")).status).toBe(404);
    expect((await post("search-console")).status).toBe(404);
    await source("ds-b", "SEARCH_CONSOLE"); // another brand's
    expect((await post("search-console")).status).toBe(404);
  });

  it("needs the kind's read key: orders need crm.read, ads need ads.read", async () => {
    await source("ds-a", "META_ADS");
    expect((await post("meta-ads")).status).toBe(403);
    auth.perms.add("ads.read");
    expect((await post("meta-ads")).status).toBe(202);
  });

  it("queues once while one is due, skips a source synced under 5 minutes ago, and allows 3 an hour", async () => {
    const s = await source("ds-a", "SEARCH_CONSOLE");
    const res = await post("search-console");
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: true });
    expect(await (await post("search-console")).json()).toEqual({ queued: false }); // a double click
    expect(await dataJobs(s.id)).toHaveLength(1);

    await prisma.dataSource.update({ where: { id: s.id }, data: { lastResult: { at: new Date().toISOString(), okAt: new Date().toISOString(), reason: null, count: 1, error: null } } });
    await prisma.job.updateMany({ where: { type: DATA_SYNC_JOB }, data: { status: "COMPLETED" } });
    expect(await (await post("search-console")).json()).toEqual({ queued: false }); // fresh

    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    await prisma.dataSource.update({ where: { id: s.id }, data: { lastResult: { at: old, okAt: old, reason: null, count: 1, error: null } } });
    for (let i = 2; i <= 3; i++) {
      expect(await (await post("search-console")).json()).toEqual({ queued: true });
      await prisma.job.updateMany({ where: { type: DATA_SYNC_JOB }, data: { status: "COMPLETED" } });
    }
    expect((await post("search-console")).status).toBe(429);
    auth.userId = "u2"; // the limit is per person
    expect((await post("search-console")).status).toBe(202);
    auth.userId = "u1";
  });
});
