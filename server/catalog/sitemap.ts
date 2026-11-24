import { randomUUID } from "node:crypto";
import { Gunzip } from "fflate";
import { prisma } from "@/server/db/prisma";
import { ROBOTS_AGENT, robotsAllows, robotsSitemaps, safeFetchBytes } from "@/server/research/crawl";

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
// Compressed bytes pushed at a time: gzip expands at most ~1,032x, so one push inflates ≤ ~4 MB before the counter stops it.
const CHUNK = 4096;
const MAX_URL = 2000;
const ACCEPT = "application/xml, text/xml;q=0.9, */*;q=0.5";

const PRODUCT_SITEMAP = /product|produit/i;
const PRODUCT_PATH = /\/p\/|\/products?(?:[/-]|$)|\/produits?(?:[/-]|$)|-p-\d+/i;

export type FoundPage = { url: string; lastmod: Date | null };
export type Discovery = { urls: FoundPage[]; complete: boolean; capped: boolean; reason?: "no-product-pages" };

const siteHost = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, "");

/** An http(s) URL on the same site as `base` (host equal or its www. variant), hash dropped; else null. */
function sameSite(raw: string, base: URL): URL | null {
  if (raw.length > MAX_URL) return null;
  try {
    const u = new URL(raw, base);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || siteHost(u) !== siteHost(base)) return null;
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

/** `<urlset>` or `<sitemapindex>` entries: each `<loc>` with the `<lastmod>` of the same `<url>`/`<sitemap>` element. */
export function parseSitemap(xml: string): Parsed | null {
  if (/<!DOCTYPE/i.test(xml)) return null;
  const index = xml.includes("<sitemapindex");
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
 * fetch means). `complete` is false when any sitemap was cut off, answered other than 200, failed, was skipped over
 * the child limit, or time ran out: then the list may miss pages and nothing must be deleted because of it.
 * With a sitemap named product/produit only those are used; otherwise only product-looking paths count.
 */
export async function discoverProductUrls(origin: string, robots: string, signal?: AbortSignal): Promise<Discovery> {
  const base = new URL(origin);
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(DEADLINE_MS)]) : AbortSignal.timeout(DEADLINE_MS);
  let complete = true;
  let budget = MAX_TOTAL;

  /** One sitemap file, parsed; null (and `complete` false) when it can't be read whole. A partial file still yields what it had. */
  const read = async (url: URL): Promise<Parsed | null> => {
    if (deadline.aborted || budget <= 0) {
      complete = false;
      return null;
    }
    try {
      const res = await safeFetchBytes(url.toString(), ACCEPT, Math.min(MAX_FILE, budget), deadline, FILE_TIMEOUT_MS);
      budget -= res.bytes.length;
      if (res.status !== 200 || res.truncated || !sameSite(res.url.toString(), base)) complete = false;
      if (res.status !== 200 || !sameSite(res.url.toString(), base)) return null;
      let bytes = res.bytes;
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const inflated = gunzip(bytes, Math.min(MAX_FILE, budget));
        if (!inflated) {
          complete = false;
          return null;
        }
        budget -= inflated.length;
        bytes = inflated;
      }
      const parsed = parseSitemap(new TextDecoder().decode(bytes));
      if (!parsed) complete = false;
      return parsed;
    } catch {
      complete = false;
      return null;
    }
  };

  let roots = robotsSitemaps(robots).flatMap((s) => sameSite(s, base) ?? []);
  const fromRobots = roots.length > 0;
  if (!fromRobots) roots = [new URL("/sitemap.xml", base), new URL("/sitemap_index.xml", base)];

  const product = new Map<string, string | null>();
  const other = new Map<string, string | null>();
  const take = (file: URL, entries: Entry[]) => {
    const into = PRODUCT_SITEMAP.test(file.pathname) ? product : other;
    for (const e of entries) into.set(e.loc, e.lastmod);
  };
  const children = new Map<string, URL>();
  let anyRead = false;
  for (const root of uniqueUrls(roots)) {
    // Without robots lines, /sitemap_index.xml is only a fallback: a missing one doesn't make the read incomplete.
    if (!fromRobots && anyRead) break;
    const before: boolean = complete;
    const parsed = await read(root);
    if (!fromRobots && !parsed) complete = before;
    if (!parsed) continue;
    anyRead = true;
    if (!parsed.index) take(root, parsed.entries);
    else for (const e of parsed.entries) {
      const child = sameSite(e.loc, base);
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
    const parsed = await read(child);
    if (!parsed) continue;
    // ponytail: one level of index only; a nested index is skipped (and the read marked incomplete).
    if (parsed.index) complete = false;
    else take(child, parsed.entries);
  }

  const source = product.size ? product : other;
  const pages = new Map<string, FoundPage>();
  for (const [loc, lastmod] of source) {
    const u = sameSite(loc, base);
    if (!u || pages.has(u.toString())) continue;
    if (!product.size && !PRODUCT_PATH.test(u.pathname)) continue;
    if (!robotsAllows(robots, u.pathname + u.search, ROBOTS_AGENT)) continue;
    const t = lastmod ? Date.parse(lastmod) : NaN;
    pages.set(u.toString(), { url: u.toString(), lastmod: Number.isFinite(t) ? new Date(t) : null });
  }
  const urls = [...pages.values()].sort((a, b) => (b.lastmod?.getTime() ?? -Infinity) - (a.lastmod?.getTime() ?? -Infinity));
  return {
    urls: urls.slice(0, MAX_PAGES),
    complete,
    capped: urls.length > MAX_PAGES,
    ...(urls.length === 0 && { reason: "no-product-pages" as const }),
  };
}

const uniqueUrls = (urls: URL[]) => [...new Map(urls.map((u) => [u.toString(), u])).values()];

type Scope = { workspaceId: string; brandId: string };
const BATCH = 1000;

/**
 * Stores what discovery found: new pages inserted, a changed lastmod written (an unchanged one is skipped), in one
 * INSERT … FROM unnest per 1,000. When the discovery was complete, pages no longer listed are deleted and the
 * productKeys they held are returned for the archive rule (catalog.pages); an incomplete one deletes nothing.
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
  if (!found.complete) return { upserted, deleted: 0, goneKeys: [] as string[] };
  const gone = await prisma.$queryRaw<{ productKeys: string[] | null }[]>`
    DELETE FROM "CatalogPage"
    WHERE "workspaceId" = ${scope.workspaceId} AND "brandId" = ${scope.brandId} AND NOT (url = ANY(${pages.map((p) => p.url)}::text[]))
    RETURNING "productKeys"`;
  return { upserted, deleted: gone.length, goneKeys: [...new Set(gone.flatMap((g) => g.productKeys ?? []))] };
}
