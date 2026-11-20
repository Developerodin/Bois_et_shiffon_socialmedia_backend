import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const d = {
    contentItem: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), count: vi.fn(async () => 0) },
    contentVersion: { create: vi.fn() },
    auditEvent: { create: vi.fn() },
    approvalDecision: { findMany: vi.fn(async () => [] as unknown[]) },
    product: { findMany: vi.fn(async () => [] as unknown[]) },
    brandProfile: { findFirst: vi.fn(async () => null) },
    qualityCheck: { findMany: vi.fn(async () => [] as unknown[]), create: vi.fn() },
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(),
  };
  d.$transaction.mockImplementation(async (fn: (tx: typeof d) => unknown) => fn(d));
  return d;
});

vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/agents/engine", () => ({ startAgentRun: vi.fn(async () => null), NothingToDoError: class extends Error {} }));
vi.mock("@/server/services/context-docs", () => ({ listContextDocs: vi.fn(async () => []) }));
vi.mock("@/server/catalog/linked", () => ({ linkedProducts: vi.fn(async () => []) }));
vi.mock("@/server/research/brand-assets", async (orig) => ({ ...(await orig<object>()), storeImage: vi.fn(async () => null) }));

import { creatorAgent } from "@/server/agents/definitions/creator";
import { pinDestination, saveDraft } from "@/server/services/publishing";

const scope = { workspaceId: "w1", brandId: "b1" };
const base = { hook: "", caption: "Hello", hashtags: [], slides: [], script: [], pinTitle: "T", altText: "a" };
const saved = () => db.contentVersion.create.mock.calls.at(-1)![0].data.body as Record<string, unknown>;
const pin = (body: object, status = "DRAFT_REVIEW") => ({ id: "i1", ...scope, title: "P", channel: "PINTEREST_PIN", status, studio: false, productIds: [], brief: null, versions: [{ id: "v1", version: 1, body, checks: [] }], decisions: [] });

beforeEach(() => { vi.clearAllMocks(); db.contentVersion.create.mockResolvedValue({ version: 2 }); });

describe("a pin's destination link", () => {
  it("uses the pin's own link", () => {
    expect(pinDestination("https://shop.example/products/milo", "https://shop.example")).toBe("https://shop.example/products/milo");
  });
  it("falls back to the brand website", () => {
    expect(pinDestination(undefined, "https://shop.example")).toBe("https://shop.example/");
    expect(pinDestination("javascript:alert(1)", "https://shop.example")).toBe("https://shop.example/"); // a body that skipped the save check
    expect(pinDestination(undefined, null)).toBeNull();
  });
  it("saves the link as URL.href", async () => {
    db.contentItem.findFirst.mockResolvedValue(pin({ caption: "old" }));
    await saveDraft({ ...scope, userId: "u1", itemId: "i1", version: 1, body: { ...base, pinLink: " https://Shop.example/a b " } });
    expect(saved().pinLink).toBe("https://shop.example/a%20b");
  });
  it.each([
    "http://shop.example/a",
    "https://user:pw@shop.example/a",
    "https://user@shop.example/a",
    "ftp://shop.example/a",
    "not a url",
    `https://shop.example/${"a".repeat(2000)}`,
  ])("refuses http, credentials or over 2000 chars: %s", async (pinLink) => {
    db.contentItem.findFirst.mockResolvedValue(pin({ caption: "old" }));
    await expect(saveDraft({ ...scope, userId: "u1", itemId: "i1", version: 1, body: { ...base, pinLink } })).rejects.toMatchObject({ status: 400 });
    expect(db.contentVersion.create).not.toHaveBeenCalled();
  });
  it("an emptied field takes the link off, a missing one keeps it", async () => {
    db.contentItem.findFirst.mockResolvedValue(pin({ caption: "old", pinLink: "https://shop.example/a" }));
    await saveDraft({ ...scope, userId: "u1", itemId: "i1", version: 1, body: { ...base, pinLink: "" } });
    expect(saved()).not.toHaveProperty("pinLink");
    await saveDraft({ ...scope, userId: "u1", itemId: "i1", version: 1, body: base });
    expect(saved().pinLink).toBe("https://shop.example/a");
  });
});

describe("Creator rewrite", () => {
  const ai = vi.fn(async (input: { mock: unknown }) => input.mock);
  const ctx = { runId: "r1", brand: { ...scope, displayName: "Brand" }, log: vi.fn(), ai: { generateObject: ai } } as never;
  const run = async (channel: string) => {
    db.contentItem.findMany.mockResolvedValue([{ ...pin({ ...base, photoKeys: [], productIds: [], pinLink: "https://shop.example/a" }), channel, decisions: [{ verdict: "CHANGES_REQUESTED", contentVersionId: "v1", note: "shorter", switchProducts: false }] }]);
    db.contentItem.findUnique.mockResolvedValue({ status: "DRAFT_REVIEW", versions: [{ version: 1 }] });
    await creatorAgent.run(ctx, {});
    return saved();
  };
  it("a rewrite keeps the pin's link", async () => {
    expect((await run("PINTEREST_PIN")).pinLink).toBe("https://shop.example/a");
  });
  it("other channels don't take one", async () => {
    expect(await run("INSTAGRAM_POST")).not.toHaveProperty("pinLink");
  });
});
