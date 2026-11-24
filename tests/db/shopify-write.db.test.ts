import { beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/db/prisma";
import { AccessDeniedError } from "@/server/auth/errors";
import type { DraftOrder, ShopifyWriteAdapter } from "@/server/shopify/adapter";
import { confirmWrite, expireStaleWrites, previewWrite, ShopifyWriteError, type WriteKey, type WriteScope } from "@/server/shopify/writes";
import type { PermissionKey } from "@/shared";
import { fakeShopify } from "../fixtures/shopify-fake";

/**
 * Confirmed writes against a real ShopifyWrite table, with the fake adapter for Shopify. Each test drafts its own quote
 * (an in-memory entity: version and payload), so rows never collide.
 */
let ws: string;
let brand: string;
let otherBrand: string;
const perms = new Set<PermissionKey>(["brand.read", "crm.manage"]);
let scope: WriteScope;
const T0 = new Date("2026-11-24T12:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

beforeAll(async () => {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-shopify-writes" } })).id;
  brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "B" } })).id;
  otherBrand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b2", displayName: "B2" } })).id;
  const user = (await prisma.user.create({ data: { email: "a@shopify-writes.test", name: "A" } })).id;
  scope = { workspaceId: ws, brandId: brand, userId: user, perms };
});

let n = 0;
/** A quote and the hooks that write it as a draft order; `action` defaults to a create. */
function quote(action: WriteKey["action"] = "DRAFT_ORDER_CREATE") {
  const id = `q${++n}`;
  const entity = { version: 1, payload: { currency: "EUR", lines: [{ title: "Bag", quantity: 1, unitPrice: "10.00" }], tag: `sma-quote-${id}` }, draftId: null as string | null };
  const done: DraftOrder[] = [];
  const key: WriteKey = { entityType: "QUOTE", entityId: id, action };
  const invoice = { to: "buyer@example.test", subject: "Your quote", message: "Thanks" };
  const hooks = {
    permission: "crm.manage" as const,
    rebuild: async () => ({ version: entity.version, payload: action === "DRAFT_ORDER_INVOICE_SEND" ? { ...entity.payload, invoice } : entity.payload }),
    run: (a: ShopifyWriteAdapter, p: typeof entity.payload, requestId: string) =>
      action === "DRAFT_ORDER_INVOICE_SEND" ? a.sendInvoice(scope, requestId, entity.draftId!, invoice) : a.createDraftOrder(scope, requestId, p),
    reconcile: (a: ShopifyWriteAdapter) => a.lookupDraftOrder(scope, { tag: entity.payload.tag }),
    onDone: async (_tx: unknown, r: DraftOrder) => void done.push(r),
  };
  return { id, entity, key, hooks, done };
}

/** The preview a person would see now. */
async function previewOf(q: ReturnType<typeof quote>, adapter: ShopifyWriteAdapter, opts: { s?: WriteScope; now?: Date; again?: boolean } = {}) {
  const { payload, version } = await q.hooks.rebuild();
  return previewWrite(opts.s ?? scope, { ...q.key, version, payload, again: opts.again }, adapter, opts.now ?? T0);
}

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (e instanceof ShopifyWriteError ? { status: e.status, code: e.code, message: e.message, fields: e.fields } : e),
  );
const rows = (entityId: string) => prisma.shopifyWrite.findMany({ where: { entityId }, orderBy: { attempt: "asc" } });

describe("Shopify confirmed writes", () => {
  it("with AskCart not connected yet: the preview says so and a confirm writes nothing", async () => {
    const q = quote();
    const { payload, version } = await q.hooks.rebuild();
    const p = await previewWrite(scope, { ...q.key, version, payload });
    expect(p.writes).toEqual({ ready: false, reason: "NOT_CONNECTED" });
    expect(p.preview).toEqual(payload);
    expect(await refusal(confirmWrite(scope, p.confirmToken, q.key, q.hooks))).toMatchObject({ status: 503, code: "NOT_CONNECTED", message: "Shopify writes aren't connected yet" });
    expect(await rows(q.id)).toEqual([]);
  });

  it("writes once, marks DONE in the same transaction as the entity update, and audits ids only", async () => {
    const shop = fakeShopify();
    const q = quote();
    const p = await previewOf(q, shop.adapter);
    expect(p).toMatchObject({ attempt: 1, writes: { ready: true }, last: null });
    const { result, write } = await confirmWrite(scope, p.confirmToken, q.key, q.hooks, shop.adapter, T0);
    expect(write).toMatchObject({ status: "DONE", shopifyId: result.shopifyId, attempt: 1, runs: 1 });
    expect(q.done).toHaveLength(1);
    expect(shop.calls).toEqual([{ method: "createDraftOrder", requestId: `${write.id}.1` }]);
    const audit = await prisma.auditEvent.findMany({ where: { entityId: write.id } });
    expect(audit.map((a) => a.action)).toEqual(["shopify.draft_order_create"]);
    expect(audit[0]!.metadata).toEqual({ entityType: "QUOTE", entityId: q.id, version: 1, attempt: 1, run: 1, status: "DONE", shopifyId: result.shopifyId });
    expect(await refusal(confirmWrite(scope, p.confirmToken, q.key, q.hooks, shop.adapter, T0))).toMatchObject({ status: 409, code: "ALREADY_DONE" });
  });

  it("two confirms at once write once", async () => {
    const shop = fakeShopify();
    const q = quote();
    const p = await previewOf(q, shop.adapter);
    const both = await Promise.all([0, 1].map(() => refusal(confirmWrite(scope, p.confirmToken, q.key, q.hooks, shop.adapter, T0))));
    expect(both.filter((r) => r === null)).toHaveLength(1);
    expect(both.find((r) => r !== null)).toMatchObject({ status: 409 });
    expect(shop.calls.filter((c) => c.method === "createDraftOrder")).toHaveLength(1);
  });

  it("refuses a token for another user, brand or entity, without echoing it", async () => {
    const shop = fakeShopify();
    const q = quote();
    const p = await previewOf(q, shop.adapter);
    for (const [s, key] of [
      [{ ...scope, userId: "someone-else" }, q.key],
      [{ ...scope, brandId: otherBrand }, q.key],
      [scope, { ...q.key, entityId: "other" }],
      [scope, { ...q.key, action: "DRAFT_ORDER_UPDATE" }],
    ] as const) {
      const r = await refusal(confirmWrite(s, p.confirmToken, key, q.hooks, shop.adapter, T0));
      expect(r).toMatchObject({ status: 409, code: "BAD_TOKEN" });
      expect(JSON.stringify(r)).not.toContain(p.confirmToken.split(".")[1]);
    }
    expect(await refusal(confirmWrite(scope, p.confirmToken, q.key, q.hooks, shop.adapter, at(11)))).toMatchObject({ code: "BAD_TOKEN" });
    expect(shop.calls).toEqual([]);
  });

  it("re-checks the permission at confirm", async () => {
    const shop = fakeShopify();
    const q = quote();
    const p = await previewOf(q, shop.adapter);
    await expect(confirmWrite({ ...scope, perms: new Set<PermissionKey>(["brand.read"]) }, p.confirmToken, q.key, q.hooks, shop.adapter, T0)).rejects.toBeInstanceOf(AccessDeniedError);
    expect(shop.calls).toEqual([]);
  });

  it("refuses when the payload or the version changed since the preview", async () => {
    const shop = fakeShopify();
    const q = quote();
    const p = await previewOf(q, shop.adapter);
    q.entity.payload = { ...q.entity.payload, lines: [{ title: "Bag", quantity: 2, unitPrice: "10.00" }] };
    expect(await refusal(confirmWrite(scope, p.confirmToken, q.key, q.hooks, shop.adapter, T0))).toMatchObject({ status: 409, code: "CHANGED", message: "This changed since you checked it" });
    const p2 = await previewOf(q, shop.adapter);
    q.entity.version = 2;
    expect(await refusal(confirmWrite(scope, p2.confirmToken, q.key, q.hooks, shop.adapter, T0))).toMatchObject({ code: "CHANGED" });
    expect(await rows(q.id)).toEqual([]);
  });

  it("a missing scope refuses before any row; Shopify's userErrors fail the row, which the next confirm reuses", async () => {
    const q = quote();
    const noScope = fakeShopify({ scopes: ["write_content"] });
    const p0 = await previewOf(q, noScope.adapter);
    expect(p0.writes).toEqual({ ready: false, reason: "MISSING_SCOPE", scope: "write_draft_orders" });
    expect(await refusal(confirmWrite(scope, p0.confirmToken, q.key, q.hooks, noScope.adapter, T0))).toMatchObject({ status: 422, code: "MISSING_SCOPE" });
    expect(await rows(q.id)).toEqual([]);

    const shop = fakeShopify();
    shop.fail({ ok: false, reason: "USER_ERROR", fields: ["lineItems.0.variantId"] });
    const p = await previewOf(q, shop.adapter);
    expect(await refusal(confirmWrite(scope, p.confirmToken, q.key, q.hooks, shop.adapter, T0))).toMatchObject({ status: 422, code: "USER_ERROR", fields: ["lineItems.0.variantId"] });
    const [failed] = await rows(q.id);
    expect(failed).toMatchObject({ status: "FAILED", error: "Shopify refused the change", runs: 1 });

    const again = await previewOf(q, shop.adapter, { now: at(1) });
    expect(again).toMatchObject({ attempt: 1, last: "FAILED" });
    const { write } = await confirmWrite(scope, again.confirmToken, q.key, q.hooks, shop.adapter, at(1));
    expect(write).toMatchObject({ id: failed!.id, status: "DONE", runs: 2, error: null });
    expect(shop.calls.map((c) => c.requestId)).toEqual([`${failed!.id}.1`, `${failed!.id}.2`]);
  });

  it("an answer lost after the write: UNKNOWN, then reconciled by tag to DONE without a second create", async () => {
    const shop = fakeShopify();
    const q = quote();
    shop.fail("lost");
    const p = await previewOf(q, shop.adapter);
    expect(await refusal(confirmWrite(scope, p.confirmToken, q.key, q.hooks, shop.adapter, T0))).toMatchObject({ status: 502, code: "NOT_CONFIRMED_YET" });
    expect((await rows(q.id))[0]).toMatchObject({ status: "UNKNOWN" });
    const p2 = await previewOf(q, shop.adapter, { now: at(1) });
    expect(p2).toMatchObject({ attempt: 1, last: "UNKNOWN" });
    const { write } = await confirmWrite(scope, p2.confirmToken, q.key, q.hooks, shop.adapter, at(1));
    expect(write).toMatchObject({ status: "DONE", shopifyId: [...shop.drafts.keys()][0] });
    expect(shop.calls.filter((c) => c.method === "createDraftOrder")).toHaveLength(1);
    expect(q.done).toHaveLength(1);
  });

  it("UNKNOWN with no sign in Shopify: wait 10 min, then Send again takes attempt 2", async () => {
    const shop = fakeShopify();
    const q = quote();
    shop.fail("throw");
    await refusal(confirmWrite(scope, (await previewOf(q, shop.adapter)).confirmToken, q.key, q.hooks, shop.adapter, T0));
    const soon = await previewOf(q, shop.adapter, { now: at(5), again: true });
    expect(soon.attempt).toBe(2);
    expect(await refusal(confirmWrite(scope, soon.confirmToken, q.key, q.hooks, shop.adapter, at(5)))).toMatchObject({ status: 409, code: "NOT_CONFIRMED_YET" });
    const same = await previewOf(q, shop.adapter, { now: at(11) });
    expect(await refusal(confirmWrite(scope, same.confirmToken, q.key, q.hooks, shop.adapter, at(11)))).toMatchObject({ status: 409, code: "SEND_AGAIN" });
    const again = await previewOf(q, shop.adapter, { now: at(11), again: true });
    const { write } = await confirmWrite(scope, again.confirmToken, q.key, q.hooks, shop.adapter, at(11));
    expect(write).toMatchObject({ attempt: 2, status: "DONE" });
    expect((await rows(q.id)).map((r) => r.status)).toEqual(["UNKNOWN", "DONE"]);
    expect(shop.drafts.size).toBe(1);
  });

  it("a PENDING write is 'already sending' for 2 min, then reconciled; the sweep makes it UNKNOWN after 10", async () => {
    const shop = fakeShopify();
    const q = quote();
    const p = await previewOf(q, shop.adapter);
    const { payload } = await q.hooks.rebuild();
    // A send that never came back (the process died mid-request), after reaching Shopify.
    const row = await prisma.shopifyWrite.create({
      data: { workspaceId: ws, brandId: brand, ...q.key, version: 1, payloadHash: "x", actorUserId: scope.userId, startedAt: T0 },
    });
    await shop.adapter.createDraftOrder(scope, `${row.id}.1`, payload);
    expect(await refusal(confirmWrite(scope, p.confirmToken, q.key, q.hooks, shop.adapter, at(1)))).toMatchObject({ code: "ALREADY_SENDING" });
    expect(await expireStaleWrites(at(9))).toBe(0);
    const p2 = await previewOf(q, shop.adapter, { now: at(3) });
    const { write } = await confirmWrite(scope, p2.confirmToken, q.key, q.hooks, shop.adapter, at(3));
    expect(write).toMatchObject({ id: row.id, status: "DONE" });
    expect(shop.drafts.size).toBe(1);

    const stale = await prisma.shopifyWrite.create({
      data: { workspaceId: ws, brandId: brand, entityType: "QUOTE", entityId: "stale", version: 1, action: "DRAFT_ORDER_CREATE", payloadHash: "x", actorUserId: scope.userId, startedAt: T0 },
    });
    expect(await expireStaleWrites(at(11))).toBe(1);
    expect(await prisma.shopifyWrite.findUnique({ where: { id: stale.id } })).toMatchObject({ status: "UNKNOWN" });
  });

  it("an invoice is sent again only as a deliberate next attempt; a create never is", async () => {
    const shop = fakeShopify();
    const q = quote();
    const created = await confirmWrite(scope, (await previewOf(q, shop.adapter)).confirmToken, q.key, q.hooks, shop.adapter, T0);
    expect(await previewOf(q, shop.adapter, { again: true })).toMatchObject({ attempt: 1, last: "DONE" });

    const inv = quote("DRAFT_ORDER_INVOICE_SEND");
    inv.entity.draftId = created.result.shopifyId;
    const first = await previewOf(inv, shop.adapter);
    expect(first.preview).toMatchObject({ invoice: { to: "buyer@example.test", subject: "Your quote", message: "Thanks" } });
    await confirmWrite(scope, first.confirmToken, inv.key, inv.hooks, shop.adapter, T0);
    expect(await refusal(confirmWrite(scope, (await previewOf(inv, shop.adapter)).confirmToken, inv.key, inv.hooks, shop.adapter, T0))).toMatchObject({ code: "ALREADY_DONE" });
    const again = await previewOf(inv, shop.adapter, { again: true });
    expect(again.attempt).toBe(2);
    await confirmWrite(scope, again.confirmToken, inv.key, inv.hooks, shop.adapter, T0);
    expect(shop.calls.filter((c) => c.method === "sendInvoice")).toHaveLength(2);
    expect((await rows(inv.id)).map((r) => [r.attempt, r.status])).toEqual([[1, "DONE"], [2, "DONE"]]);
  });

  it("stops at 30 writes an hour per person on a brand", async () => {
    const shop = fakeShopify();
    const q = quote();
    const key = `shopify-writes:${brand}:${scope.userId}`;
    await prisma.rateLimitBucket.upsert({ where: { key }, create: { key, count: 30, windowStart: new Date() }, update: { count: 30, windowStart: new Date() } });
    expect(await refusal(confirmWrite(scope, (await previewOf(q, shop.adapter)).confirmToken, q.key, q.hooks, shop.adapter, T0))).toMatchObject({ status: 429, code: "RATE_LIMITED" });
    expect(shop.calls).toEqual([]);
  });
});
