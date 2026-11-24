import { httpUrl, parsePrice, str, syncedRow, variantTitle, type SyncedRow } from "@/server/catalog/sync";
import { amountOf } from "@/server/content/product-checks";
import { htmlText, jsonLdNodes, sameSite, type LdNode } from "@/server/research/crawl";

/** At most this many rows from one page (a page listing more is cut, not refused). */
export const MAX_PAGE_ROWS = 200;
// Raw text read per field before stripping HTML: a 5,000-char description never needs more, and a hostile 1 MB one
// would otherwise be stripped once per variant.
const RAW_TEXT = 20_000;
// The keys that lead from a top-level node to the page's own products; any other nesting (a review's itemReviewed,
// an offer's itemOffered, accessories, related products, list items) describes some other product.
const OWN_KEYS = ["@graph", "mainEntity", "hasVariant"];

// Orderable counts as in stock, as Shopify's `available` does for a product sold on backorder.
const AVAILABILITY: Record<string, boolean> = { InStock: true, PreOrder: true, BackOrder: true, OutOfStock: false };

const types = (n: LdNode) => [n["@type"]].flat().map(String);
const isObject = (v: unknown): v is LdNode => !!v && typeof v === "object" && !Array.isArray(v);
const objects = (v: unknown) => [v].flat(Infinity).filter(isObject);
/** "12345" or 12345 (sku, gtin13, mpn) → "12345". */
const code = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : str(v, 100));
/** "12.50", 12.5, and as a last resort "1 299,00" or "1.299,00" (amountOf) → "1299.00". */
const price = (v: unknown) => parsePrice(v) ?? (typeof v === "string" && /^[\d\s.,]+$/.test(v.trim()) && /\d/.test(v) ? parsePrice(amountOf(v)) : null);

/** A string, an array of them, or an ImageObject → the first non-empty image link. */
const ldImage = (v: unknown): string | undefined => {
  if (Array.isArray(v)) return v.map(ldImage).find(Boolean);
  if (isObject(v)) return ldImage(v.url ?? v.contentUrl);
  return typeof v === "string" && v.trim() ? v : undefined;
};

/**
 * Products a product page describes in its JSON-LD (schema.org Product, and ProductGroup.hasVariant), one row per
 * product or variant, first one wins per key. Only top-level, @graph, mainEntity and hasVariant products count.
 * Everything in the page is untrusted: text becomes plain text, links http(s) only, a canonical link to another
 * site falls back to the page's own address.
 */
export function pageProducts(html: string, pageUrl: string): SyncedRow[] {
  const page = new URL(pageUrl);
  /** A link resolved against the page, kept only when it is http(s). */
  const abs = (v: unknown) => {
    try {
      return typeof v === "string" ? httpUrl(new URL(v.trim(), page).toString()) : null;
    } catch {
      return null;
    }
  };
  /** The same, on the page's own site only (product links; images may sit on a CDN). */
  const own = (v: unknown) => {
    const u = abs(v);
    return u && sameSite(new URL(u).hostname, page.hostname) ? u : null;
  };
  // Variants usually repeat the group's description: each distinct text is stripped once.
  const texts = new Map<string, string | null>();
  const text = (v: unknown, max: number) => {
    if (typeof v !== "string") return null;
    const raw = v.slice(0, RAW_TEXT);
    if (!texts.has(raw)) texts.set(raw, htmlText(raw));
    return str(texts.get(raw), max);
  };
  const nodes = jsonLdNodes(html);

  // The page's own nodes: those no other node contains, then down OWN_KEYS only.
  const nested = new Set<unknown>(nodes.flatMap((n) => Object.values(n).flatMap(objects)));
  const mine = new Set<LdNode>();
  const visit = (n: LdNode) => {
    if (mine.has(n)) return;
    mine.add(n);
    for (const k of OWN_KEYS) objects(n[k]).forEach(visit);
  };
  nodes.filter((n) => !nested.has(n)).forEach(visit);

  const groupOf = new Map<LdNode, { group: LdNode; n: number }>();
  for (const node of mine) if (types(node).includes("ProductGroup")) objects(node.hasVariant).forEach((v, n) => groupOf.set(v, { group: node, n }));
  const crumbs = nodes.find((n) => types(n).includes("BreadcrumbList"))?.itemListElement;
  const crumbNames = (Array.isArray(crumbs) ? crumbs : []).map((c) => text(isObject(c) ? (c.name ?? (isObject(c.item) ? c.item.name : null)) : null, 120));

  const found: { row: SyncedRow; n?: number; ownLink: boolean }[] = [];
  for (const node of mine) {
    if (found.length >= MAX_PAGE_ROWS) break;
    if (!types(node).includes("Product")) continue;
    const { group, n } = groupOf.get(node) ?? {};
    const field = (k: string) => node[k] ?? group?.[k];
    const name = text(field("name"), 200);
    if (!name) continue;
    // Variants sharing the group's name ("Sofa" × 8) are told apart by what they vary by.
    const varies = group ? [node.color, node.size].map((v) => text(v, 60)).filter((v): v is string => !!v && !name.includes(v)) : [];
    const offer = objects(node.offers)[0] ?? objects(group?.offers)[0];
    const link = own(node.url) ?? own(objects(node.offers)[0]?.url);
    const url = link ?? own(group?.url) ?? page.toString();
    const sku = code(node.sku) ?? code(node.gtin13) ?? code(node.mpn);
    const currency = typeof offer?.priceCurrency === "string" && /^[A-Z]{3}$/.test(offer.priceCurrency) ? offer.priceCurrency : null;
    const availability = typeof offer?.availability === "string" ? /([A-Za-z]+)\/?$/.exec(offer.availability)?.[1] : undefined;
    const category = typeof field("category") === "string" ? field("category") : crumbNames.filter((c) => c && c !== name).at(-1);
    found.push({
      n,
      ownLink: !!link,
      row: syncedRow({
        externalId: sku ? `sku:${sku}` : `url:${url}`,
        sku,
        title: varies.length ? variantTitle(name, varies.join(" / ")) : name,
        url,
        category: text(category, 120),
        description: text(field("description"), 5000),
        price: price(offer?.price ?? offer?.lowPrice),
        compareAtPrice: null,
        currency,
        inStock: availability && Object.hasOwn(AVAILABILITY, availability) ? AVAILABILITY[availability] : null,
        image: abs(ldImage(field("image"))),
      }),
    });
  }

  // A variant without a sku keys on its own link, which stays put when the list is reordered; only one without its
  // own link, or sharing it with another, adds its place in hasVariant (#n). Any key still repeated (two products
  // with one sku, or two plain products on the page's address): the first wins.
  const count = new Map<string, number>();
  for (const { row } of found) count.set(row.externalId, (count.get(row.externalId) ?? 0) + 1);
  const rows = new Map<string, SyncedRow>();
  for (const { row, n, ownLink } of found) {
    const key = n !== undefined && !row.sku && (!ownLink || count.get(row.externalId)! > 1) ? `${row.externalId}#${n}` : row.externalId;
    if (!rows.has(key)) rows.set(key, { ...row, externalId: key });
  }
  return [...rows.values()];
}
