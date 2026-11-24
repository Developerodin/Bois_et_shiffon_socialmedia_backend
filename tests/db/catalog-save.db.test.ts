import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/prisma";
import { saveRows, type SavedRow } from "@/server/catalog/sync";

/**
 * saveRows against Postgres: what each source archives, the batched UPDATE, keys mode, IMPORT person fields and
 * matching, and running inside a caller's transaction.
 */
let ws: string;
const scope = () => ({ workspaceId: ws, brandId: "cs-a" });
const row = (externalId: string, extra: Partial<SavedRow> = {}): SavedRow => ({
  externalId, sku: null, title: `Chair ${externalId}`, url: null, category: null, description: null, price: "10.00", compareAtPrice: null,
  currency: "EUR", inStock: true, stockQuantity: null, imageUrl: null, ...extra,
});
const seed = (source: "WEBSITE" | "SHOPIFY" | "SITE" | "IMPORT" | "MANUAL", externalId: string | null, extra: object = {}, brandId = "cs-a") =>
  prisma.product.create({ data: { workspaceId: ws, brandId, source, externalId, title: `${source} ${externalId}`, ...extra } });
const live = async (brandId = "cs-a") =>
  (await prisma.product.findMany({ where: { workspaceId: ws, brandId, archivedAt: null } })).map((p) => `${p.source}:${p.externalId ?? "-"}`).sort();

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-catalog-save" } })).id;
  for (const id of ["cs-a", "cs-b"]) await prisma.brand.create({ data: { id, workspaceId: ws, slug: id, displayName: id } });
});
beforeEach(async () => {
  await prisma.product.deleteMany({});
});

describe("what a save archives", () => {
  it("WEBSITE and SHOPIFY archive as before: unseen rows of their own and the other synced source; MANUAL stays", async () => {
    await seed("WEBSITE", "1");
    await seed("WEBSITE", "2");
    await seed("SHOPIFY", "gid://shopify/ProductVariant/9");
    await seed("MANUAL", null);
    await seed("IMPORT", "sku:X");
    await saveRows(prisma, scope(), "WEBSITE", { rows: [row("1")], complete: true });
    expect(await live()).toEqual(["WEBSITE:1", "MANUAL:-", "IMPORT:sku:X"].sort());

    await saveRows(prisma, scope(), "SHOPIFY", { rows: [row("gid://shopify/ProductVariant/1")], complete: true });
    expect(await live()).toEqual(["SHOPIFY:gid://shopify/ProductVariant/1", "MANUAL:-", "IMPORT:sku:X"].sort());
  });

  it("an automatic source also archives SITE rows, and SITE archives the other two", async () => {
    await seed("SITE", "sku:S");
    await saveRows(prisma, scope(), "WEBSITE", { rows: [row("1")], complete: true });
    expect(await live()).toEqual(["WEBSITE:1"]);
    await saveRows(prisma, scope(), "SITE", { rows: [row("sku:S")], complete: true });
    expect(await live()).toEqual(["SITE:sku:S"]);
  });

  it("IMPORT archives only its own unseen rows: never MANUAL or synced rows, nor another brand's", async () => {
    await seed("IMPORT", "sku:A");
    await seed("IMPORT", "sku:B");
    await seed("WEBSITE", "1");
    await seed("SITE", "sku:S");
    await seed("MANUAL", null);
    await seed("IMPORT", "sku:B", {}, "cs-b");
    await saveRows(prisma, scope(), "IMPORT", { rows: [row("sku:A")], complete: true });
    expect(await live()).toEqual(["WEBSITE:1", "MANUAL:-", "IMPORT:sku:A", "SITE:sku:S"].sort());
    expect(await live("cs-b")).toEqual(["IMPORT:sku:B"]);
  });

  it("an incomplete fetch archives nothing", async () => {
    await seed("WEBSITE", "1");
    await seed("SHOPIFY", "gid://shopify/ProductVariant/9");
    await seed("IMPORT", "sku:A");
    await saveRows(prisma, scope(), "WEBSITE", { rows: [row("2")], complete: false });
    await saveRows(prisma, scope(), "IMPORT", { rows: [row("sku:Z")], complete: false });
    expect(await live()).toHaveLength(5);
  });
});

describe("writing rows", () => {
  it("updates changed rows in one statement: fields, stock freshness, updatedAt, un-archiving", async () => {
    const old = new Date("2026-01-01T00:00:00Z");
    const a = await seed("WEBSITE", "1", { price: "10.00", inStock: true, stockCheckedAt: old, archivedAt: old, materials: "Oak" });
    const b = await seed("WEBSITE", "2", { title: "Same", price: "10.00", currency: "EUR", inStock: true, stockCheckedAt: old });
    await saveRows(prisma, scope(), "WEBSITE", { rows: [row("1", { title: "New", price: "12.5", inStock: false, stockQuantity: 3 }), row("2", { title: "Same" })], complete: false });
    const after = await prisma.product.findUniqueOrThrow({ where: { id: a.id } });
    expect(after).toMatchObject({ title: "New", inStock: false, stockQuantity: 3, archivedAt: null, materials: "Oak", currency: "EUR" });
    expect(after.price?.toFixed(2)).toBe("12.50");
    expect(after.stockCheckedAt!.getTime()).toBeGreaterThan(old.getTime());
    expect(Math.abs(after.updatedAt.getTime() - Date.now())).toBeLessThan(60_000);
    // Unchanged, but it reported stock: only its freshness moves.
    const same = await prisma.product.findUniqueOrThrow({ where: { id: b.id } });
    expect(same.stockCheckedAt!.getTime()).toBeGreaterThan(old.getTime());
    expect(same.title).toBe("Same");
  });

  it("IMPORT person fields: written when given, never blanked by an empty cell", async () => {
    const p = await seed("IMPORT", "sku:A", { materials: "Oak", dimensions: "80 cm" });
    await saveRows(prisma, scope(), "IMPORT", { rows: [row("sku:A", { materials: null, dimensions: "90 cm", certifications: "FSC" })], complete: true });
    expect(await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ materials: "Oak", dimensions: "90 cm", certifications: "FSC" });
    await saveRows(prisma, scope(), "IMPORT", { rows: [row("sku:B", { materials: "Linen" })], complete: false });
    expect(await prisma.product.findFirstOrThrow({ where: { externalId: "sku:B" } })).toMatchObject({ materials: "Linen", source: "IMPORT" });
  });

  it("match: a stored IMPORT row keeps its id and takes the new key; a stored row is claimed once", async () => {
    const p = await seed("IMPORT", "title:chair", { materials: "Oak" });
    await saveRows(prisma, scope(), "IMPORT", { rows: [row("sku:1", { title: "Chair" }), row("sku:2", { title: "Chair" })], complete: true }, {
      match: (rows, stored) => new Map(rows.map((r) => [r.externalId, stored[0]!.id])),
    });
    const rows = await prisma.product.findMany({ where: { workspaceId: ws, brandId: "cs-a", archivedAt: null }, orderBy: { externalId: "asc" } });
    expect(rows.map((r) => [r.externalId, r.id === p.id])).toEqual([["sku:1", true], ["sku:2", false]]);
    expect(rows[0]!.materials).toBe("Oak");
  });

  it("keys mode reads only those stored rows", async () => {
    await seed("SITE", "a");
    await seed("SITE", "b", { title: "B" });
    const queries: string[] = [];
    const client = logged(queries);
    await saveRows(client, scope(), "SITE", { rows: [row("b", { title: "B2" })], complete: false }, { keys: ["b"] });
    expect(queries[0]).toMatch(/"externalId" IN/);
    expect((await prisma.product.findFirstOrThrow({ where: { externalId: "b" } })).title).toBe("B2");
    await client.$disconnect();
  });

  it("runs inside a passed transaction: a rollback leaves nothing", async () => {
    await seed("IMPORT", "sku:A");
    await expect(
      prisma.$transaction(async (tx) => {
        await saveRows(tx, scope(), "IMPORT", { rows: [row("sku:B"), row("sku:C", { title: "x" })], complete: true });
        expect(await tx.product.count({ where: { brandId: "cs-a", archivedAt: null } })).toBe(2);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await live()).toEqual(["IMPORT:sku:A"]);
  });
});

function logged(queries: string[]) {
  const client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
  client.$on("query", (e) => queries.push(e.query));
  return client;
}

describe("a big change", () => {
  let client: PrismaClient;
  const queries: string[] = [];
  beforeAll(() => void (client = logged(queries)));
  afterAll(() => client.$disconnect());

  it("5,000 changed rows: at most 6 queries and under 5 s", async () => {
    const ids = Array.from({ length: 5000 }, (_, i) => String(i));
    await prisma.product.createMany({ data: ids.map((id) => ({ workspaceId: ws, brandId: "cs-a", source: "SHOPIFY" as const, externalId: id, title: `Old ${id}`, price: "1.00" })) });
    await client.$connect();
    queries.length = 0;
    const start = Date.now();
    await saveRows(client, scope(), "SHOPIFY", { rows: ids.map((id) => row(id, { price: "2.00", stockQuantity: 4 })), complete: false });
    expect(Date.now() - start).toBeLessThan(5000);
    expect(queries.length).toBeLessThanOrEqual(6);
    const sample = await prisma.product.findFirstOrThrow({ where: { externalId: "4999", source: "SHOPIFY" } });
    expect(sample).toMatchObject({ title: "Chair 4999", stockQuantity: 4 });
    expect(sample.price?.toFixed(2)).toBe("2.00");
  });
});
