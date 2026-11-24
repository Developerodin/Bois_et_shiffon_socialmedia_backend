import { randomUUID } from "node:crypto";
import { Gunzip } from "fflate";
import { prisma } from "@/server/db/prisma";
import { ROBOTS_AGENT, robotsAllows, robotsRules, robotsSitemaps, safeFetchBytes, sameSite } from "@/server/research/crawl";

/**
 * Finds a website's product pages from its sitemap (robots.txt `Sitemap:` lines, else /sitemap.xml or
 * /sitemap_index.xml), for the site reader (catalog.pages). Every sitemap and page must be on the same site (host
 * equal, `www.` ignored). Sitemaps are untrusted: each file is capped at 20 MB and all of them at 40 MB (downloaded
 * plus inflated bytes), the whole discovery at 2 minutes; gzip is inflated in a stream with real byte counting (its
 * size field is never read); a DOCTYPE refuses the file (no entity expansion); `<loc>`/`<lastmod>` are found with a
 * linear indexOf scan, never a backtracking pattern.
 */
const MAX_FILE = 20 * 1024 * 1024;
const MAX_TOTAL = 40 * 1024 * 1024;
const DEADLINE_MS = 120_000;
const FILE_TIMEOUT_MS = 30_000;
const MAX_CHILDREN = 50;
// Same ceiling as a feed (sync.ts MAX_ROWS): newest lastmod first.
export const MAX_PAGES = 5000;
// Sitemap entries kept in all: past this the rest is skipped (and the read is incomplete), so a hostile sitemap of a
// million URLs never reaches the sort or robots.txt.
const MAX_ENTRIES = 50_000;
// Compressed bytes pushed at a time: gzip expands at most ~1,032x, so one push inflates ≤ ~4 MB before the counter stops it.
const CHUNK = 4096;
const MAX_URL = 2000;
const ACCEPT = "application/xml, text/xml;q=0.9, */*;q=0.5";

const PRODUCT_SITEMAP = /product|produit/i;
const PRODUCT_PATH = /\/p\/|\/products?(?:[/-]|$)|\/produits?(?:[/-]|$)|-p-\d+/i;

export type FoundPage = { url: string; lastmod: Date | null };
export type Discovery = { urls: FoundPage[]; complete: boolean; capped: boolean; reason?: "no-product-pages" };

/**
 * An http(s) URL on the same site as `base` (host equal or its www. variant), hash dropped; else null. `secure`: an
 * https site's sitemap files must be https too.
 */
function sitemapUrl(raw: string, base: URL, secure = false): URL | null {
  if (raw.length > MAX_URL) return null;
  try {
    const u = new URL(raw, base);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || !sameSite(u.hostname, base.hostname)) return null;
    if (secure && base.protocol === "https:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u;
  } catch {
    return null;
  }
}

type Entry = { loc: string; lastmod: string | null };
type Parsed = { index: boolean; entries: Entry[] };

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, n: string) => NAMED[n]);
const cdata = (s: string) => {
  const t = s.trim();
  return t.startsWith("<![CDATA[") && t.endsWith("]]>") ? t.slice(9, -3).trim() : unescapeXml(t);
};

/**
 * Next index of `needle` at or after `from`, remembering the last answer so the whole scan stays linear: a needle
 * that's rare or absent is searched for once, not once per entry.
 */
function finder(text: string, needle: string) {
  let at = -2;
  return (from: number) => {
    if (at === -1) return -1;
    if (at < from) at = text.indexOf(needle, from);
    return at;
  };
}

// The root element, optionally namespace-prefixed. Bounded prefix: linear on hostile input.
const ROOT = /<(?:[\w.-]{1,32}:)?(urlset|sitemapindex)[\s>]/;

/**
 * `<urlset>` or `<sitemapindex>` entries: each `<loc>` with the `<lastmod>` of the same `<url>`/`<sitemap>` element.
 * null when it isn't a sitemap (no such root: a maintenance page, a JSON error) or carries a DOCTYPE, so a 200 that
 * isn't a sitemap never reads as an empty one.
 */
export function parseSitemap(xml: string): Parsed | null {
  if (/<!DOCTYPE/i.test(xml)) return null;
  const root = ROOT.exec(xml);
  if (!root) return null;
  const index = root[1] === "sitemapindex";
  const close = index ? "</sitemap>" : "</url>";
  const nextLoc = finder(xml, "<loc>");
  const nextLocEnd = finder(xml, "</loc>");
  const nextMod = finder(xml, "<lastmod>");
  const nextModEnd = finder(xml, "</lastmod>");
  const nextClose = finder(xml, close);
  const entries: Entry[] = [];
  let pos = 0;
  for (;;) {
    const open = nextLoc(pos);
    if (open < 0) break;
    const end = nextLocEnd(open);
    if (end < 0) break;
    const closeAt = nextClose(end);
    const entryEnd = closeAt < 0 ? xml.length : closeAt;
    // lastmod may come before or after loc inside the element: search from the element's start (pos).
    let lastmod: string | null = null;
    const m = nextMod(pos);
    if (m >= 0 && m < entryEnd) {
      const me = nextModEnd(m);
      if (me >= 0 && me < entryEnd) lastmod = cdata(xml.slice(m + 9, me));
    }
    entries.push({ loc: cdata(xml.slice(open + 5, end)), lastmod });
    pos = closeAt < 0 ? end + 6 : closeAt + close.length;
  }
  return { index, entries };
}

/** Streams gzip through fflate, counting inflated bytes; null once past `limit` or on damaged data. */
function gunzip(bytes: Uint8Array, limit: number): Uint8Array | null {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let failed = false;
  const gz = new Gunzip((data) => {
    size += data.length;
    if (size > limit) failed = true;
    else chunks.push(data);
  });
  try {
    for (let i = 0; i < bytes.length && !failed; i += CHUNK) gz.push(bytes.subarray(i, i + CHUNK), i + CHUNK >= bytes.length);
  } catch {
    return null;
  }
  return failed ? null : Buffer.concat(chunks);
}

/**
 * The product pages a site lists. `robots` is its robots.txt text (the caller fetched it and decides what a failed
 * fetch means). `complete` is false when any sitemap was cut off, answered other than 200, wasn't a sitemap, failed,
 * was skipped over the child limit, or time ran out; also when the list was capped (the pages past the cap are still
 * on the site) or came out empty (an emptied sitemap): then nothing must be deleted because of it.
 * With a sitemap named product/produit only those are used; otherwise only product-looking paths count.
 */
export async function discoverProductUrls(origin: string, robots: string, signal?: AbortSignal): Promise<Discovery> {
  const base = new URL(origin);
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(DEADLINE_MS)]) : AbortSignal.timeout(DEADLINE_MS);
  let complete = true;
  let budget = MAX_TOTAL;

  /**
   * One sitemap file, parsed; `parsed` null (and `complete` false) when it can't be read whole. A partial file still
   * yields what it had. `status` is the answer's (null when nothing answered).
   */
  const read = async (url: URL): Promise<{ parsed: Parsed | null; status: number | null }> => {
    if (deadline.aborted || budget <= 0) {
      complete = false;
      return { parsed: null, status: null };
    }
    try {
      const res = await safeFetchBytes(url.toString(), ACCEPT, Math.min(MAX_FILE, budget), deadline, FILE_TIMEOUT_MS, { sameSite: true });
      budget -= res.bytes.length;
      const fail = (status: number | null = res.status) => {
        complete = false;
        return { parsed: null, status };
      };
      if (res.status !== 200 || !sitemapUrl(res.url.toString(), base, true)) return fail();
      if (res.truncated) complete = false;
      let bytes = res.bytes;
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const inflated = gunzip(bytes, Math.min(MAX_FILE, budget));
        if (!inflated) return fail();
        budget -= inflated.length;
        bytes = inflated;
      }
      const parsed = parseSitemap(new TextDecoder().decode(bytes));
      return parsed ? { parsed, status: res.status } : fail();
    } catch {
      complete = false;
      return { parsed: null, status: null };
    }
  };

  let roots = robotsSitemaps(robots).flatMap((s) => sitemapUrl(s, base, true) ?? []);
  const fromRobots = roots.length > 0;
  if (!fromRobots) roots = [new URL("/sitemap.xml", base), new URL("/sitemap_index.xml", base)];

  const product = new Map<string, string | null>();
  const other = new Map<string, string | null>();
  const take = (file: URL, entries: Entry[]) => {
    const into = PRODUCT_SITEMAP.test(file.pathname) ? product : other;
    for (const e of entries) {
      if (product.size + other.size >= MAX_ENTRIES) {
        complete = false;
        return;
      }
      into.set(e.loc, e.lastmod);
    }
  };
  const children = new Map<string, URL>();
  let anyRead = false;
  for (const root of uniqueUrls(roots)) {
    // Without robots lines, /sitemap_index.xml is only a fallback: /sitemap.xml answering 404/410 (it doesn't exist)
    // doesn't make the read incomplete; any other failure (a 503, a time-out, a page that isn't a sitemap) does.
    if (!fromRobots && anyRead) break;
    const before: boolean = complete;
    const { parsed, status } = await read(root);
    if (!fromRobots && !parsed && (status === 404 || status === 410)) complete = before;
    if (!parsed) continue;
    anyRead = true;
    if (!parsed.index) take(root, parsed.entries);
    else for (const e of parsed.entries) {
      const child = sitemapUrl(e.loc, base, true);
      if (child) children.set(child.toString(), child);
    }
  }
  if (!anyRead) return { urls: [], complete: false, capped: false, reason: "no-product-pages" };

  const all = [...children.values()];
  const preferred = all.filter((c) => PRODUCT_SITEMAP.test(c.pathname));
  let queue = preferred.length || product.size ? preferred : all;
  if (queue.length > MAX_CHILDREN) {
    complete = false;
    queue = queue.slice(0, MAX_CHILDREN);
  }
  for (const child of queue) {
    const { parsed } = await read(child);
    if (!parsed) continue;
    // ponytail: one level of index only; a nested index is skipped (and the read marked incomplete).
    if (parsed.index) complete = false;
    else take(child, parsed.entries);
  }

  const source = product.size ? product : other;
  const pages = new Map<string, FoundPage & { path: string }>();
  for (const [loc, lastmod] of source) {
    const u = sitemapUrl(loc, base);
    if (!u || pages.has(u.toString())) continue;
    if (!product.size && !PRODUCT_PATH.test(u.pathname)) continue;
    const t = lastmod ? Date.parse(lastmod) : NaN;
    pages.set(u.toString(), { url: u.toString(), lastmod: Number.isFinite(t) ? new Date(t) : null, path: u.pathname + u.search });
  }
  const sorted = [...pages.values()].sort((a, b) => (b.lastmod?.getTime() ?? -Infinity) - (a.lastmod?.getTime() ?? -Infinity));
  // robots.txt is checked on the newest MAX_PAGES only (its matching costs per URL): a disallowed one leaves the list
  // short of the cap rather than letting a later page in.
  const rules = robotsRules(robots, ROBOTS_AGENT);
  const urls = sorted.slice(0, MAX_PAGES).flatMap(({ path, ...p }) => (robotsAllows(rules, path) ? [p] : []));
  // Capped: the pages past the newest 5,000 are still on the site. Empty: more likely an emptied or broken sitemap than
  // a shop with nothing for sale. Neither may delete pages (and archive their products).
  return {
    urls,
    complete: complete && urls.length > 0 && sorted.length <= MAX_PAGES,
    capped: sorted.length > MAX_PAGES,
    ...(urls.length === 0 && { reason: "no-product-pages" as const }),
  };
}

const uniqueUrls = (urls: URL[]) => [...new Map(urls.map((u) => [u.toString(), u])).values()];

type Scope = { workspaceId: string; brandId: string };
const BATCH = 1000;

/**
 * Stores what discovery found: new pages inserted, a changed lastmod written (an unchanged one is skipped), in one
 * INSERT … FROM unnest per 1,000. When the discovery was complete, pages no longer listed are deleted and the
 * productKeys only they held are returned for the archive rule (catalog.pages); an incomplete or empty one deletes nothing.
 * ponytail: the delete passes every listed URL (≤ MAX_PAGES) in one array parameter.
 */
export async function syncCatalogPages(scope: Scope, found: { urls: FoundPage[]; complete: boolean }) {
  const pages = [...new Map(found.urls.map((p) => [p.url, p])).values()];
  let upserted = 0;
  for (let i = 0; i < pages.length; i += BATCH) {
    const part = pages.slice(i, i + BATCH);
    upserted += await prisma.$executeRaw`
      INSERT INTO "CatalogPage" (id, "workspaceId", "brandId", url, lastmod)
      SELECT u.id, ${scope.workspaceId}, ${scope.brandId}, u.url, u.lastmod
      FROM unnest(${part.map(() => randomUUID())}::text[], ${part.map((p) => p.url)}::text[],
        ${part.map((p) => p.lastmod?.toISOString() ?? null)}::text[]::timestamp(3)[]) AS u(id, url, lastmod)
      ON CONFLICT ("brandId", url) DO UPDATE SET lastmod = EXCLUDED.lastmod
      WHERE "CatalogPage"."workspaceId" = ${scope.workspaceId} AND "CatalogPage".lastmod IS DISTINCT FROM EXCLUDED.lastmod`;
  }
  if (!found.complete || pages.length === 0) return { upserted, deleted: 0, goneKeys: [] as string[] };
  // goneKeys: keys of the deleted pages that no remaining page of the brand still holds (a product listed on two pages
  // stays). The statement's other parts see the table as it was before the DELETE, so "remaining" = the listed URLs.
  // The delete and the archive (the caller's) are separate steps: a crash between them leaves those products
  // unarchived, the safe side.
  const listed = pages.map((p) => p.url);
  const [res] = await prisma.$queryRaw<{ deleted: number; keys: string[] }[]>`
    WITH gone AS (
      DELETE FROM "CatalogPage"
      WHERE "workspaceId" = ${scope.workspaceId} AND "brandId" = ${scope.brandId} AND NOT (url = ANY(${listed}::text[]))
      RETURNING "productKeys"
    )
    SELECT (SELECT count(*) FROM gone)::int AS deleted,
      ARRAY(
        SELECT DISTINCT k FROM gone, unnest(gone."productKeys") AS k
        WHERE NOT EXISTS (
          SELECT 1 FROM "CatalogPage" c
          WHERE c."workspaceId" = ${scope.workspaceId} AND c."brandId" = ${scope.brandId} AND c.url = ANY(${listed}::text[]) AND k = ANY(c."productKeys")
        )
      ) AS keys`;
  return { upserted, deleted: res.deleted, goneKeys: res.keys };
}
