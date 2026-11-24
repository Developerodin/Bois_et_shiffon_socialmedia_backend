import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ safeFetchBytes: vi.fn(), enqueueJob: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 0 })) }));
vi.mock("@/server/jobs/queue", () => ({ enqueueJob: m.enqueueJob }));
vi.mock("@/server/research/crawl", async (orig) => ({ ...(await orig<object>()), safeFetch: vi.fn(async () => ({ status: 404, body: "" })), safeFetchBytes: m.safeFetchBytes }));
vi.mock("@/server/db/prisma", () => {
  const tx = { $executeRaw: vi.fn(async () => 0), product: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })) }, brandProfile: { updateMany: m.updateMany } };
  return {
    prisma: {
      integrationConnection: { findFirst: vi.fn(async () => null) },
      brandProfile: { findFirst: vi.fn(async () => ({ websiteUrl: "https://shop.test", catalogSync: null })), updateMany: m.updateMany },
      product: { updateMany: vi.fn(async () => ({ count: 0 })), count: vi.fn(async () => 0) },
      catalogPage: { count: vi.fn(async () => 0) },
      job: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null), count: vi.fn(async () => 0) },
      $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    },
  };
});

import { spacingMs } from "@/server/catalog/page-reader";
import { runCatalogSync } from "@/server/catalog/sync";
import { stockState } from "@/server/content/product-checks";

const res = (status: number) => ({ status, bytes: new TextEncoder().encode("<html></html>"), truncated: false, url: new URL("https://shop.test/products.json"), headers: new Headers() });
const scope = { workspaceId: "w1", brandId: "b1" };
const recorded = () => (m.updateMany.mock.calls.at(-1) as unknown as [{ data: { catalogSync: Record<string, unknown> } }])[0].data.catalogSync;

beforeEach(() => vi.clearAllMocks());

describe("runCatalogSync and the site reader", () => {
  it("NOT_A_FEED queues the page job and says it is reading; BLOCKED doesn't", async () => {
    m.safeFetchBytes.mockResolvedValueOnce(res(404));
    await runCatalogSync(scope);
    const day = new Date().toISOString().slice(0, 10);
    expect(m.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
      type: "catalog.pages", idempotencyKey: `catalog-pages:b1:${day}:0`, payload: { workspaceId: "w1", brandId: "b1", day, step: 0 },
    }));
    expect(recorded()).toMatchObject({ source: "SITE", reason: "reading", error: null, pages: { read: 0, total: 0, capped: false } });

    vi.clearAllMocks();
    m.safeFetchBytes.mockResolvedValueOnce(res(403));
    await runCatalogSync(scope);
    expect(m.enqueueJob).not.toHaveBeenCalled();
    expect(recorded()).toMatchObject({ source: "WEBSITE", reason: "blocked" });
  });
});

describe("spacingMs", () => {
  it("waits at least 1 s, the site's Crawl-delay when longer, at most 10 s", () => {
    expect(spacingMs(null)).toBe(1000);
    expect(spacingMs(0.2)).toBe(1000);
    expect(spacingMs(4)).toBe(4000);
    expect(spacingMs(60)).toBe(10_000);
  });
});

describe("stockState for SITE rows", () => {
  const now = new Date("2026-11-24T12:00:00Z");
  const row = (source: string, hoursAgo: number) => ({ source, inStock: true, stockQuantity: null, stockCheckedAt: new Date(now.getTime() - hoursAgo * 3_600_000) }) as Parameters<typeof stockState>[0][number];
  it("a SITE row is fresh for 8 days after its page was read; a feed row for 50 h", () => {
    expect(stockState([row("SITE", 7 * 24)], now)).toBe("in");
    expect(stockState([row("SITE", 8 * 24 + 1)], now)).toBe("unconfirmed");
    expect(stockState([row("WEBSITE", 51)], now)).toBe("unconfirmed");
  });
});
