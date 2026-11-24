import type { Article, DraftOrder, DraftOrderInput, ShopifyRefusal, ShopifyWriteAdapter } from "@/server/shopify/adapter";

type Next = "ok" | "lost" | "throw" | ShopifyRefusal;

/**
 * An in-memory store behind the write adapter, for tests. `fail(next)` makes the next write: "lost" = written but the
 * answer never arrives (throws after writing), "throw" = throws before writing, a refusal = returned as is.
 * A draft's subtotal is worked out from what was sent, plus `roundingCents` (Shopify rounding differently from us).
 */
export function fakeShopify(opts: { connected?: boolean; scopes?: string[] } = {}) {
  const drafts = new Map<string, DraftOrder & { tags: string[] }>();
  const articles = new Map<string, Article>();
  const calls: { method: string; requestId?: string }[] = [];
  let next: Next = "ok";
  let roundingCents = 0;
  const at = () => new Date().toISOString();
  const cents = (s: string) => Math.round(Number(s) * 100);
  const subtotal = (input: DraftOrderInput) => {
    const sum = input.lines.reduce((n, l) => n + l.quantity * cents(l.unitPrice), 0);
    const off = !input.discount ? 0 : input.discount.kind === "PERCENT" ? Math.round((sum * Number(input.discount.value)) / 100) : Math.min(cents(input.discount.value), sum);
    return ((sum - off + roundingCents) / 100).toFixed(2);
  };

  async function write<T>(method: string, requestId: string, apply: () => T) {
    calls.push({ method, requestId });
    const mode = next;
    next = "ok";
    if (mode === "throw") throw new Error("socket hang up");
    if (typeof mode === "object") return mode;
    const value = apply();
    if (mode === "lost") throw new Error("timeout");
    return { ok: true as const, value };
  }

  const adapter: ShopifyWriteAdapter = {
    capabilities: async () => ({ connected: opts.connected ?? true, scopes: opts.scopes ?? ["write_draft_orders", "write_content"] }),
    createDraftOrder: (_t, requestId, input) =>
      write("createDraftOrder", requestId, () => {
        const n = drafts.size + 1;
        const d = { shopifyId: `gid://shopify/DraftOrder/${n}`, name: `#D${n}`, status: "OPEN", subtotal: subtotal(input), invoiceUrl: `https://shop.test/invoices/${n}`, invoiceSentAt: null, orderId: null, updatedAt: at(), tags: [input.tag] };
        drafts.set(d.shopifyId, d);
        return d;
      }),
    updateDraftOrder: (_t, requestId, id, input) => write("updateDraftOrder", requestId, () => Object.assign(drafts.get(id)!, { subtotal: subtotal(input), updatedAt: at() })),
    sendInvoice: (_t, requestId, id) => write("sendInvoice", requestId, () => Object.assign(drafts.get(id)!, { invoiceSentAt: at() })),
    lookupDraftOrder: async (_t, by) => {
      calls.push({ method: "lookupDraftOrder" });
      const found = "id" in by ? drafts.get(by.id) : [...drafts.values()].find((d) => d.tags.includes(by.tag));
      return { ok: true, value: found ?? null };
    },
    listBlogs: async () => ({ ok: true, value: [{ id: "gid://shopify/Blog/1", title: "News" }] }),
    createArticle: (_t, requestId, input) =>
      write("createArticle", requestId, () => {
        const a = { shopifyId: `gid://shopify/Article/${articles.size + 1}`, blogId: input.blogId, handle: input.handle, isPublished: false, updatedAt: at() };
        articles.set(a.shopifyId, a);
        return a;
      }),
    updateArticle: (_t, requestId, id) => write("updateArticle", requestId, () => Object.assign(articles.get(id)!, { updatedAt: at() })),
    publishArticle: (_t, requestId, id) => write("publishArticle", requestId, () => Object.assign(articles.get(id)!, { isPublished: true })),
    lookupArticle: async (_t, by) => {
      calls.push({ method: "lookupArticle" });
      const found = "id" in by ? articles.get(by.id) : [...articles.values()].find((a) => a.blogId === by.blogId && a.handle === by.handle);
      return { ok: true, value: found ?? null };
    },
  };
  return {
    adapter,
    drafts,
    articles,
    calls,
    fail(mode: Next) {
      next = mode;
    },
    rounding(c: number) {
      roundingCents = c;
    },
  };
}
