import type { Prisma, Product } from "@prisma/client";
import { z } from "zod";
import { problemResponse } from "@/server/api/http-error";
import { httpUrl } from "@/server/catalog/sync";

/** Fields people own on every row; on synced rows these are the only ones they can edit. */
export const PERSON_FIELDS = ["materials", "dimensions", "certifications"] as const;

/**
 * Fields only `rules.approve` holders may write, null included: typed stock and prices clear the publishing gate,
 * and facts decide whether Quality accepts a product claim. Stock and prices are writable on MANUAL rows only.
 */
export const VOUCHED_FIELDS = [...PERSON_FIELDS, "inStock", "stockQuantity", "price", "compareAtPrice"] as const;
type Vouched = (typeof VOUCHED_FIELDS)[number];

/** The vouched fields an input writes (keys present, even null). */
export const vouchedIn = (input: ProductInput) => VOUCHED_FIELDS.filter((f) => f in input);

/** 403 for a write to VOUCHED_FIELDS without rules.approve. */
export const cannotVouch = () =>
  problemResponse({
    type: "https://api.brandpilot/errors/access-denied",
    title: "Forbidden",
    status: 403,
    detail: "Only people who can approve product claims can change stock, prices or product facts.",
  });

/** `product.updated` audit metadata for vouched fields: `{ field: [before, after] }`, prices as "12.50". */
export function vouchedChanges(fields: Vouched[], before: Pick<Product, Vouched>, after: Pick<Product, Vouched>) {
  const plain = (v: Product[Vouched]) => (v !== null && typeof v === "object" ? v.toFixed(2) : v);
  return Object.fromEntries(fields.map((f) => [f, [plain(before[f]), plain(after[f])]]));
}

const text = (max: number) => z.string().trim().max(max).transform((s) => s || null).nullable();
const link = z
  .string()
  .trim()
  .max(2000)
  .transform((s) => s || null)
  .nullable()
  .refine((s) => s === null || httpUrl(s) !== null, "Enter a link that starts with https://");
const money = z.number().nonnegative().max(1_000_000_000).nullable();

/** A product as a person types it. Every key is optional (PATCH); POST also needs a title. */
export const ProductInput = z
  .object({
    // One line: names go into prompts (see productName).
    title: z.string().transform((s) => s.replace(/\s+/g, " ").trim()).pipe(z.string().min(1).max(300)),
    sku: text(100),
    url: link,
    category: text(120),
    description: text(5000),
    materials: text(1000),
    dimensions: text(1000),
    certifications: text(1000),
    price: money,
    compareAtPrice: money,
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Use a 3-letter currency code like EUR").nullable(),
    inStock: z.boolean().nullable(),
    stockQuantity: z.number().int().min(0).max(1_000_000_000).nullable(),
    imageUrl: link,
  })
  .partial()
  .strict();
export type ProductInput = z.infer<typeof ProductInput>;

/** Prisma data from validated input: prices as 2-decimal strings, and a stock answer stamps its freshness. */
export function productData(input: ProductInput) {
  const { price, compareAtPrice, ...rest } = input;
  return {
    ...rest,
    ...(price !== undefined && { price: price === null ? null : price.toFixed(2) }),
    ...(compareAtPrice !== undefined && { compareAtPrice: compareAtPrice === null ? null : compareAtPrice.toFixed(2) }),
    // Only an actual answer is fresh stock; clearing it to "unknown" (null) isn't.
    ...((input.inStock != null || input.stockQuantity != null) && { stockCheckedAt: new Date() }),
  };
}

/** A product with its description: the detail route and writes. */
export const toProductDto = (p: Product) => ({ ...toProductListDto(p), description: p.description });

/** A list row: no description (up to 5,000 characters each; the detail route has it). */
export const toProductListDto = (p: Omit<Product, "description">) => ({
  id: p.id,
  source: p.source,
  externalId: p.externalId,
  sku: p.sku,
  title: p.title,
  url: p.url,
  category: p.category,
  materials: p.materials,
  dimensions: p.dimensions,
  certifications: p.certifications,
  price: p.price?.toFixed(2) ?? null,
  compareAtPrice: p.compareAtPrice?.toFixed(2) ?? null,
  currency: p.currency,
  inStock: p.inStock,
  stockQuantity: p.stockQuantity,
  stockCheckedAt: p.stockCheckedAt?.toISOString() ?? null,
  imageUrl: p.imageUrl,
  archivedAt: p.archivedAt?.toISOString() ?? null,
  updatedAt: p.updatedAt.toISOString(),
});

/** Page sizes the list offers; anything else is refused rather than guessed. */
export const PRODUCT_PAGE_SIZES = [20, 50, 100] as const;

/**
 * The list's paged form (`?page=` present): page from 1, a size from PRODUCT_PAGE_SIZES, a title/SKU search, a stock
 * filter. null = no `page`, the whole list as before (the phone and the product pickers read that). A page past the
 * end is clamped by the route once it knows the total.
 */
export const ProductPageQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000),
  limit: z.coerce.number().refine((n) => (PRODUCT_PAGE_SIZES as readonly number[]).includes(n), "limit must be 20, 50 or 100").default(50),
  q: z.string().trim().max(200).default(""),
  stock: z.enum(["", "in", "out"]).default(""),
});
export type ProductPageQuery = z.infer<typeof ProductPageQuery>;

/**
 * The search and stock filter as a database condition, by stockLabel's rule (shared/products.ts) so a filter and the
 * labels it shows never disagree: "in" is a positive count or inStock true (a store selling an untracked item at 0);
 * "out" is every other row, unknown stock included (both null; STOCK_UNKNOWN), spelled out so nulls aren't lost to
 * SQL's NOT.
 */
/** stockLabel's "Unknown": the source said nothing about stock. */
export const STOCK_UNKNOWN = { stockQuantity: null, inStock: null } satisfies Prisma.ProductWhereInput;

/** `q` as a literal inside ILIKE: escaped, a typed %, _ or \ is a character, not a wildcard (Postgres' default ILIKE escape is the backslash). */
export const likeLiteral = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

export function productPageWhere({ q, stock }: Pick<ProductPageQuery, "q" | "stock">): Prisma.ProductWhereInput {
  const and: Prisma.ProductWhereInput[] = [];
  // Prisma passes `contains` into ILIKE as is, so it gets the escaped literal.
  const literal = likeLiteral(q);
  if (q) and.push({ OR: [{ title: { contains: literal, mode: "insensitive" } }, { sku: { contains: literal, mode: "insensitive" } }] });
  if (stock === "in") and.push({ OR: [{ stockQuantity: { gt: 0 } }, { inStock: true }] });
  if (stock === "out") and.push({ OR: [{ stockQuantity: { lte: 0 } }, { stockQuantity: null }] }, { OR: [{ inStock: false }, { inStock: null }] });
  return and.length ? { AND: and } : {};
}
