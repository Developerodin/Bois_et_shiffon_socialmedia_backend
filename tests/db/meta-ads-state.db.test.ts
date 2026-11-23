import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/db/prisma";
import { newToken } from "@/server/auth/tokens";
import { completeConnect, ConnectionError } from "@/server/services/connections";

/**
 * A connect's state is bound to the provider it started with: a Facebook Pages (META) state can't complete on the
 * Meta Ads callback, and the other way round. The state is left unused and no code exchange happens.
 */
let workspaceId = "";
let brandId = "";
let userId = "";

beforeAll(async () => {
  workspaceId = (await prisma.workspace.create({ data: { name: "ads", slug: "w-meta-ads-state" } })).id;
  brandId = (await prisma.brand.create({ data: { workspaceId, slug: "b", displayName: "B" } })).id;
  userId = (await prisma.user.create({ data: { email: "owner@meta-ads-state.test", name: "Owner" } })).id;
  process.env.META_APP_ID = "app";
  process.env.META_APP_SECRET = "shh";
});
afterEach(() => vi.unstubAllGlobals());

async function stateFor(provider: "META" | "META_ADS") {
  const { raw, hash } = newToken();
  await prisma.oAuthStateTransaction.create({ data: { stateHash: hash, workspaceId, brandId, userId, provider, expiresAt: new Date(Date.now() + 600_000) } });
  return { raw, hash };
}

describe("OAuth state is bound to its provider", () => {
  it.each([
    ["META", "META_ADS"],
    ["META_ADS", "META"],
  ] as const)("a %s state can't complete as %s", async (started, callback) => {
    const exchange = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", exchange);
    const { raw, hash } = await stateFor(started);
    await expect(completeConnect({ provider: callback, state: raw, code: "code", userId })).rejects.toBeInstanceOf(ConnectionError);
    expect(exchange).not.toHaveBeenCalled();
    expect((await prisma.oAuthStateTransaction.findUniqueOrThrow({ where: { stateHash: hash } })).consumedAt).toBeNull();
    expect(await prisma.integrationConnection.count({ where: { brandId } })).toBe(0);
  });

  it("META_ADS is a stored provider value", async () => {
    const { hash } = await stateFor("META_ADS");
    expect((await prisma.oAuthStateTransaction.findUniqueOrThrow({ where: { stateHash: hash } })).provider).toBe("META_ADS");
  });
});
