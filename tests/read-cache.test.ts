import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  call: vi.fn(),
  limit: vi.fn(),
  conns: vi.fn(),
  conn: vi.fn(),
}));
vi.mock("@/server/db/transient", () => ({
  getTransient: vi.fn(async (k: string) => m.store.get(k) ?? null),
  putTransient: vi.fn(async (k: string, v: unknown) => void m.store.set(k, v)),
  dropTransient: vi.fn(async (k: string) => void m.store.delete(k)),
}));
vi.mock("@/server/db/prisma", () => ({ prisma: { integrationConnection: { findMany: m.conns, findFirst: m.conn }, auditEvent: { create: vi.fn(async () => ({})) } } }));
vi.mock("@/server/integrations/providers", () => ({ call: m.call, ProviderError: class extends Error {} }));
vi.mock("@/server/services/connections", () => ({ accessToken: vi.fn(async () => "t"), markReconnect: vi.fn() }));
vi.mock("@/server/auth/rate-limit", () => ({ hitRateLimit: m.limit }));

import { inbox, sendReply } from "@/server/customers/inbox";
import { cachedRead } from "@/server/db/read-cache";

const scope = { workspaceId: "w1", brandId: "b1", userId: "u1" };
const ig = { id: "c1", provider: "INSTAGRAM", externalAccountId: "me1", displayName: "@shop", scopes: ["instagram_business_manage_messages"] };
const conversations = { data: [{ id: "t1", updated_time: "2026-11-17T10:00:00Z", participants: { data: [{ id: "p1", username: "ana" }] }, messages: { data: [] } }] };

beforeEach(() => {
  vi.clearAllMocks();
  m.store.clear();
  m.limit.mockResolvedValue({ allowed: true, count: 1 });
  m.conns.mockResolvedValue([ig]);
  m.conn.mockResolvedValue(ig);
  m.call.mockImplementation(async (url: string) => (url.includes("/me/conversations") ? conversations : url.includes("/me/messages") ? { message_id: "m1" } : conversations.data[0]));
});

describe("cachedRead", () => {
  it("loads once within the TTL, and caches empty results too", async () => {
    const load = vi.fn(async () => []);
    expect(await cachedRead("k", 45_000, load)).toEqual([]);
    expect(await cachedRead("k", 45_000, load)).toEqual([]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("stores nothing when the load throws", async () => {
    await expect(cachedRead("k", 45_000, async () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(m.store.size).toBe(0);
  });
});

describe("inbox cache", () => {
  it("reads Meta and counts the rate limit once per 45 s per brand", async () => {
    await inbox(scope);
    await inbox(scope);
    expect(m.call).toHaveBeenCalledTimes(1);
    expect(m.limit).toHaveBeenCalledTimes(1);
  });

  it("reads again right after a reply goes out", async () => {
    await inbox(scope);
    await sendReply(scope, "c1", "t1", "Merci !");
    m.call.mockClear();
    await inbox(scope);
    expect(m.call.mock.calls.some(([url]) => String(url).includes("/me/conversations"))).toBe(true);
  });
});
