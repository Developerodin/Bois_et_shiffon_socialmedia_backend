import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/prisma";
import { syncCatalogPages } from "@/server/catalog/sitemap";

/** syncCatalogPages against Postgres: batched upsert, unchanged lastmod skipped, deletes only after a complete discovery. */
let ws: string;
const scope = (brandId = "cp-a") => ({ workspaceId: ws, brandId });
const page = (n: number, lastmod: string | null = "2026-11-01T00:00:00.000Z") => ({ url: `https://shop.test/p/${n}`, lastmod: lastmod ? new Date(lastmod) : null });
const urls = async (brandId = "cp-a") => (await prisma.catalogPage.findMany({ where: { brandId }, orderBy: { url: "asc" } })).map((p) => p.url);

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-catalog-page" } })).id;
  for (const id of ["cp-a", "cp-b"]) await prisma.brand.create({ data: { id, workspaceId: ws, slug: id, displayName: id } });
});
beforeEach(async () => {
  await prisma.catalogPage.deleteMany({});
});

describe("syncCatalogPages", () => {
  it("inserts in batches, writes a changed lastmod and skips an unchanged one", async () => {
    const many = Array.from({ length: 2500 }, (_, i) => page(i));
    expect((await syncCatalogPages(scope(), { urls: many, complete: true })).upserted).toBe(2500);
    await prisma.catalogPage.update({ where: { brandId_url: { brandId: "cp-a", url: page(1).url } }, data: { readAt: new Date(), productKeys: ["sku:1"] } });

    const again = await syncCatalogPages(scope(), { urls: [...many.slice(0, 3), page(2, "2026-11-20T00:00:00.000Z")], complete: false });
    expect(again.upserted).toBe(1); // only page 2's lastmod changed (the later duplicate wins)
    const stored = await prisma.catalogPage.findUnique({ where: { brandId_url: { brandId: "cp-a", url: page(1).url } } });
    expect(stored?.productKeys).toEqual(["sku:1"]);
    expect(stored?.readAt).not.toBeNull();
    expect((await prisma.catalogPage.findUnique({ where: { brandId_url: { brandId: "cp-a", url: page(2).url } } }))?.lastmod?.toISOString()).toBe("2026-11-20T00:00:00.000Z");
  });

  it("an incomplete discovery deletes nothing", async () => {
    await syncCatalogPages(scope(), { urls: [page(1), page(2)], complete: true });
    const res = await syncCatalogPages(scope(), { urls: [page(1)], complete: false });
    expect(res).toMatchObject({ deleted: 0, goneKeys: [] });
    expect(await urls()).toHaveLength(2);
  });

  it("a complete discovery deletes unlisted pages and returns their product keys; another brand's pages stay", async () => {
    await syncCatalogPages(scope(), { urls: [page(1), page(2), page(3)], complete: true });
    await syncCatalogPages(scope("cp-b"), { urls: [page(2)], complete: true });
    await prisma.catalogPage.updateMany({ where: { brandId: "cp-a", url: { in: [page(2).url, page(3).url] } }, data: { productKeys: ["sku:A", "sku:B"] } });
    const res = await syncCatalogPages(scope(), { urls: [page(1)], complete: true });
    expect(res.deleted).toBe(2);
    expect(res.goneKeys.sort()).toEqual(["sku:A", "sku:B"]);
    expect(await urls()).toEqual([page(1).url]);
    expect(await urls("cp-b")).toEqual([page(2).url]);
  });

  it("an empty list deletes nothing, even when called complete", async () => {
    await syncCatalogPages(scope(), { urls: [page(1)], complete: true });
    expect((await syncCatalogPages(scope(), { urls: [], complete: true })).deleted).toBe(0);
    expect(await urls()).toEqual([page(1).url]);
  });

  it("a key another remaining page still holds isn't returned", async () => {
    await syncCatalogPages(scope(), { urls: [page(1), page(2)], complete: true });
    await syncCatalogPages(scope("cp-b"), { urls: [page(1)], complete: true });
    await prisma.catalogPage.updateMany({ where: { brandId: "cp-a", url: page(1).url }, data: { productKeys: ["sku:A"] } });
    await prisma.catalogPage.updateMany({ where: { brandId: "cp-a", url: page(2).url }, data: { productKeys: ["sku:A", "sku:B"] } });
    await prisma.catalogPage.updateMany({ where: { brandId: "cp-b" }, data: { productKeys: ["sku:B"] } }); // another brand's hold doesn't count
    const res = await syncCatalogPages(scope(), { urls: [page(1)], complete: true });
    expect(res).toMatchObject({ deleted: 1, goneKeys: ["sku:B"] });
  });
});
