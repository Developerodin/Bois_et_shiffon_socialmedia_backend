import { Prisma, type SiteCrawl } from "@prisma/client";
import { z } from "zod";
import { hitRateLimit } from "@/server/auth/rate-limit";
import {
  BUSY, DAY_MS, onHost, PAGE_BYTES, PAGE_TIMEOUT_MS, robotsFor, RUN_MS, siteHost, spacingMs,
} from "@/server/catalog/page-reader";
import { discoverSiteUrls } from "@/server/catalog/sitemap";
import { prisma } from "@/server/db/prisma";
import { getTransient, putTransient } from "@/server/db/transient";
import { enqueueJob } from "@/server/jobs/queue";
import { pageLinks, ROBOTS_AGENT, robotsAllows, robotsRules, safeFetchBytes, sameSite, type RobotsGroup } from "@/server/research/crawl";
import { classifyLink, type LinkCheck, type LinkRow } from "@/server/seo/links";

/**
 * The weekly link check (job seo.links, docs/superpowers/plans/2026-11-26-seo-depth.md Task 4): every page of the
 * brand's site read for its links, every same-site link target checked, so the SEO audit can report broken links,
 * server errors and redirect chains. A cycle is a SiteCrawl and its SiteCrawlUrl rows; the weekly SEO agent starts it
 * (startSiteCrawl) and reports the last finished one (lastCompleteCrawl). A cycle runs as a chain of runs of at most
 * RUN_MS; each queues the next as its last write, so a crash resumes from the rows (checkedAt null), never from the job.
 *
 * Politeness, shared with the site reader (server/catalog/page-reader.ts): its host lock (one request at a time per
 * host, www ignored, ≥ 1 s apart or the site's Crawl-delay up to 10 s), its daily robots.txt cache (unreadable → the
 * cycle stops), its daily host bucket `site-pages:<host>:<day>`: the crawl stops for the day at CRAWL_HOST_SHARE of the
 * reader's 1,500, so the catalogue always keeps ≥ 500 a day; plus CRAWL_BRAND_PER_DAY per brand. Every request goes
 * through safeFetchBytes with sameSite (SSRF check on every hop, our USER_AGENT). One queue slot with catalog.pages.
 * A 429, a 503 with Retry-After or 5 server errors in a row pause the cycle; a bot wall (≥ 16 of the last 20 answers
 * 401/403) stops it with nothing reported.
 *
 * Risk: a workspace can point websiteUrl at a site it doesn't own and make us crawl it. Bounded by robots.txt, our
 * honest user agent, ≤ 1 request/s per host and the host bucket shared by every brand (≤ 1,000 crawl requests a day to
 * any one host, whoever asks). Upgrade: crawl only sites proven owned (a verified Search Console property or Shopify).
 * ponytail: ~4,000 requests per brand per week through one queue slot shared with the reader: ~100 brands crawling;
 * then raise PAGES_RUNNING_MAX (server/jobs/queue.ts) to 2 (host locks keep per-host politeness).
 */
export const SEO_LINKS_JOB = "seo.links";
export const SITE_PAGES_MAX = 2_000;       // PAGE rows per cycle (sitemap: newest lastmod first)
export const LINK_FOLLOW_MAX = 500;        // PAGE rows when following links (no sitemap), ≤ FOLLOW_DEPTH clicks from home
export const TARGETS_MAX = 2_000;          // TARGET rows per cycle; more are counted as unchecked (overflow)
export const CRAWL_HOST_SHARE = 1_000;     // the crawl stops for the day once the shared host bucket reaches this
export const CRAWL_BRAND_PER_DAY = 1_000;  // requests per brand per day
export const CYCLE_MAX_DAYS = 6;           // a cycle not complete by then ends PARTIAL
export const LINKS_FRESH_DAYS = 14;        // the audit reports a finished cycle at most this old
export const TARGET_TIMEOUT_MS = 10_000;
const FOLLOW_DEPTH = 3;
const MAX_URL = 2_000;
// A cycle whose last write is older than this (and isn't paused) lost its chain: startSiteCrawl queues it again.
const STALE_MS = DAY_MS;
// The pause between runs that stopped for time or a busy host (the reader's pacing).
const NEXT_RUN_MS = 60_000;
const RETRY_AFTER_MAX_MS = DAY_MS;
const SERVER_ERRORS_IN_A_ROW = 5;
const BOT_WALL_WINDOW = 20;
const BOT_WALL_MIN = 16;
// Never read as pages when following links: checked as targets only.
const ASSET = /\.(jpe?g|png|gif|webp|svg|pdf|zip|mp4|css|js|xml|txt|json|ico|woff2?)$/i;

type Scope = { workspaceId: string; brandId: string };
type Deps = { sleep?: (ms: number) => Promise<void>; now?: () => Date };
type Row = { id: string; url: string; kind: "PAGE" | "TARGET"; outcome: string | null; depth: number };
/** Why a run ended: "time" and "busy" carry on in a minute, "budget" and "pause" later; the rest end the cycle. */
type Stop = "time" | "busy" | "budget" | "pause" | "done" | "bot-wall";

const Payload = z.object({
  workspaceId: z.string().min(1),
  brandId: z.string().min(1),
  crawlId: z.string().min(1),
  /** The crawl's runNo when queued: a job whose number is behind (a retried run that already queued its next) does nothing. */
  runNo: z.number().int().min(1),
});

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
/** 00:10 UTC tomorrow: after the daily buckets have turned over. */
const tomorrow = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 10));
const daysSince = (day: Date, now: Date) => Math.floor((Date.parse(`${dayOf(now)}T00:00:00Z`) - Date.parse(`${dayOf(day)}T00:00:00Z`)) / DAY_MS);
const hostOf = (url: string) => new URL(url).hostname;
const jobKey = (crawlId: string, runNo: number) => `seo-links:${crawlId}:${runNo}`;

/** The brand's website origin, or null (none, or not a URL). */
async function websiteOf(scope: Scope, db: Prisma.TransactionClient | typeof prisma = prisma) {
  const profile = await db.brandProfile.findFirst({ where: scope, select: { websiteUrl: true } });
  try {
    return profile?.websiteUrl ? new URL(profile.websiteUrl).origin : null;
  } catch {
    return null;
  }
}

/** Retry-After (seconds or an HTTP date) as a wait in ms, at most a day; null when absent or unreadable. */
export function retryAfterMs(value: string | null | undefined, now: Date): number | null {
  if (!value) return null;
  const v = value.trim();
  const ms = /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v) - now.getTime();
  return Number.isFinite(ms) ? Math.min(RETRY_AFTER_MAX_MS, Math.max(0, ms)) : null;
}

/** Under the brand's crawl lock (transaction-scoped, as the reader's `pages:` lock), or nothing when it's held. */
function withBrandLock(brandId: string, fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  // ponytail: a run holds one pooled connection idle for its length (≤ ~5 min); the timeout only bounds a stuck run.
  return prisma.$transaction(async (tx) => {
    const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('site-crawl:' || ${brandId})) AS locked`;
    if (locked) await fn(tx);
  }, { maxWait: 10_000, timeout: 10 * 60_000 });
}

/** Queues run `runNo` of a cycle, in `db`'s transaction (its key dedupes a repeat). */
const queueRun = (db: Prisma.TransactionClient, crawl: Pick<SiteCrawl, "id" | "workspaceId" | "brandId">, runNo: number, runAt: Date) =>
  enqueueJob({
    type: SEO_LINKS_JOB,
    workspaceId: crawl.workspaceId,
    brandId: crawl.brandId,
    payload: { workspaceId: crawl.workspaceId, brandId: crawl.brandId, crawlId: crawl.id, runNo },
    runAt,
    idempotencyKey: jobKey(crawl.id, runNo),
  }, db);

/**
 * From the weekly SEO agent; idempotent under the brand lock. A fresh RUNNING cycle → nothing; one whose chain was
 * lost (no write for a day, not paused) → queued again; one too old or on another site → ended (PARTIAL / ABANDONED)
 * and a new one started. Starting: the brand's cycles other than its latest COMPLETE or PARTIAL are deleted, a
 * RUNNING cycle for the current websiteUrl created and its first run queued. No websiteUrl → nothing.
 */
export async function startSiteCrawl(scope: Scope, deps: Pick<Deps, "now"> = {}): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  await withBrandLock(scope.brandId, async (tx) => {
    const origin = await websiteOf(scope, tx);
    if (!origin) return;
    const running = await tx.siteCrawl.findFirst({ where: { ...scope, status: "RUNNING" }, orderBy: { createdAt: "desc" } });
    if (running) {
      if (!sameSite(hostOf(running.origin), hostOf(origin))) {
        await tx.siteCrawl.update({ where: { id: running.id }, data: { status: "ABANDONED", stopReason: "changed", finishedAt: now } });
      } else if (daysSince(running.startedOn, now) >= CYCLE_MAX_DAYS) {
        await tx.siteCrawl.update({ where: { id: running.id }, data: { status: "PARTIAL", stopReason: "too-old", finishedAt: now } });
      } else {
        const paused = running.pausedUntil && running.pausedUntil > now;
        if (!paused && running.updatedAt.getTime() < now.getTime() - STALE_MS) {
          await tx.siteCrawl.update({ where: { id: running.id }, data: { runNo: running.runNo + 1 } });
          await queueRun(tx, running, running.runNo + 1, now);
        }
        return;
      }
    }
    const keep = await tx.siteCrawl.findFirst({
      where: { ...scope, status: { in: ["COMPLETE", "PARTIAL"] } },
      orderBy: { finishedAt: "desc" },
      select: { id: true },
    });
    await tx.siteCrawl.deleteMany({ where: { ...scope, ...(keep && { id: { not: keep.id } }) } });
    const crawl = await tx.siteCrawl.create({
      data: { ...scope, origin, startedOn: new Date(`${dayOf(now)}T00:00:00Z`), runNo: 1 },
    });
    await queueRun(tx, crawl, 1, now);
  });
}

/** The latest finished cycle for the current site, fresh, with its rows; else why not (and the running cycle's progress). */
export async function lastCompleteCrawl(scope: Scope, deps: Pick<Deps, "now"> = {}): Promise<
  | { crawl: SiteCrawl; rows: LinkRow[] }
  | { reason: "none" | "stale" | "changed"; running: { pages: number; checked: number } | null }
> {
  const now = (deps.now ?? (() => new Date()))();
  const [origin, latest, running] = await Promise.all([
    websiteOf(scope),
    prisma.siteCrawl.findFirst({ where: { ...scope, status: { in: ["COMPLETE", "PARTIAL"] } }, orderBy: { finishedAt: "desc" } }),
    prisma.siteCrawl.findFirst({ where: { ...scope, status: "RUNNING" }, orderBy: { createdAt: "desc" }, select: { pages: true, checked: true } }),
  ]);
  if (!latest) return { reason: "none", running };
  if (!origin || !sameSite(hostOf(latest.origin), hostOf(origin))) return { reason: "changed", running };
  if (!latest.finishedAt || latest.finishedAt.getTime() < now.getTime() - LINKS_FRESH_DAYS * DAY_MS) return { reason: "stale", running };
  const rows = await prisma.siteCrawlUrl.findMany({
    where: { crawlId: latest.id },
    select: { url: true, checkedAt: true, status: true, redirects: true, outcome: true, carryCount: true, sources: true },
  });
  return { crawl: latest, rows };
}

/** Job handler (seo.links). One run per brand at a time: a second finds the brand lock taken and ends. */
export const runSeoLinks = (payload: unknown) => runSiteCrawl(payload);

/** runSeoLinks with the pause and the clock injectable (tests). */
export async function runSiteCrawl(payload: unknown, deps: Deps = {}): Promise<void> {
  const job = Payload.parse(payload);
  const scope = { workspaceId: job.workspaceId, brandId: job.brandId };
  await withBrandLock(scope.brandId, () => crawlRun(job, scope, { sleep: deps.sleep ?? realSleep, now: deps.now ?? (() => new Date()) }));
}

type Job = z.infer<typeof Payload>;

async function crawlRun(job: Job, scope: Scope, deps: Required<Deps>) {
  const { now, sleep } = deps;
  const started = now().getTime();
  const crawl = await prisma.siteCrawl.findFirst({ where: { id: job.crawlId, ...scope } });
  if (!crawl || crawl.status !== "RUNNING" || crawl.runNo !== job.runNo) return;
  const end = (status: "COMPLETE" | "STOPPED" | "PARTIAL" | "ABANDONED", stopReason: string | null) =>
    prisma.siteCrawl.updateMany({ where: { id: crawl.id, status: "RUNNING" }, data: { status, stopReason, finishedAt: now(), pausedUntil: null } });

  // The brand's site changed (or went): this cycle is of another site and is never reported.
  const origin = await websiteOf(scope);
  if (!origin || !sameSite(hostOf(origin), hostOf(crawl.origin))) return void (await end("ABANDONED", "changed"));
  if (daysSince(crawl.startedOn, now()) >= CYCLE_MAX_DAYS) return void (await end("PARTIAL", "too-old"));

  const day = dayOf(now());
  const signal = AbortSignal.timeout(RUN_MS);
  const robots = await robotsFor(crawl.origin, day, signal, sleep);
  if (robots.disallowAll) return void (await end("STOPPED", "robots"));
  const rules = robotsRules(robots.txt ?? "", ROBOTS_AGENT);
  if (!crawl.discoveryComplete) await discover(crawl, robots.txt ?? "", day, signal);

  const host = siteHost(crawl.origin);
  const siteHostname = hostOf(crawl.origin);
  const delay = spacingMs(rules.crawlDelay);
  // The last answers, newest last, seeded from earlier runs: the bot-wall rule spans runs.
  const recent = (await prisma.$queryRaw<{ status: number }[]>`
    SELECT status FROM "SiteCrawlUrl" WHERE "crawlId" = ${crawl.id} AND status IS NOT NULL
    ORDER BY "checkedAt" DESC LIMIT ${BOT_WALL_WINDOW}`).map((r) => r.status).reverse();
  let serverErrors = 0;
  let pausedUntil: Date | null = null;
  let stop: Stop | null = null;

  while (!stop) {
    // Room for one more fetch and pause inside the run.
    if (now().getTime() - started > RUN_MS - PAGE_TIMEOUT_MS - delay) {
      stop = "time";
      break;
    }
    const row = await nextRow(crawl.id);
    if (!row) {
      stop = "done";
      break;
    }
    const url = new URL(row.url);
    if (!robotsAllows(rules, url.pathname + url.search)) {
      await prisma.$transaction([
        prisma.siteCrawlUrl.update({ where: { id: row.id }, data: { checkedAt: now(), outcome: "skipped" } }),
        prisma.siteCrawl.update({ where: { id: crawl.id }, data: { checked: { increment: 1 } } }),
      ]);
      continue;
    }
    const result = await onHost(host, async (tx) => {
      // A refusal throws, so the transaction rolls back and the refused hit counts against neither bucket.
      if (!(await hitRateLimit(`site-crawl-brand:${scope.brandId}:${day}`, CRAWL_BRAND_PER_DAY, DAY_MS, 1, tx)).allowed) throw REFUSED;
      if (!(await hitRateLimit(`site-pages:${host}:${day}`, CRAWL_HOST_SHARE, DAY_MS, 1, tx)).allowed) throw REFUSED;
      const fetched = await fetchRow(row, signal);
      // The run's own deadline cut the fetch: not the link's fault, left for the next run.
      if (signal.aborted) return "time" as const;
      const outcome = classifyLink(fetched.check, row.outcome === "recheck");
      if (outcome !== "wait") await saveRow(tx, crawl, row, fetched, outcome, rules, siteHostname, now());
      await sleep(delay);
      return { fetched, outcome };
    }).catch((e: unknown) => {
      if (e === REFUSED) return "budget" as const;
      throw e;
    });
    if (result === BUSY) stop = "busy";
    else if (result === "budget" || result === "time") stop = result;
    else {
      const { fetched, outcome } = result;
      const status = "status" in fetched.check ? fetched.check.status : null;
      const wait = retryAfterMs(fetched.retryAfter, now());
      if (status !== null) {
        recent.push(status);
        if (recent.length > BOT_WALL_WINDOW) recent.shift();
      }
      serverErrors = status !== null && status >= 500 ? serverErrors + 1 : 0;
      if (recent.length >= BOT_WALL_WINDOW && recent.filter((s) => s === 401 || s === 403).length >= BOT_WALL_MIN) stop = "bot-wall";
      else if (outcome === "wait" || (status === 503 && wait !== null) || serverErrors >= SERVER_ERRORS_IN_A_ROW) {
        stop = "pause";
        pausedUntil = wait !== null ? new Date(now().getTime() + wait) : tomorrow(now());
      }
    }
  }

  if (stop === "done") return void (await end("COMPLETE", null));
  if (stop === "bot-wall") return void (await end("STOPPED", "bot-wall"));
  if (stop === "budget") pausedUntil = tomorrow(now());
  const runAt = pausedUntil ?? new Date(now().getTime() + NEXT_RUN_MS);
  // The run's last write: the next run queued and the run number moved on together, so a retried run (whose number is
  // now behind) does nothing and the chain never forks.
  await prisma.$transaction(async (tx) => {
    const moved = await tx.siteCrawl.updateMany({
      where: { id: crawl.id, status: "RUNNING", runNo: job.runNo },
      data: { runNo: job.runNo + 1, pausedUntil, stopReason: stop },
    });
    if (moved.count) await queueRun(tx, crawl, job.runNo + 1, runAt);
  });
}

const REFUSED = Symbol("refused");

/**
 * The next row to check: pages first (nearest the home page first), then targets most-linked first, then the 5xx
 * re-checks last.
 */
async function nextRow(crawlId: string): Promise<Row | null> {
  const [row] = await prisma.$queryRaw<Row[]>`
    SELECT id, url, kind::text AS kind, outcome, depth FROM "SiteCrawlUrl"
    WHERE "crawlId" = ${crawlId} AND ("checkedAt" IS NULL OR outcome = 'recheck')
    ORDER BY ("checkedAt" IS NOT NULL), kind, depth, "carryCount" DESC, url
    LIMIT 1`;
  return row ?? null;
}

type Fetched = { check: LinkCheck; retryAfter: string | null; html: string | null; finalUrl: URL | null };

/** A page read in full (its links wanted); a target with a 1-byte GET. Errors are the check's answer, not thrown. */
async function fetchRow(row: Row, signal: AbortSignal): Promise<Fetched> {
  const page = row.kind === "PAGE";
  try {
    const res = await safeFetchBytes(
      row.url, page ? "text/html" : "*/*", page ? PAGE_BYTES : 1, signal, page ? PAGE_TIMEOUT_MS : TARGET_TIMEOUT_MS, { sameSite: true },
    );
    const html = page && res.status === 200 && /html/i.test(res.contentType) ? Buffer.from(res.bytes).toString("utf8") : null;
    return { check: { status: res.status, redirects: res.redirects ?? 0 }, retryAfter: res.headers?.get("retry-after") ?? null, html, finalUrl: res.url };
  } catch (error) {
    return { check: { error }, retryAfter: null, html: null, finalUrl: null };
  }
}

/** One row's answer, and for a page that answered HTML, its links as rows, in the host-lock transaction. */
async function saveRow(
  tx: Prisma.TransactionClient, crawl: SiteCrawl, row: Row, fetched: Fetched, outcome: Exclude<ReturnType<typeof classifyLink>, "wait">,
  rules: RobotsGroup, siteHostname: string, at: Date,
) {
  const status = "status" in fetched.check ? fetched.check.status : null;
  const redirects = "status" in fetched.check ? fetched.check.redirects : 0;
  await tx.siteCrawlUrl.update({ where: { id: row.id }, data: { checkedAt: at, status, redirects, outcome } });
  const counts = { pages: 0, targets: 0, overflow: 0 };
  if (fetched.html && fetched.finalUrl && (outcome === "ok" || outcome === "chain")) {
    const links = pageLinks(fetched.html, fetched.finalUrl, (u) => sameSite(u.hostname, siteHostname))
      .filter((l) => l.length <= MAX_URL && robotsAllows(rules, new URL(l).pathname));
    Object.assign(counts, await addLinks(tx, crawl, row, links));
  }
  await tx.siteCrawl.update({
    where: { id: crawl.id },
    data: { checked: { increment: 1 }, pages: { increment: counts.pages }, targets: { increment: counts.targets }, overflow: { increment: counts.overflow } },
  });
}

/**
 * A page's links: rows already in the cycle count one more page linking to them (and keep up to 5 such pages); new
 * ones become PAGE rows when following links (≤ FOLLOW_DEPTH clicks, ≤ LINK_FOLLOW_MAX pages), else TARGET rows up to
 * TARGETS_MAX; past the caps they're only counted (overflow).
 */
async function addLinks(tx: Prisma.TransactionClient, crawl: SiteCrawl, row: Row, links: string[]) {
  const counts = { pages: 0, targets: 0, overflow: 0 };
  if (!links.length) return counts;
  const existing = new Set((await tx.$queryRaw<{ url: string }[]>`
    SELECT url FROM "SiteCrawlUrl" WHERE "crawlId" = ${crawl.id} AND url = ANY(${links}::text[])`).map((r) => r.url));
  if (existing.size) {
    await tx.$executeRaw`
      UPDATE "SiteCrawlUrl" SET "carryCount" = "carryCount" + 1,
        sources = CASE WHEN COALESCE(cardinality(sources), 0) < 5 THEN array_append(sources, ${row.url}) ELSE sources END
      WHERE "crawlId" = ${crawl.id} AND url = ANY(${[...existing]}::text[])`;
  }
  const fresh = links.filter((l) => !existing.has(l));
  if (!fresh.length) return counts;
  // The counts as they stand in this transaction (the brand lock makes this run the only writer).
  const now = await tx.siteCrawl.findUniqueOrThrow({ where: { id: crawl.id }, select: { pages: true, targets: true } });
  let pageRoom = crawl.followLinks && row.depth + 1 <= FOLLOW_DEPTH ? Math.max(0, LINK_FOLLOW_MAX - now.pages) : 0;
  let targetRoom = Math.max(0, TARGETS_MAX - now.targets);
  const data: Prisma.SiteCrawlUrlCreateManyInput[] = [];
  for (const url of fresh) {
    const asPage = pageRoom > 0 && !ASSET.test(new URL(url).pathname);
    if (asPage) {
      pageRoom--;
      counts.pages++;
    } else if (targetRoom > 0) {
      targetRoom--;
      counts.targets++;
    } else {
      counts.overflow++;
      continue;
    }
    data.push({ crawlId: crawl.id, url, kind: asPage ? "PAGE" : "TARGET", depth: asPage ? row.depth + 1 : 0, carryCount: 1, sources: [row.url] });
  }
  if (data.length) await tx.siteCrawlUrl.createMany({ data, skipDuplicates: true });
  return counts;
}

/**
 * The cycle's first rows, from the sitemaps (every page kind, other hosts dropped, newest first, SITE_PAGES_MAX), or
 * the home page alone with link-following when there is no sitemap. The list is shared for the day per host under its
 * own key (`site-discovery:` holds the reader's product list). A retried discovery adds nothing twice (skipDuplicates).
 */
async function discover(crawl: SiteCrawl, robotsTxt: string, day: string, signal: AbortSignal) {
  const key = `site-all-pages:${siteHost(crawl.origin)}:${day}`;
  const cached = await getTransient<{ urls: { url: string }[] }>(key);
  let found: { urls: { url: string }[] } | null = cached;
  if (!found) {
    found = await discoverSiteUrls(crawl.origin, robotsTxt, signal, SITE_PAGES_MAX);
    await putTransient(key, found, DAY_MS);
  }
  const urls = found.urls.map((u) => u.url).filter((u) => u.length <= MAX_URL);
  const home = `${crawl.origin}/`;
  const follow = urls.length === 0;
  const rows = (follow ? [home] : urls).map((url) => ({ crawlId: crawl.id, url, kind: "PAGE" as const, sources: [] }));
  await prisma.$transaction(async (tx) => {
    await tx.siteCrawlUrl.createMany({ data: rows, skipDuplicates: true });
    const pages = await tx.siteCrawlUrl.count({ where: { crawlId: crawl.id, kind: "PAGE" } });
    await tx.siteCrawl.update({ where: { id: crawl.id }, data: { discoveryComplete: true, followLinks: follow, pages } });
  });
  crawl.discoveryComplete = true;
  crawl.followLinks = follow;
}
