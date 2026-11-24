import type { Article, DraftOrder, ShopifyRefusal, ShopifyWriteAdapter } from "@/server/shopify/adapter";

type Next = "ok" | "lost" | "throw" | ShopifyRefusal;

/**
 * An in-memory store behind the write adapter, for tests. `fail(next)` makes the next write: "lost" = written but the
 * answer never arrives (throws after writing), "throw" = throws before writing, a refusal = returned as is.
 */
export function fakeShopify(opts: { connected?: boolean; scopes?: string[] } = {}) {
  const drafts = new Map<string, DraftOrder & { tags: string[] }>();
  const articles = new Map<string, Article>();
  const calls: { method: string; requestId?: string }[] = [];
  let next: Next = "ok";
  const at = () => new Date().toISOString();

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
        const d = { shopifyId: `gid://shopify/DraftOrder/${drafts.size + 1}`, name: `#D${drafts.size + 1}`, status: "OPEN", subtotal: "0.00", invoiceUrl: null, invoiceSentAt: null, updatedAt: at(), tags: [input.tag] };
        drafts.set(d.shopifyId, d);
        return d;
      }),
    updateDraftOrder: (_t, requestId, id) => write("updateDraftOrder", requestId, () => Object.assign(drafts.get(id)!, { updatedAt: at() })),
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
  };
}
