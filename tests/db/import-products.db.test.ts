import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/db/prisma";

vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: vi.fn(async (_r: Request, p: Promise<{ workspaceId: string; brandId: string }>) => ({ userId: "u1", ...(await p) })) }));
vi.mock("@/server/auth/rate-limit", () => ({ hitRateLimit: vi.fn(async () => ({ allowed: true, count: 1 })) }));
vi.mock("@/server/auth/permissions", () => ({ effectivePermissions: vi.fn(async () => new Set(["context.edit", "rules.approve"])) }));

import { POST } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/products/import/route";

/** The import route against Postgres: re-imports keep ids and facts, archive only IMPORT rows, and stay in one brand. */
let ws: string;

async function upload(csv: string, mapping: unknown, brandId = "ip-a") {
  const form = new FormData();
  form.set("file", new File([csv], "p.csv"));
  form.set("mapping", JSON.stringify(mapping));
  const body = new Response(form);
  const bytes = await body.arrayBuffer();
  const res = await POST(
    new Request("http://x/import", { method: "POST", body: bytes, headers: { "content-type": body.headers.get("content-type")!, "content-length": String(bytes.byteLength) } }),
    { params: Promise.resolve({ workspaceId: ws, brandId }) },
  );
  return { status: res.status, body: await res.json() };
}
const live = async (brandId = "ip-a") =>
  (await prisma.product.findMany({ where: { workspaceId: ws, brandId, archivedAt: null }, orderBy: { title: "asc" } })).map((p) => `${p.source}:${p.externalId ?? "-"}`);

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-import-products" } })).id;
  for (const id of ["ip-a", "ip-b"]) await prisma.brand.create({ data: { id, workspaceId: ws, slug: id, displayName: id } });
});
beforeEach(async () => {
  await prisma.product.deleteMany({});
});

describe("product import", () => {
  it("a re-import that adds a SKU column keeps the product's id (and its links)", async () => {
    await upload("Name,Price\nMilo Sofa,10\nOslo Chair,20", ["title", "price"]);
    const before = await prisma.product.findFirstOrThrow({ where: { workspaceId: ws, title: "Milo Sofa" } });
    expect(before.externalId).toBe("title:milo sofa");

    const { body } = await upload("Name,Price,SKU\nMilo Sofa,12,M-1\nOslo Chair,20,O-1", ["title", "price", "sku"]);
    expect(body).toMatchObject({ created: 0, updated: 2, archived: 0 });
    const after = await prisma.product.findFirstOrThrow({ where: { workspaceId: ws, title: "Milo Sofa" } });
    expect([after.id, after.externalId, after.price?.toFixed(2)]).toEqual([before.id, "sku:M-1", "12.00"]);
  });

  it("archives IMPORT rows the file no longer has, and nothing else; another brand is untouched", async () => {
    for (const [source, externalId, brandId] of [["MANUAL", null, "ip-a"], ["WEBSITE", "1", "ip-a"], ["IMPORT", "sku:B", "ip-b"]] as const) {
      await prisma.product.create({ data: { workspaceId: ws, brandId, source, externalId, title: `${source} ${externalId}` } });
    }
    await upload("Name,SKU\nMilo,A\nOslo,B", ["title", "sku"]);
    const { body } = await upload("Name,SKU\nMilo,A", ["title", "sku"]);
    expect(body).toMatchObject({ created: 0, unchanged: 1, archived: 1 });
    expect((await live()).sort()).toEqual(["IMPORT:sku:A", "MANUAL:-", "WEBSITE:1"].sort());
    expect(await live("ip-b")).toEqual(["IMPORT:sku:B"]);
  });

  it("an empty materials cell keeps the stored materials; a file without a price column keeps prices", async () => {
    await upload("Name,SKU,Materials,Price\nMilo,A,Oak,10", ["title", "sku", "materials", "price"]);
    await upload("Name,SKU,Materials\nMilo,A,", ["title", "sku", "materials"]);
    const p = await prisma.product.findFirstOrThrow({ where: { workspaceId: ws, externalId: "sku:A" } });
    expect([p.materials, p.price?.toFixed(2)]).toEqual(["Oak", "10.00"]);
  });

  it("a file with no good row writes and archives nothing", async () => {
    await upload("Name,SKU\nMilo,A", ["title", "sku"]);
    expect((await upload("Name,SKU\n,B", ["title", "sku"])).status).toBe(422);
    expect(await live()).toEqual(["IMPORT:sku:A"]);
  });

  it("two imports at once both finish, one after the other, with consistent rows", async () => {
    const [a, b] = await Promise.all([upload("Name,SKU\nMilo,A\nOslo,B", ["title", "sku"]), upload("Name,SKU\nMilo,A\nAva,C", ["title", "sku"])]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const rows = await live();
    expect(rows.length).toBe(2);
    expect(rows).toContain("IMPORT:sku:A");
  });
});
