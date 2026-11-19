import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  product: { count: vi.fn(), findMany: vi.fn() },
  brandProfile: { findFirst: vi.fn() },
}));

vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: vi.fn(async () => ({ userId: "u1", workspaceId: "w1", brandId: "b1" })) }));
vi.mock("@/server/jobs/runner", () => ({ kickIfDue: vi.fn(async () => {}) }));
vi.mock("@/server/catalog/sync", () => ({ catalogSource: vi.fn(async () => ({ source: "WEBSITE" })), catalogSyncRunning: vi.fn(async () => false), httpUrl: (u: string) => u }));

import { GET } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/products/route";

const params = Promise.resolve({ workspaceId: "w1", brandId: "b1" });
const get = (qs: string) => GET(new Request(`http://x/api?${qs}`), { params });

beforeEach(() => {
  vi.clearAllMocks();
  db.product.findMany.mockResolvedValue([]);
  db.brandProfile.findFirst.mockResolvedValue(null);
});

describe("GET products, paged", () => {
  it("returns the page, its size and the totals, newest first with id breaking ties", async () => {
    db.product.count.mockResolvedValue(1393);
    const res = await get("page=2&limit=20");
    expect(res.status).toBe(200);
    expect((await res.json()).pagination).toEqual({ page: 2, limit: 20, total: 1393, totalPages: 70 });
    expect(db.product.findMany.mock.calls[0][0]).toMatchObject({ skip: 20, take: 20, orderBy: [{ updatedAt: "desc" }, { id: "desc" }] });
  });

  it("clamps a page past the end to the last page, and an empty list to page 1", async () => {
    db.product.count.mockResolvedValue(41);
    expect((await (await get("page=9&limit=20")).json()).pagination).toMatchObject({ page: 3, totalPages: 3 });
    db.product.count.mockResolvedValue(0);
    expect((await (await get("page=4")).json()).pagination).toEqual({ page: 1, limit: 50, total: 0, totalPages: 1 });
  });

  it("refuses page sizes it doesn't offer and pages below 1", async () => {
    expect((await get("page=1&limit=1000")).status).toBe(400);
    expect((await get("page=0")).status).toBe(400);
    expect((await get("page=abc")).status).toBe(400);
    expect(db.product.findMany).not.toHaveBeenCalled();
  });

  it("searches title and SKU, and 'out' keeps rows whose stock is unknown", async () => {
    db.product.count.mockResolvedValue(0);
    await get("page=1&q=%20oak%20&stock=out");
    const where = db.product.count.mock.calls[0][0].where;
    expect(where).toMatchObject({ workspaceId: "w1", brandId: "b1", archivedAt: null });
    expect(where.AND[0].OR).toEqual([{ title: { contains: "oak", mode: "insensitive" } }, { sku: { contains: "oak", mode: "insensitive" } }]);
    // "Out" keeps unknown stock: count 0-or-none AND inStock false-or-none (both null = unknown).
    expect(where.AND.slice(1)).toEqual([{ OR: [{ stockQuantity: { lte: 0 } }, { stockQuantity: null }] }, { OR: [{ inStock: false }, { inStock: null }] }]);
  });

  it("counts an untracked item the store still sells (0 but inStock) as in stock, like its label", async () => {
    db.product.count.mockResolvedValue(0);
    await get("page=1&stock=in");
    expect(db.product.count.mock.calls[0][0].where.AND[0].OR).toContainEqual({ inStock: true });
  });

  it("without page, still returns the whole list and no pagination", async () => {
    db.product.findMany.mockResolvedValue([]);
    const body = await (await get("")).json();
    expect(body.pagination).toBeUndefined();
    expect(db.product.count).not.toHaveBeenCalled();
    expect(db.product.findMany.mock.calls[0][0].skip).toBeUndefined();
  });
});
