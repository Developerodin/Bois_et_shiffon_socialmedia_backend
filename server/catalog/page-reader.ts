import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { pageProducts } from "@/server/catalog/page-product";
import { discoverProductUrls, syncCatalogPages, type Discovery } from "@/server/catalog/sitemap";
import {
  CATALOG_PAGES_JOB, catalogSource, pagesKey, READING, record, saveRows, siteProgress, withCatalogLock,
  type Note, type SyncedRow,
} from "@/server/catalog/sync";
import { prisma } from "@/server/db/prisma";
import { getTransient, putTransient } from "@/server/db/transient";
import { enqueueJob } from "@/server/jobs/queue";
import { fetchRobots, ROBOTS_AGENT, robotsAllows, robotsRules, safeFetchBytes } from "@/server/research/crawl";

/**
 * The site reader (job catalog.pages, docs/superpowers/plans/2026-11-24-product-import.md Task 8): for a brand whose
 * website has no product feed (catalogSource SITE), reads the product pages its sitemap lists, a little each day.
 * A day's work is a chain of runs of at most 4 minutes; each run queues the next as its last write, so a crash
 * resumes from the pages' own state (CatalogPage readAt/triedAt/state), never from the job. Step 0 also runs discovery.
 *
 * Politeness: robots.txt read once a day per host (a failed one, after one retry, stops the chain); the sitemaps
 * once a day per host, whichever brands share it; one page request at a time per host (www ignored), ≥ 1 s apart or
 * the site's Crawl-delay up to 10 s; 1,000 pages per brand and 1,500 per host per UTC day; conditional requests
 * (304 = no body). 401/403/429 stop the chain for the day and archive nothing.
 * Archiving: a SITE product is archived only when no page of the brand produces it any more: its page left a complete
 * sitemap, answered 404/410 on two different days, failed on three different days, or dropped it while still listing
 * others. A page that listed products and suddenly shows none only counts as failing (a bot challenge or a template
 * change looks the same), and when most of a batch does that, or 404s, the run stops without archiving. The brand's
 * WEBSITE/SHOPIFY rows go only once every page of a complete discovery is settled.
 *
 * ponytail: one runner (claimNextJob caps catalog.pages and seo.links at 1 together), ~1,000 pages × ~1.5 s ≈ 25 min per brand per day, so
 * ~55 brands a day at full budget; past that raise the cap or read different hosts in parallel. Bandwidth ~400 MB per
 * brand per day on a first fill (3 MB page cap), mostly 304s after. The host lock and spacing cover page reads only:
 * robots.txt and the sitemaps are fetched outside it (once a day per host). A run uses up to three pooled connections
 * at once (the brand lock, the host lock, a save): docs/DEPLOY_EC2.md.
 */
export const RUN_MS = 240_000;
const BATCH = 25;
const BRAND_PAGES_PER_DAY = 1000;
export const HOST_PAGES_PER_DAY = 1500;
export const PAGE_BYTES = 3_000_000;
export const PAGE_TIMEOUT_MS = 30_000;
const REFRESH_MS = 7 * 86_400_000;
export const DAY_MS = 86_400_000;
// The catalogue lock wait for a batch save: an import or the daily sync can hold it a while.
const LOCK_WAIT_MS = 120_000;
// A page failing (an error, or empty after listing products) on this many different days is given up on ("dead").
const DEAD_AFTER_DAYS = 3;
// Keys per archive statement.
const ARCHIVE_CHUNK = 500;

const SITE_REFUSED: Note = { error: "Your website turned our product reader away, so we stopped reading its product pages. Connect Shopify, import a file or add products by hand.", reason: "site-refused" };
const NO_PRODUCT_PAGES: Note = { error: "We couldn't find product pages in your website's sitemap. Connect Shopify, import a file or add products by hand.", reason: "no-product-pages" };
// Pages that listed products now show none or 404 (a bot challenge, maintenance, a new template): nothing archived, tomorrow again.
const PAGES_CHANGED: Note = { error: "Your website's product pages stopped showing product details we can read, so we paused reading them. We'll try again tomorrow.", reason: "pages-changed" };
// A batch stops the run when more than half of its pages that listed products come back empty or missing, and at least this many do.
const EMPTIED_MIN = 3;

/** Pause after each page read: at least 1 s, the site's Crawl-delay when longer, never more than 10 s. */
export const spacingMs = (crawlDelay: number | null) => Math.min(10, Math.max(1, crawlDelay ?? 1)) * 1000;

const Payload = z.object({
  workspaceId: z.string(),
  brandId: z.string(),
  /** The UTC day the chain reads for (its budget); a chain still going the next day stops. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  step: z.number().int().min(0),
  manual: z.number().int().positive().optional(),
  /** Carried along the chain: pages read so far, and what step 0's discovery said. */
  read: z.number().int().min(0).default(0),
  complete: z.boolean().default(false),
  capped: z.boolean().default(false),
});
type Chain = z.infer<typeof Payload>;
type Scope = { workspaceId: string; brandId: string };
type Page = { id: string; url: string; etag: string | null; modifiedAt: string | null; productKeys: string[]; state: string | null };
type Outcome =
  | { page: Page; kind: "read"; rows: SyncedRow[]; etag: string | null; modifiedAt: string | null }
  /** notFound: 404/410. `held`: the batch looked like a site change, so it only counts as a failure. */
  | { page: Page; kind: "unchanged" | "notFound" | "disallowed"; held?: boolean }
  /** `emptied`: a 200 without the products this page listed before (kept, not archived). */
  | { page: Page; kind: "failed"; emptied?: boolean };
/** Why a run ended: "time" and "busy" (another brand reads this host) carry on in a minute; the rest end the chain. */
type Stop = "time" | "busy" | "budget" | "refused" | "done" | "robots" | "changed";

/** The brand stopped reading from its product pages (Shopify connected, or a feed saved), seen under the catalogue lock. */
class Moved extends Error {}
async function stillSite(tx: Prisma.TransactionClient, scope: Scope) {
  if ((await catalogSource(scope, tx)).source !== "SITE") throw new Moved();
}

/** The host as the reader keys its lock, budget and caches: lower case, `www.` dropped (shared with seo.links). */
export const siteHost = (origin: string) => new URL(origin).hostname.toLowerCase().replace(/^www\./, "");
/** Days in a row a page has failed, from its state ("failed:<n>"; a first 404 counts as one). */
const failedDays = (state: string | null) => (state === "missing" ? 1 : Number(/^failed:(\d+)$/.exec(state ?? "")?.[1] ?? 0));
/** A 404/410 or an empty page that used to list products: what may mean the site changed, not the catalogue. */
const suspect = (o: Outcome) => o.page.productKeys.length > 0 && ((o.kind === "failed" && !!o.emptied) || o.kind === "notFound");

/**
 * Pages due, at most BATCH: never read, then lastmod newer than the read, then read over 7 days ago; never one already
 * tried this day (a failed page waits for tomorrow). Times as text → timestamp(3): the columns hold UTC without a zone.
 */
function duePages(scope: Scope, dayStart: Date) {
  const day = dayStart.toISOString();
  const stale = new Date(Date.now() - REFRESH_MS).toISOString();
  return prisma.$queryRaw<Page[]>`
    SELECT id, url, etag, "modifiedAt", "productKeys", state FROM "CatalogPage"
    WHERE "workspaceId" = ${scope.workspaceId} AND "brandId" = ${scope.brandId}
      AND ("triedAt" IS NULL OR "triedAt" < ${day}::timestamp(3))
      AND ("readAt" IS NULL OR lastmod > "readAt" OR "readAt" < ${stale}::timestamp(3))
    ORDER BY CASE WHEN "readAt" IS NULL THEN 0 WHEN lastmod > "readAt" THEN 1 ELSE 2 END, "readAt" NULLS FIRST, lastmod DESC NULLS LAST, url
    LIMIT ${BATCH}`;
}

/**
 * `fn` while holding the host's lock, or "busy" when another run holds it. A transaction-scoped advisory lock (not the
 * session pg_try_advisory_lock), so a pooled connection can't keep it: it ends with the transaction, whatever happens.
 * The transaction holds one connection for the fetch and the pause after it (≤ ~40 s); `fn` gets it for its queries.
 */
export const BUSY = Symbol("busy");
export function onHost<T>(host: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T | typeof BUSY> {
  return prisma.$transaction(async (tx) => {
    const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('host:' || ${host})) AS locked`;
    return locked ? fn(tx) : BUSY;
  }, { maxWait: 10_000, timeout: PAGE_TIMEOUT_MS + 30_000 });
}

/** A validator header worth sending back: absent or absurdly long → none (a cut one would never match). */
const validator = (v: string | null) => (v && v.length <= 500 ? v : null);

/**
 * SITE products with these keys that no page of the brand produces any more, archived, ARCHIVE_CHUNK keys a statement.
 * Run after the pages' new productKeys are written, in the same transaction.
 */
async function archiveUnproduced(tx: Prisma.TransactionClient, scope: Scope, keys: string[]) {
  const unique = [...new Set(keys)];
  const at = new Date().toISOString();
  for (let i = 0; i < unique.length; i += ARCHIVE_CHUNK) {
    await tx.$executeRaw`
      UPDATE "Product" p SET "archivedAt" = ${at}::timestamp(3), "updatedAt" = ${at}::timestamp(3)
      WHERE p."workspaceId" = ${scope.workspaceId} AND p."brandId" = ${scope.brandId} AND p.source = 'SITE'::"ProductSource"
        AND p."archivedAt" IS NULL AND p."externalId" = ANY(${unique.slice(i, i + ARCHIVE_CHUNK)}::text[])
        AND NOT EXISTS (
          SELECT 1 FROM "CatalogPage" c
          WHERE c."workspaceId" = p."workspaceId" AND c."brandId" = p."brandId" AND p."externalId" = ANY(c."productKeys"))`;
  }
}

/** A page given up on: settled for a week (readAt), its products archived unless another page holds them. */
const settled = (now: Date, state: string) => ({ readAt: now, triedAt: now, productKeys: [], state, etag: null, modifiedAt: null });

/**
 * One batch's results under the catalogue lock: rows saved (keys mode, never archiving), the pages' state written,
 * a 304's products stamped fresh, then products no page produces any more archived.
 */
function saveBatch(scope: Scope, outcomes: Outcome[]) {
  const now = new Date();
  const rows = outcomes.flatMap((o) => (o.kind === "read" ? o.rows : []));
  return withCatalogLock(scope, LOCK_WAIT_MS, async (tx) => {
    // A sync that moved the brand saved under this lock first: writing SITE rows now would bring them back.
    await stillSite(tx, scope);
    if (rows.length) await saveRows(tx, scope, "SITE", { rows, complete: false }, { keys: [...new Set(rows.map((r) => r.externalId))] });
    const removed: string[] = [];
    const confirmed: string[] = [];
    for (const o of outcomes) {
      const where = { id: o.page.id, workspaceId: scope.workspaceId, brandId: scope.brandId };
      const failing = o.kind === "failed" || (o.kind === "notFound" && o.held);
      if (failing) {
        const days = failedDays(o.page.state) + 1;
        if (days >= DEAD_AFTER_DAYS) {
          removed.push(...o.page.productKeys);
          await tx.catalogPage.updateMany({ where, data: settled(now, "dead") });
        } else {
          await tx.catalogPage.updateMany({ where, data: { triedAt: now, state: `failed:${days}` } });
        }
      } else if (o.kind === "notFound" && o.page.productKeys.length && o.page.state !== "missing") {
        // A first 404/410 for a page that listed products: kept until it says so again on another day.
        await tx.catalogPage.updateMany({ where, data: { triedAt: now, state: "missing" } });
      } else if (o.kind === "notFound") {
        removed.push(...o.page.productKeys);
        await tx.catalogPage.updateMany({ where, data: settled(now, "gone") });
      } else if (o.kind === "disallowed") {
        // robots.txt forbids it now: left alone for a week (no budget spent); a complete discovery drops it.
        await tx.catalogPage.updateMany({ where, data: { readAt: now, state: "disallowed" } });
      } else if (o.kind === "unchanged") {
        confirmed.push(...o.page.productKeys);
        await tx.catalogPage.updateMany({ where, data: { readAt: now, triedAt: now, state: o.page.productKeys.length ? "ok" : "no-product" } });
      } else if (o.kind === "read") {
        const keys = [...new Set(o.rows.map((r) => r.externalId))];
        removed.push(...o.page.productKeys.filter((k) => !keys.includes(k)));
        await tx.catalogPage.updateMany({
          where,
          data: { readAt: now, triedAt: now, productKeys: keys, state: keys.length ? "ok" : "no-product", etag: o.etag, modifiedAt: o.modifiedAt },
        });
      }
    }
    // An unchanged page still vouches for its products' stock (stockState: SITE fresh for 8 days).
    if (confirmed.length) {
      await tx.product.updateMany({
        where: { ...scope, source: "SITE", archivedAt: null, externalId: { in: [...new Set(confirmed)] }, OR: [{ inStock: { not: null } }, { stockQuantity: { not: null } }] },
        data: { stockCheckedAt: now },
      });
    }
    await archiveUnproduced(tx, scope, removed);
  });
}

/** One page: fetched with its validators, classified. null = stop the chain (the site refused us). */
async function readPage(page: Page, signal: AbortSignal): Promise<Outcome | null> {
  const headers: Record<string, string> = {
    ...(page.etag && { "if-none-match": page.etag }),
    ...(page.modifiedAt && { "if-modified-since": page.modifiedAt }),
  };
  // A redirect to another site isn't this page: refused in the fetch (it throws), not parsed.
  const res = await safeFetchBytes(page.url, "text/html", PAGE_BYTES, signal, PAGE_TIMEOUT_MS, { headers, sameSite: true }).catch(() => null);
  if (!res) return { page, kind: "failed" };
  if (res.status === 401 || res.status === 403 || res.status === 429) return null;
  if (res.status === 304) return { page, kind: "unchanged" };
  if (res.status === 404 || res.status === 410) return { page, kind: "notFound" };
  if (res.status !== 200 || res.truncated) return { page, kind: "failed" };
  const rows = pageProducts(Buffer.from(res.bytes).toString("utf8"), page.url);
  if (!rows.length && page.productKeys.length) return { page, kind: "failed", emptied: true };
  return {
    page,
    kind: "read",
    rows,
    etag: validator(res.headers.get("etag")),
    modifiedAt: validator(res.headers.get("last-modified")),
  };
}

/**
 * The status on screen, under the catalogue lock and only while the brand still reads its pages. `full`: the end of a
 * chain after every page of a complete discovery is settled: the old feed's WEBSITE/SHOPIFY rows go too (SITE saves
 * are partial, so nothing else archives them).
 */
async function report(scope: Scope, chain: Chain, note: Note | null, full: boolean) {
  const progress = await siteProgress(scope, chain.capped);
  await withCatalogLock(scope, LOCK_WAIT_MS, async (tx) => {
    await stillSite(tx, scope);
    if (full) await tx.product.updateMany({ where: { ...scope, source: { in: ["WEBSITE", "SHOPIFY"] }, archivedAt: null }, data: { archivedAt: new Date() } });
    await record(scope, { at: new Date().toISOString(), source: "SITE", ...progress }, note, tx);
  });
  return progress;
}

/** End of a chain: the status recorded (and the old feed's rows archived after a full read), audited. */
async function finish(scope: Scope, chain: Chain, stop: Stop) {
  const { read, total } = (await siteProgress(scope, chain.capped)).pages;
  const note = stop === "refused" || stop === "robots" ? SITE_REFUSED : stop === "changed" ? PAGES_CHANGED
    : total === 0 ? NO_PRODUCT_PAGES : read < total ? READING : null;
  const progress = await report(scope, chain, note, chain.complete && total > 0 && read === total);
  await prisma.auditEvent.create({
    data: {
      workspaceId: scope.workspaceId, brandId: scope.brandId, action: "catalog.pages", entityType: "Brand", entityId: scope.brandId,
      metadata: { pagesRead: chain.read, pages: progress.pages.total, products: progress.count, stopped: stop },
    },
  });
}

/**
 * robots.txt for the day, shared by every brand on the host (TransientEntry, a day). A failed fetch is tried once
 * more after a pause and never cached, so tomorrow (or the next run) asks again.
 */
export async function robotsFor(origin: string, day: string, signal: AbortSignal, sleep: (ms: number) => Promise<void>) {
  const key = `site-robots:${siteHost(origin)}:${day}`;
  const cached = await getTransient<{ txt: string | null }>(key);
  if (cached) return { txt: cached.txt, disallowAll: false };
  let robots = await fetchRobots(origin, signal);
  if (robots.disallowAll) {
    await sleep(5_000);
    robots = await fetchRobots(origin, signal);
  }
  if (!robots.disallowAll) await putTransient(key, { txt: robots.txt?.slice(0, 500 * 1024) ?? null }, DAY_MS);
  return robots;
}

/**
 * The sitemap's product pages for the day, shared by every brand on the host and by a chain started again that day
 * (TransientEntry, a day): the sitemaps are downloaded once a day per host. A retried step 0 finds it too, with the
 * same `complete`. ponytail: the cached list is up to MAX_PAGES URLs (~0.5 MB of JSON) per host.
 */
async function discoveryFor(origin: string, robots: string, day: string, signal: AbortSignal): Promise<Discovery> {
  const key = `site-discovery:${siteHost(origin)}:${day}`;
  const cached = await getTransient<Omit<Discovery, "urls"> & { urls: { url: string; lastmod: string | null }[] }>(key);
  if (cached) return { ...cached, urls: cached.urls.map((u) => ({ url: u.url, lastmod: u.lastmod ? new Date(u.lastmod) : null })) };
  const found = await discoverProductUrls(origin, robots, signal);
  await putTransient(key, found, DAY_MS);
  return found;
}

/**
 * Pages of another site (the brand's website changed): deleted, and the products only they held archived. The brand
 * route clears them when the website changes; this covers a chain already under way.
 */
async function dropForeignPages(scope: Scope, origin: string) {
  const host = siteHost(origin).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const gone = await prisma.$queryRaw<{ productKeys: string[] }[]>`
    DELETE FROM "CatalogPage"
    WHERE "workspaceId" = ${scope.workspaceId} AND "brandId" = ${scope.brandId}
      AND url !~* ${`^https?://(www\\.)?${host}(:[0-9]+)?([/?#]|$)`}
    RETURNING "productKeys"`;
  const keys = gone.flatMap((g) => g.productKeys);
  if (keys.length) await withCatalogLock(scope, LOCK_WAIT_MS, async (tx) => {
    await stillSite(tx, scope);
    await archiveUnproduced(tx, scope, keys);
  });
}

/**
 * Job handler. One chain per brand: a run holds the brand's advisory lock for its whole length (in a transaction, so
 * a pooled connection never keeps it); a second run for the brand (two chains claimed at once) finds it taken and
 * ends without queuing anything, the holder carries on. A step left from an earlier day ends quietly (today's chain,
 * which the daily sync starts, reads now). A brand that moved to Shopify or a feed ends the chain; the sync that moved
 * it cleared what was read.
 */
export const runCatalogPages = (payload: unknown) => readSitePages(payload);

/** runCatalogPages with the pause injectable (tests). */
export async function readSitePages(payload: unknown, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {
  const chain = Payload.parse(payload);
  const scope = { workspaceId: chain.workspaceId, brandId: chain.brandId };
  if (chain.day !== new Date().toISOString().slice(0, 10)) return;
  // ponytail: holds one pooled connection idle for the run (≤ ~5 min); the timeout only bounds a stuck run.
  await prisma.$transaction(async (tx) => {
    const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('pages:' || ${scope.brandId})) AS locked`;
    if (!locked) return;
    await readChain(chain, scope, sleep).catch((e: unknown) => {
      if (!(e instanceof Moved)) throw e;
    });
  }, { maxWait: 10_000, timeout: 10 * 60_000 });
}

async function readChain(chain: Chain, scope: Scope, sleep: (ms: number) => Promise<void>) {
  const found = await catalogSource(scope);
  if (found.source !== "SITE") return;
  const started = Date.now();
  const signal = AbortSignal.timeout(RUN_MS);
  const origin = new URL(found.websiteUrl).origin;
  await dropForeignPages(scope, origin);
  const robots = await robotsFor(origin, chain.day, signal, sleep);
  if (robots.disallowAll) return finish(scope, chain, "robots");
  const rules = robotsRules(robots.txt ?? "", ROBOTS_AGENT);
  if (chain.step === 0) {
    const discovery = await discoveryFor(origin, robots.txt ?? "", chain.day, signal);
    const { goneKeys } = await syncCatalogPages(scope, discovery);
    await withCatalogLock(scope, LOCK_WAIT_MS, async (tx) => {
      await stillSite(tx, scope);
      await archiveUnproduced(tx, scope, goneKeys);
    });
    chain.complete = discovery.complete;
    chain.capped = discovery.capped;
  }

  const dayStart = new Date(`${chain.day}T00:00:00.000Z`);
  const delay = spacingMs(rules.crawlDelay);
  let tried = await prisma.catalogPage.count({ where: { ...scope, triedAt: { gte: dayStart } } });
  let stop: Stop | null = null;
  while (!stop) {
    const due = await duePages(scope, dayStart);
    if (!due.length) stop = "done";
    const outcomes: Outcome[] = [];
    for (const page of due) {
      // Room for one more fetch and pause inside the run.
      if (Date.now() - started > RUN_MS - PAGE_TIMEOUT_MS - delay) stop = "time";
      else if (tried >= BRAND_PAGES_PER_DAY) stop = "budget";
      if (stop) break;
      const url = new URL(page.url);
      if (!robotsAllows(rules, url.pathname + url.search)) {
        outcomes.push({ page, kind: "disallowed" });
        continue;
      }
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      const outcome = await onHost(host, async (tx) => {
        if (!(await hitRateLimit(`site-pages:${host}:${chain.day}`, HOST_PAGES_PER_DAY, DAY_MS, 1, tx)).allowed) return "budget" as const;
        const o = await readPage(page, signal);
        await sleep(delay);
        return o;
      });
      if (outcome === BUSY) stop = "busy";
      else if (outcome === "budget") stop = "budget";
      else if (outcome === null) stop = "refused";
      else {
        outcomes.push(outcome);
        tried++;
      }
    }
    if (!outcomes.length) continue;
    // Most pages that listed products now list none or 404: the site changed, not the catalogue. Nothing of this
    // batch is archived for it (a 404 counts as a failed day), and the run stops before it spreads.
    const listed = outcomes.filter((o) => o.page.productKeys.length && (o.kind === "read" || o.kind === "failed" || o.kind === "notFound")).length;
    const suspects = outcomes.filter(suspect).length;
    const changed = suspects >= EMPTIED_MIN && suspects * 2 > listed;
    if (changed) {
      stop = "changed";
      for (const o of outcomes) if (o.kind === "notFound") o.held = true;
    }
    await saveBatch(scope, outcomes);
    chain.read += outcomes.filter((o) => o.kind === "read" || o.kind === "unchanged" || (o.kind === "notFound" && !o.held)).length;
  }

  if (stop !== "time" && stop !== "busy") return finish(scope, chain, stop);
  // Progress on screen as the chain goes, then the run's last write: the next step (its key dedupes a rerun of this step).
  await report(scope, chain, READING, false);
  await enqueueJob({
    type: CATALOG_PAGES_JOB,
    ...scope,
    payload: { ...chain, step: chain.step + 1 },
    runAt: new Date(Date.now() + 60_000),
    idempotencyKey: pagesKey(scope.brandId, chain.day, chain.step + 1, chain.manual),
  });
}
