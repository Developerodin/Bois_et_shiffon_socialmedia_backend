import { describe, expect, it, vi } from "vitest";

const safeFetchBytes = vi.hoisted(() => vi.fn());
vi.mock("@/server/db/prisma", () => ({ prisma: {} }));
vi.mock("@/server/jobs/queue", () => ({ enqueueJob: vi.fn() }));
vi.mock("@/server/research/crawl", () => ({ htmlText: (s: string) => s, safeFetch: vi.fn(), safeFetchBytes }));

import { websiteFeed } from "@/server/catalog/sync";

const page = (status: number, body = "<html></html>") => ({ status, bytes: new TextEncoder().encode(body), truncated: false, url: new URL("https://shop.test/products.json") });

describe("websiteFeed", () => {
  it("says the site blocks us when the feed answers 403", async () => {
    safeFetchBytes.mockResolvedValueOnce(page(403));
    const res = await websiteFeed("https://shop.test");
    expect(res.note?.reason).toBe("blocked");
    expect(res.rows).toEqual([]);
  });

  it("says there is no feed when the site answers 404", async () => {
    safeFetchBytes.mockResolvedValueOnce(page(404));
    expect((await websiteFeed("https://shop.test")).note?.reason).toBe("not-a-feed");
  });
});
