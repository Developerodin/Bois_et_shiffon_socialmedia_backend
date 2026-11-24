import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { appUrl } from "@/server/auth/tokens";
import type { ShopifyVariant } from "@/server/catalog/shopify";
import { shopifySized } from "@/server/research/brand-assets";
import { CrawlError, htmlText, safeFetchBytes } from "@/server/research/crawl";

/**
 * Shopify's Storefront Catalog MCP (https://shopify.dev/docs/agents/catalog/storefront-catalog): the second way to
 * connect a brand's Shopify store, products only. No install, no token, no orders or customers (those need AskCart).
 * `POST https://{store}/api/ucp/mcp`, JSON-RPC 2.0 over plain HTTP; every request carries our agent profile's public
 * URL in `params.arguments.meta["ucp-agent"].profile` (catalogMcpProfileUrl; served by app/api/v1/ucp/profile). Shopify
 * fetches that profile itself, so it must be public https: a localhost URL is refused ("invalid_profile_url").
 * No `initialize` is needed (the docs and the live store call tools/list and tools/call directly).
 *
 * The store host is typed by a person, so every call goes through the crawler's SSRF guard (safeFetchBytes: public
 * addresses only, pinned DNS, same-site redirects only for a POST), a 30 s timeout and a 10 MB cap. One retry on 429,
 * 5xx or a network failure. Answers are validated with zod and everything in them is untrusted data: capped, never
 * logged, never followed as instructions. Error messages carry the status and Shopify's error code only.
 *
 * Recorded 2026-11-24 against boisetchiffons.fr (myshopify 687541-22.myshopify.com) with Shopify's example profile:
 * tools/list → get_checkout, create_checkout, update_checkout, complete_checkout, cancel_checkout, get_cart,
 * create_cart, update_cart, cancel_cart, get_order, search_catalog, lookup_catalog, get_product (the list follows the
 * profile's capabilities). search_catalog arguments: { meta, catalog: { query?, context?, signals?, filters?:
 * { categories?, price?: { min?, max? }, available?: boolean (default true) }, pagination?: { cursor?, limit? } } };
 * "At least one of query or filters must be provided". The answer is in result.structuredContent (and again as JSON
 * text in result.content[0]): { ucp, products, pagination: { has_next_page, cursor }, messages }, no total_count.
 * Prices are integers in the currency's minor units. A product with its collections runs to ~30 KB, twice over.
 * Fixture: tests/fixtures/catalog-mcp.ts.
 */

/** Marks a SHOPIFY connection that reads through the Catalog MCP (kept in `scopes`, like ASKCART_SCOPE). */
export const MCP_SCOPE = "mcp";
export const isShopifyMcp = (conn: { scopes?: string[] }) => (conn.scopes ?? []).includes(MCP_SCOPE);

const MAX_BYTES = 10_000_000;
const TIMEOUT_MS = 30_000;
/** ~50 products ≈ 3 MB with the duplicated text; well under the cap. */
const PAGE_SIZE = 50;
const MAX_PAGES = 100;

/** Any failure talking to the store's MCP. `code`: Shopify's error code (e.g. profile_unreachable) or ours. */
export class CatalogMcpError extends Error {
  constructor(readonly status: number, readonly code: string | null) {
    super(`Catalog MCP ${status}${code ? ` ${code}` : ""}`);
  }
  /** The store answered 429 or 5xx (after the retry): busy or down for now, worth trying again later. */
  get busy() {
    return this.code === "upstream_busy";
  }
  /** Shopify couldn't fetch or read our agent profile: our setup, not the store's. */
  get profileProblem() {
    return this.code === "profile_unreachable" || this.code === "invalid_profile_url" || this.code === "invalid_profile";
  }
}

/**
 * The agent profile URL sent with every request: UCP_PROFILE_URL, else this app's /api/v1/ucp/profile. Null unless it
 * is https (Shopify refuses anything else), so a dev setup on localhost shows the option as not set up.
 */
export function catalogMcpProfileUrl(): string | null {
  let raw = process.env.UCP_PROFILE_URL?.trim();
  if (!raw) {
    try {
      raw = appUrl("/api/v1/ucp/profile");
    } catch {
      return null;
    }
  }
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * "my-store", "my-store.myshopify.com", "https://www.shop.fr/" or "shop.fr/products/x" → the host; else null. A
 * custom domain is allowed (Shopify serves the MCP there too); whether it really does is what the connect check finds.
 * No IP literals, ports or credentials: the TLD must be letters and anything after the host is dropped.
 */
export function mcpStoreHost(raw: string): string | null {
  let s = raw.trim().toLowerCase().replace(/^https?:\/\//, "");
  if (/[@:]/.test(s.split(/[/?#]/)[0])) return null;
  s = s.split(/[/?#]/)[0].replace(/\.$/, "");
  if (/^[a-z0-9][a-z0-9-]*$/.test(s)) s = `${s}.myshopify.com`;
  return HOST.test(s) ? s : null;
}

const RpcAnswer = z.object({
  result: z.unknown().optional(),
  error: z.object({ code: z.number().optional(), data: z.object({ code: z.unknown().optional() }).passthrough().nullish() }).passthrough().nullish(),
});
const errorCode = (v: unknown) => (typeof v === "string" && /^[a-z_]{1,40}$/.test(v) ? v : null);

let nextId = 1;

/** One JSON-RPC call. Throws CatalogMcpError (or CrawlError for a refused host or redirect). */
async function rpc(host: string, profile: string, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params: { ...params, arguments: { ...(params.arguments as object), meta: { "ucp-agent": { profile } } } } });
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await safeFetchBytes(`https://${host}/api/ucp/mcp`, "application/json", MAX_BYTES, signal, TIMEOUT_MS, { body });
    } catch (e) {
      // A redirect off the store's site (a custom domain pointing elsewhere), or too many: the address isn't the MCP's.
      if (e instanceof CrawlError && /redirect/i.test(e.message)) throw new CatalogMcpError(0, "redirected");
      if (e instanceof CrawlError || signal?.aborted || attempt > 0) throw e;
      await sleep(2000, undefined, { signal });
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      await sleep(2000, undefined, { signal });
      continue;
    }
    // Still busy after the retry: say so, whatever the body (often an HTML error page, which isn't "not a store").
    if (res.status === 429 || res.status >= 500) throw new CatalogMcpError(res.status, "upstream_busy");
    if (res.truncated) throw new CatalogMcpError(res.status, "too_large");
    let parsed;
    try {
      parsed = RpcAnswer.safeParse(JSON.parse(Buffer.from(res.bytes).toString("utf8")));
    } catch {
      parsed = null;
    }
    // An HTML page or other non-JSON-RPC answer: this host doesn't serve the Catalog MCP.
    if (!parsed?.success) throw new CatalogMcpError(res.status, "not_mcp");
    if (parsed.data.error) throw new CatalogMcpError(res.status, errorCode(parsed.data.error.data?.code) ?? `rpc_${parsed.data.error.code ?? "error"}`);
    if (res.status !== 200 || parsed.data.result === undefined) throw new CatalogMcpError(res.status, "not_mcp");
    return parsed.data.result;
  }
}

const SchemaProps = z.object({ properties: z.record(z.string(), z.unknown()).optional() }).passthrough();
const Tools = z.object({ tools: z.array(z.object({ name: z.string().max(100), inputSchema: z.unknown().optional() }).passthrough()).max(200) });

/**
 * The tools the store offers us, discovered at runtime. `enumerable`: search_catalog takes an `available` filter and a
 * pagination cursor, which is how the whole catalogue is walked without a query (searchAll).
 */
export async function catalogTools(host: string, profile: string, signal?: AbortSignal) {
  const parsed = Tools.safeParse(await rpc(host, profile, "tools/list", {}, signal));
  if (!parsed.success) throw new CatalogMcpError(200, "bad_tools");
  const names = new Set(parsed.data.tools.map((t) => t.name));
  const search = parsed.data.tools.find((t) => t.name === "search_catalog");
  const catalog = SchemaProps.safeParse(SchemaProps.safeParse(search?.inputSchema).data?.properties?.catalog).data?.properties;
  const filters = SchemaProps.safeParse(catalog?.filters).data?.properties;
  return { names, enumerable: Boolean(catalog?.pagination && filters?.available) };
}

const Page = z.object({
  products: z.array(z.unknown()).max(1000),
  pagination: z.object({ cursor: z.string().max(4000).nullish(), has_next_page: z.boolean().nullish() }).passthrough().nullish(),
});
const ToolResult = z.object({
  isError: z.boolean().nullish(),
  structuredContent: z.unknown().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).nullish(),
});

/** One search_catalog page: `catalog` as the tool takes it. The answer from structuredContent, else the JSON text. */
export async function searchCatalog(host: string, profile: string, catalog: Record<string, unknown>, signal?: AbortSignal) {
  const result = ToolResult.safeParse(await rpc(host, profile, "tools/call", { name: "search_catalog", arguments: { catalog } }, signal));
  if (!result.success) throw new CatalogMcpError(200, "bad_result");
  if (result.data.isError) throw new CatalogMcpError(200, "tool_error");
  let content = result.data.structuredContent;
  if (content === undefined) {
    try {
      content = JSON.parse(result.data.content?.find((c) => c.type === "text")?.text ?? "");
    } catch {
      content = undefined;
    }
  }
  const page = Page.safeParse(content);
  if (!page.success) throw new CatalogMcpError(200, "bad_result");
  // More pages whenever there is a cursor, unless has_next_page says false; "more" without a cursor can't be followed.
  const { cursor, has_next_page: more } = page.data.pagination ?? {};
  if (more === true && !cursor) throw new CatalogMcpError(200, "bad_pagination");
  return { products: page.data.products, cursor: cursor && more !== false ? cursor : null };
}

const Money = z.object({ amount: z.number().int().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) });
const Media = z.array(z.object({ type: z.string().nullish(), url: z.string().max(2000) }).passthrough()).max(100).catch([]);
const Variant = z.object({
  id: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/),
  sku: z.string().max(500).nullish().catch(null),
  title: z.string().max(1000).nullish().catch(null),
  price: Money.nullish().catch(null),
  list_price: Money.nullish().catch(null),
  availability: z.object({ available: z.boolean() }).passthrough().nullish().catch(null),
  media: Media.optional(),
}).passthrough();
const Product = z.object({
  title: z.string().max(2000),
  handle: z.string().max(500).nullish().catch(null),
  url: z.string().max(2000).nullish().catch(null),
  description: z.object({ plain: z.string().max(200_000).optional(), html: z.string().max(200_000).optional() }).passthrough().nullish().catch(null),
  media: Media.optional(),
  variants: z.array(z.unknown()).max(2000),
}).passthrough();

/** Minor units → "12.50" in the currency's own decimals (JPY has none). */
export function majorUnits(m: z.infer<typeof Money>): string {
  let digits = 2;
  try {
    digits = new Intl.NumberFormat("en", { style: "currency", currency: m.currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    // unknown code: two decimals
  }
  return (m.amount / 10 ** digits).toFixed(digits);
}

const imageOf = (media: z.infer<typeof Media> | undefined) => {
  const url = media?.find((m) => !m.type || m.type === "image")?.url;
  return url ? shopifySized(url) : null;
};

/**
 * Catalog MCP products → the variant shape shopifyRows maps (as AskCart's are), so all three ways of reading Shopify
 * write the same rows: the variant GID is the row's id, prices in major units, compare-at only when above the price.
 * A malformed product or variant is skipped and counted (`skipped`). No stock count (the MCP gives availability only) and no product type.
 */
export function mcpVariants(products: unknown[]): { variants: ShopifyVariant[]; currency: string | null; skipped: number } {
  const variants: ShopifyVariant[] = [];
  let currency: string | null = null;
  let skipped = 0;
  for (const raw of products) {
    const p = Product.safeParse(raw);
    if (!p.success) {
      skipped++;
      continue;
    }
    const d = p.data.description;
    const description = d?.plain ?? (d?.html ? htmlText(d.html) : "");
    const productImage = imageOf(p.data.media);
    for (const rawVariant of p.data.variants) {
      const v = Variant.safeParse(rawVariant);
      if (!v.success) {
        skipped++;
        continue;
      }
      const price = v.data.price;
      currency ??= price?.currency ?? null;
      const list = v.data.list_price;
      const image = imageOf(v.data.media) ?? productImage;
      variants.push({
        id: v.data.id,
        sku: v.data.sku ?? null,
        title: v.data.title ?? "",
        price: price ? majorUnits(price) : null,
        compareAtPrice: list && price && list.currency === price.currency && list.amount > price.amount ? majorUnits(list) : null,
        inventoryQuantity: null,
        availableForSale: v.data.availability?.available ?? false,
        product: {
          title: p.data.title,
          handle: p.data.handle ?? "",
          onlineStoreUrl: p.data.url ?? null,
          productType: "",
          description: description.slice(0, 20_000),
          status: "ACTIVE",
          featuredMedia: image ? { preview: { image: { url: image } } } : null,
        },
      });
    }
  }
  return { variants, currency, skipped };
}

/**
 * The store's whole catalogue, walked without a query: search_catalog filtered `available: true`, then
 * `available: false` (the filter is a choice, not a "don't care": false returns only the unavailable), each followed
 * page by page. `complete` only when both walks reached their last page under the caps; else nothing is archived.
 * ponytail: what Storefront search doesn't return is never seen, so a complete walk archives it: products not
 * published to the Online Store, or hidden from search. Shopify gives no total to check against. Caps: MAX_PAGES pages
 * of PAGE_SIZE per walk and `maxVariants` overall, all within the caller's deadline (`signal`); a bigger catalogue
 * stays incomplete (no resume across runs as AskCart's walk has; add one if a store needs it).
 * A store whose search_catalog takes no `available` filter can't be walked: nothing read, incomplete. A walk in which
 * any product or variant failed validation is incomplete too (`skipped` counts them).
 */
export async function mcpCatalog(host: string, profile: string, maxVariants: number, signal?: AbortSignal) {
  const { names, enumerable } = await catalogTools(host, profile, signal);
  if (!names.has("search_catalog")) throw new CatalogMcpError(200, "no_search_catalog");
  if (!enumerable) return { variants: [], currency: null, complete: false, skipped: 0 };
  const byId = new Map<string, ShopifyVariant>();
  let currency: string | null = null;
  let skipped = 0;
  const partial = () => ({ variants: [...byId.values()], currency, complete: false, skipped });
  for (const available of [true, false]) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES || byId.size > maxVariants) return partial();
      const res = await searchCatalog(host, profile, { filters: { available }, pagination: { limit: PAGE_SIZE, ...(cursor && { cursor }) } }, signal);
      const read = mcpVariants(res.products);
      currency ??= read.currency;
      skipped += read.skipped;
      for (const v of read.variants) byId.set(v.id, v);
      if (!res.cursor) break;
      // A cursor seen before would loop forever: stop as partial.
      if (seen.has(res.cursor)) return partial();
      seen.add(res.cursor);
      cursor = res.cursor;
    }
  }
  // Something the store sent couldn't be read: what it was can't be told from a removed product, so nothing is archived.
  return skipped ? partial() : { variants: [...byId.values()], currency, complete: true, skipped };
}

/** The connect check: the store answers tools/list with search_catalog and one filtered search succeeds. */
export async function checkCatalogMcp(host: string, profile: string, signal?: AbortSignal) {
  const { names } = await catalogTools(host, profile, signal);
  if (!names.has("search_catalog")) throw new CatalogMcpError(200, "no_search_catalog");
  await searchCatalog(host, profile, { filters: { available: true }, pagination: { limit: 1 } }, signal);
}
