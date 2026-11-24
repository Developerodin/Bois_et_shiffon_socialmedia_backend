import type { IntegrationConnection, Prisma, ProductSource } from "@prisma/client";
import { z } from "zod";
import type { CatalogSync, SyncReason } from "@/shared";
import type { PERSON_FIELDS } from "@/server/catalog/products";
import { SHOPIFY_REFUSED, shopifyVariants, type ShopifyVariant } from "@/server/catalog/shopify";
import { prisma } from "@/server/db/prisma";
import { enqueueJob } from "@/server/jobs/queue";
import { shopifySized } from "@/server/research/brand-assets";
import { htmlText, safeFetch, safeFetchBytes } from "@/server/research/crawl";
import { accessToken, markReconnect, ReconnectNeeded } from "@/server/services/connections";

/**
 * Product catalogue sync (docs/superpowers/specs/2026-11-05-product-catalogue-design.md).
 * One synced source per brand: SHOPIFY when a Shopify connection exists (a broken one stays visible as an
 * error rather than silently falling back), else the website's public /products.json feed. A sync writes only
 * the fields it owns; materials, dimensions and certifications stay the person's. Rows it no longer sees, and
 * rows of the other synced source, are archived only after a complete fetch.
 */
export const CATALOG_SYNC_JOB = "catalog.sync";
/** The site reader (server/catalog/page-reader.ts): a brand whose website has no feed has its product pages read. */
export const CATALOG_PAGES_JOB = "catalog.pages";

type Scope = { workspaceId: string; brandId: string };
/** `error` null: a status, not a failure ("reading"). */
export type Note = { error: string | null; reason: SyncReason };

/** What a sync writes: every field it owns, except stockCheckedAt and archivedAt, which saving sets. */
export type SyncedRow = {
  externalId: string;
  sku: string | null;
  title: string;
  url: string | null;
  category: string | null;
  description: string | null;
  price: string | null;
  compareAtPrice: string | null;
  currency: string | null;
  inStock: boolean | null;
  stockQuantity: number | null;
  imageUrl: string | null;
};
type Fetched = { rows: SyncedRow[]; complete: boolean; note?: Note };
/** What saveRows writes: IMPORT rows also carry the person fields from the file (null = empty cell, keeps the stored value). */
export type SavedRow = SyncedRow & { materials?: string | null; dimensions?: string | null; certifications?: string | null };

const FEED_PAGES = 20;
const FEED_PAGE_SIZE = 250;
// A full page of 250 products with their HTML descriptions runs to a few MB; safeFetch's 1 MB cap would cut it.
const FEED_BYTES = 10_000_000;
// ponytail: one sync reads at most 5,000 rows (variants) within 4 minutes; past either it stops early and archives
// nothing. A bigger catalogue needs Shopify's bulk operations and a job that can run longer than one request.
export const MAX_ROWS = 5000;
const DEADLINE_MS = 240_000;
const NOT_A_FEED: Note = { error: "Your website doesn't publish a product feed we can read (Shopify stores do). Connect Shopify or add products by hand.", reason: "not-a-feed" };
// 401/403 on the feed: the site turns automated readers away (bot protection), so we can't tell whether it has a feed.
const BLOCKED: Note = { error: "Your website blocks our product reader, so we can't read its products. Connect Shopify or add products by hand.", reason: "blocked" };
const PARTIAL: Note = { error: "Only part of the catalogue could be read, so no products were archived.", reason: "partial" };
const FAILED: Note = { error: "The last sync couldn't read the products. Press Sync now to try again.", reason: "failed" };
const REFUSED: Note = { error: SHOPIFY_REFUSED, reason: "shopify-refused" };
export const READING: Note = { error: null, reason: "reading" };

export const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** "12.50", 12.5 → "12.50"; empty, negative, NaN, ≥ 1e9 (ProductInput's cap) or non-numeric → null (the feed is untrusted). */
export function parsePrice(v: unknown): string | null {
  if (typeof v !== "number" && (typeof v !== "string" || !v.trim())) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 1e9 ? n.toFixed(2) : null;
}

export function httpUrl(v: unknown): string | null {
  const s = str(v, 2000);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** "Chair" + "Oak / Large" → "Chair — Oak / Large"; Shopify's single-variant "Default Title" adds nothing. */
export function variantTitle(product: string, variant: unknown) {
  const v = str(variant, 150);
  return (v && v !== "Default Title" ? `${product} — ${v}` : product).slice(0, 300);
}

/**
 * One row from a page or feed's untrusted values, through the caps every source gets. `title` and `url` are final;
 * `description` is already plain text (htmlText), so a product's variants convert it once.
 */
export function syncedRow(v: {
  externalId: string; title: string; url: string | null; description: string | null; currency: string | null;
  sku: unknown; category: unknown; price: unknown; compareAtPrice: unknown; inStock: unknown; image: unknown;
}): SyncedRow {
  return {
    externalId: v.externalId,
    sku: str(v.sku, 100),
    title: v.title,
    url: v.url,
    category: str(v.category, 120),
    description: str(v.description, 5000),
    price: parsePrice(v.price),
    compareAtPrice: parsePrice(v.compareAtPrice),
    currency: v.currency,
    inStock: typeof v.inStock === "boolean" ? v.inStock : null,
    stockQuantity: null,
    imageUrl: httpUrl(v.image),
  };
}

/** Rows from one page of a public /products.json feed: one per variant. Malformed entries are skipped. */
export function websiteRows(products: unknown[], origin: string, currency: string | null): SyncedRow[] {
  return products.flatMap((raw) => {
    const p = raw as Record<string, unknown> | null;
    const title = str(p?.title, 200);
    const handle = str(p?.handle, 255);
    if (!p || !title || !handle || !Array.isArray(p.variants)) return [];
    const url = new URL(`/products/${encodeURIComponent(handle)}`, origin).toString();
    const description = typeof p.body_html === "string" ? htmlText(p.body_html) : null;
    const productImage = Array.isArray(p.images) ? p.images[0]?.src : undefined;
    return p.variants.flatMap((v) => {
      const id = typeof v?.id === "number" || typeof v?.id === "string" ? String(v.id).trim().slice(0, 100) : "";
      if (!id) return [];
      const image = v.featured_image?.src ?? productImage;
      return [syncedRow({
        externalId: id,
        sku: v.sku,
        title: variantTitle(title, v.title),
        url,
        category: p.product_type,
        description,
        price: v.price,
        compareAtPrice: v.compare_at_price,
        currency,
        inStock: v.available,
        image: typeof image === "string" ? shopifySized(image) : null,
      })];
    });
  });
}

export function shopifyRows(variants: ShopifyVariant[], currency: string | null): SyncedRow[] {
  return variants.map((v) => ({
    externalId: v.id,
    sku: str(v.sku, 100),
    title: variantTitle(str(v.product.title, 200) ?? "Untitled product", v.title),
    url: httpUrl(v.product.onlineStoreUrl),
    category: str(v.product.productType, 120),
    description: str(v.product.description, 5000),
    price: parsePrice(v.price),
    compareAtPrice: parsePrice(v.compareAtPrice),
    currency,
    inStock: typeof v.availableForSale === "boolean" ? v.availableForSale : null,
    stockQuantity: Number.isInteger(v.inventoryQuantity) ? v.inventoryQuantity : null,
    imageUrl: httpUrl(v.product.featuredMedia?.preview?.image?.url),
  }));
}

/** "gid://shopify/ProductVariant/123" → "123": the same variant's id in the public feed (WEBSITE rows). */
export const variantNumericId = (gid: string) => /^gid:\/\/shopify\/ProductVariant\/(\d+)$/.exec(gid)?.[1] ?? null;

/** At most MAX_ROWS rows; more means the fetch was cut short, so it's partial (nothing archived). */
export function capRows(fetched: Fetched): Fetched {
  return fetched.rows.length > MAX_ROWS ? { rows: fetched.rows.slice(0, MAX_ROWS), complete: false, note: PARTIAL } : fetched;
}

/** Sources a sync fills; a brand reads from one of them at a time. */
const AUTOMATIC: ProductSource[] = ["SHOPIFY", "WEBSITE", "SITE"];

/**
 * The rows a save archives, or null when it must archive nothing (a partial fetch, or MANUAL, which no save owns).
 * An automatic source archives its rows it didn't see and every row of the other automatic sources (the brand moved);
 * IMPORT archives only its own unseen rows. An empty `seen` after a complete fetch archives every row of that source:
 * the store (or the file) really is empty.
 */
export function archiveWhere(scope: Scope, source: ProductSource, seen: string[], complete: boolean): Prisma.ProductWhereInput | null {
  if (!complete || source === "MANUAL") return null;
  const others = AUTOMATIC.includes(source) ? AUTOMATIC.filter((s) => s !== source) : [];
  return {
    workspaceId: scope.workspaceId,
    brandId: scope.brandId,
    archivedAt: null,
    OR: [...(others.length ? [{ source: { in: others } }] : []), { source, externalId: { notIn: seen } }],
  };
}

async function cartCurrency(origin: string, signal?: AbortSignal) {
  const res = await safeFetch(new URL("/cart.js", origin).toString(), "application/json", signal).catch(() => null);
  try {
    const c = res?.status === 200 ? (JSON.parse(res.body) as { currency?: unknown }).currency : null;
    return typeof c === "string" && /^[A-Z]{3}$/.test(c) ? c : null;
  } catch {
    return null;
  }
}

/**
 * The public Shopify feed, 250 products a page, through the crawler's SSRF guard and size cap.
 * Not a feed on page 1 (404, HTML) → nothing, with a note; a server error or a broken later page throws (retried).
 * Stops once it holds more than MAX_ROWS variants (partial). `signal` is the sync's overall deadline.
 * ponytail: 20 pages (5,000 products); a bigger catalogue stays incomplete (nothing archived): connect Shopify Admin.
 */
export async function websiteFeed(websiteUrl: string, signal?: AbortSignal): Promise<Fetched> {
  let origin = new URL(websiteUrl).origin;
  let currency: string | null = null;
  const rows: SyncedRow[] = [];
  for (let page = 1; page <= FEED_PAGES; page++) {
    const res = await safeFetchBytes(new URL(`/products.json?limit=${FEED_PAGE_SIZE}&page=${page}`, origin).toString(), "application/json", FEED_BYTES, signal, 30_000);
    if (page === 1 && (res.status === 401 || res.status === 403)) return { rows: [], complete: false, note: BLOCKED };
    if (res.status === 429 || res.status >= 500 || res.truncated) throw new Error(`Product feed page ${page}: ${res.truncated ? "too large" : res.status}`);
    let list: unknown = null;
    try {
      list = res.status === 200 ? (JSON.parse(Buffer.from(res.bytes).toString("utf8")) as { products?: unknown })?.products : null;
    } catch {
      // not JSON: an HTML page, so not a Shopify feed
    }
    if (!Array.isArray(list)) {
      if (page === 1) return { rows: [], complete: false, note: NOT_A_FEED };
      throw new Error(`Product feed page ${page}: not a product list`);
    }
    if (page === 1) {
      origin = res.url.origin; // after redirects (e.g. → www.)
      currency = await cartCurrency(origin, signal);
    }
    rows.push(...websiteRows(list, origin, currency));
    if (list.length < FEED_PAGE_SIZE) return capRows({ rows, complete: true });
    if (rows.length > MAX_ROWS) break;
  }
  return capRows({ rows, complete: false, note: PARTIAL });
}

/** The connection's store (its account id is the shop domain), token via accessToken(), which throws ReconnectNeeded. */
async function shopifyFeed(conn: IntegrationConnection, signal: AbortSignal): Promise<Fetched> {
  const { variants, currency, complete } = await shopifyVariants(conn.externalAccountId, await accessToken(conn), signal);
  return capRows({ rows: shopifyRows(variants, currency), complete, note: complete ? undefined : PARTIAL });
}

/**
 * Which source a brand syncs from: its newest working Shopify connection, else a broken one, else the website: its
 * product pages (SITE) once its last sync found no feed there (catalogSync.source), else its feed (WEBSITE).
 */
export async function catalogSource(scope: Scope, db: Db = prisma) {
  const shop = await db.integrationConnection.findFirst({
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId, provider: "SHOPIFY", status: { not: "REVOKED" } },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
  });
  if (shop) return { source: "SHOPIFY" as const, shop };
  const profile = await db.brandProfile.findFirst({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId }, select: { websiteUrl: true, catalogSync: true } });
  if (!profile?.websiteUrl) return { source: null };
  const last = profile.catalogSync as CatalogSync | null;
  return last?.source === "SITE"
    ? { source: "SITE" as const, websiteUrl: profile.websiteUrl, capped: last.pages?.capped ?? false }
    : { source: "WEBSITE" as const, websiteUrl: profile.websiteUrl };
}

/** The fields a save writes (SavedRow's keys), read back to tell changed rows from unchanged ones. */
const OWNED = {
  id: true, externalId: true, archivedAt: true, sku: true, title: true, url: true, category: true, description: true,
  price: true, compareAtPrice: true, currency: true, inStock: true, stockQuantity: true, imageUrl: true,
  materials: true, dimensions: true, certifications: true,
} satisfies Prisma.ProductSelect;
type Stored = Prisma.ProductGetPayload<{ select: typeof OWNED }>;
// PERSON_FIELDS (products.ts imports this module, so only its type is imported here)
const PERSON = new Set<string>(["materials", "dimensions", "certifications"] satisfies (typeof PERSON_FIELDS)[number][]);
const CHUNK = 1000;
const chunks = <T>(list: T[]) => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK));

/**
 * True when a stored row already holds what the source says (prices compared as numbers: Decimal prints "12.5").
 * An empty person field (IMPORT) keeps the stored value, so it never counts as a change.
 */
export function sameRow(stored: Record<keyof SyncedRow, unknown> & { archivedAt: Date | null } & Partial<Record<keyof SavedRow, unknown>>, row: SavedRow) {
  if (stored.archivedAt) return false;
  return (Object.keys(row) as (keyof SavedRow)[]).every((k) =>
    k === "price" || k === "compareAtPrice"
      ? stored[k] == null ? row[k] === null : row[k] !== null && Number(stored[k]) === Number(row[k])
      : (PERSON.has(k) && row[k] == null) || (stored[k] ?? null) === row[k],
  );
}

type Db = Prisma.TransactionClient;
type SaveOptions = {
  /** Read only the stored rows with these externalIds (the unique index) instead of the whole source: partial batches. */
  keys?: string[];
  /**
   * IMPORT: incoming externalId -> id of a stored row it updates (that row takes the new externalId), asked only for rows
   * whose own key isn't stored, with the ids already claimed by their own key. A stored row is claimed once; a second
   * claim or an unknown id creates a new row instead.
   */
  match?: (rows: SavedRow[], stored: Stored[], claimed: ReadonlySet<string>) => Map<string, string>;
  /**
   * IMPORT: stock and price fields the file has no column for: a matched row keeps its stored value, a new row has none.
   * The caller keeps pairs whole (price with compareAtPrice, inStock with stockQuantity), so a kept value never
   * contradicts a written one.
   */
  keep?: KeptField[];
};
type KeptField = "price" | "compareAtPrice" | "inStock" | "stockQuantity";
const kept = (p: Stored, f: KeptField) => (f === "price" || f === "compareAtPrice" ? (p[f]?.toFixed(2) ?? null) : p[f]);

/**
 * Write what changed, then archive what the source no longer has (complete fetches only, archiveWhere). Returns rows
 * seen and what happened to them. `db` may be a transaction. A row sent without a currency (the website's /cart.js failed) keeps the stored one.
 * New SHOPIFY rows take the person's facts from the same variant's WEBSITE row, so switching to Shopify keeps them.
 * Queries: one read of the source (or of `keys`), changed rows in one UPDATE … FROM unnest per 1,000 (their stock
 * freshness included), createMany per 1,000 new rows, one stockCheckedAt update per 1,000 unchanged rows that report
 * stock, and the archive. Changed rows go first, so a key a matched row gives up is free for a new row.
 * ponytail: the default read holds the whole source in memory (≤ MAX_ROWS rows); `keys` is the batch path.
 */
export async function saveRows(db: Db, scope: Scope, source: Exclude<ProductSource, "MANUAL">, fetched: { rows: SavedRow[]; complete: boolean }, opts: SaveOptions = {}) {
  const now = new Date();
  const where = { workspaceId: scope.workspaceId, brandId: scope.brandId, source };
  const stored = await db.product.findMany({ where: opts.keys ? { ...where, externalId: { in: opts.keys } } : where, select: OWNED });
  const byKey = new Map(stored.map((p) => [p.externalId, p]));
  const unique = [...new Map(fetched.rows.map((r) => [r.externalId, r])).values()];
  // incoming externalId -> the stored row it writes: its own key, else the one `match` names
  const target = new Map(unique.flatMap((r) => { const p = byKey.get(r.externalId); return p ? [[r.externalId, p] as const] : []; }));
  if (opts.match) {
    const byId = new Map(stored.map((p) => [p.id, p]));
    const claimed = new Set([...target.values()].map((p) => p.id));
    for (const [key, id] of opts.match(unique.filter((r) => !target.has(r.externalId)), stored, claimed)) {
      const p = byId.get(id);
      if (p && !claimed.has(id) && !target.has(key)) {
        target.set(key, p);
        claimed.add(id);
      }
    }
  }
  const rows = unique.map((r) => {
    const p = target.get(r.externalId);
    const keep = r.currency === null ? p?.currency : null;
    const own = p && opts.keep?.length ? Object.fromEntries(opts.keep.map((f) => [f, kept(p, f)])) : {};
    return { ...r, ...(keep && { currency: keep }), ...own };
  });
  // Stock is fresh only when the source said something about it: values kept from the stored row (`keep`) aren't news.
  const reported = new Set(unique.filter((r) => r.inStock !== null || r.stockQuantity !== null).map((r) => r.externalId));
  const reports = (r: SavedRow) => reported.has(r.externalId);
  const created = rows.filter((r) => !target.has(r.externalId));
  const changed: (SavedRow & { id: string })[] = [];
  const unchangedReporting: string[] = [];
  for (const r of rows) {
    const p = target.get(r.externalId);
    if (p && !sameRow(p, r)) changed.push({ ...r, id: p.id });
    else if (p && reports(r)) unchangedReporting.push(p.id);
  }

  const at = now.toISOString(); // text -> timestamp(3): the columns hold UTC without a zone, as Prisma writes them
  for (const part of chunks(changed)) {
    const col = (f: (r: SavedRow & { id: string }) => string | null | undefined) => part.map((r) => f(r) ?? null);
    const text = (v: boolean | number | null) => (v === null ? null : String(v));
    await db.$executeRaw`
      UPDATE "Product" p SET
        "externalId" = u.external_id, sku = u.sku, title = u.title, url = u.url, category = u.category, description = u.description,
        price = u.price, "compareAtPrice" = u.compare_at_price, currency = u.currency, "inStock" = u.in_stock,
        "stockQuantity" = u.stock_quantity, "imageUrl" = u.image_url,
        materials = COALESCE(u.materials, p.materials), dimensions = COALESCE(u.dimensions, p.dimensions),
        certifications = COALESCE(u.certifications, p.certifications),
        "stockCheckedAt" = CASE WHEN u.reports THEN ${at}::timestamp(3) ELSE p."stockCheckedAt" END,
        "archivedAt" = NULL, "updatedAt" = ${at}::timestamp(3)
      FROM unnest(
        ${col((r) => r.id)}::text[], ${col((r) => r.externalId)}::text[], ${col((r) => r.sku)}::text[], ${col((r) => r.title)}::text[],
        ${col((r) => r.url)}::text[], ${col((r) => r.category)}::text[], ${col((r) => r.description)}::text[],
        ${col((r) => r.price)}::text[]::numeric[], ${col((r) => r.compareAtPrice)}::text[]::numeric[], ${col((r) => r.currency)}::text[],
        ${col((r) => text(r.inStock))}::text[]::boolean[], ${col((r) => text(r.stockQuantity))}::text[]::int[], ${col((r) => r.imageUrl)}::text[],
        ${col((r) => r.materials)}::text[], ${col((r) => r.dimensions)}::text[], ${col((r) => r.certifications)}::text[],
        ${col((r) => text(reports(r)))}::text[]::boolean[]
      ) AS u(id, external_id, sku, title, url, category, description, price, compare_at_price, currency, in_stock, stock_quantity,
             image_url, materials, dimensions, certifications, reports)
      WHERE p.id = u.id AND p."workspaceId" = ${scope.workspaceId} AND p."brandId" = ${scope.brandId} AND p.source = ${source}::"ProductSource"`;
  }

  const facts = new Map<string, { materials: string | null; dimensions: string | null; certifications: string | null }>();
  if (source === "SHOPIFY" && created.length) {
    const website = await db.product.findMany({
      where: { workspaceId: scope.workspaceId, brandId: scope.brandId, source: "WEBSITE", externalId: { in: created.flatMap((r) => variantNumericId(r.externalId) ?? []) } },
      select: { externalId: true, materials: true, dimensions: true, certifications: true },
    });
    for (const { externalId, ...f } of website) if (externalId) facts.set(externalId, f);
  }
  let added = 0;
  for (const part of chunks(created)) {
    added += (await db.product.createMany({
      data: part.map((r) => ({ ...facts.get(variantNumericId(r.externalId) ?? ""), ...r, ...where, ...(reports(r) && { stockCheckedAt: now }) })),
      skipDuplicates: true,
    })).count;
  }
  for (const part of chunks(unchangedReporting)) await db.product.updateMany({ where: { ...where, id: { in: part } }, data: { stockCheckedAt: now } });
  const gone = archiveWhere(scope, source, rows.map((r) => r.externalId), fetched.complete);
  const archived = gone ? (await db.product.updateMany({ where: gone, data: { archivedAt: now } })).count : 0;
  return { seen: rows.length, created: added, updated: changed.length, unchanged: rows.length - created.length - changed.length, archived };
}

/**
 * saveRows in a transaction holding the brand's catalogue lock, so an import and a sync of one brand (or two imports)
 * never interleave: the second waits for the first to commit. It waits at most `lockWaitMs` for the lock (Postgres'
 * lock_timeout, for the lock only: Prisma's maxWait only covers getting a connection), then throws CatalogBusy; the
 * save then has 60 s, which covers MAX_ROWS rows (well under 5 s on a test DB).
 */
export class CatalogBusy extends Error {}
export function lockedSave(scope: Scope, source: Exclude<ProductSource, "MANUAL">, fetched: { rows: SavedRow[]; complete: boolean }, opts: SaveOptions, lockWaitMs: number) {
  return withCatalogLock(scope, lockWaitMs, (tx) => saveRows(tx, scope, source, fetched, opts));
}

/** `fn` in a transaction holding the brand's catalogue lock (lockedSave's lock, wait and timeout), for saves that write more than saveRows. */
export function withCatalogLock<T>(scope: Scope, lockWaitMs: number, fn: (tx: Db) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('lock_timeout', ${String(lockWaitMs)}, true)`;
    try {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('catalog:' || ${scope.brandId}))`;
    } catch (e) {
      if (/lock timeout/i.test(String(e))) throw new CatalogBusy("Another import or sync of this catalogue is running");
      throw e;
    }
    await tx.$executeRaw`SELECT set_config('lock_timeout', '0', true)`;
    return fn(tx);
  }, { timeout: lockWaitMs + 60_000 });
}

/** With no Shopify connection and no website feed, nothing updates SHOPIFY rows any more: their stock would go stale. */
const archiveShopifyRows = (scope: Scope) =>
  prisma.product.updateMany({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId, source: "SHOPIFY", archivedAt: null }, data: { archivedAt: new Date() } });

export const record = (scope: Scope, sync: Pick<CatalogSync, "at" | "source" | "count" | "pages">, note: Note | null, db: Db = prisma) =>
  db.brandProfile.updateMany({
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId },
    data: { catalogSync: { ...sync, error: note?.error ?? null, reason: note?.reason ?? null } },
  });

const Payload = z.object({ workspaceId: z.string(), brandId: z.string() });

/**
 * Job handler. Network errors throw (retried); a refused Shopify token marks the connection and throws
 * ReconnectNeeded (the runner doesn't retry it). Every fetch of one sync shares a 4-minute deadline.
 */
export async function runCatalogSync(payload: unknown) {
  const scope = Payload.parse(payload);
  const at = new Date().toISOString();
  const found = await catalogSource(scope);
  if (found.source === null) {
    await archiveShopifyRows(scope);
    return void (await record(scope, { at, source: null, count: 0 }, null));
  }
  if (found.source === "SHOPIFY" && found.shop.status !== "ACTIVE") {
    // The connection's own lastError (e.g. set by a refused sync) is the message; the app says "reconnect".
    return void (await record(scope, { at, source: "SHOPIFY", count: 0 }, { ...REFUSED, error: found.shop.lastError ?? SHOPIFY_REFUSED }));
  }
  const signal = AbortSignal.timeout(DEADLINE_MS);
  try {
    // A SITE brand's feed is checked every day too: once the site has one, the feed takes over (and archives SITE rows).
    const fetched = found.source === "SHOPIFY" ? await shopifyFeed(found.shop, signal) : await websiteFeed(found.websiteUrl, signal);
    // A SITE brand stays one when its feed URL turns readers away for a day: only a feed that answers moves it.
    if (fetched.note === NOT_A_FEED || (fetched.note === BLOCKED && found.source === "SITE")) {
      await archiveShopifyRows(scope);
      await startPageChain(scope);
      return void (await record(scope, { at, source: "SITE", ...(await siteProgress(scope, found.source === "SITE" && found.capped)) }, READING));
    }
    const source = found.source === "SHOPIFY" ? "SHOPIFY" : "WEBSITE";
    // Up to 2 minutes behind an import or another sync's save; past that the job is retried, nothing recorded.
    // The save and the record share the catalogue lock's transaction: the site reader checks the source under the
    // same lock, so it never writes SITE rows (or archives these) after the brand moved.
    await withCatalogLock(scope, 120_000, async (tx) => {
      const { seen: count } = await saveRows(tx, scope, source, fetched, {});
      // A complete save archived any SITE rows: forget what the site reader read, so a switch back reads every page again.
      if (fetched.complete) await tx.catalogPage.updateMany({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId }, data: { readAt: null, etag: null, modifiedAt: null } });
      await record(scope, { at, source, count }, fetched.note ?? null, tx);
    });
  } catch (error) {
    if (error instanceof CatalogBusy) throw error;
    const refused = error instanceof ReconnectNeeded;
    if (refused && found.source === "SHOPIFY") await markReconnect(found.shop.id, SHOPIFY_REFUSED);
    // Messages here carry statuses and Shopify error codes only, never a token.
    console.warn("[catalog] sync failed", scope.brandId, found.source, error instanceof Error ? error.message : error);
    // A SITE brand keeps its reader's progress on screen.
    const kept = found.source === "SITE" ? await siteProgress(scope, found.capped) : { count: 0 };
    await record(scope, { at, source: found.source, ...kept }, refused ? REFUSED : FAILED);
    throw error;
  }
}

/** Queue a sync. `key` dedupes (the day for the daily sweep, the connect time); without one it's always a new job. */
export function enqueueCatalogSync(scope: Scope, key?: string) {
  return enqueueJob({
    type: CATALOG_SYNC_JOB,
    workspaceId: scope.workspaceId,
    brandId: scope.brandId,
    payload: { workspaceId: scope.workspaceId, brandId: scope.brandId },
    idempotencyKey: key && `catalog-sync:${scope.brandId}:${key}`,
  });
}

/** True while a sync or the site reader for this brand is queued or running (what the screens poll for). */
export async function catalogSyncRunning(scope: Scope) {
  const job = await prisma.job.findFirst({
    where: { type: { in: [CATALOG_SYNC_JOB, CATALOG_PAGES_JOB] }, workspaceId: scope.workspaceId, brandId: scope.brandId, status: { in: ["PENDING", "RUNNING"] } },
    select: { id: true },
  });
  return job !== null;
}

/** The site reader's job key: one per step of a day's chain; a chain started again by hand that day is `manual:<n>`. */
export const pagesKey = (brandId: string, day: string, step: number, manual?: number) =>
  `catalog-pages:${brandId}:${day}:${manual ? `manual:${manual}:` : ""}${step}`;

/**
 * Starts today's site-reader chain, unless one is queued or running for the brand. When today's chain already ran and
 * stopped (its budget, the site refused, or it finished), this is Sync now (or a second daily sync): a new `manual:<n>`
 * chain, since the completed `:0` job would swallow its key. The budgets still hold, so a spent day reads nothing more.
 * ponytail: check-then-create like requestCatalogSync; two at once can queue two chains, and the second one's
 * handler exits while the first runs (one chain per brand).
 */
export async function startPageChain(scope: Scope, day = new Date().toISOString().slice(0, 10)) {
  const where = { type: CATALOG_PAGES_JOB, workspaceId: scope.workspaceId, brandId: scope.brandId };
  // A step left from an earlier day doesn't count: it ends without reading when it runs.
  const alive = await prisma.job.findFirst({ where: { ...where, status: { in: ["PENDING", "RUNNING"] }, payload: { path: ["day"], equals: day } }, select: { id: true } });
  if (alive) return;
  const ranToday = await prisma.job.findUnique({ where: { idempotencyKey: pagesKey(scope.brandId, day, 0) }, select: { id: true } });
  const manual = ranToday
    ? 1 + (await prisma.job.count({ where: { ...where, idempotencyKey: { startsWith: `catalog-pages:${scope.brandId}:${day}:manual:`, endsWith: ":0" } } }))
    : undefined;
  await enqueueJob({
    type: CATALOG_PAGES_JOB,
    workspaceId: scope.workspaceId,
    brandId: scope.brandId,
    payload: { workspaceId: scope.workspaceId, brandId: scope.brandId, day, step: 0, ...(manual && { manual }) },
    idempotencyKey: pagesKey(scope.brandId, day, 0, manual),
  });
}

/** What the site reader has so far: live SITE products, and its pages read of those known. */
export async function siteProgress(scope: Scope, capped: boolean) {
  const where = { workspaceId: scope.workspaceId, brandId: scope.brandId };
  const [count, total, read] = await Promise.all([
    prisma.product.count({ where: { ...where, source: "SITE", archivedAt: null } }),
    prisma.catalogPage.count({ where }),
    prisma.catalogPage.count({ where: { ...where, readAt: { not: null } } }),
  ]);
  return { count, pages: { read, total, capped } };
}

/**
 * "Sync now": nothing new while this brand's sync is queued or running (a double click, two people), else a new job.
 * ponytail: check-then-create, so two presses in the same instant can queue two syncs. With the worker's parallel
 * loops they (or one with the daily or connect-time sync) can run at the same time. Saves are serialised per brand by
 * lockedSave; the two fetches may still run at once, and the later save wins: its fetch can be up to the 4-minute
 * deadline older, so a product the shop added in between can show archived until the next sync corrects it.
 */
export async function requestCatalogSync(scope: Scope) {
  if (await catalogSyncRunning(scope)) return { queued: false };
  await enqueueCatalogSync(scope);
  return { queued: true };
}

/** Daily sweep: every active brand with a website or a working Shopify connection. */
export async function enqueueDailyCatalogSyncs() {
  const day = new Date().toISOString().slice(0, 10);
  const brands = await prisma.brand.findMany({
    where: {
      status: "ACTIVE",
      // Leftover SHOPIFY rows too: their sync archives them once the store is gone and there is no website feed.
      OR: [
        { profile: { websiteUrl: { not: null } } },
        { connections: { some: { provider: "SHOPIFY", status: "ACTIVE" } } },
        { products: { some: { source: "SHOPIFY", archivedAt: null } } },
      ],
    },
    select: { id: true, workspaceId: true },
  });
  for (const b of brands) await enqueueCatalogSync({ workspaceId: b.workspaceId, brandId: b.id }, day);
}
