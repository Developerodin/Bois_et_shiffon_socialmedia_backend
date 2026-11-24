import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/db/prisma";

vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: vi.fn(async (_r: Request, p: Promise<{ workspaceId: string; brandId: string }>) => ({ userId: "u1", ...(await p) })) }));
vi.mock("@/server/jobs/runner", () => ({ kickRunner: vi.fn() }));
// No DNS lookups: every website is taken as public.
vi.mock("@/server/research/crawl", async (orig) => ({ ...(await orig<object>()), assertPublicUrl: vi.fn(async (u: string) => new URL(u)) }));

import { PATCH } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/route";
import { POST as syncNow } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/products/sync/route";

/** The brand route's website change against the site reader's rows, and the Sync now limit. */
let ws: string;
const params = (brandId = "bs-a") => ({ params: Promise.resolve({ workspaceId: ws, brandId }) });
const patch = (websiteUrl: string, brandId = "bs-a") =>
  PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify({ websiteUrl }) }), params(brandId));
const seed = async (brandId: string) => {
  await prisma.catalogPage.create({ data: { workspaceId: ws, brandId, url: "https://shop.test/p/1", productKeys: ["sku:1"] } });
  await prisma.product.create({ data: { workspaceId: ws, brandId, source: "SITE", externalId: "sku:1", title: "Chair" } });
  await prisma.product.create({ data: { workspaceId: ws, brandId, source: "MANUAL", title: "Lamp" } });
};
const state = async (brandId = "bs-a") => ({
  pages: await prisma.catalogPage.count({ where: { brandId } }),
  live: (await prisma.product.findMany({ where: { brandId, archivedAt: null }, orderBy: { title: "asc" } })).map((p) => p.source),
});

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-brand-site" } })).id;
  for (const id of ["bs-a", "bs-b"]) await prisma.brand.create({ data: { id, workspaceId: ws, slug: id, displayName: id } });
});
beforeEach(async () => {
  for (const t of [prisma.catalogPage, prisma.product, prisma.brandProfile, prisma.job, prisma.rateLimitBucket]) await (t as typeof prisma.job).deleteMany({});
  for (const id of ["bs-a", "bs-b"]) {
    await prisma.brandProfile.create({ data: { workspaceId: ws, brandId: id, websiteUrl: "https://shop.test" } });
    await seed(id);
  }
});

describe("changing the brand's website", () => {
  it("another host: the brand's pages go and its SITE products are archived; other rows and brands stay", async () => {
    expect((await patch("https://newshop.test")).status).toBe(200);
    expect(await state()).toEqual({ pages: 0, live: ["MANUAL"] });
    expect(await state("bs-b")).toEqual({ pages: 1, live: ["SITE", "MANUAL"] });
  });

  it("the same site (www., another path): nothing is cleared", async () => {
    expect((await patch("https://www.shop.test/fr")).status).toBe(200);
    expect(await state()).toEqual({ pages: 1, live: ["SITE", "MANUAL"] });
  });
});

describe("Sync now", () => {
  it("allows 6 presses an hour per person and brand, then answers 429", async () => {
    const press = (brandId = "bs-a") => syncNow(new Request("http://x", { method: "POST" }), params(brandId));
    for (let i = 0; i < 6; i++) expect((await press()).status).toBe(202);
    expect((await press()).status).toBe(429);
    expect((await press("bs-b")).status).toBe(202); // another brand has its own count
  });
});
