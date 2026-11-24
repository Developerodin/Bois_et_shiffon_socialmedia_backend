import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/request-user", () => ({ requestUserId: vi.fn() }));

import { prisma } from "@/server/db/prisma";
import { AccessDeniedError } from "@/server/auth/errors";
import { ArticleEdit, createArticle, decideArticle, editArticle, type ArticleScope } from "@/server/blog/articles";
import { confirmArticleWrite, previewArticleWrite, shopifyBlogs } from "@/server/blog/shopify-articles";
import { ShopifyWriteError } from "@/server/shopify/writes";
import type { ArticleShopifyAction, ArticleWritePreview, PermissionKey } from "@/shared";
import { fakeShopify } from "../fixtures/shopify-fake";

/** Articles to Shopify through the confirmed-write module, with the fake adapter standing in for AskCart. */
let ws: string;
let brand: string;
let writer: ArticleScope;
let approver: ArticleScope;
const ALL = new Set<PermissionKey>(["brand.read", "tasks.read", "tasks.all", "content.create", "content.approve", "publish.execute"]);
const span = (text: string, href: string | null = null) => ({ text, bold: false, italic: false, href });
const blocks = [
  { type: "h2" as const, lines: [[span("Care")]] },
  { type: "p" as const, lines: [[span("See "), span("our guide", "https://bc.test/guide")]] },
];

beforeAll(async () => {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-blog-shopify" } })).id;
  brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "Bois & Chiffons" } })).id;
  const a = await prisma.user.create({ data: { email: "a@blog-shopify.test", name: "a" } });
  const b = await prisma.user.create({ data: { email: "b@blog-shopify.test", name: "b" } });
  writer = { workspaceId: ws, brandId: brand, userId: a.id, perms: ALL, clientReviewer: false };
  approver = { ...writer, userId: b.id };
});

let n = 0;
/** An approved article (written by `writer`, approved by `approver`), optionally from a task. */
async function approved(taskId?: string) {
  const a = await createArticle(writer, taskId ? { taskId, productIds: [] } : { topic: `Linen care ${++n}`, productIds: [] });
  await editArticle(writer, a.id, ArticleEdit.parse({ version: 1, blocks, summary: "How to." }));
  return decideArticle(approver, a.id, { version: 2, verdict: "APPROVED" });
}
async function send(id: string, action: ArticleShopifyAction, shop: ReturnType<typeof fakeShopify>) {
  const preview = await previewArticleWrite(approver, id, action, {}, shop.adapter);
  return { preview, article: await confirmArticleWrite(approver, id, action, preview.confirmToken, shop.adapter) };
}
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; code?: string; message?: string }) => ({ status: e.status, code: e.code, message: e.message }));

describe("articles to Shopify", () => {
  it("an unapproved article can't be sent", async () => {
    const a = await createArticle(writer, { topic: "Unapproved", productIds: [] });
    expect(await refusal(previewArticleWrite(writer, a.id, "create", {}, fakeShopify().adapter))).toMatchObject({ status: 409, code: "blog.notReady" });
  });

  it("is created hidden in the store's first blog with the brand as author, every link listed", async () => {
    const shop = fakeShopify();
    const create = vi.spyOn(shop.adapter, "createArticle");
    const a = await approved();
    const { preview, article } = await send(a.id, "create", shop);
    const p = preview.preview as ArticleWritePreview;
    expect(p).toMatchObject({ blogId: "gid://shopify/Blog/1", author: "Bois & Chiffons", handle: a.handle, summary: "How to.", links: ["https://bc.test/guide"] });
    expect(p.bodyHtml).toBe('<h2>Care</h2>\n<p>See <a href="https://bc.test/guide">our guide</a></p>');
    expect(create.mock.calls[0]![2]).toEqual({ blogId: "gid://shopify/Blog/1", title: a.title, handle: a.handle, bodyHtml: p.bodyHtml, summaryHtml: "<p>How to.</p>", tags: [], author: "Bois & Chiffons" });
    expect(p).toMatchObject({ blocks, summaryHtml: "<p>How to.</p>", externalLinks: ["https://bc.test/guide"] });
    expect(article).toMatchObject({ status: "HIDDEN_IN_SHOPIFY", shopifyId: "gid://shopify/Article/1" });
    expect(shop.articles.get("gid://shopify/Article/1")!.isPublished).toBe(false);
  });

  it("uses the brand's picked blog over the first", async () => {
    const shop = fakeShopify();
    vi.spyOn(shop.adapter, "listBlogs").mockResolvedValue({ ok: true, value: [{ id: "blog-1", title: "News" }, { id: "blog-2", title: "Journal" }] });
    expect(await shopifyBlogs(writer, shop.adapter)).toMatchObject({ defaultId: "blog-1", selectedId: null, connected: true });
    await prisma.brandProfile.upsert({ where: { brandId: brand }, create: { workspaceId: ws, brandId: brand, shopifyBlogId: "blog-2" }, update: { shopifyBlogId: "blog-2" } });
    try {
      const a = await approved();
      expect(((await previewArticleWrite(approver, a.id, "create", {}, shop.adapter)).preview as ArticleWritePreview).blogId).toBe("blog-2");
    } finally {
      await prisma.brandProfile.update({ where: { brandId: brand }, data: { shopifyBlogId: null } });
    }
  });

  it("publishes only from hidden, and tells the task it came from, which stays open", async () => {
    const shop = fakeShopify();
    const task = await prisma.task.create({ data: { workspaceId: ws, brandId: brand, title: "Write about linen care", areas: ["SEO"] } });
    const a = await approved(task.id);
    expect(await refusal(previewArticleWrite(approver, a.id, "publish", {}, shop.adapter))).toMatchObject({ status: 409, code: "blog.notReady" });
    await send(a.id, "create", shop);
    const { article } = await send(a.id, "publish", shop);
    expect(article).toMatchObject({ status: "PUBLISHED", publishedAt: expect.any(String) });
    expect(shop.articles.get(article.shopifyId!)!.isPublished).toBe(true);
    const comments = await prisma.taskComment.findMany({ where: { taskId: task.id } });
    expect(comments).toEqual([expect.objectContaining({ kind: "SYSTEM", authorId: null, body: `The article "${a.title}" is published on the Shopify blog` })]);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("TODO");
  });

  it("an edit while hidden goes back to review, then an update is sent after re-approval", async () => {
    const shop = fakeShopify();
    const a = await approved();
    await send(a.id, "create", shop);
    const edited = await editArticle(writer, a.id, ArticleEdit.parse({ version: 2, title: "Linen care, updated" }));
    expect(edited).toMatchObject({ status: "IN_REVIEW", version: 3 });
    await decideArticle(approver, a.id, { version: 3, verdict: "APPROVED" });
    const update = vi.spyOn(shop.adapter, "updateArticle");
    const { article } = await send(a.id, "update", shop);
    expect(update.mock.calls[0]![3]).toMatchObject({ title: "Linen care, updated" });
    expect(article).toMatchObject({ status: "HIDDEN_IN_SHOPIFY", version: 3 });
  });

  it("someone without publish.execute can't preview or confirm", async () => {
    const shop = fakeShopify();
    const a = await approved();
    const creator = { ...approver, perms: new Set<PermissionKey>(["brand.read", "content.create"]) };
    await expect(previewArticleWrite(creator, a.id, "create", {}, shop.adapter)).rejects.toBeInstanceOf(AccessDeniedError);
    const p = await previewArticleWrite(approver, a.id, "create", {}, shop.adapter);
    await expect(confirmArticleWrite(creator, a.id, "create", p.confirmToken, shop.adapter)).rejects.toBeInstanceOf(AccessDeniedError);
    expect(shop.calls.filter((c) => c.method === "createArticle")).toEqual([]);
  });

  it("a handle Shopify already has is named as such", async () => {
    const shop = fakeShopify();
    const a = await approved();
    const p = await previewArticleWrite(approver, a.id, "create", {}, shop.adapter);
    shop.fail({ ok: false, reason: "USER_ERROR", fields: ["article", "handle"] });
    const e = await confirmArticleWrite(approver, a.id, "create", p.confirmToken, shop.adapter).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ShopifyWriteError);
    expect(e).toMatchObject({ status: 422, message: "An article with this address exists in Shopify; change the address", fields: ["article", "handle"] });
  });

  it("an article deleted in Shopify goes back to APPROVED with its Shopify id cleared", async () => {
    const shop = fakeShopify();
    const a = await approved();
    const { article } = await send(a.id, "create", shop);
    shop.articles.delete(article.shopifyId!);
    expect(await refusal(previewArticleWrite(approver, a.id, "publish", {}, shop.adapter))).toMatchObject({ status: 409, code: "blog.deletedInShopify" });
    expect(await prisma.blogArticle.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: "APPROVED", shopifyId: null, shopifyBlogId: null });
  });

  it("a create whose answer was lost is found by its handle, never sent twice", async () => {
    const shop = fakeShopify();
    const a = await approved();
    const p = await previewArticleWrite(approver, a.id, "create", {}, shop.adapter);
    shop.fail("lost");
    expect(await refusal(confirmArticleWrite(approver, a.id, "create", p.confirmToken, shop.adapter))).toMatchObject({ status: 502 });
    expect(await prisma.blogArticle.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: "APPROVED", shopifyId: null });
    const again = await previewArticleWrite(approver, a.id, "create", {}, shop.adapter);
    expect(again.last).toBe("UNKNOWN");
    const article = await confirmArticleWrite(approver, a.id, "create", again.confirmToken, shop.adapter);
    expect(article).toMatchObject({ status: "HIDDEN_IN_SHOPIFY", shopifyId: "gid://shopify/Article/1" });
    expect(shop.calls.filter((c) => c.method === "createArticle")).toHaveLength(1);
    expect(shop.calls.some((c) => c.method === "lookupArticle")).toBe(true);
  });

  it("an edit after a create whose answer was lost never creates it twice: found by handle, the article takes its id", async () => {
    const shop = fakeShopify();
    const a = await approved();
    const p = await previewArticleWrite(approver, a.id, "create", {}, shop.adapter);
    shop.fail("lost");
    await refusal(confirmArticleWrite(approver, a.id, "create", p.confirmToken, shop.adapter));
    await editArticle(writer, a.id, ArticleEdit.parse({ version: 2, title: "Retitled" }));
    await decideArticle(approver, a.id, { version: 3, verdict: "APPROVED" });
    expect(await refusal(previewArticleWrite(approver, a.id, "create", {}, shop.adapter))).toMatchObject({ status: 409, code: "blog.earlierSend" });
    expect(await prisma.blogArticle.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: "APPROVED", version: 3, shopifyId: "gid://shopify/Article/1" });
    const row = await prisma.shopifyWrite.findFirstOrThrow({ where: { entityId: a.id, version: 2 } });
    expect(row).toMatchObject({ status: "DONE", shopifyId: "gid://shopify/Article/1" });
    // Settled through writes.ts's shared helper: audited as the write's action, by whoever settled it.
    const settled = await prisma.auditEvent.findMany({ where: { entityType: "ShopifyWrite", entityId: row.id, action: "shopify.article_create" } });
    expect(settled.map((e) => [e.actorUserId, (e.metadata as { status: string }).status])).toContainEqual([approver.userId, "DONE"]);
    const { article } = await send(a.id, "update", shop);
    expect(article).toMatchObject({ status: "HIDDEN_IN_SHOPIFY" });
    expect(shop.calls.filter((c) => c.method === "createArticle")).toHaveLength(1);
  });

  it("an edit after a create that never arrived waits 10 minutes, keeps the address, then may create again", async () => {
    const shop = fakeShopify();
    const a = await approved();
    const p = await previewArticleWrite(approver, a.id, "create", {}, shop.adapter);
    shop.fail("throw");
    await refusal(confirmArticleWrite(approver, a.id, "create", p.confirmToken, shop.adapter));
    expect(await refusal(editArticle(writer, a.id, ArticleEdit.parse({ version: 2, handle: "another-address" })))).toMatchObject({ status: 409, code: "blog.handleLocked" });
    await editArticle(writer, a.id, ArticleEdit.parse({ version: 2, title: "Retitled" }));
    await decideArticle(approver, a.id, { version: 3, verdict: "APPROVED" });
    expect(await refusal(previewArticleWrite(approver, a.id, "create", {}, shop.adapter))).toMatchObject({ status: 409, code: "blog.earlierSend" });
    await prisma.shopifyWrite.updateMany({ where: { entityId: a.id, version: 2 }, data: { startedAt: new Date(Date.now() - 11 * 60_000) } });
    const { article } = await send(a.id, "create", shop);
    expect(article).toMatchObject({ status: "HIDDEN_IN_SHOPIFY", version: 3 });
    expect(await prisma.shopifyWrite.findFirst({ where: { entityId: a.id, version: 2 } })).toMatchObject({ status: "FAILED" });
    expect(shop.articles.size).toBe(1);
  });

  it("an edit during an in-flight Publish: the article is still marked published and the task told", async () => {
    const shop = fakeShopify();
    const task = await prisma.task.create({ data: { workspaceId: ws, brandId: brand, title: "Write about drying", areas: ["SEO"] } });
    const a = await approved(task.id);
    await send(a.id, "create", shop);
    const publish = shop.adapter.publishArticle;
    vi.spyOn(shop.adapter, "publishArticle").mockImplementation(async (...args) => {
      await editArticle(writer, a.id, ArticleEdit.parse({ version: 2, title: "Edited meanwhile" }));
      return publish(...args);
    });
    const { article } = await send(a.id, "publish", shop);
    expect(article).toMatchObject({ status: "PUBLISHED", version: 3, publishedAt: expect.any(String) });
    expect(await prisma.taskComment.count({ where: { taskId: task.id, kind: "SYSTEM" } })).toBe(1);
  });

  it("an update Shopify answers as published leaves the article published, not hidden", async () => {
    const shop = fakeShopify();
    const a = await approved();
    const { article: hidden } = await send(a.id, "create", shop);
    shop.articles.get(hidden.shopifyId!)!.isPublished = true;
    await editArticle(writer, a.id, ArticleEdit.parse({ version: 2, title: "Changed" }));
    await decideArticle(approver, a.id, { version: 3, verdict: "APPROVED" });
    expect((await send(a.id, "update", shop)).article).toMatchObject({ status: "PUBLISHED" });
  });

  it("until AskCart's writes exist: the preview says so and a confirm writes nothing", async () => {
    const a = await approved();
    const p = await previewArticleWrite(approver, a.id, "create");
    expect(p.writes).toEqual({ ready: false, reason: "NOT_CONNECTED" });
    expect(await refusal(confirmArticleWrite(approver, a.id, "create", p.confirmToken))).toMatchObject({ status: 503, message: "Shopify writes aren't connected yet" });
    expect(await prisma.shopifyWrite.count({ where: { entityId: a.id } })).toBe(0);
  });
});
