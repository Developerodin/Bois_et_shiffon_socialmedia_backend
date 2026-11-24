/**
 * How the platform writes to a brand's Shopify store. Writes go through the owner's AskCart app (plan 2026-11-24-phase-3-crm,
 * "Shopify access through AskCart"), which holds the store's install; no Admin token is pasted here. AskCart's write
 * endpoints aren't built yet, so askCartWriteAdapter answers NOT_CONNECTED to everything ("Shopify writes aren't
 * connected yet"). Callers reach it only through confirmWrite (server/shopify/writes.ts), which passes tests a fake.
 *
 * Every write takes a request id ("<ShopifyWrite id>.<run>") that AskCart is to use for idempotency.
 * A returned refusal means nothing was written; a thrown error means the outcome is unknown (it may have been written).
 * ponytail: the input and output shapes below are ours; settle them with AskCart's contract when its write endpoints exist.
 */
export type ShopifyTarget = { workspaceId: string; brandId: string };

export type ShopifyRefusal =
  | { ok: false; reason: "NOT_CONNECTED" }
  | { ok: false; reason: "MISSING_SCOPE"; scope: string }
  /** Shopify's userErrors: the field paths only, never its messages (they can echo customer text). */
  | { ok: false; reason: "USER_ERROR"; fields: string[] };
export type ShopifyResult<T> = { ok: true; value: T } | ShopifyRefusal;

export type DraftOrderLine = { variantId?: string; title: string; quantity: number; unitPrice: string };
export type DraftOrderInput = {
  currency: string;
  lines: DraftOrderLine[];
  discount?: { kind: "PERCENT" | "AMOUNT"; value: string } | null;
  note?: string | null;
  /** "sma-quote-<id>": how a create whose answer was lost is found again */
  tag: string;
};
export type DraftOrder = {
  shopifyId: string;
  name: string;
  status: string;
  subtotal: string;
  invoiceUrl: string | null;
  invoiceSentAt: string | null;
  updatedAt: string;
};
export type InvoiceInput = { to: string; subject: string; message: string };
export type Blog = { id: string; title: string };
export type ArticleInput = { blogId: string; title: string; handle: string; bodyHtml: string; /** escaped, in a <p> (themes print it as HTML) */ summaryHtml: string; tags: string[]; author: string };
export type Article = { shopifyId: string; blogId: string; handle: string; isPublished: boolean; updatedAt: string };

export interface ShopifyWriteAdapter {
  /** Whether writes can reach the store, and the access scopes they hold (write_ handles as granted). */
  capabilities(t: ShopifyTarget): Promise<{ connected: boolean; scopes: string[] }>;
  createDraftOrder(t: ShopifyTarget, requestId: string, input: DraftOrderInput): Promise<ShopifyResult<DraftOrder>>;
  updateDraftOrder(t: ShopifyTarget, requestId: string, id: string, input: DraftOrderInput): Promise<ShopifyResult<DraftOrder>>;
  sendInvoice(t: ShopifyTarget, requestId: string, id: string, input: InvoiceInput): Promise<ShopifyResult<DraftOrder>>;
  /** By id, or by our tag; null when Shopify has none. */
  lookupDraftOrder(t: ShopifyTarget, by: { id: string } | { tag: string }): Promise<ShopifyResult<DraftOrder | null>>;
  listBlogs(t: ShopifyTarget): Promise<ShopifyResult<Blog[]>>;
  createArticle(t: ShopifyTarget, requestId: string, input: ArticleInput): Promise<ShopifyResult<Article>>;
  updateArticle(t: ShopifyTarget, requestId: string, id: string, input: ArticleInput): Promise<ShopifyResult<Article>>;
  publishArticle(t: ShopifyTarget, requestId: string, id: string): Promise<ShopifyResult<Article>>;
  /** By id, or by handle within a blog; null when Shopify has none. */
  lookupArticle(t: ShopifyTarget, by: { id: string } | { blogId: string; handle: string }): Promise<ShopifyResult<Article | null>>;
}

const notYet = async () => ({ ok: false, reason: "NOT_CONNECTED" }) as const;

/** AskCart's write endpoints don't exist yet: nothing is connected and nothing is sent. */
export const askCartWriteAdapter: ShopifyWriteAdapter = {
  capabilities: async () => ({ connected: false, scopes: [] }),
  createDraftOrder: notYet,
  updateDraftOrder: notYet,
  sendInvoice: notYet,
  lookupDraftOrder: notYet,
  listBlogs: notYet,
  createArticle: notYet,
  updateArticle: notYet,
  publishArticle: notYet,
  lookupArticle: notYet,
};
