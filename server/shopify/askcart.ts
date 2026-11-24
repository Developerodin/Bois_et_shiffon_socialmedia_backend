import { setTimeout as sleep } from "node:timers/promises";
import type { Prisma } from "@prisma/client";
import type { ShopifyVariant } from "@/server/catalog/shopify";
import { ReconnectNeeded } from "@/server/services/reconnect-needed";

/**
 * Read client for AskCart's partner API (contract: the AskCart repo's docs/partner-api.md; plan 2026-11-24-phase-3-crm,
 * "Shopify access through AskCart"). AskCart holds B&C's Shopify install and serves its catalogue and order totals;
 * no Shopify token ever reaches this platform. Env: ASKCART_URL (base, e.g. https://askcart.example) and ASKCART_SECRET.
 *
 * A brand reads through AskCart when its SHOPIFY connection's account id is ASKCART_ACCOUNT (never a valid
 * .myshopify.com domain, so it can't collide with a pasted-token connection). That connection stores no secret: the
 * secret stays in env and is only ever put in the Authorization header, never in a message, a log or a job payload.
 *
 * Plain fetch, not the crawler's safeFetch: ASKCART_URL is set by the operator, not taken from a person, so there is no
 * SSRF to guard (and safeFetch's public-address check would refuse a dev AskCart on localhost). Redirects are refused
 * (fetch would carry the Authorization header along), each call has a 30 s timeout and the body is capped at 10 MB.
 */
export const ASKCART_ACCOUNT = "askcart";
export const isAskCart = (conn: { externalAccountId: string }) => conn.externalAccountId === ASKCART_ACCOUNT;

export const ASKCART_REFUSED = "AskCart can't reach the store. Open AskCart in Shopify admin to reconnect it, then connect Shopify via AskCart again.";
export const ASKCART_KEY_REFUSED = "AskCart refused this platform's key. An admin must check ASKCART_SECRET, then connect Shopify via AskCart again.";
/** The reason shown in Connections for a ReconnectNeeded thrown here: our key (401) or the store's install (503). */
export const askCartReason = (e: Error) => (e.message.startsWith("AskCart 401") ? ASKCART_KEY_REFUSED : ASKCART_REFUSED);

/** Any other non-2xx answer, a body that isn't JSON or one over the cap. Carries the status and AskCart's code only. */
export class AskCartError extends Error {
  constructor(readonly status: number, readonly code: string | null, readonly visibleSince: string | null = null) {
    super(`AskCart ${status}${code ? ` ${code}` : ""}`);
  }
  /** AskCart's own 60-a-minute limit (429) or Shopify's throttle (503 shopify_throttled), still there after the retries. */
  get rateLimited() {
    return this.status === 429 || this.code === "shopify_throttled";
  }
}

export function askCartConfig(): { url: string; secret: string } | null {
  const url = process.env.ASKCART_URL?.trim().replace(/\/+$/, "");
  const secret = process.env.ASKCART_SECRET?.trim();
  return url && secret ? { url, secret } : null;
}

export type AskCartMoney = { amount: string; currencyCode: string };
export type AskCartPage<T> = {
  items: T[];
  nextCursor: string | null;
  complete: boolean;
  rateLimited?: boolean;
  /** Orders only: an incremental read leaves out orders created before visibleSince until read_all_orders is approved. */
  warning?: { code: string; visibleSince: string };
};
export type AskCartOrder = {
  id: string;
  name: string;
  processedAt: string;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  test: boolean;
  taxesIncluded: boolean;
  sourceName: string | null;
  currentSubtotalPriceSet: AskCartMoney;
  currentTotalDiscountsSet: AskCartMoney | null;
  currentShippingPriceSet: AskCartMoney | null;
  currentTotalPriceSet: AskCartMoney;
  totalRefundedSet: AskCartMoney | null;
  currentTaxLines: { title: string; rate: number | null; priceSet: AskCartMoney }[];
};
export type AskCartProduct = {
  id: string;
  title: string;
  handle: string;
  onlineStoreUrl: string | null;
  productType: string;
  description: string;
  status: string;
  featuredImageUrl: string | null;
  variants: {
    id: string;
    sku: string | null;
    title: string;
    price: AskCartMoney | null;
    compareAtPrice: AskCartMoney | null;
    inventoryQuantity: number | null;
    availableForSale: boolean;
  }[];
};
/** Exactly one mode: incremental by update time, or a backfill of creation days (YYYY-MM-DD, inclusive). */
export type OrdersQuery = { updatedSince: Date } | { createdFrom: string; createdTo: string };

const MAX_BYTES = 10_000_000;
const RETRIES = 2;
const MAX_RETRY_WAIT_S = 30;

async function cappedText(res: Response) {
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new AskCartError(res.status, "too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * One GET. 429 and 503 shopify_throttled wait Retry-After (at most 30 s) and retry, twice; then AskCartError.
 * 401 (our secret) and 503 store_not_connected / store_reconnect_needed throw ReconnectNeeded: a person has to act.
 * Everything else that isn't 200 throws AskCartError (403 read_all_orders_pending carries visibleSince).
 */
export async function askCartGet<T>(path: string, params: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
  const cfg = askCartConfig();
  if (!cfg) throw new AskCartError(0, "not_configured");
  const url = `${cfg.url}/api/partner/${path}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ""}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      redirect: "error",
      headers: { accept: "application/json", authorization: `Bearer ${cfg.secret}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    const text = await cappedText(res);
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON: a proxy's error page; handled by status below
    }
    if (res.ok && body && typeof body === "object") return body as T;
    const { error, visibleSince } = (body ?? {}) as { error?: unknown; visibleSince?: unknown };
    // AskCart's codes are short identifiers; anything else (an HTML page) is dropped rather than echoed.
    const code = typeof error === "string" && /^[a-z_]{1,60}$/.test(error) ? error : null;
    if (res.status === 401 || (res.status === 503 && (code === "store_not_connected" || code === "store_reconnect_needed"))) {
      throw new ReconnectNeeded(`AskCart ${res.status}${code ? ` ${code}` : ""}`);
    }
    const err = new AskCartError(res.ok ? 502 : res.status, res.ok ? "bad_body" : code, typeof visibleSince === "string" ? visibleSince : null);
    const wait = Number(res.headers.get("retry-after") ?? 2);
    if (err.rateLimited && attempt < RETRIES && Number.isFinite(wait) && wait >= 0 && wait <= MAX_RETRY_WAIT_S) {
      await sleep(wait * 1000, undefined, { signal });
      continue;
    }
    throw err;
  }
}

export const askCartShop = (signal?: AbortSignal) => askCartGet<{ name: string; currencyCode: string }>("shop", {}, signal);

/** One page of orders; pass the previous page's nextCursor with the same query. */
export function askCartOrders(query: OrdersQuery, cursor: string | null, signal?: AbortSignal) {
  const params: Record<string, string> =
    "updatedSince" in query ? { updatedSince: query.updatedSince.toISOString() } : { createdFrom: query.createdFrom, createdTo: query.createdTo };
  if (cursor) params.cursor = cursor;
  return askCartGet<AskCartPage<AskCartOrder>>("orders", params, signal);
}

/** An AskCart product's variants in the Admin GraphQL shape the catalogue sync maps (shopifyRows), so it doesn't change. */
export const askCartVariants = (p: AskCartProduct): ShopifyVariant[] =>
  p.variants.map((v) => ({
    id: v.id,
    sku: v.sku,
    title: v.title,
    price: v.price?.amount ?? null,
    compareAtPrice: v.compareAtPrice?.amount ?? null,
    inventoryQuantity: v.inventoryQuantity,
    availableForSale: v.availableForSale,
    product: {
      title: p.title,
      handle: p.handle,
      onlineStoreUrl: p.onlineStoreUrl,
      productType: p.productType,
      description: p.description,
      status: p.status,
      featuredMedia: p.featuredImageUrl ? { preview: { image: { url: p.featuredImageUrl } } } : null,
    },
  }));

const MAX_PAGES = 50;

/**
 * Every variant of the store's active products, shaped like shopifyVariants' answer. `complete` only when AskCart said
 * so on the last page: a page cut short by Shopify's throttle (rateLimited) or the page cap stops the walk as partial
 * (nothing archived) and returns AskCart's cursor. Currency is the prices' (always the shop's).
 * ponytail: 50 pages × 100 products a run, one walk from the start each time; a bigger store stays partial until the
 * cursor is kept between runs.
 */
export async function askCartCatalog(signal?: AbortSignal) {
  const variants: ShopifyVariant[] = [];
  let currency: string | null = null;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res: AskCartPage<AskCartProduct> = await askCartGet("products", cursor ? { cursor } : {}, signal);
    for (const p of res.items ?? []) {
      variants.push(...askCartVariants(p).filter((v) => v.product.status === "ACTIVE"));
      currency ??= p.variants.find((v) => v.price)?.price?.currencyCode ?? null;
    }
    if (res.complete && !res.rateLimited) return { variants, currency, complete: true, cursor: null };
    if (res.rateLimited || !res.nextCursor) return { variants, currency, complete: false, cursor: res.nextCursor ?? cursor };
    cursor = res.nextCursor;
  }
  return { variants, currency, complete: false, cursor };
}

/**
 * Only one brand per deployment may attach AskCart: its secret is locked to one store (B&C's) on AskCart's side, so
 * a second brand attached to it would read B&C's products and sales as its own. Run inside the transaction that saves
 * the connection (saveConnections' `guard`); the advisory lock makes two connects at once take turns.
 */
export class AskCartTaken extends Error {}
export async function guardAskCartBrand(tx: Prisma.TransactionClient, brandId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('askcart:attach'))`;
  const other = await tx.integrationConnection.findFirst({
    where: { provider: "SHOPIFY", externalAccountId: ASKCART_ACCOUNT, status: { not: "REVOKED" }, brandId: { not: brandId } },
    select: { id: true },
  });
  if (other) throw new AskCartTaken("AskCart is already connected to another brand");
}
