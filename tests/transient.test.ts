import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  prisma: {
    $queryRaw: vi.fn(),
    transientEntry: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  },
}));
vi.mock("@/server/db/prisma", () => ({ prisma: m.prisma }));

import { claimTransient, getTransient, putTransient, takeTransient } from "@/server/db/transient";

beforeEach(() => vi.clearAllMocks());

describe("transient entries", () => {
  it("claims only when the insert returns a row", async () => {
    m.prisma.$queryRaw.mockResolvedValueOnce([{ key: "k" }]);
    expect(await claimTransient("k", { a: 1 }, 1000)).toBe(true);
    m.prisma.$queryRaw.mockResolvedValueOnce([]);
    expect(await claimTransient("k", { a: 1 }, 1000)).toBe(false);
  });

  it("takes a value once", async () => {
    m.prisma.$queryRaw.mockResolvedValueOnce([{ value: { x: 1 } }]).mockResolvedValueOnce([]);
    expect(await takeTransient("k")).toEqual({ x: 1 });
    expect(await takeTransient("k")).toBeNull();
  });

  it("reads null for a missing or expired entry", async () => {
    m.prisma.transientEntry.findUnique.mockResolvedValueOnce({ key: "k", value: 1, expiresAt: new Date(Date.now() - 1) });
    expect(await getTransient("k")).toBeNull();
    m.prisma.transientEntry.findUnique.mockResolvedValueOnce(null);
    expect(await getTransient("k")).toBeNull();
    m.prisma.transientEntry.findUnique.mockResolvedValueOnce({ key: "k", value: 2, expiresAt: new Date(Date.now() + 60_000) });
    expect(await getTransient("k")).toBe(2);
  });

  it("upserts with the ttl as expiry", async () => {
    await putTransient("k", { y: 1 }, 5000);
    const arg = m.prisma.transientEntry.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ key: "k" });
    expect(arg.create.expiresAt.getTime()).toBeGreaterThan(Date.now() + 4000);
  });
});
