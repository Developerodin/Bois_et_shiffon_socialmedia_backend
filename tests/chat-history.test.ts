import { beforeEach, describe, expect, it, vi } from "vitest";

// The chat route over a stubbed auth, database and model: what a saved thread's sales steps show for each role.
const m = vi.hoisted(() => ({ authorize: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), streamText: vi.fn(), toUIMessageStream: vi.fn() }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: m.authorize }));
vi.mock("@/server/db/prisma", () => ({
  prisma: { chatThread: { findFirst: m.findFirst, findUnique: m.findUnique }, brand: { findFirstOrThrow: async () => ({ displayName: "B", profile: null }) } },
}));
vi.mock("@/server/auth/rate-limit", () => ({ hitRateLimit: async () => ({ allowed: true }), limitKey: (k: string, v: string) => `${k}:${v}` }));
vi.mock("@/server/ai/model-config", () => ({ modelConfig: async () => ({}) }));
vi.mock("@/server/ai/models", async (orig) => ({ ...(await orig<object>()), modelFor: () => ({ tier: "medium", model: "gpt-test" }) }));
vi.mock("ai", async (orig) => ({
  ...(await orig<object>()),
  streamText: m.streamText,
  toUIMessageStream: m.toUIMessageStream,
  createUIMessageStreamResponse: () => new Response(null),
}));

import { GET, POST } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/chat/route";
import { SALES_HIDDEN } from "@/server/chat/turn";

const params = Promise.resolve({ workspaceId: "w1", brandId: "b1" });
const sales = { type: "tool-salesSummary", toolCallId: "1", state: "output-available", input: {}, output: { total: "900.00" } };
const thread = { id: "t1", messages: [{ id: "a", role: "assistant", parts: [sales] }] };
const as = (perms: string[]) => m.authorize.mockResolvedValue({ workspaceId: "w1", brandId: "b1", userId: "u1", perms: new Set(perms) });
const read = async (perms: string[]) => {
  as(perms);
  return (await (await GET(new Request("http://x/api"), { params })).json()).thread;
};

beforeEach(() => {
  m.findFirst.mockResolvedValue(thread);
  m.findUnique.mockResolvedValue({ ...thread, id: "thread-1", userId: "u1", brandId: "b1" });
  m.streamText.mockReset().mockReturnValue({ consumeStream: () => {}, stream: new ReadableStream() });
  m.toUIMessageStream.mockReset().mockReturnValue(new ReadableStream());
});

describe("chat GET", () => {
  it("hides a saved sales step's figures from a viewer without crm.read", async () => {
    expect((await read(["agents.read"])).messages[0].parts[0]).toEqual({ ...sales, output: SALES_HIDDEN });
  });

  it("returns the thread as saved to a viewer with crm.read", async () => {
    expect(await read(["agents.read", "crm.read"])).toEqual(thread);
  });

  it("hides a saved ads step from a viewer who lost ads.read, and keeps the sales step for crm.read", async () => {
    const ads = { type: "tool-adsSummary", toolCallId: "2", state: "output-available", input: {}, output: { spend: "120.00" } };
    m.findFirst.mockResolvedValue({ id: "t1", messages: [{ id: "a", role: "assistant", parts: [sales, ads] }] });
    const parts = (await read(["agents.read", "crm.read"])).messages[0].parts;
    expect(parts).toEqual([sales, { ...ads, output: { error: "Your role can't see ads." } }]);
  });
});

describe("chat POST", () => {
  const send = async (perms: string[]) => {
    as(perms);
    const body = { id: "thread-1", message: { id: "u", role: "user", parts: [{ type: "text", text: "And this week?" }] } };
    await POST(new Request("http://x/api", { method: "POST", body: JSON.stringify(body) }), { params });
    const model = JSON.stringify(m.streamText.mock.calls[0]![0].messages);
    const saved = JSON.stringify(m.toUIMessageStream.mock.calls[0]![0].originalMessages);
    return { model, saved };
  };

  it("doesn't give the model a saved sales step's figures for a person without crm.read; the thread keeps them", async () => {
    const { model, saved } = await send(["agents.read"]);
    expect(model).not.toContain("900.00");
    expect(model).toContain(SALES_HIDDEN.error);
    expect(saved).toContain("900.00");
  });

  it("doesn't give the model a saved ads step's figures once ads.read is lost; the thread keeps them", async () => {
    const ads = { type: "tool-adsSummary", toolCallId: "2", state: "output-available", input: {}, output: { spend: "120.00" } };
    m.findUnique.mockResolvedValue({ id: "thread-1", userId: "u1", brandId: "b1", messages: [{ id: "a", role: "assistant", parts: [ads] }] });
    const { model, saved } = await send(["agents.read", "crm.read"]);
    expect(model).not.toContain("120.00");
    expect(model).toContain("Your role can't see ads.");
    expect(saved).toContain("120.00");
  });

  it("gives them to the model for a person with crm.read", async () => {
    const { model, saved } = await send(["agents.read", "crm.read"]);
    expect(model).toContain("900.00");
    expect(saved).toContain("900.00");
  });
});
