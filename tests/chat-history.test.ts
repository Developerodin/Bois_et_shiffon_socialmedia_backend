import { beforeEach, describe, expect, it, vi } from "vitest";

// The chat's GET over a stubbed auth and database: what a saved thread's sales steps show for each role.
const m = vi.hoisted(() => ({ authorize: vi.fn(), findFirst: vi.fn() }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: m.authorize }));
vi.mock("@/server/db/prisma", () => ({ prisma: { chatThread: { findFirst: m.findFirst } } }));

import { GET } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/chat/route";
import { SALES_HIDDEN } from "@/server/chat/turn";

const params = Promise.resolve({ workspaceId: "w1", brandId: "b1" });
const sales = { type: "tool-salesSummary", toolCallId: "1", state: "output-available", input: {}, output: { total: "900.00" } };
const thread = { id: "t1", messages: [{ id: "a", role: "assistant", parts: [sales] }] };
const read = async (perms: string[]) => {
  m.authorize.mockResolvedValue({ workspaceId: "w1", brandId: "b1", userId: "u1", perms: new Set(perms) });
  return (await (await GET(new Request("http://x/api"), { params })).json()).thread;
};

beforeEach(() => m.findFirst.mockResolvedValue(thread));

describe("chat GET", () => {
  it("hides a saved sales step's figures from a viewer without crm.read", async () => {
    expect((await read(["agents.read"])).messages[0].parts[0]).toEqual({ ...sales, output: SALES_HIDDEN });
  });

  it("returns the thread as saved to a viewer with crm.read", async () => {
    expect(await read(["agents.read", "crm.read"])).toEqual(thread);
  });
});
