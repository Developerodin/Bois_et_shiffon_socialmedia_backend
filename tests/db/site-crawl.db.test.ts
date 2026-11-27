import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The weekly link check (seo.links) against Postgres, with the network faked: robots.txt, the sitemap discovery and
 * every fetch are stubs, so nothing here reaches a real site.
 */
type Served = { status?: number; body?: string; headers?: Record<string, string>; redirects?: number; error?: string; type?: string };
const m = vi.hoisted(() => ({
  serve: new Map<string, Served | Served[]>(),
  robots: "" as string | null,
  discovered: [] as string[],
  fetched: [] as { url: string; accept: string; maxBytes: number; opts: Record<string, unknown> }[],
}));
vi.mock("@/server/research/crawl", async (orig) => {
  const actual = await orig<typeof import("@/server/research/crawl")>();
  return {
    ...actual,
    fetchRobots: vi.fn(async () => (m.robots === null ? { txt: null, disallowAll: true } : { txt: m.robots, disallowAll: false })),
    safeFetchBytes: vi.fn(async (url: string, accept: string, maxBytes: number, _s: AbortSignal, _t: number, opts: Record<string, unknown> = {}) => {
      m.fetched.push({ url, accept, maxBytes, opts });
      const hit = m.serve.get(url);
      // A list answers in turn (the last one repeats): a 503 then a 200.
      const s: Served = Array.isArray(hit) ? (hit.length > 1 ? hit.shift()! : hit[0]!) : hit ?? { status: 200, body: "" };
      if (s.error) throw new actual.CrawlError(s.error);
      return {
        url: new URL(url), status: s.status ?? 200, bytes: new TextEncoder().encode(s.body ?? ""), contentType: s.type ?? "text/html",
        truncated: false, headers: new Headers(s.headers), redirects: s.redirects ?? 0,
      };
    }),
  };
});
vi.mock("@/server/catalog/sitemap", async (orig) => ({
  ...(await orig<object>()),
  discoverSiteUrls: vi.fn(async () => ({ urls: m.discovered.map((url) => ({ url, lastmod: null })), complete: true, capped: false })),
}));

import { prisma } from "@/server/db/prisma";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { discoverSiteUrls } from "@/server/catalog/sitemap";
import { claimNextJob } from "@/server/jobs/queue";
import { CRAWL_HOST_SHARE, lastCompleteCrawl, runSiteCrawl, SEO_LINKS_JOB, startSiteCrawl } from "@/server/seo/site-crawl";

let ws: string;
const A = "sc-a";
const B = "sc-b";
const scope = (brandId = A) => ({ workspaceId: ws, brandId });
const day = () => new Date().toISOString().slice(0, 10);
const noSleep = async () => {};
const u = (path: string) => `https://shop.test${path}`;
const page = (...links: string[]) => ({ status: 200, body: links.map((l) => `<a href="${l}">x</a>`).join("") });
const jobs = (brandId = A) => prisma.job.findMany({ where: { type: SEO_LINKS_JOB, brandId }, orderBy: { createdAt: "asc" } });
const crawlOf = async (brandId = A) => (await prisma.siteCrawl.findMany({ where: { brandId }, orderBy: { createdAt: "desc" } }))[0]!;
const rows = async (crawlId: string) => prisma.siteCrawlUrl.findMany({ where: { crawlId }, orderBy: { url: "asc" } });
const row = async (crawlId: string, url: string) => prisma.siteCrawlUrl.findUniqueOrThrow({ where: { crawlId_url: { crawlId, url } } });

/** Starts a cycle and runs its chain until it ends or pauses (at most `max` runs). Returns the crawl. */
async function cycle(brandId = A, max = 10, sleep = noSleep) {
  await startSiteCrawl(scope(brandId));
  for (let i = 0; i < max; i++) {
    const c = await crawlOf(brandId);
    if (c.status !== "RUNNING" || c.pausedUntil) break;
    const job = (await jobs(brandId)).find((j) => (j.payload as { runNo: number }).runNo === c.runNo)!;
    await runSiteCrawl(job.payload, { sleep });
  }
  return crawlOf(brandId);
}

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-site-crawl" } })).id;
  for (const id of [A, B]) await prisma.brand.create({ data: { id, workspaceId: ws, slug: id, displayName: id } });
  for (const id of [A, B]) await prisma.brandProfile.create({ data: { workspaceId: ws, brandId: id, websiteUrl: "https://shop.test" } });
});
beforeEach(async () => {
  for (const t of [prisma.siteCrawl, prisma.job, prisma.rateLimitBucket, prisma.transientEntry]) await (t as typeof prisma.job).deleteMany({});
  await prisma.brandProfile.updateMany({ data: { websiteUrl: "https://shop.test" } });
  Object.assign(m, { robots: "", discovered: [], fetched: [] });
  m.serve.clear();
  vi.mocked(discoverSiteUrls).mockClear();
});

describe("a cycle from the sitemap", () => {
  it("reads every page, checks every link target once, counts who links where, and completes", async () => {
    m.discovered = [u("/"), u("/about")];
    m.serve.set(u("/"), page("/about", "/gone", "https://www.shop.test/moved", "https://other.test/x", "/gone#again"));
    m.serve.set(u("/about"), page("/", "/gone"));
    m.serve.set(u("/gone"), { status: 404 });
    m.serve.set("https://www.shop.test/moved", { status: 200, redirects: 2 });
    const c = await cycle();
    expect(c).toMatchObject({ status: "COMPLETE", pages: 2, targets: 2, checked: 4, discoveryComplete: true, followLinks: false });
    expect((await rows(c.id)).map((r) => [r.url, r.kind, r.outcome, r.carryCount])).toEqual([
      [u("/"), "PAGE", "ok", 1], [u("/about"), "PAGE", "ok", 1], [u("/gone"), "TARGET", "broken", 2], ["https://www.shop.test/moved", "TARGET", "chain", 1],
    ]);
    expect((await row(c.id, u("/gone"))).sources.sort()).toEqual([u("/"), u("/about")]);
    // Pages read in full as HTML, targets with a 1-byte GET; every request same-site only (the SSRF guard per hop).
    expect(m.fetched.map((f) => [f.url, f.accept, f.maxBytes])).toEqual([
      [u("/"), "text/html", 3_000_000], [u("/about"), "text/html", 3_000_000], [u("/gone"), "*/*", 1], ["https://www.shop.test/moved", "*/*", 1],
    ]);
    expect(m.fetched.every((f) => f.opts.sameSite === true)).toBe(true);
    // Its own day cache for the all-pages list; the reader's product list key is left alone.
    expect(await prisma.transientEntry.count({ where: { key: `site-all-pages:shop.test:${day()}` } })).toBe(1);
    expect(await prisma.transientEntry.count({ where: { key: { startsWith: "site-discovery:" } } })).toBe(0);
  });

  it("pauses at least 1 s between requests, the site's Crawl-delay when longer", async () => {
    m.discovered = [u("/a"), u("/b")];
    const sleep = vi.fn(async () => {});
    await cycle(A, 10, sleep);
    expect(sleep.mock.calls).toEqual([[1000], [1000]]);
    m.robots = "User-agent: *\nCrawl-delay: 4";
    await prisma.siteCrawl.deleteMany({});
    await prisma.job.deleteMany({});
    await prisma.transientEntry.deleteMany({});
    sleep.mockClear();
    await cycle(A, 10, sleep);
    expect(sleep.mock.calls).toEqual([[4000], [4000]]);
  });

  it("a 503 is checked again at the end: 503 then 200 is fine, 503 twice is a server error", async () => {
    m.discovered = [u("/")];
    m.serve.set(u("/"), page("/blip", "/down"));
    m.serve.set(u("/blip"), [{ status: 503 }, { status: 200 }]);
    m.serve.set(u("/down"), { status: 503 });
    const c = await cycle();
    expect(c.status).toBe("COMPLETE");
    expect((await row(c.id, u("/blip"))).outcome).toBe("ok");
    expect((await row(c.id, u("/down"))).outcome).toBe("server-error");
  });

  it("robots.txt-disallowed rows are skipped without a request; disallowed links aren't added", async () => {
    m.robots = "User-agent: *\nDisallow: /private";
    m.discovered = [u("/"), u("/private/page")];
    m.serve.set(u("/"), page("/private/other", "/ok"));
    const c = await cycle();
    expect((await row(c.id, u("/private/page"))).outcome).toBe("skipped");
    expect((await rows(c.id)).map((r) => r.url)).not.toContain(u("/private/other"));
    expect(m.fetched.map((f) => f.url)).not.toContain(u("/private/page"));
  });
});

describe("following links when there is no sitemap", () => {
  it("starts from the home page and reads linked pages as pages, ≤ 3 clicks deep", async () => {
    m.serve.set(u("/"), page("/1"));
    m.serve.set(u("/1"), page("/2", "/file.pdf"));
    m.serve.set(u("/2"), page("/3"));
    m.serve.set(u("/3"), page("/4"));
    m.serve.set(u("/4"), page("/5"));
    const c = await cycle();
    expect(c).toMatchObject({ status: "COMPLETE", followLinks: true });
    expect((await rows(c.id)).map((r) => [r.url, r.kind, r.depth])).toEqual([
      [u("/"), "PAGE", 0], [u("/1"), "PAGE", 1], [u("/2"), "PAGE", 2], [u("/3"), "PAGE", 3], [u("/4"), "TARGET", 0], [u("/file.pdf"), "TARGET", 0],
    ]);
  });
});

describe("resuming, stopping and pausing", () => {
  it("a crash mid-run loses only the fetch in flight; the retried run resumes from the rows", async () => {
    m.discovered = [u("/a"), u("/b"), u("/c"), u("/d")];
    await startSiteCrawl(scope());
    const [job] = await jobs();
    let calls = 0;
    const crash = async () => {
      if (++calls === 2) throw new Error("runner died");
    };
    await expect(runSiteCrawl(job!.payload, { sleep: crash })).rejects.toThrow("runner died");
    const c = await crawlOf();
    expect((await rows(c.id)).filter((r) => r.checkedAt).map((r) => r.url)).toEqual([u("/a")]);
    await runSiteCrawl(job!.payload, { sleep: noSleep });
    expect((await crawlOf()).status).toBe("COMPLETE");
    expect(m.fetched.map((f) => f.url)).toEqual([u("/a"), u("/b"), u("/b"), u("/c"), u("/d")]);
  });

  it("the website changed mid-chain: ABANDONED, never reported", async () => {
    m.discovered = [u("/a")];
    await startSiteCrawl(scope());
    await prisma.brandProfile.updateMany({ where: { brandId: A }, data: { websiteUrl: "https://new-shop.test" } });
    await runSiteCrawl((await jobs())[0]!.payload, { sleep: noSleep });
    expect(await crawlOf()).toMatchObject({ status: "ABANDONED", stopReason: "changed" });
    expect(m.fetched).toEqual([]);
    expect(await lastCompleteCrawl(scope())).toEqual({ reason: "none", running: null });
  });

  it("robots.txt unreadable: STOPPED, nothing fetched", async () => {
    m.robots = null;
    m.discovered = [u("/a")];
    const c = await cycle();
    expect(c).toMatchObject({ status: "STOPPED", stopReason: "robots" });
    expect(m.fetched).toEqual([]);
  });

  it("the shared host bucket at 1,000: the crawl stops until tomorrow, uncounted, and the reader still reads", async () => {
    await prisma.rateLimitBucket.create({ data: { key: `site-pages:shop.test:${day()}`, count: CRAWL_HOST_SHARE, windowStart: new Date() } });
    m.discovered = [u("/a")];
    const c = await cycle();
    expect(m.fetched).toEqual([]);
    expect(c).toMatchObject({ status: "RUNNING", stopReason: "budget" });
    expect(c.pausedUntil!.toISOString()).toMatch(/T00:10:00\.000Z$/);
    const next = (await jobs()).at(-1)!;
    expect(next.runAt.getTime()).toBe(c.pausedUntil!.getTime());
    // The refusal rolled back: the reader (limit 1,500) gets its next page.
    expect((await prisma.rateLimitBucket.findUniqueOrThrow({ where: { key: `site-pages:shop.test:${day()}` } })).count).toBe(CRAWL_HOST_SHARE);
    expect((await hitRateLimit(`site-pages:shop.test:${day()}`, 1500, 86_400_000)).allowed).toBe(true);
  });

  it("the brand's daily budget stops the crawl too", async () => {
    await prisma.rateLimitBucket.create({ data: { key: `site-crawl-brand:${A}:${day()}`, count: 1000, windowStart: new Date() } });
    m.discovered = [u("/a")];
    expect(await cycle()).toMatchObject({ status: "RUNNING", stopReason: "budget" });
    expect(m.fetched).toEqual([]);
  });

  it("a 429 with Retry-After pauses the cycle and queues the next run then; the row stays unchecked", async () => {
    m.discovered = [u("/a"), u("/b")];
    m.serve.set(u("/a"), { status: 429, headers: { "retry-after": "120" } });
    const before = Date.now();
    const c = await cycle();
    expect(c).toMatchObject({ status: "RUNNING", stopReason: "pause" });
    expect(c.pausedUntil!.getTime() - before).toBeGreaterThanOrEqual(120_000);
    expect(c.pausedUntil!.getTime() - before).toBeLessThan(130_000);
    expect((await jobs()).at(-1)!.runAt.getTime()).toBe(c.pausedUntil!.getTime());
    expect((await row(c.id, u("/a"))).checkedAt).toBeNull();
    expect(m.fetched.map((f) => f.url)).toEqual([u("/a")]);
  });

  it("five server errors in a row pause the cycle until tomorrow, the rows waiting for their re-check", async () => {
    m.discovered = ["/1", "/2", "/3", "/4", "/5", "/6"].map(u);
    for (const p of m.discovered) m.serve.set(p, { status: 500 });
    const c = await cycle();
    expect(c).toMatchObject({ status: "RUNNING", stopReason: "pause" });
    expect(c.pausedUntil!.toISOString()).toMatch(/T00:10:00\.000Z$/);
    expect(m.fetched).toHaveLength(5);
    expect((await rows(c.id)).filter((r) => r.outcome === "recheck")).toHaveLength(5);
  });

  it("a bot wall (16 of the last 20 answers 401/403) stops the cycle with nothing reported", async () => {
    m.discovered = Array.from({ length: 25 }, (_, i) => u(`/p${i}`));
    for (const p of m.discovered) m.serve.set(p, { status: 403 });
    const c = await cycle();
    expect(c).toMatchObject({ status: "STOPPED", stopReason: "bot-wall" });
    expect(m.fetched).toHaveLength(20);
    expect(await lastCompleteCrawl(scope())).toMatchObject({ reason: "none" });
  });

  it("a run stops for time and the next one is queued a minute later", async () => {
    m.discovered = [u("/a"), u("/b"), u("/c")];
    await startSiteCrawl(scope());
    let t = Date.now();
    const now = () => new Date(t);
    await runSiteCrawl((await jobs())[0]!.payload, { now, sleep: async () => { t += 150_000; } });
    const c = await crawlOf();
    expect(c).toMatchObject({ status: "RUNNING", stopReason: "time", runNo: 2 });
    expect(m.fetched).toHaveLength(2);
    const next = (await jobs()).at(-1)!;
    expect(next.idempotencyKey).toBe(`seo-links:${c.id}:2`);
    expect(next.runAt.getTime()).toBe(t + 60_000);
  });

  it("a retried run (its number now behind) does nothing and queues nothing", async () => {
    m.discovered = [u("/a"), u("/b")];
    await startSiteCrawl(scope());
    const first = (await jobs())[0]!;
    let t = Date.now();
    await runSiteCrawl(first.payload, { now: () => new Date(t), sleep: async () => { t += 300_000; } });
    expect(await jobs()).toHaveLength(2);
    m.fetched = [];
    await runSiteCrawl(first.payload, { sleep: noSleep });
    expect(m.fetched).toEqual([]);
    expect(await jobs()).toHaveLength(2);
  });

  it("another brand's crawl id in a payload does nothing", async () => {
    m.discovered = [u("/a")];
    await startSiteCrawl(scope(A));
    const c = await crawlOf(A);
    await runSiteCrawl({ workspaceId: ws, brandId: B, crawlId: c.id, runNo: 1 }, { sleep: noSleep });
    expect(m.fetched).toEqual([]);
    expect((await crawlOf(A)).status).toBe("RUNNING");
  });
});

describe("startSiteCrawl", () => {
  it("is idempotent: a fresh running cycle gets no second cycle or job", async () => {
    await startSiteCrawl(scope());
    await startSiteCrawl(scope());
    expect(await prisma.siteCrawl.count({ where: { brandId: A } })).toBe(1);
    expect(await jobs()).toHaveLength(1);
  });

  it("queues a cycle again when its chain was lost (no write for a day, not paused)", async () => {
    await startSiteCrawl(scope());
    const c = await crawlOf();
    await prisma.$executeRaw`UPDATE "SiteCrawl" SET "updatedAt" = now() - interval '2 days' WHERE id = ${c.id}`;
    await startSiteCrawl(scope());
    expect((await jobs()).map((j) => j.idempotencyKey)).toEqual([`seo-links:${c.id}:1`, `seo-links:${c.id}:2`]);
    expect((await crawlOf()).runNo).toBe(2);
    // Paused (a pending run is due later): left alone.
    await prisma.$executeRaw`UPDATE "SiteCrawl" SET "updatedAt" = now() - interval '2 days', "pausedUntil" = now() + interval '1 hour' WHERE id = ${c.id}`;
    await startSiteCrawl(scope());
    expect(await jobs()).toHaveLength(2);
  });

  it("ends a cycle past its days as PARTIAL, keeps it and starts afresh; older cycles are pruned", async () => {
    const old = await prisma.siteCrawl.create({ data: { ...scope(), origin: "https://shop.test", startedOn: new Date("2026-01-01"), status: "COMPLETE", finishedAt: new Date("2026-01-02") } });
    const stopped = await prisma.siteCrawl.create({ data: { ...scope(), origin: "https://shop.test", startedOn: new Date("2026-01-05"), status: "STOPPED", finishedAt: new Date("2026-01-05") } });
    const running = await prisma.siteCrawl.create({ data: { ...scope(), origin: "https://shop.test", startedOn: new Date(Date.now() - 7 * 86_400_000), runNo: 3 } });
    await startSiteCrawl(scope());
    const left = await prisma.siteCrawl.findMany({ where: { brandId: A }, orderBy: { createdAt: "asc" } });
    expect(left.map((c) => c.id)).not.toContain(old.id);
    expect(left.map((c) => c.id)).not.toContain(stopped.id);
    expect(left.find((c) => c.id === running.id)).toMatchObject({ status: "PARTIAL", stopReason: "too-old" });
    expect(left.filter((c) => c.status === "RUNNING")).toHaveLength(1);
  });

  it("does nothing without a website", async () => {
    await prisma.brandProfile.updateMany({ where: { brandId: A }, data: { websiteUrl: null } });
    await startSiteCrawl(scope());
    expect(await prisma.siteCrawl.count()).toBe(0);
  });
});

describe("lastCompleteCrawl", () => {
  const finished = (data: Record<string, unknown> = {}) =>
    prisma.siteCrawl.create({ data: { ...scope(), origin: "https://shop.test", startedOn: new Date(), status: "COMPLETE", finishedAt: new Date(), ...data } });

  it("the latest fresh COMPLETE or PARTIAL cycle of the current site, with its rows", async () => {
    const c = await finished({ status: "PARTIAL" });
    await prisma.siteCrawlUrl.create({ data: { crawlId: c.id, url: u("/gone"), kind: "TARGET", outcome: "broken", status: 404, carryCount: 1, sources: [u("/")] } });
    const got = await lastCompleteCrawl(scope());
    expect("crawl" in got && got.crawl.id).toBe(c.id);
    expect("crawl" in got && got.rows.map((r) => r.url)).toEqual([u("/gone")]);
  });

  it("stale past 14 days, changed when the website moved, with the running cycle's progress", async () => {
    await finished({ finishedAt: new Date(Date.now() - 15 * 86_400_000) });
    await prisma.siteCrawl.create({ data: { ...scope(), origin: "https://shop.test", startedOn: new Date(), pages: 7, checked: 3 } });
    expect(await lastCompleteCrawl(scope())).toEqual({ reason: "stale", running: { pages: 7, checked: 3 } });
    await prisma.siteCrawl.deleteMany({});
    await prisma.job.deleteMany({});
    await finished();
    await prisma.brandProfile.updateMany({ where: { brandId: A }, data: { websiteUrl: "https://elsewhere.test" } });
    expect(await lastCompleteCrawl(scope())).toEqual({ reason: "changed", running: null });
    // www. and the bare host are one site.
    await prisma.brandProfile.updateMany({ where: { brandId: A }, data: { websiteUrl: "https://www.shop.test/fr" } });
    expect("crawl" in (await lastCompleteCrawl(scope()))).toBe(true);
  });
});

describe("the queue slot shared with the site reader", () => {
  it("with catalog.pages running, seo.links isn't claimed (and the reverse); other jobs still are", async () => {
    const live = new Date(Date.now() + 60_000);
    const due = new Date(Date.now() - 1000);
    await prisma.job.create({ data: { type: "catalog.pages", payload: {}, status: "RUNNING", leasedUntil: live, idempotencyKey: "reader" } });
    const links = await prisma.job.create({ data: { type: SEO_LINKS_JOB, payload: {}, runAt: due, idempotencyKey: "links" } });
    const other = await prisma.job.create({ data: { type: "tasks.from-report", payload: {}, runAt: new Date(Date.now() - 500), idempotencyKey: "other" } });
    expect((await claimNextJob("w1"))?.id).toBe(other.id);
    expect(await claimNextJob("w1")).toBeNull();
    await prisma.job.updateMany({ where: { idempotencyKey: "reader" }, data: { status: "COMPLETED" } });
    expect((await claimNextJob("w1"))?.id).toBe(links.id);
    await prisma.job.create({ data: { type: "catalog.pages", payload: {}, runAt: due, idempotencyKey: "reader-2" } });
    expect(await claimNextJob("w1")).toBeNull();
  });
});
