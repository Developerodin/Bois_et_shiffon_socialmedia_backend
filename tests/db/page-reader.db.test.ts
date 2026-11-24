import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The site reader (catalog.pages) against Postgres, with the network faked: robots.txt, discovery and page fetches
 * are stubs, so nothing here reaches a real site.
 */
type Served = { status: number; body?: string; url?: string; headers?: Record<string, string> };
const m = vi.hoisted(() => ({
  serve: new Map<string, Served>(),
  robots: "",
  discovered: { urls: [] as { url: string; lastmod: Date | null }[], complete: false, capped: false },
  fetched: [] as { url: string; headers: Record<string, string> }[],
  delayMs: 0,
  inFlight: 0,
  maxInFlight: 0,
  onFetch: null as null | ((url: string) => Promise<void>),
}));
vi.mock("@/server/research/crawl", async (orig) => ({
  ...(await orig<object>()),
  fetchRobots: vi.fn(async () => ({ txt: m.robots, disallowAll: false })),
  safeFetchBytes: vi.fn(async (url: string, _a: string, _b: number, _s: AbortSignal, _t: number, headers: Record<string, string> = {}) => {
    m.fetched.push({ url, headers });
    await m.onFetch?.(url);
    m.inFlight++;
    m.maxInFlight = Math.max(m.maxInFlight, m.inFlight);
    await new Promise((r) => setTimeout(r, m.delayMs));
    m.inFlight--;
    const s = m.serve.get(url) ?? { status: 500 };
    return { url: new URL(s.url ?? url), status: s.status, bytes: new TextEncoder().encode(s.body ?? ""), contentType: "text/html", truncated: false, headers: new Headers(s.headers) };
  }),
  safeFetch: vi.fn(async (url: string) => ({ url: new URL(url), status: 404, body: "", contentType: "text/html" })),
}));
vi.mock("@/server/catalog/sitemap", async (orig) => ({ ...(await orig<object>()), discoverProductUrls: vi.fn(async () => m.discovered) }));

import { prisma } from "@/server/db/prisma";
import { readSitePages } from "@/server/catalog/page-reader";
import { discoverProductUrls } from "@/server/catalog/sitemap";
import { runCatalogSync, startPageChain } from "@/server/catalog/sync";
import { claimNextJob } from "@/server/jobs/queue";

let ws: string;
const day = () => new Date().toISOString().slice(0, 10);
const scope = (brandId = "pr-a") => ({ workspaceId: ws, brandId });
const payload = (brandId = "pr-a", step = 1) => ({ workspaceId: ws, brandId, day: day(), step });
const noSleep = async () => {};
const url = (n: number | string) => `https://shop.test/p/${n}`;
const html = (...skus: string[]) => skus.map((sku) =>
  `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Chair ${sku}","sku":"${sku}","offers":{"@type":"Offer","price":"10","priceCurrency":"EUR","availability":"https://schema.org/InStock"}}</script>`).join("");
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
const addPage = (n: number | string, data: Record<string, unknown> = {}, brandId = "pr-a") =>
  prisma.catalogPage.create({ data: { workspaceId: ws, brandId, url: url(n), ...data } });
const addProduct = (sku: string, brandId = "pr-a", source: "SITE" | "WEBSITE" = "SITE") =>
  prisma.product.create({ data: { workspaceId: ws, brandId, source, externalId: `sku:${sku}`, title: sku, inStock: true, stockCheckedAt: daysAgo(3) } });
const live = async (brandId = "pr-a") =>
  (await prisma.product.findMany({ where: { brandId, archivedAt: null }, orderBy: { externalId: "asc" } })).map((p) => `${p.source}:${p.externalId}`);
const sync = async (brandId = "pr-a") => (await prisma.brandProfile.findUnique({ where: { brandId } }))?.catalogSync as Record<string, unknown>;
const connectShopify = () => prisma.integrationConnection.create({
  data: { workspaceId: ws, brandId: "pr-a", provider: "SHOPIFY", externalAccountId: "s.myshopify.com", displayName: "S", scopes: [], credentialKeyVersion: 1, connectedByUserId: "u" },
});
const nextSteps = (brandId = "pr-a") => prisma.job.findMany({ where: { type: "catalog.pages", brandId } });

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-page-reader" } })).id;
  for (const id of ["pr-a", "pr-b"]) await prisma.brand.create({ data: { id, workspaceId: ws, slug: id, displayName: id } });
});
beforeEach(async () => {
  for (const t of [prisma.catalogPage, prisma.product, prisma.job, prisma.rateLimitBucket, prisma.integrationConnection, prisma.brandProfile, prisma.auditEvent]) await (t as typeof prisma.job).deleteMany({});
  for (const id of ["pr-a", "pr-b"]) {
    await prisma.brandProfile.create({ data: { workspaceId: ws, brandId: id, websiteUrl: "https://shop.test", catalogSync: { at: "x", source: "SITE", count: 0, error: null } } });
  }
  Object.assign(m, { robots: "", discovered: { urls: [], complete: false, capped: false }, fetched: [], delayMs: 0, inFlight: 0, maxInFlight: 0, onFetch: null });
  vi.mocked(discoverProductUrls).mockClear();
  m.serve.clear();
});

describe("one chain per brand, budgets and the host lock", () => {
  it("two runs for one brand at once: one reads, the other ends without queuing anything", async () => {
    await addPage(1);
    await addPage(2);
    m.delayMs = 30;
    await Promise.all([readSitePages(payload(), noSleep), readSitePages({ ...payload(), manual: 1 }, noSleep)]);
    expect(m.fetched.map((f) => f.url).sort()).toEqual([url(1), url(2)]);
    expect(await nextSteps()).toEqual([]);
    expect(await prisma.auditEvent.count({ where: { brandId: "pr-a", action: "catalog.pages" } })).toBe(1);
  });

  it("the queue runs one catalog.pages job at a time", async () => {
    for (const k of ["q1", "q2"]) await prisma.job.create({ data: { type: "catalog.pages", payload: {}, idempotencyKey: k, runAt: new Date(Date.now() - 1000) } });
    expect((await claimNextJob("w1"))?.type).toBe("catalog.pages");
    expect(await claimNextJob("w2")).toBeNull();
  });

  it("the brand's daily budget stops the run, counted from the pages tried today", async () => {
    await prisma.catalogPage.createMany({ data: Array.from({ length: 1000 }, (_, i) => ({ workspaceId: ws, brandId: "pr-a", url: url(`t${i}`), triedAt: new Date(), readAt: new Date() })) });
    await addPage(1);
    await readSitePages(payload(), noSleep);
    expect(m.fetched).toEqual([]);
    expect(await nextSteps()).toEqual([]); // the chain ends for the day
    expect(await sync()).toMatchObject({ source: "SITE", reason: "reading", pages: { read: 1000, total: 1001 } });
  });

  it("the host's daily budget stops the run", async () => {
    await prisma.rateLimitBucket.create({ data: { key: `site-pages:shop.test:${day()}`, count: 1500, windowStart: new Date() } });
    await addPage(1);
    await readSitePages(payload(), noSleep);
    expect(m.fetched).toEqual([]);
  });

  it("two brands on one host never fetch at once: the second finds the host busy and tries again in a minute", async () => {
    for (const b of ["pr-a", "pr-b"]) for (const n of [1, 2, 3]) await addPage(`${b}-${n}`, {}, b);
    m.delayMs = 50;
    await Promise.all([readSitePages(payload("pr-a"), noSleep), readSitePages(payload("pr-b"), noSleep)]);
    expect(m.maxInFlight).toBe(1);
    const steps = [...(await nextSteps("pr-a")), ...(await nextSteps("pr-b"))];
    expect(steps.map((j) => j.idempotencyKey)).toEqual([expect.stringMatching(/^catalog-pages:pr-[ab]:\d{4}-\d{2}-\d{2}:2$/)]);
    expect(steps[0]!.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("pauses at least 1 s between pages, the site's Crawl-delay when longer", async () => {
    await addPage(1);
    await addPage(2);
    const sleep = vi.fn(async () => {});
    await readSitePages(payload(), sleep);
    expect(sleep.mock.calls).toEqual([[1000], [1000]]);
    m.robots = "User-agent: *\nCrawl-delay: 4";
    await prisma.catalogPage.updateMany({ data: { triedAt: null, readAt: null } });
    sleep.mockClear();
    await readSitePages(payload(), sleep);
    expect(sleep.mock.calls).toEqual([[4000], [4000]]);
  });
});

describe("what a page's answer does", () => {
  it("404 archives only the products no other page produces", async () => {
    await addPage(1, { readAt: daysAgo(8), productKeys: ["sku:1", "sku:2"] });
    await addPage(2, { readAt: daysAgo(1), productKeys: ["sku:2"] });
    await addProduct("1");
    await addProduct("2");
    m.serve.set(url(1), { status: 404 });
    await readSitePages(payload(), noSleep);
    expect(m.fetched.map((f) => f.url)).toEqual([url(1)]);
    expect(await live()).toEqual(["SITE:sku:2"]);
    expect(await prisma.catalogPage.findFirst({ where: { url: url(1) } })).toMatchObject({ state: "gone", productKeys: [] });
  });

  it("403 stops the chain without archiving or marking the page", async () => {
    await addPage(1, { readAt: daysAgo(9), productKeys: ["sku:1"] });
    await addPage(2, { readAt: daysAgo(8) });
    await addProduct("1");
    m.serve.set(url(1), { status: 403 });
    await readSitePages(payload(), noSleep);
    expect(m.fetched).toHaveLength(1);
    expect(await live()).toEqual(["SITE:sku:1"]);
    expect((await prisma.catalogPage.findFirst({ where: { url: url(1) } }))?.triedAt).toBeNull();
    expect(await sync()).toMatchObject({ reason: "site-refused" });
    expect(await nextSteps()).toEqual([]);
  });

  it("a failed page is tried once a day", async () => {
    await addPage(1);
    m.serve.set(url(1), { status: 500 });
    await readSitePages(payload(), noSleep);
    await readSitePages(payload(), noSleep);
    expect(m.fetched).toHaveLength(1);
    expect(await prisma.catalogPage.findFirst({ where: { url: url(1) } })).toMatchObject({ state: "failed", readAt: null });
  });

  it("200 saves the page's products; a later 304 (asked with its validators) keeps them and stamps their stock", async () => {
    await addPage(1);
    m.serve.set(url(1), { status: 200, body: html("1", "2"), headers: { etag: '"v1"', "last-modified": "Mon, 23 Nov 2026 10:00:00 GMT" } });
    await readSitePages(payload(), noSleep);
    expect(await live()).toEqual(["SITE:sku:1", "SITE:sku:2"]);
    expect(await prisma.catalogPage.findFirst({ where: { url: url(1) } })).toMatchObject({ state: "ok", productKeys: ["sku:1", "sku:2"], etag: '"v1"' });

    await prisma.catalogPage.updateMany({ data: { readAt: daysAgo(8), triedAt: daysAgo(8) } });
    await prisma.product.updateMany({ data: { stockCheckedAt: daysAgo(8) } });
    m.serve.set(url(1), { status: 304 });
    await readSitePages(payload(), noSleep);
    expect(m.fetched[1]!.headers).toEqual({ "if-none-match": '"v1"', "if-modified-since": "Mon, 23 Nov 2026 10:00:00 GMT" });
    expect(await live()).toEqual(["SITE:sku:1", "SITE:sku:2"]);
    const products = await prisma.product.findMany({ where: { brandId: "pr-a" } });
    expect(products.every((p) => p.stockCheckedAt!.getTime() > Date.now() - 60_000)).toBe(true);
    expect((await prisma.catalogPage.findFirst({ where: { url: url(1) } }))!.readAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("a page that listed products and now shows none keeps them; most of a batch doing so stops the run", async () => {
    for (const n of [1, 2, 3, 4]) {
      await addPage(n, { readAt: daysAgo(8 + n), productKeys: [`sku:${n}`] });
      await addProduct(`${n}`);
      m.serve.set(url(n), { status: 200, body: n === 4 ? html("4") : "<html>Checking your browser</html>" });
    }
    await readSitePages(payload(), noSleep);
    expect(await live()).toEqual(["SITE:sku:1", "SITE:sku:2", "SITE:sku:3", "SITE:sku:4"]);
    expect(await prisma.catalogPage.findFirst({ where: { url: url(1) } })).toMatchObject({ state: "failed", productKeys: ["sku:1"] });
    expect(await sync()).toMatchObject({ reason: "site-refused" });
    expect(await nextSteps()).toEqual([]);
  });

  it("a page robots.txt now disallows is set aside for a week without spending budget", async () => {
    await addPage(1);
    m.robots = "User-agent: *\nDisallow: /p/1";
    m.discovered = { urls: [{ url: url(1), lastmod: null }], complete: true, capped: false };
    await readSitePages(payload("pr-a", 0), noSleep);
    expect(m.fetched).toEqual([]);
    const page = await prisma.catalogPage.findFirst({ where: { url: url(1) } });
    expect(page).toMatchObject({ state: "disallowed", triedAt: null });
    expect(page?.readAt).not.toBeNull();
  });

  it("a redirect to another host is not parsed", async () => {
    await addPage(1);
    m.serve.set(url(1), { status: 200, body: html("1"), url: "https://elsewhere.test/p/1" });
    await readSitePages(payload(), noSleep);
    expect(await live()).toEqual([]);
    expect(await prisma.catalogPage.findFirst({ where: { url: url(1) } })).toMatchObject({ state: "failed", readAt: null });
  });
});

describe("the chain", () => {
  it("step 0 discovers; a complete read of every page archives the old feed's rows and records the result", async () => {
    await addProduct("old", "pr-a", "WEBSITE");
    m.discovered = { urls: [{ url: url(1), lastmod: null }], complete: true, capped: false };
    m.serve.set(url(1), { status: 200, body: html("1") });
    await readSitePages(payload("pr-a", 0), noSleep);
    expect(await live()).toEqual(["SITE:sku:1"]);
    expect(await sync()).toMatchObject({ source: "SITE", count: 1, pages: { read: 1, total: 1, capped: false }, reason: null, error: null });
    expect(await prisma.auditEvent.findFirst({ where: { brandId: "pr-a", action: "catalog.pages" } })).toMatchObject({ metadata: { pagesRead: 1, stopped: "done" } });
  });

  it("a Shopify connection stops the chain before it reads", async () => {
    await addPage(1, { readAt: daysAgo(8), etag: '"v1"' });
    await connectShopify();
    await readSitePages(payload(), noSleep);
    expect(m.fetched).toEqual([]);
  });

  it("Shopify connected mid-run: the chain neither brings SITE rows back nor archives the new SHOPIFY rows", async () => {
    await addPage(1);
    m.discovered = { urls: [{ url: url(1), lastmod: null }], complete: true, capped: false };
    m.serve.set(url(1), { status: 200, body: html("1") });
    m.onFetch = async () => {
      await connectShopify();
      await prisma.product.create({ data: { workspaceId: ws, brandId: "pr-a", source: "SHOPIFY", externalId: "gid://shopify/ProductVariant/1", title: "S" } });
    };
    await readSitePages(payload("pr-a", 0), noSleep);
    expect(await live()).toEqual(["SHOPIFY:gid://shopify/ProductVariant/1"]);
    expect(await prisma.auditEvent.count({ where: { brandId: "pr-a" } })).toBe(0);
  });

  it("a SITE brand whose feed answers moves to it: SITE rows archived and what was read forgotten", async () => {
    await addPage(1, { readAt: daysAgo(1), etag: '"v1"', productKeys: ["sku:1"] });
    await addProduct("1");
    m.serve.set("https://shop.test/products.json?limit=250&page=1", { status: 200, body: JSON.stringify({ products: [{ title: "Chair", handle: "chair", variants: [{ id: 7, price: "10" }] }] }) });
    await runCatalogSync(scope());
    expect(await live()).toEqual(["WEBSITE:7"]);
    expect(await prisma.catalogPage.findFirst({ where: { url: url(1) } })).toMatchObject({ readAt: null, etag: null });
    expect(await sync()).toMatchObject({ source: "WEBSITE" });
  });

  it("a SITE brand whose feed URL answers 403 for a day stays SITE and keeps what was read", async () => {
    await addPage(1, { readAt: daysAgo(1), etag: '"v1"' });
    m.serve.set("https://shop.test/products.json?limit=250&page=1", { status: 403 });
    await runCatalogSync(scope());
    expect(await sync()).toMatchObject({ source: "SITE", reason: "reading", pages: { read: 1, total: 1 } });
    expect(await prisma.catalogPage.findFirst({ where: { url: url(1) } })).toMatchObject({ etag: '"v1"' });
    expect(await nextSteps()).toHaveLength(1);
  });

  it("a failed feed check keeps a SITE brand's progress on screen", async () => {
    await addPage(1, { readAt: daysAgo(1) });
    m.serve.set("https://shop.test/products.json?limit=250&page=1", { status: 503 });
    await expect(runCatalogSync(scope())).rejects.toThrow();
    expect(await sync()).toMatchObject({ source: "SITE", reason: "failed", pages: { read: 1, total: 1 } });
  });

  it("yesterday's pending step neither blocks today's chain nor reads", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await prisma.job.create({ data: { type: "catalog.pages", workspaceId: ws, brandId: "pr-a", payload: { ...payload(), day: yesterday }, idempotencyKey: `catalog-pages:pr-a:${yesterday}:3` } });
    await startPageChain(scope(), day());
    expect((await nextSteps()).map((j) => j.idempotencyKey)).toContain(`catalog-pages:pr-a:${day()}:0`);
    await addPage(1);
    await readSitePages({ ...payload(), day: yesterday }, noSleep);
    expect(m.fetched).toEqual([]);
  });

  it("a chain started again the same day doesn't run discovery again", async () => {
    m.discovered = { urls: [{ url: url(1), lastmod: null }], complete: true, capped: false };
    m.serve.set(url(1), { status: 200, body: html("1") });
    await readSitePages(payload("pr-a", 0), noSleep);
    await readSitePages({ ...payload("pr-a", 0), manual: 1 }, noSleep);
    expect(discoverProductUrls).toHaveBeenCalledTimes(1);
  });

  it("Sync now after today's chain stopped starts a new chain under a manual key", async () => {
    await startPageChain(scope(), day());
    const first = (await nextSteps())[0]!;
    expect(first.idempotencyKey).toBe(`catalog-pages:pr-a:${day()}:0`);
    await startPageChain(scope(), day()); // still queued: nothing new
    expect(await nextSteps()).toHaveLength(1);
    await prisma.job.update({ where: { id: first.id }, data: { status: "COMPLETED" } });
    await startPageChain(scope(), day());
    await prisma.job.updateMany({ where: { brandId: "pr-a" }, data: { status: "COMPLETED" } });
    await startPageChain(scope(), day());
    expect((await nextSteps()).map((j) => j.idempotencyKey).sort()).toEqual(
      [`catalog-pages:pr-a:${day()}:0`, `catalog-pages:pr-a:${day()}:manual:1:0`, `catalog-pages:pr-a:${day()}:manual:2:0`]);
  });

  it("a run that crashes mid-batch resumes without duplicates", async () => {
    for (let n = 0; n < 30; n++) {
      await addPage(n);
      m.serve.set(url(n), { status: 200, body: html(`${n}`) });
    }
    let calls = 0;
    const crashing = async () => { if (++calls === 28) throw new Error("killed"); };
    await expect(readSitePages(payload(), crashing)).rejects.toThrow("killed");
    expect(await prisma.product.count({ where: { brandId: "pr-a" } })).toBe(25); // the first batch committed, the second didn't
    await readSitePages(payload(), noSleep);
    expect(await prisma.product.count({ where: { brandId: "pr-a" } })).toBe(30);
    expect(await prisma.catalogPage.count({ where: { brandId: "pr-a", readAt: null } })).toBe(0);
  });

  it("leaves another brand's pages and products alone", async () => {
    await addPage(1, { readAt: daysAgo(8), productKeys: ["sku:1"] });
    await addProduct("1");
    await addPage(1, { readAt: daysAgo(8), productKeys: ["sku:1"] }, "pr-b");
    await addProduct("1", "pr-b");
    m.serve.set(url(1), { status: 404 });
    await readSitePages(payload("pr-a"), noSleep);
    expect(await live("pr-a")).toEqual([]);
    expect(await live("pr-b")).toEqual(["SITE:sku:1"]);
    expect(await prisma.catalogPage.findFirst({ where: { brandId: "pr-b" } })).toMatchObject({ productKeys: ["sku:1"], state: null, triedAt: null });
  });
});
