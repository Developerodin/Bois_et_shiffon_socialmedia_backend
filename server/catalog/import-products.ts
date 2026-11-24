import { IMPORT_FIELDS, type ImportField, type ImportProblem } from "@/shared";
import type { Sheet } from "@/server/catalog/import-file";
import { ProductInput, VOUCHED_FIELDS } from "@/server/catalog/products";
import { httpUrl, type SavedRow } from "@/server/catalog/sync";
import { amountOf } from "@/server/content/product-checks";
import { htmlText } from "@/server/research/crawl";

/**
 * Turns a parsed spreadsheet into catalogue rows (docs/superpowers/plans/2026-11-24-product-import.md, Task 3):
 * columns matched to fields by their headers (English and French), cells validated with ProductInput's caps, and each
 * row given a key that a re-import of the same product finds again.
 */

/** "Prix TTC (€)" → "prix ttc": lowercase, accents and punctuation gone, spaces collapsed. ASCII only: never for names (sameName). */
const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Header synonyms per field, already normalised. A header matches its field's exact synonym. */
const SYNONYMS: Record<ImportField, string[]> = {
  title: ["title", "name", "product", "product name", "product title", "titre", "nom", "nom du produit", "produit", "designation", "libelle"],
  sku: ["sku", "ref", "reference", "code", "product code", "article", "code article", "variant sku"],
  url: ["url", "link", "lien", "product url", "product link", "page", "lien produit", "url produit"],
  imageUrl: ["image", "image url", "image link", "photo", "visuel", "image src", "picture", "url image", "lien image"],
  price: ["price", "prix", "prix ttc", "sale price", "prix de vente", "variant price", "tarif"],
  compareAtPrice: ["compare at", "compare at price", "regular price", "prix barre", "prix avant", "prix initial", "original price", "variant compare at price"],
  currency: ["currency", "devise", "monnaie"],
  category: ["category", "categorie", "type", "product type", "collection", "famille", "rayon"],
  description: ["description", "body", "body html", "details", "descriptif"],
  inStock: ["in stock", "available", "availability", "disponible", "disponibilite", "en stock"],
  stockQuantity: ["stock", "quantity", "qty", "quantite", "inventory", "stock quantity", "variant inventory qty", "quantite en stock"],
  materials: ["materials", "material", "materiau", "materiaux", "matiere", "matieres", "composition"],
  dimensions: ["dimensions", "size", "sizes", "taille", "mesures"],
  certifications: ["certifications", "certification", "labels", "label", "certificats"],
};
const BY_HEADER = new Map(IMPORT_FIELDS.flatMap((f) => SYNONYMS[f].map((h) => [h, f] as const)));

/** One field (or null) per header, each field at most once: the first column that names it wins. */
export function guessMapping(headers: string[]): (ImportField | null)[] {
  const taken = new Set<ImportField>();
  return headers.map((h) => {
    const f = BY_HEADER.get(norm(h));
    if (!f || taken.has(f)) return null;
    taken.add(f);
    return f;
  });
}

/** The fields among these that need rules.approve (stock, prices, facts): a mapping's, or every importable one. */
export const vouchedFields = (fields: readonly (ImportField | null)[]) =>
  fields.filter((f): f is ImportField => f !== null && (VOUCHED_FIELDS as readonly string[]).includes(f));

const YES = new Set(["yes", "y", "oui", "o", "1", "true", "vrai", "in stock", "en stock", "available", "disponible", "instock"]);
const NO = new Set(["no", "n", "non", "0", "false", "faux", "out of stock", "rupture", "rupture de stock", "en rupture", "unavailable", "indisponible", "outofstock", "epuise"]);
const SYMBOL: Record<string, string> = { "€": "EUR", $: "USD", "£": "GBP" };

/**
 * "1 299,00 €" → 1299; empty → null; not an amount (or negative) → NaN, which ProductInput refuses. A plain number
 * ("24.995", "35.88": how Excel's number cells arrive) is read as a decimal and rounded to cents; written prices go
 * through amountOf. ponytail: so a CSV "1.299" meaning 1,299 reads as 1.30; such files write "1.299,00" in practice.
 */
function money(cell: string) {
  if (!cell) return null;
  if (/^\d+(\.\d+)?(e[+-]?\d+)?$/i.test(cell)) return Math.round(Number(cell) * 100) / 100;
  const digits = cell.replace(/[^\d.,\s]/g, "").trim();
  return cell.includes("-") || !/\d/.test(digits) ? NaN : amountOf(digits);
}

/** "12", "12.0" (Excel numbers), "1 200" → an integer; a negative count (oversold) is 0; empty → null. */
function count(cell: string) {
  if (!cell) return null;
  const n = Number(cell.replace(/\s/g, ""));
  return Number.isFinite(n) ? Math.max(0, n) : NaN;
}

const line = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max) || null;
const block = (s: string, max: number) => s.trim().slice(0, max) || null;
/** A link without its #fragment or trailing slash, so "…/chair/" and "…/chair#reviews" are one product. */
function sameLink(url: string) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString().replace(/\/+(\?|$)/, "$1");
  } catch {
    return url; // a stored link typed before links were checked
  }
}

/**
 * "Ava  Chair!" → "ava chair": a name compared in any script (Greek, Arabic, Hindi, CJK keep their letters), Latin
 * and Greek accents and punctuation gone (other marks stay: Hindi vowel signs tell words apart). A name of symbols only
 * ("★★★") is compared as written, so a key is never just "title:".
 */
const sameName = (title: string) =>
  title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim() || title.toLowerCase();

/** The key a row is stored under: its SKU, else its link, else its name. */
const keyOf = (r: Pick<SavedRow, "sku" | "url" | "title">) =>
  r.sku ? `sku:${r.sku}` : r.url ? `url:${sameLink(r.url)}` : `title:${sameName(r.title)}`;

const NOT_STOCK = "the in-stock value isn't yes or no, so its stock was left unknown";
const MESSAGE: Partial<Record<string, string>> = {
  price: "the price isn't an amount",
  compareAtPrice: "the compare-at price isn't an amount",
  stockQuantity: "the stock isn't a whole number",
};

/**
 * Rows to save from a sheet and a mapping. Links that aren't http(s) are dropped (not the row); a row without a name,
 * or with a price or stock that isn't a number, is skipped and reported; an in-stock value that isn't yes or no is
 * reported and read as unknown. Two rows with the same key: the last wins. An empty cell is null: it clears a price or
 * stock (the file is the catalogue) but never a stored fact (saveRows). A price or stock column the file doesn't have
 * at all is different: the route keeps those stored values (saveRows' `keep`).
 */
export function toRows(sheet: Sheet, mapping: (ImportField | null)[]) {
  const problems: ImportProblem[] = [];
  const byKey = new Map<string, SavedRow>();
  let skipped = 0;
  sheet.rows.forEach((cells, i) => {
    const at = (f: ImportField) => { const c = mapping.indexOf(f); return c < 0 ? "" : (cells[c] ?? "").trim(); };
    const report = (reason: string, skip = false) => problems.push({ row: sheet.lines[i] ?? i + 2, reason, skipped: skip });
    const skip = (reason: string) => { skipped++; report(reason, true); };
    const currency = at("currency");
    const stock = norm(at("inStock"));
    const inStock = YES.has(stock) ? true : NO.has(stock) ? false : null;
    const input = ProductInput.safeParse({
      title: line(at("title"), 300) ?? "",
      sku: line(at("sku"), 100),
      url: httpUrl(at("url")),
      imageUrl: httpUrl(at("imageUrl")),
      category: line(at("category"), 120),
      // Cut before htmlText: the cell (up to 10,000 characters) is untrusted.
      description: block(htmlText(at("description").slice(0, 5000)), 5000),
      materials: block(at("materials"), 1000),
      dimensions: block(at("dimensions"), 1000),
      certifications: block(at("certifications"), 1000),
      price: money(at("price")),
      compareAtPrice: money(at("compareAtPrice")),
      currency: /^[a-z]{3}$/i.test(currency) ? currency : (SYMBOL[currency] ?? null),
      inStock,
      stockQuantity: count(at("stockQuantity")),
    });
    if (!input.success) {
      const field = String(input.error.issues[0]?.path[0] ?? "");
      return skip(field === "title" ? "it has no name" : (MESSAGE[field] ?? input.error.issues[0]?.message ?? "it couldn't be read"));
    }
    const p = input.data;
    if (stock && inStock === null) report(NOT_STOCK);
    const row: SavedRow = {
      externalId: "",
      sku: p.sku ?? null,
      title: p.title!,
      url: p.url ?? null,
      category: p.category ?? null,
      description: p.description ?? null,
      price: p.price == null ? null : p.price.toFixed(2),
      compareAtPrice: p.compareAtPrice == null ? null : p.compareAtPrice.toFixed(2),
      currency: p.currency ?? null,
      inStock: p.inStock ?? null,
      stockQuantity: p.stockQuantity ?? null,
      imageUrl: p.imageUrl ?? null,
      materials: p.materials ?? null,
      dimensions: p.dimensions ?? null,
      certifications: p.certifications ?? null,
    };
    row.externalId = keyOf(row);
    byKey.delete(row.externalId); // re-inserted: the last row with a key keeps the file's order
    byKey.set(row.externalId, row);
  });
  const rows = [...byKey.values()];
  return { rows, skipped, duplicates: sheet.rows.length - skipped - rows.length, problems: problems.slice(0, 50) };
}

/**
 * saveRows' `match` for IMPORT: an incoming row whose key isn't stored updates the stored row with the same SKU, else
 * the same link, else the same name, so adding a SKU column to a file keeps the products (and their links and facts).
 * A stored row already taken (`claimed`, or by an earlier row here) is passed over for the next way of matching.
 */
export function matchStored(rows: SavedRow[], stored: { id: string; sku: string | null; url: string | null; title: string }[], claimed: ReadonlySet<string> = new Set()) {
  const index = (key: (p: (typeof stored)[number]) => string | null) => {
    const m = new Map<string, string>();
    for (const p of stored) { const k = key(p); if (k && !m.has(k)) m.set(k, p.id); }
    return m;
  };
  const bySku = index((p) => p.sku);
  const byLink = index((p) => (p.url ? sameLink(p.url) : null));
  const byName = index((p) => sameName(p.title));
  const found = new Map<string, string>();
  const taken = new Set(claimed);
  const free = (id: string | null | undefined) => (id && !taken.has(id) ? id : null);
  for (const r of rows) {
    const id = free(r.sku && bySku.get(r.sku)) ?? free(r.url && byLink.get(sameLink(r.url))) ?? free(byName.get(sameName(r.title)));
    if (id) {
      found.set(r.externalId, id);
      taken.add(id);
    }
  }
  return found;
}
