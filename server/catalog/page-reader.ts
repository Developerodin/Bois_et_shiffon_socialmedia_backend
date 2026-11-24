import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { pageProducts } from "@/server/catalog/page-product";
import { discoverProductUrls, syncCatalogPages } from "@/server/catalog/sitemap";
import {
  CATALOG_PAGES_JOB, catalogSource, pagesKey, READING, record, saveRows, siteProgress, withCatalogLock,
  type Note, type SyncedRow,
} from "@/server/catalog/sync";
import { prisma } from "@/server/db/prisma";
import { enqueueJob, type Lease } from "@/server/jobs/queue";
import { fetchRobots, ROBOTS_AGENT, robotsAllows, robotsRules, safeFetchBytes, sameSite } from "@/server/research/crawl";

/**
 * The site reader (job catalog.pages, docs/superpowers/plans/2026-11-24-product-import.md Task 8): for a brand whose
 * website has no product feed (catalogSource SITE), reads the product pages its sitemap lists, a little each day.
 * A day's work is a chain of runs of at most 4 minutes; each run queues the next as its last write, so a crash
 * resumes from the pages' own state (CatalogPage readAt/triedAt), never from the job. Step 0 also runs discovery.
 *
 * Politeness: robots.txt read every run (a failed one stops the chain); one request at a time per host (www ignored)
 * whichever brand asks, ≥ 1 s apart or the site's Crawl-delay up to 10 s; 1,000 pages per brand and 1,500 per host per
 * UTC day; conditional requests (304 = no body). 401/403/429 stop the chain for the day and archive nothing.
 * Archiving: a SITE product is archived only when no page of the brand produces it any more (its page went, says
 * 404/410, or dropped it); the brand's WEBSITE/SHOPIFY rows only once every listed page of a complete discovery is read.
 *
 * ponytail: one runner (claimNextJob caps catalog.pages at 1), ~1,000 pages × ~1.5 s ≈ 25 min per brand per day, so
 * ~55 brands a day at full budget; past that raise the cap or read different hosts in parallel. Bandwidth ~400 MB per
 * brand per day on a first fill (3 MB page cap), mostly 304s after. The host lock and spacing cover page reads only:
 * robots.txt (once a run) and the sitemaps (step 0) are fetched outside it.
 */
const RUN_MS = 240_000;
const BATCH = 25;
const BRAND_PAGES_PER_DAY = 1000;
const HOST_PAGES_PER_DAY = 1500;
const PAGE_BYTES = 3_000_000;
const PAGE_TIMEOUT_MS = 30_000;
const REFRESH_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;
// The catalogue lock wait for a batch save: an import or the daily sync can hold it a while.
const LOCK_WAIT_MS = 120_000;

const SITE_REFUSED: Note = { error: "Your website turned our product reader away, so we stopped reading its product pages. Connect Shopify, import a file or add products by hand.", reason: "site-refused" };
const NO_PRODUCT_PAGES: Note = { error: "We couldn't find product pages in your website's sitemap. Connect Shopify, import a file or add products by hand.", reason: "no-product-pages" };

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
type Page = { id: string; url: string; etag: string | null; modifiedAt: string | null; productKeys: string[] };
type Outcome =
  | { page: Page; kind: "read"; rows: SyncedRow[]; etag: string | null; modifiedAt: string | null }
  | { page: Page; kind: "unchanged" | "gone" | "failed" };
/** Why a run ended: "time" and "busy" (another brand reads this host) carry on in a minute; the rest end the chain. */
type Stop = "time" | "busy" | "budget" | "refused" | "done" | "robots" | "day";

/**
 * Pages due, at most BATCH: never read, then lastmod newer than the read, then read over 7 days ago; never one already
 * tried this day (a failed page waits for tomorrow). Times as text → timestamp(3): the columns hold UTC without a zone.
 */
function duePages(scope: Scope, dayStart: Date) {
  const day = dayStart.toISOString();
  const stale = new Date(Date.now() - REFRESH_MS).toISOString();
  return prisma.$queryRaw<Page[]>`
    SELECT id, url, etag, "modifiedAt", "productKeys" FROM "CatalogPage"
    WHERE "workspaceId" = ${scope.workspaceId} AND "brandId" = ${scope.brandId}
      AND ("triedAt" IS NULL OR "triedAt" < ${day}::timestamp(3))
      AND ("readAt" IS NULL OR lastmod > "readAt" OR "readAt" < ${stale}::timestamp(3))
    ORDER BY CASE WHEN "readAt" IS NULL THEN 0 WHEN lastmod > "readAt" THEN 1 ELSE 2 END, "readAt" NULLS FIRST, lastmod DESC NULLS LAST, url
    LIMIT ${BATCH}`;
}

/**
 * `fn` while holding the host's lock, or "busy" when another run holds it. A transaction-scoped advisory lock (not the
 * session pg_try_advisory_lock), so a pooled connection can't keep it: it ends with the transaction, whatever happens.
 * The transaction holds one connection for the fetch and the pause after it (≤ ~40 s).
 */
const BUSY = Symbol("busy");
function onHost<T>(host: string, fn: () => Promise<T>): Promise<T | typeof BUSY> {
  return prisma.$transaction(async (tx) => {
    const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('host:' || ${host})) AS locked`;
    return locked ? fn() : BUSY;
  }, { maxWait: 10_000, timeout: PAGE_TIMEOUT_MS + 30_000 });
}

/** A validator header worth sending back: absent or absurdly long → none (a cut one would never match). */
const validator = (v: string | null) => (v && v.length <= 500 ? v : null);

/**
 * SITE products with these keys that no page of the brand produces any more, archived. Run after the pages' new
 * productKeys are written, in the same transaction.
 */
function archiveUnproduced(tx: Prisma.TransactionClient, scope: Scope, keys: string[]) {
  if (!keys.length) return Promise.resolve(0);
  const at = new Date().toISOString();
  return tx.$executeRaw`
    UPDATE "Product" p SET "archivedAt" = ${at}::timestamp(3), "updatedAt" = ${at}::timestamp(3)
    WHERE p."workspaceId" = ${scope.workspaceId} AND p."brandId" = ${scope.brandId} AND p.source = 'SITE'::"ProductSource"
      AND p."archivedAt" IS NULL AND p."externalId" = ANY(${[...new Set(keys)]}::text[])
      AND NOT EXISTS (
        SELECT 1 FROM "CatalogPage" c
        WHERE c."workspaceId" = p."workspaceId" AND c."brandId" = p."brandId" AND p."externalId" = ANY(c."productKeys"))`;
}

/**
 * One batch's results under the catalogue lock: rows saved (keys mode, never archiving), the pages' state written,
 * a 304's products stamped fresh, then products no page produces any more archived.
 */
function saveBatch(scope: Scope, outcomes: Outcome[]) {
  const now = new Date();
  const rows = outcomes.flatMap((o) => (o.kind === "read" ? o.rows : []));
  return withCatalogLock(scope, LOCK_WAIT_MS, async (tx) => {
    if (rows.length) await saveRows(tx, scope, "SITE", { rows, complete: false }, { keys: [...new Set(rows.map((r) => r.externalId))] });
    const removed: string[] = [];
    const confirmed: string[] = [];
    for (const o of outcomes) {
      const where = { id: o.page.id, workspaceId: scope.workspaceId, brandId: scope.brandId };
      if (o.kind === "failed") {
        await tx.catalogPage.updateMany({ where, data: { triedAt: now, state: "failed" } });
      } else if (o.kind === "unchanged") {
        confirmed.push(...o.page.productKeys);
        await tx.catalogPage.updateMany({ where, data: { readAt: now, triedAt: now } });
      } else {
        const keys = o.kind === "read" ? [...new Set(o.rows.map((r) => r.externalId))] : [];
        removed.push(...o.page.productKeys.filter((k) => !keys.includes(k)));
        await tx.catalogPage.updateMany({
          where,
          data: {
            readAt: now, triedAt: now, productKeys: keys,
            state: o.kind === "gone" ? "gone" : keys.length ? "ok" : "no-product",
            etag: o.kind === "read" ? o.etag : null,
            modifiedAt: o.kind === "read" ? o.modifiedAt : null,
          },
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
  const res = await safeFetchBytes(page.url, "text/html", PAGE_BYTES, signal, PAGE_TIMEOUT_MS, headers).catch(() => null);
  // A redirect to another site isn't this page: not parsed.
  if (!res || !sameSite(res.url.hostname, new URL(page.url).hostname)) return { page, kind: "failed" };
  if (res.status === 401 || res.status === 403 || res.status === 429) return null;
  if (res.status === 304) return { page, kind: "unchanged" };
  if (res.status === 404 || res.status === 410) return { page, kind: "gone" };
  if (res.status !== 200 || res.truncated) return { page, kind: "failed" };
  return {
    page,
    kind: "read",
    rows: pageProducts(Buffer.from(res.bytes).toString("utf8"), page.url),
    etag: validator(res.headers.get("etag")),
    modifiedAt: validator(res.headers.get("last-modified")),
  };
}

/** End of a chain: archive the old feed's rows after a first full read, record the status once, audit. */
async function finish(scope: Scope, chain: Chain, stop: Stop) {
  const progress = await siteProgress(scope, chain.capped);
  const { read, total } = progress.pages;
  if (chain.complete && total > 0 && read === total) {
    // SITE saves are partial (never archive), so the brand's WEBSITE/SHOPIFY rows go here, once it's all read.
    await withCatalogLock(scope, LOCK_WAIT_MS, (tx) =>
      tx.product.updateMany({ where: { ...scope, source: { in: ["WEBSITE", "SHOPIFY"] }, archivedAt: null }, data: { archivedAt: new Date() } }));
  }
  const note = stop === "refused" || stop === "robots" ? SITE_REFUSED : total === 0 ? NO_PRODUCT_PAGES : read < total ? READING : null;
  await record(scope, { at: new Date().toISOString(), source: "SITE", ...progress }, note);
  await prisma.auditEvent.create({
    data: {
      workspaceId: scope.workspaceId, brandId: scope.brandId, action: "catalog.pages", entityType: "Brand", entityId: scope.brandId,
      metadata: { pagesRead: chain.read, pages: total, products: progress.count, stopped: stop },
    },
  });
}

/**
 * Job handler. Exits at once when another run for the brand is going (one chain per brand), and stops the chain,
 * clearing what was read, once the brand reads from Shopify or a feed (a later switch back re-reads every page).
 * `sleep` is for tests.
 */
export async function runCatalogPages(payload: unknown, lease?: Lease, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {
  const chain = Payload.parse(payload);
  const scope = { workspaceId: chain.workspaceId, brandId: chain.brandId };
  const other = await prisma.job.findFirst({
    where: { type: CATALOG_PAGES_JOB, ...scope, status: "RUNNING", leasedUntil: { gt: new Date() }, ...(lease && { id: { not: lease.jobId } }) },
    select: { id: true },
  });
  if (other) return;
  const found = await catalogSource(scope);
  if (found.source !== "SITE") {
    await prisma.catalogPage.updateMany({ where: scope, data: { readAt: null, etag: null, modifiedAt: null } });
    return;
  }
  if (chain.day !== new Date().toISOString().slice(0, 10)) return finish(scope, chain, "day");

  const started = Date.now();
  const signal = AbortSignal.timeout(RUN_MS);
  const origin = new URL(found.websiteUrl).origin;
  const robots = await fetchRobots(origin, signal);
  if (robots.disallowAll) return finish(scope, chain, "robots");
  const rules = robotsRules(robots.txt ?? "", ROBOTS_AGENT);
  if (chain.step === 0) {
    const discovery = await discoverProductUrls(origin, robots.txt ?? "", signal);
    const { goneKeys } = await syncCatalogPages(scope, discovery);
    await withCatalogLock(scope, LOCK_WAIT_MS, (tx) => archiveUnproduced(tx, scope, goneKeys));
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
        // Disallowed since discovery: not read; a complete discovery drops it (and archives what only it produced).
        outcomes.push({ page, kind: "failed" });
        tried++;
        continue;
      }
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      const outcome = await onHost(host, async () => {
        if (!(await hitRateLimit(`site-pages:${host}:${chain.day}`, HOST_PAGES_PER_DAY, DAY_MS)).allowed) return "budget" as const;
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
    if (outcomes.length) {
      await saveBatch(scope, outcomes);
      chain.read += outcomes.filter((o) => o.kind !== "failed").length;
    }
  }

  if (stop !== "time" && stop !== "busy") return finish(scope, chain, stop);
  // The run's last write: the chain's next step (its key dedupes a rerun of this step).
  await enqueueJob({
    type: CATALOG_PAGES_JOB,
    ...scope,
    payload: { ...chain, step: chain.step + 1 },
    runAt: new Date(Date.now() + 60_000),
    idempotencyKey: pagesKey(scope.brandId, chain.day, chain.step + 1, chain.manual),
  });
}
