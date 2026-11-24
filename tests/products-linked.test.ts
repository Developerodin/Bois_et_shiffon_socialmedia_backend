import { describe, expect, it, vi } from "vitest";
import type { ProductRow } from "@/server/content/product-checks";

vi.mock("@/server/db/prisma", () => ({ prisma: {} })); // sync.ts imports it; linkedProducts uses the db it's given
import { linkedProducts } from "@/server/catalog/linked";

type Row = ProductRow & { workspaceId: string; brandId: string; sku?: string | null };
type Where = {
  workspaceId: string; brandId: string; id?: { in: string[] }; archivedAt?: null;
  OR?: Clause[];
};
type Clause =
  | { url: { contains: string } } | { source: string; externalId: string }
  | { source: { in: string[] }; url: { in: string[] } } | { source: { in: string[] }; sku: string };
const matches = (r: Row, c: Clause) => {
  if ("externalId" in c) return r.source === c.source && r.externalId === c.externalId;
  if ("sku" in c) return c.source.in.includes(r.source) && r.sku === c.sku;
  if ("source" in c) return c.source.in.includes(r.source) && !!r.url && c.url.in.includes(r.url);
  return !!r.url?.toLowerCase().includes(c.url.contains.toLowerCase());
};

/** A product table that answers the two shapes of query linkedProducts sends. */
function fakeDb(rows: Row[]) {
  const findMany = vi.fn(async ({ where }: { where: Where }) =>
    rows.filter((r) =>
      r.workspaceId === where.workspaceId && r.brandId === where.brandId &&
      (!where.id || where.id.in.includes(r.id)) &&
      (where.archivedAt !== null || r.archivedAt === null) &&
      (!where.OR || where.OR.some((c) => matches(r, c))),
    ),
  );
  return { db: { product: { findMany } } as never, findMany };
}

const scope = { workspaceId: "w1", brandId: "b1" };
const now = new Date("2026-11-05T12:00:00Z");
function row(id: string, over: Partial<Row> = {}): Row {
  return {
    id, workspaceId: "w1", brandId: "b1", source: "WEBSITE", externalId: id, title: "Milo Sofa — Linen", url: "https://shop.example/products/milo",
    category: "Sofas", materials: null, dimensions: null, certifications: null, currency: "EUR", inStock: true, stockQuantity: null,
    stockCheckedAt: now, imageUrl: null, archivedAt: null, price: "10.00", compareAtPrice: null, ...over,
  };
}

describe("linkedProducts", () => {
  it("an id from another brand is gone", async () => {
    const { db } = fakeDb([row("p1", { brandId: "b2" })]);
    expect(await linkedProducts(db, scope, ["p1"], now)).toEqual([{ id: "p1", row: null, group: [], name: "a removed product", state: "gone" }]);
  });

  it("maps a store switch both ways by variant number", async () => {
    const archivedWebsite = row("w123", { externalId: "123", archivedAt: now });
    const shopify = row("s123", { source: "SHOPIFY", externalId: "gid://shopify/ProductVariant/123", price: "12.00" });
    const shopifySibling = row("s124", { source: "SHOPIFY", externalId: "gid://shopify/ProductVariant/124", title: "Milo Sofa — Velvet" });
    let { db } = fakeDb([archivedWebsite, shopify, shopifySibling]);
    const [toShopify] = await linkedProducts(db, scope, ["w123"], now);
    expect(toShopify).toMatchObject({ id: "w123", name: "Milo Sofa", state: "in" });
    expect(toShopify!.row?.id).toBe("s123");
    expect(toShopify!.group.map((r) => r.id).sort()).toEqual(["s123", "s124"]);

    const archivedShopify = row("s9", { source: "SHOPIFY", externalId: "gid://shopify/ProductVariant/9", archivedAt: now });
    const website = row("w9", { externalId: "9" });
    ({ db } = fakeDb([archivedShopify, website]));
    expect((await linkedProducts(db, scope, ["s9"], now))[0]!.row?.id).toBe("w9");
  });

  it("a post linked to a SITE row resolves after the brand moves to Shopify: by link, then by SKU", async () => {
    const pageRow = row("site1", { source: "SITE", externalId: "url:https://shop.example/p/milo-sofa", url: "https://shop.example/p/milo-sofa", archivedAt: now });
    const shopify = row("s1", { source: "SHOPIFY", externalId: "gid://shopify/ProductVariant/1", url: "https://shop.example/p/milo-sofa/", price: "12.00" });
    let { db } = fakeDb([pageRow, shopify, row("s2", { source: "SHOPIFY", externalId: "gid://shopify/ProductVariant/2", url: "https://shop.example/p/other" })]);
    expect((await linkedProducts(db, scope, ["site1"], now))[0]).toMatchObject({ row: { id: "s1" }, state: "in" });

    const bySku = row("site2", { source: "SITE", externalId: "sku:MS-1", sku: "MS-1", url: "https://old.example/milo", archivedAt: now });
    ({ db } = fakeDb([bySku, row("w5", { externalId: "5", sku: "MS-1", url: "https://shop.example/products/milo?variant=5" })]));
    expect((await linkedProducts(db, scope, ["site2"], now))[0]!.row?.id).toBe("w5");
  });

  it("a post linked to a feed row resolves to the SITE row that replaced it; feed and Shopify still match only by variant", async () => {
    const feedRow = row("w7", { externalId: "7", url: "https://shop.example/chair", archivedAt: now });
    const site = row("site7", { source: "SITE", externalId: "url:https://shop.example/chair", url: "https://shop.example/chair" });
    let { db } = fakeDb([feedRow, site]);
    expect((await linkedProducts(db, scope, ["w7"], now))[0]!.row?.id).toBe("site7");

    ({ db } = fakeDb([feedRow, row("s8", { source: "SHOPIFY", externalId: "gid://shopify/ProductVariant/8", url: "https://shop.example/chair" })]));
    expect((await linkedProducts(db, scope, ["w7"], now))[0]!.row).toBeNull();
  });

  it("a deleted variant of a live product maps to its first live sibling; with none it's gone, named from its row", async () => {
    const deleted = row("v1", { externalId: "1", archivedAt: now });
    const { db, findMany } = fakeDb([deleted, row("v30", { externalId: "30" }), row("v4", { externalId: "4" })]);
    const [linked] = await linkedProducts(db, scope, ["v1", "v1"], now);
    expect(linked!.row?.id).toBe("v4");
    expect(findMany).toHaveBeenCalledTimes(2); // the ids, then the live rows and groups

    const alone = fakeDb([row("m1", { source: "SHOPIFY", externalId: "gid://shopify/ProductVariant/77", url: null, title: "Old Lamp", archivedAt: now })]);
    expect(await linkedProducts(alone.db, scope, ["m1"], now)).toMatchObject([{ row: null, name: "Old Lamp", state: "gone" }]);
  });
});
