import { httpUrl, str, syncedRow, variantTitle, type SyncedRow } from "@/server/catalog/sync";
import { htmlText, jsonLdNodes, type LdNode } from "@/server/research/crawl";

/** At most this many rows from one page (a page listing more is cut, not refused). */
export const MAX_PAGE_ROWS = 200;

// Orderable counts as in stock, as Shopify's `available` does for a product sold on backorder.
const AVAILABILITY: Record<string, boolean> = { InStock: true, PreOrder: true, BackOrder: true, OutOfStock: false };

const types = (n: LdNode) => [n["@type"]].flat().map(String);
const isObject = (v: unknown): v is LdNode => !!v && typeof v === "object" && !Array.isArray(v);
const first = (v: unknown) => [v].flat().find(isObject);
const text = (v: unknown, max: number) => str(typeof v === "string" ? htmlText(v) : null, max);
const host = (u: URL) => u.hostname.replace(/^www\./, "");

/** A string, an array of them, or an ImageObject → the first image link. */
const ldImage = (v: unknown): unknown => (Array.isArray(v) ? ldImage(v[0]) : isObject(v) ? (v.url ?? v.contentUrl) : v);

/**
 * Products a product page describes in its JSON-LD (schema.org Product, and ProductGroup.hasVariant), one row per
 * product or variant. Everything in the page is untrusted: text becomes plain text, links http(s) only, a canonical
 * link to another site falls back to the page's own address.
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
  const nodes = jsonLdNodes(html);

  // A variant's missing fields come from its group; a product only mentioned as related to another isn't this page's.
  const groupOf = new Map<LdNode, { group: LdNode; n: number }>();
  const related = new Set<unknown>();
  for (const node of nodes) {
    if (types(node).includes("ProductGroup")) [node.hasVariant].flat().filter(isObject).forEach((v, n) => groupOf.set(v, { group: node, n }));
    for (const k of ["isRelatedTo", "isSimilarTo"]) [node[k]].flat().forEach((v) => related.add(v));
  }
  const crumbs = nodes.find((n) => types(n).includes("BreadcrumbList"))?.itemListElement;
  const crumbNames = (Array.isArray(crumbs) ? crumbs : []).map((c) => text(isObject(c) ? (c.name ?? (isObject(c.item) ? c.item.name : null)) : null, 120));

  const rows: SyncedRow[] = [];
  for (const node of nodes) {
    if (rows.length >= MAX_PAGE_ROWS) break;
    if (!types(node).includes("Product") || related.has(node)) continue;
    const { group, n } = groupOf.get(node) ?? {};
    const field = (k: string) => node[k] ?? group?.[k];
    const name = text(field("name"), 200);
    if (!name) continue;
    // Variants sharing the group's name ("Sofa" × 8) are told apart by what they vary by.
    const varies = group ? [node.color, node.size].map((v) => text(v, 60)).filter((v): v is string => !!v && !name.includes(v)) : [];
    const offer = first(node.offers) ?? first(group?.offers);
    const link = abs(node.url ?? offer?.url ?? group?.url);
    const url = link && host(new URL(link)) === host(page) ? link : page.toString();
    const sku = str(node.sku, 100) ?? str(node.gtin13, 100) ?? str(node.mpn, 100);
    const currency = typeof offer?.priceCurrency === "string" && /^[A-Z]{3}$/.test(offer.priceCurrency) ? offer.priceCurrency : null;
    const availability = typeof offer?.availability === "string" ? /([A-Za-z]+)\/?$/.exec(offer.availability)?.[1] : undefined;
    const category = typeof field("category") === "string" ? field("category") : crumbNames.filter((c) => c && c !== name).at(-1);
    rows.push(syncedRow({
      externalId: sku ? `sku:${sku}` : `url:${url}${group ? `#${n}` : ""}`,
      sku,
      title: varies.length ? variantTitle(name, varies.join(" / ")) : name,
      url,
      category: text(category, 120),
      description: text(field("description"), 5000),
      price: offer?.price ?? offer?.lowPrice,
      compareAtPrice: null,
      currency,
      inStock: availability && Object.hasOwn(AVAILABILITY, availability) ? AVAILABILITY[availability] : null,
      image: abs(ldImage(field("image"))),
    }));
  }
  return rows;
}
