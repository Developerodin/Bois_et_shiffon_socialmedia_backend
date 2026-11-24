import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/prisma", () => ({ prisma: {} }));

import { askCartWriteAdapter } from "@/server/shopify/adapter";
import { confirmToken, payloadHash, readConfirmToken, writesReady } from "@/server/shopify/writes";
import { fakeShopify } from "./fixtures/shopify-fake";

const NOW = new Date("2026-11-24T12:00:00Z");
const claims = {
  brandId: "b1",
  entityType: "QUOTE" as const,
  entityId: "q1",
  version: 3,
  action: "DRAFT_ORDER_INVOICE_SEND" as const,
  attempt: 1,
  hash: "abc",
  userId: "u1",
  exp: NOW.getTime() + 600_000,
};
const scope = { workspaceId: "w1", brandId: "b1", userId: "u1", perms: new Set<never>() };

beforeAll(() => {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
});

describe("payloadHash", () => {
  it("is the same whatever the key order, and changes with any field", () => {
    const invoice = { to: "a@b.test", subject: "Your quote", message: "Hello", lines: [{ q: 1, t: "x" }] };
    expect(payloadHash(invoice)).toBe(payloadHash({ lines: [{ t: "x", q: 1 }], message: "Hello", subject: "Your quote", to: "a@b.test" }));
    expect(payloadHash({ ...invoice, to: "c@d.test" })).not.toBe(payloadHash(invoice));
    expect(payloadHash({ ...invoice, subject: "Quote" })).not.toBe(payloadHash(invoice));
    expect(payloadHash({ ...invoice, message: "Hi" })).not.toBe(payloadHash(invoice));
  });
});

describe("confirm tokens", () => {
  it("round-trips what was signed", () => {
    expect(readConfirmToken(confirmToken(claims), NOW)).toEqual(claims);
  });

  it("refuses a changed body, a changed or short signature, an expired token and junk", () => {
    const token = confirmToken(claims);
    const [body, mac] = token.split(".");
    const other = confirmToken({ ...claims, userId: "u2" }).split(".")[0];
    expect(readConfirmToken(`${other}.${mac}`, NOW)).toBeNull();
    expect(readConfirmToken(`${body}.${mac!.slice(0, -2)}`, NOW)).toBeNull();
    expect(readConfirmToken(`${body}.${"A".repeat(mac!.length)}`, NOW)).toBeNull();
    expect(readConfirmToken(token, new Date(claims.exp + 1))).toBeNull();
    expect(readConfirmToken("x", NOW)).toBeNull();
    expect(readConfirmToken(`${token}.x`, NOW)).toBeNull();
    expect(readConfirmToken(confirmToken({ ...claims, exp: Number.NaN }), NOW)).toBeNull();
  });

  it("depends on the credentials key", () => {
    const token = confirmToken(claims);
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", Buffer.alloc(32, 8).toString("base64"));
    expect(readConfirmToken(token, NOW)).toBeNull();
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  });
});

describe("write adapters", () => {
  it("AskCart's isn't connected yet and sends nothing", async () => {
    const t = { workspaceId: "w1", brandId: "b1" };
    expect(await writesReady(askCartWriteAdapter, scope, "DRAFT_ORDER_CREATE")).toEqual({ ready: false, reason: "NOT_CONNECTED" });
    const lines = { currency: "EUR", lines: [], tag: "sma-quote-q1" };
    for (const r of [
      await askCartWriteAdapter.createDraftOrder(t, "r1", lines),
      await askCartWriteAdapter.sendInvoice(t, "r1", "d1", { to: "a@b.test", subject: "s", message: "m" }),
      await askCartWriteAdapter.lookupDraftOrder(t, { tag: "x" }),
      await askCartWriteAdapter.listBlogs(t),
      await askCartWriteAdapter.publishArticle(t, "r1", "a1"),
      await askCartWriteAdapter.lookupArticle(t, { id: "a1" }),
    ]) {
      expect(r).toEqual({ ok: false, reason: "NOT_CONNECTED" });
    }
  });

  it("names the scope a write lacks, from the adapter's capabilities", async () => {
    const shop = fakeShopify({ scopes: ["write_draft_orders"] });
    expect(await writesReady(shop.adapter, scope, "DRAFT_ORDER_INVOICE_SEND")).toEqual({ ready: true });
    expect(await writesReady(shop.adapter, scope, "ARTICLE_PUBLISH")).toEqual({ ready: false, reason: "MISSING_SCOPE", scope: "write_content" });
  });
});
