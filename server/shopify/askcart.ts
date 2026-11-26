import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Prisma } from "@prisma/client";
import type { ShopifyVariant } from "@/server/catalog/shopify";
import { BodyTooLarge, cappedText } from "@/server/integrations/capped-text";
import { ReconnectNeeded } from "@/server/services/reconnect-needed";

/**
 * Client for AskCart's partner API (contract: the AskCart repo's docs/partner-api.md; plan 2026-11-24-phase-3-crm,
 * "Shopify access through AskCart"). AskCart holds the store's Shopify install and serves its catalogue and order
 * totals; no Shopify token ever reaches this platform. Two modes, chosen by env (askCartConfig):
 *
 * - per-brand (the target): AskCart is a public Shopify app. A brand connects from our Connections (portal-initiated,
 *   PKCE; server/shopify/askcart-connect.ts) and gets its own AskCart token, stored encrypted on its SHOPIFY
 *   connection like any provider token (account id = the shop domain, ASKCART_SCOPE among its scopes). Env:
 *   ASKCART_URL, ASKCART_CLIENT_ID, ASKCART_CLIENT_SECRET.
 * - single-store (INTERIM, until AskCart ships the per-brand connect): AskCart serves B&C's store only, behind one
 *   shared secret (ASKCART_SECRET). One brand per deployment attaches it (account id ASKCART_ACCOUNT, no token stored).
 *   Remove this mode, ASKCART_ACCOUNT and guardAskCartBrand once every deployment has a client id.
 *
 * The secret and tokens only ever go in the Authorization header or the token request body: never in a message, a log
 * or a job payload. Plain fetch, not the crawler's safeFetch: ASKCART_URL is set by the operator, not taken from a
 * person, so there is no SSRF to guard (and safeFetch's public-address check would refuse a dev AskCart on localhost).
 * Redirects are refused (fetch would carry the Authorization header along), each call has a 30 s timeout and the body
 * is capped at 10 MB.
 */
/** INTERIM single-store mode: the account id of the one connection that reads through ASKCART_SECRET. */
export const ASKCART_ACCOUNT = "askcart";
/** Marks a SHOPIFY connection that reads through AskCart (kept in `scopes`, so no schema change; see isAskCart). */
export const ASKCART_SCOPE = "askcart";
/**
 * A SHOPIFY connection that reads through AskCart rather than a pasted Admin token.
 * ponytail: a marker in `scopes` rather than a column or a provider value (no migration, no enum fan-out); a
 * token connect of the same shop replaces the scopes and so turns it back into a token connection. Move it to a
 * column if anything else starts writing scopes.
 */
export const isAskCart = (conn: { externalAccountId: string; scopes?: string[] }) =>
  conn.externalAccountId === ASKCART_ACCOUNT || (conn.scopes ?? []).includes(ASKCART_SCOPE);

export const ASKCART_REFUSED = "AskCart can't reach the store. Open AskCart in Shopify admin to reconnect it, then connect Shopify via AskCart again.";
export const ASKCART_KEY_REFUSED = "AskCart no longer accepts this platform's access to the store. Connect Shopify via AskCart again.";
export const ASKCART_MODE_CHANGED = "AskCart now connects each store on its own. Connect Shopify via AskCart again.";
export const ASKCART_SCOPE_MISSING = "This platform's AskCart access doesn't cover this data. Connect Shopify via AskCart again to grant it.";
/**
 * Not a reconnect: AskCart's own Shopify access lapsed (503 store_reconnect_needed). Our token stays valid; the
 * merchant opens AskCart once in Shopify admin and the next sync works.
 */
export const ASKCART_STORE_LAPSED = "AskCart lost its access to the store. Open AskCart once in Shopify admin; the next sync then works.";
/**
 * The reason shown in Connections for a ReconnectNeeded from AskCart: our access (401), a scope the token lacks (403),
 * a connection from the other mode (askCartToken), or the store's install (legacy secret's 503).
 */
export const askCartReason = (e: Error) =>
  e.message.startsWith("AskCart 401") ? ASKCART_KEY_REFUSED
  : e.message.startsWith("AskCart 403") ? ASKCART_SCOPE_MISSING
  : e.message.startsWith("AskCart mode") ? ASKCART_MODE_CHANGED
  : ASKCART_REFUSED;
/** AskCart's own Shopify access lapsed: temporary, not our connection's fault (see ASKCART_STORE_LAPSED). */
export const isAskCartStoreLapsed = (e: unknown) => e instanceof AskCartError && e.code === "store_reconnect_needed";

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

export type AskCartConfig =
  | { mode: "per-brand"; url: string; clientId: string; clientSecret: string }
  | { mode: "single-store"; url: string; secret: string };

/** per-brand when the client id and secret are set; else single-store (INTERIM) when ASKCART_SECRET is; else null. */
export function askCartConfig(): AskCartConfig | null {
  const env = (k: string) => process.env[k]?.trim() || null;
  const url = env("ASKCART_URL")?.replace(/\/+$/, "");
  if (!url) return null;
  const clientId = env("ASKCART_CLIENT_ID");
  const clientSecret = env("ASKCART_CLIENT_SECRET");
  if (clientId) return clientSecret ? { mode: "per-brand", url, clientId, clientSecret } : null;
  const secret = env("ASKCART_SECRET");
  return secret ? { mode: "single-store", url, secret } : null;
}

export type AskCartMoney = { amount: string; currencyCode: string };
export type AskCartPage<T> = {
  items: T[];
  nextCursor: string | null;
  complete: boolean;
  rateLimited?: boolean;
  /** Ours, not AskCart's body: the Retry-After header (seconds) of a page cut short (rateLimited), when it sent one. */
  retryAfter?: number;
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
  // Additive fields (partner API §9): optional because an AskCart that predates them doesn't send them.
  displayFulfillmentStatus?: string | null;
  displayFinancialStatus?: string | null;
  discountCodes?: string[] | null;
  /** The first 100; absent = not sent (the stored lines stay). */
  lineItems?: AskCartLineItem[] | null;
  lineItemsTruncated?: boolean | null;
};
export type AskCartLineItem = {
  id: string;
  /** null (with variantTitle) when productId is: custom lines and deleted products. */
  title: string | null;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  currentQuantity?: number | null;
  /** null when the product or variant was deleted from the store */
  productId: string | null;
  variantId: string | null;
  originalUnitPriceSet: AskCartMoney | null;
  /** Includes refunded units. */
  discountedTotalSet: AskCartMoney | null;
  /** Unit price after line and order-level discounts (AskCart 3e05bfc on). */
  discountedUnitPriceAfterAllDiscountsSet?: AskCartMoney | null;
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
  // Additive fields (partner API §9): optional because an AskCart that predates them doesn't send them.
  vendor?: string | null;
  tags?: string[] | null;
  collections?: { id: string; title: string; handle: string }[] | null;
  /** Shopify was busy and not every variant could be read: the ones missing aren't gone. */
  variantsTruncated?: boolean | null;
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
/**
 * Gap between two requests on one bearer: AskCart allows 60 a minute per token, and the orders and catalogue syncs
 * share it. Each call reserves the next free slot before waiting, so two at once still go 1.1 s apart.
 * ponytail: per process. Two server processes running syncs for one brand could reach 2 a second; then the 429
 * retries below take over. Move the slots to Postgres or Redis if that shows up in the logs.
 */
export const PACE_MS = 1100;
/** Keyed by a hash of the bearer, so the token itself isn't kept in memory longer than its request. */
const nextSlot = new Map<string, number>();
/** Tests: their waits return at once, so the reserved slots would pile up from one test to the next. */
export const resetAskCartPace = () => nextSlot.clear();
async function pace(bearer: string, signal?: AbortSignal) {
  const now = Date.now();
  const key = createHash("sha256").update(bearer).digest("base64url");
  const slot = Math.max(now, nextSlot.get(key) ?? 0);
  nextSlot.set(key, slot + PACE_MS);
  // A slot well in the past is dead weight: forget tokens idle for a minute (keeps the map to the active ones).
  for (const [k, v] of nextSlot) if (v < now - 60_000) nextSlot.delete(k);
  if (slot > now) await sleep(slot - now, "pace", { signal }); // the value tells tests these waits apart
}
const RETRIES = 2;
const MAX_RETRY_WAIT_S = 30;

/**
 * One call to `${ASKCART_URL}/api/partner/<path>`. `bearer` is the brand's token (or the INTERIM shared secret); the
 * token endpoint takes none. 429 and 503 shopify_throttled wait Retry-After (at most 30 s) and retry, twice; then
 * AskCartError. A bearer call answered 401, 403 insufficient_scope or (legacy secret) 503 store_not_connected throws
 * ReconnectNeeded: someone has to connect again. 503 store_reconnect_needed is an AskCartError, not retried here: our
 * token stays valid and the merchant only has to open AskCart in Shopify admin (isAskCartStoreLapsed). Everything
 * else that isn't 2xx throws AskCartError (403 read_all_orders_pending carries visibleSince). 204 → null.
 */
export async function askCartRequest<T>(
  path: string,
  opts: {
    bearer?: string;
    method?: "GET" | "POST" | "DELETE";
    params?: Record<string, string>;
    body?: unknown;
    signal?: AbortSignal;
    /** false: a rate limit fails at once (no Retry-After wait) */
    retry?: boolean;
  } = {},
): Promise<T> {
  const cfg = askCartConfig();
  if (!cfg) throw new AskCartError(0, "not_configured");
  const { params = {}, signal } = opts;
  const url = `${cfg.url}/api/partner/${path}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ""}`;
  for (let attempt = 0; ; attempt++) {
    if (opts.bearer !== undefined) await pace(opts.bearer, signal);
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      redirect: "error",
      headers: {
        accept: "application/json",
        ...(opts.bearer !== undefined && { authorization: `Bearer ${opts.bearer}` }),
        ...(opts.body !== undefined && { "content-type": "application/json" }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    let text: string;
    try {
      text = await cappedText(res, MAX_BYTES);
    } catch (e) {
      throw e instanceof BodyTooLarge ? new AskCartError(res.status, "too_large") : e;
    }
    if (res.status === 204) return null as T;
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON: a proxy's error page; handled by status below
    }
    if (res.ok && body && typeof body === "object") {
      // A list page cut short (200 with rateLimited) says how long to wait in Retry-After: handed to the caller.
      const after = Number(res.headers.get("retry-after"));
      if ((body as { rateLimited?: unknown }).rateLimited === true && res.headers.has("retry-after") && Number.isFinite(after) && after >= 0) {
        // At least 1 s: a "0" would have a run ask again at once, in a loop, while the store's budget refills.
        (body as { retryAfter?: number }).retryAfter = Math.max(1, after);
      }
      return body as T;
    }
    const { error, visibleSince } = (body ?? {}) as { error?: unknown; visibleSince?: unknown };
    // AskCart's codes are short identifiers; anything else (an HTML page) is dropped rather than echoed.
    const code = typeof error === "string" && /^[a-z_]{1,60}$/.test(error) ? error : null;
    // 403 insufficient_scope: the token lacks a scope it needs and never gains one; only a new connect fixes it.
    const storeGone = (res.status === 503 && code === "store_not_connected") || (res.status === 403 && code === "insufficient_scope");
    if (opts.bearer !== undefined && (res.status === 401 || storeGone)) throw new ReconnectNeeded(`AskCart ${res.status}${code ? ` ${code}` : ""}`);
    const err = new AskCartError(res.ok ? 502 : res.status, res.ok ? "bad_body" : code, typeof visibleSince === "string" ? visibleSince : null);
    const wait = Number(res.headers.get("retry-after") ?? 2);
    if (err.rateLimited && opts.retry !== false && attempt < RETRIES && Number.isFinite(wait) && wait >= 0 && wait <= MAX_RETRY_WAIT_S) {
      await sleep(wait * 1000, undefined, { signal });
      continue;
    }
    throw err;
  }
}

export const askCartShop = (bearer: string, signal?: AbortSignal) =>
  askCartRequest<{ name: string; currencyCode: string; domain?: string }>("shop", { bearer, signal });

/** One page of orders; pass the previous page's nextCursor with the same query. */
export function askCartOrders(bearer: string, query: OrdersQuery, cursor: string | null, signal?: AbortSignal) {
  const params: Record<string, string> =
    "updatedSince" in query ? { updatedSince: query.updatedSince.toISOString() } : { createdFrom: query.createdFrom, createdTo: query.createdTo };
  if (cursor) params.cursor = cursor;
  return askCartRequest<AskCartPage<AskCartOrder>>("orders", { bearer, params, signal });
}

/**
 * An AskCart product's variants in the Admin GraphQL shape the catalogue sync maps (shopifyRows), so it doesn't change.
 * availableForSale is always a boolean, so every row a walk sees reports stock and gets stockCheckedAt: a walk that
 * resumes across runs archives by that (saveRows' seenSince).
 */
export const askCartVariants = (p: AskCartProduct): ShopifyVariant[] =>
  p.variants.map((v) => ({
    id: v.id,
    sku: v.sku,
    title: v.title,
    price: v.price?.amount ?? null,
    compareAtPrice: v.compareAtPrice?.amount ?? null,
    inventoryQuantity: v.inventoryQuantity,
    availableForSale: v.availableForSale === true,
    product: {
      title: p.title,
      handle: p.handle,
      onlineStoreUrl: p.onlineStoreUrl,
      productType: p.productType,
      description: p.description,
      status: p.status,
      featuredMedia: p.featuredImageUrl ? { preview: { image: { url: p.featuredImageUrl } } } : null,
      // Only what AskCart sent: a key left out keeps the stored value (shopifyRows, saveRows).
      ...(p.vendor !== undefined && { vendor: p.vendor }),
      ...(p.tags !== undefined && { tags: p.tags }),
      ...(p.collections !== undefined && { collections: p.collections }),
    },
  }));

const MAX_PAGES = 50;

/**
 * The store's active variants from `cursor` on (null = the start), shaped like shopifyVariants' answer. `complete` only
 * when AskCart said so: a page cut short by Shopify's throttle (rateLimited), the page cap or `maxVariants` (checked
 * between pages) stops the walk and returns the cursor to resume from next run. Currency is the prices' (the shop's).
 * `truncated`: how many products came with variantsTruncated (some variants unread, not removed), logged here; the
 * sync archives nothing on a walk that saw one.
 * ponytail: one page (up to 50 products) can hold their variants past `maxVariants`; 50 pages are 2,500 products a run.
 */
export async function askCartCatalog(bearer: string, cursor: string | null, maxVariants: number, signal?: AbortSignal) {
  const variants: ShopifyVariant[] = [];
  let currency: string | null = null;
  let truncated = 0;
  const out = (complete: boolean, next: string | null) => {
    if (truncated) console.warn("[askcart] products sent without all their variants (store busy)", truncated);
    return { variants, currency, complete, cursor: next, truncated };
  };
  for (let page = 0; page < MAX_PAGES && variants.length < maxVariants; page++) {
    const res: AskCartPage<AskCartProduct> = await askCartRequest("products", { bearer, params: cursor ? { cursor } : {}, signal });
    for (const p of res.items ?? []) {
      variants.push(...askCartVariants(p).filter((v) => v.product.status === "ACTIVE"));
      currency ??= p.variants.find((v) => v.price)?.price?.currencyCode ?? null;
      if (p.variantsTruncated === true) truncated++;
    }
    if (res.complete && !res.rateLimited) return out(true, null);
    // rateLimited with no cursor: nothing on this page was read, so the same cursor is asked again next run
    if (res.rateLimited || !res.nextCursor) return out(false, res.nextCursor ?? cursor);
    cursor = res.nextCursor;
  }
  return out(false, cursor);
}

/** What AskCart's token endpoint answers: a long-lived opaque token, or an access token with a refresh token. */
export type AskCartToken = {
  access_token: string;
  refresh_token?: string | null;
  expires_in?: number | null;
  shop?: { domain: string; name: string; currencyCode?: string };
  scopes?: string[];
};

/**
 * POST /api/partner/token with our client id and secret: `grant` is the code exchange (code, redirect_uri,
 * code_verifier) or a refresh (refresh_token). Per-brand mode only. A 4xx is an AskCartError (the code or refresh token
 * was refused); the body is never echoed.
 */
export async function askCartTokenRequest(grant: { grant_type: "authorization_code"; code: string; redirect_uri: string; code_verifier: string } | { grant_type: "refresh_token"; refresh_token: string }) {
  const cfg = askCartConfig();
  if (cfg?.mode !== "per-brand") throw new AskCartError(0, "not_configured");
  // Never retry a code exchange: AskCart treats a reused code as theft and revokes the token the first call issued.
  const tok = await askCartRequest<AskCartToken>("token", { method: "POST", body: { ...grant, client_id: cfg.clientId, client_secret: cfg.clientSecret }, retry: grant.grant_type !== "authorization_code" });
  if (typeof tok?.access_token !== "string" || !tok.access_token) throw new AskCartError(502, "bad_body");
  return tok;
}

/** Per-brand mode: tell AskCart to forget this brand's token (Disconnect). Best effort: the caller ignores failures. */
export const askCartRevoke = (bearer: string, signal?: AbortSignal) => askCartRequest<null>("token", { method: "DELETE", bearer, signal, retry: false });

/**
 * INTERIM single-store mode only. One brand per deployment may attach AskCart: its secret is locked to one store
 * (B&C's) on AskCart's side, so a second brand attached to it would read B&C's products and sales as its own. Run
 * inside the transaction that saves the connection (saveConnections' `guard`); the advisory lock makes two connects
 * at once take turns.
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
