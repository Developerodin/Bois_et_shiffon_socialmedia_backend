import { describe, expect, it, vi } from "vitest";

const enqueueJob = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@/server/db/prisma", () => ({ prisma: {} }));
vi.mock("@/server/jobs/queue", () => ({ enqueueJob }));

import { enqueueCatalogSync } from "@/server/catalog/sync";

describe("enqueueCatalogSync", () => {
  it("stores only the workspace and brand, even when handed the whole route scope", async () => {
    const routeScope = { userId: "u1", workspaceId: "w1", brandId: "b1", perms: new Set(["brand.read"]), clientReviewer: false };
    await enqueueCatalogSync(routeScope, "k");
    expect(enqueueJob).toHaveBeenCalledWith(expect.objectContaining({ payload: { workspaceId: "w1", brandId: "b1" } }));
  });
});
