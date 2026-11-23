import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const d = {
    $transaction: vi.fn(async (f: (tx: unknown) => unknown): Promise<unknown> => f(d)),
    integrationConnection: { updateMany: vi.fn(), findMany: vi.fn(async (): Promise<unknown[]> => []) },
    publicationAttempt: { findMany: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    contentItem: { updateMany: vi.fn(async () => ({ count: 1 })) },
    auditEvent: { create: vi.fn(async () => ({})) },
  };
  return d;
});
const refresh = vi.hoisted(() => vi.fn());
vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/crypto/credentials", () => ({ currentKeyVersion: () => 1, encryptCredentials: () => "sealed", decryptCredentials: () => ({ accessToken: "old", refreshToken: "r" }) }));
vi.mock("@/server/integrations/providers", () => ({
  PROVIDERS: { INSTAGRAM: { refresh, label: "Instagram" }, THREADS: { refresh, label: "Threads" }, META_ADS: { noRefresh: true, label: "Meta Ads" } },
  providerConfig: () => ({ clientId: "id", secret: "s" }),
  ProviderError: class extends Error {},
}));

import { accessToken, disconnect, ReconnectNeeded, refreshExpiringTokens } from "@/server/services/connections";

const input = { workspaceId: "w1", brandId: "b1", connectionId: "c1", userId: "u1" };
const frame = (i: number, state: string) => ({ i, state, mediaId: state === "published" ? `m${i}` : null });

beforeEach(() => {
  vi.clearAllMocks();
  db.integrationConnection.updateMany.mockResolvedValue({ count: 1 });
});

describe("disconnect", () => {
  it("cancels a plain scheduled post and puts its item back to APPROVED", async () => {
    db.publicationAttempt.findMany.mockResolvedValue([{ id: "a1", contentItemId: "i1", target: {} }]);
    await disconnect(input);
    expect(db.publicationAttempt.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["a1"] }, status: "SCHEDULED" }, data: expect.objectContaining({ status: "CANCELLED" }) });
    expect(db.contentItem.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["i1"] }, status: "SCHEDULED" }, data: { status: "APPROVED" } });
  });

  it("puts a story's Post the rest back to PARTIAL, item still SCHEDULED, so frames already out aren't posted again", async () => {
    const target = { story: true, frames: 3, progress: [frame(0, "published"), frame(1, "published")] };
    db.publicationAttempt.findMany.mockResolvedValue([{ id: "a2", contentItemId: "i2", target }]);
    await disconnect(input);
    expect(db.publicationAttempt.updateMany).toHaveBeenCalledTimes(1);
    expect(db.publicationAttempt.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["a2"] }, status: "SCHEDULED" }, data: expect.objectContaining({ status: "PARTIAL" }) });
    expect(db.contentItem.updateMany).not.toHaveBeenCalled();
  });
});

describe("accessToken refresh", () => {
  const conn = { id: "c1", provider: "INSTAGRAM", status: "ACTIVE", displayName: "@shop", encryptedCredentials: "x", tokenExpiresAt: new Date(Date.now() + 86_400_000) } as Parameters<typeof accessToken>[0];

  it("writes the new tokens only onto a still-connected account", async () => {
    refresh.mockResolvedValue({ credentials: { accessToken: "new", refreshToken: "r2" }, tokenExpiresAt: new Date(Date.now() + 60 * 86_400_000) });
    db.integrationConnection.updateMany.mockResolvedValue({ count: 1 });
    await expect(accessToken(conn)).resolves.toBe("new");
    expect(db.integrationConnection.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "c1", status: "ACTIVE" } }));
  });

  it("disconnected during the refresh: nothing written back, and no token handed out", async () => {
    refresh.mockResolvedValue({ credentials: { accessToken: "new", refreshToken: "r2" }, tokenExpiresAt: new Date(Date.now() + 60 * 86_400_000) });
    db.integrationConnection.updateMany.mockResolvedValue({ count: 0 });
    await expect(accessToken(conn)).rejects.toBeInstanceOf(ReconnectNeeded);
  });
});

describe("no-refresh tokens (Meta Ads)", () => {
  const DAY = 86_400_000;
  const conn = (provider: string, inMs: number) =>
    ({ id: "c1", provider, status: "ACTIVE", displayName: "Ads", encryptedCredentials: "x", tokenExpiresAt: new Date(Date.now() + inMs) }) as Parameters<typeof accessToken>[0];

  it("used until it actually expires: a day out, no refresh and nothing written", async () => {
    await expect(accessToken(conn("META_ADS", DAY))).resolves.toBe("old");
    await expect(accessToken(conn("META_ADS", 60_000))).resolves.toBe("old");
    expect(refresh).not.toHaveBeenCalled();
    expect(db.integrationConnection.updateMany).not.toHaveBeenCalled();
  });

  it("once expired: Needs reconnect", async () => {
    await expect(accessToken(conn("META_ADS", -1000))).rejects.toBeInstanceOf(ReconnectNeeded);
    expect(db.integrationConnection.updateMany).toHaveBeenCalledWith({ where: { id: "c1", status: "ACTIVE" }, data: expect.objectContaining({ status: "ERROR" }) });
  });

  it("other adapters unchanged: Threads and Instagram still refresh 3 days ahead", async () => {
    refresh.mockResolvedValue({ credentials: { accessToken: "new" }, tokenExpiresAt: new Date(Date.now() + 60 * DAY) });
    await expect(accessToken(conn("THREADS", DAY))).resolves.toBe("new");
    await expect(accessToken(conn("INSTAGRAM", 2 * DAY))).resolves.toBe("new");
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("7-day warning: a fixed 'Reconnect Meta Ads before <date>' note, status left ACTIVE", async () => {
    const at = new Date(Date.now() + 5 * DAY);
    db.integrationConnection.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "c9", provider: "META_ADS", tokenExpiresAt: at }]);
    await refreshExpiringTokens();
    expect(db.integrationConnection.findMany).toHaveBeenLastCalledWith({
      where: { status: "ACTIVE", provider: { in: ["META_ADS"] }, tokenExpiresAt: { gt: expect.any(Date), lt: expect.any(Date) } },
      select: { id: true, provider: true, tokenExpiresAt: true },
    });
    const { lt } = (db.integrationConnection.findMany.mock.calls[1] as unknown as [{ where: { tokenExpiresAt: { lt: Date } } }])[0].where.tokenExpiresAt;
    expect(Math.round((lt.getTime() - Date.now()) / DAY)).toBe(7);
    expect(db.integrationConnection.updateMany).toHaveBeenCalledWith({
      where: { id: "c9", status: "ACTIVE" },
      data: { lastError: `Reconnect Meta Ads before ${at.toISOString().slice(0, 10)}.` },
    });
  });
});
