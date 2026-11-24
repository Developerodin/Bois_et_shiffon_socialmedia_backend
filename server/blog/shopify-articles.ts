import type { BlogArticle, ShopifyWriteAction } from "@prisma/client";
import { AccessDeniedError } from "@/server/auth/errors";
import { articleBlocks, loadArticle, toArticleDto, type ArticleScope } from "@/server/blog/articles";
import { articleLinks, renderArticleHtml } from "@/server/blog/render";
import { prisma } from "@/server/db/prisma";
import { PublishingError } from "@/server/services/publishing";
import { askCartWriteAdapter, type Article, type ShopifyWriteAdapter } from "@/server/shopify/adapter";
import { confirmWrite, previewWrite, ShopifyWriteError } from "@/server/shopify/writes";
import type { ArticlePublishPreview, ArticleShopifyAction, ArticleWritePreview, ShopifyBlogsDto } from "@/shared";

/**
 * Articles to Shopify (plan 2026-11-24-phase-3-crm, Task 6; owner decision 6): an approved article is created in the
 * brand's blog hidden; the team checks it in Shopify; a person clicks Publish here. Every write is a confirmed write
 * (server/shopify/writes.ts) needing publish.execute, its preview listing every field and link target. Shopify access
 * goes through AskCart, whose write endpoints don't exist yet: until then previews say so and confirms answer 503.
 * The blog is the one the brand picked (BrandProfile.shopifyBlogId), else the store's first; the author is the brand name.
 */
const ACTION: Record<ArticleShopifyAction, ShopifyWriteAction> = { create: "ARTICLE_CREATE", update: "ARTICLE_UPDATE", publish: "ARTICLE_PUBLISH" };
type Payload = ArticleWritePreview | ArticlePublishPreview;
const target = (scope: { workspaceId: string; brandId: string }) => ({ workspaceId: scope.workspaceId, brandId: scope.brandId });

/** The store's blogs and the brand's pick. Not connected → no blogs. */
export async function shopifyBlogs(scope: { workspaceId: string; brandId: string }, adapter: ShopifyWriteAdapter = askCartWriteAdapter): Promise<ShopifyBlogsDto> {
  const [res, profile] = await Promise.all([
    adapter.listBlogs(target(scope)),
    prisma.brandProfile.findFirst({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId }, select: { shopifyBlogId: true } }),
  ]);
  const blogs = res.ok ? res.value : [];
  return { blogs, selectedId: profile?.shopifyBlogId ?? null, defaultId: blogs[0]?.id ?? null, connected: res.ok };
}

/** Pick the blog new articles go to (integrations.manage, checked by the route); null = back to the store's first. */
export async function pickShopifyBlog(scope: { workspaceId: string; brandId: string; userId: string }, blogId: string | null, adapter: ShopifyWriteAdapter = askCartWriteAdapter) {
  if (blogId) {
    const { blogs, connected } = await shopifyBlogs(scope, adapter);
    if (!connected) throw new PublishingError("Shopify writes aren't connected yet", 503);
    if (!blogs.some((b) => b.id === blogId)) throw new PublishingError("That blog isn't in the store", 400);
  }
  await prisma.brandProfile.upsert({
    where: { brandId: scope.brandId },
    create: { workspaceId: scope.workspaceId, brandId: scope.brandId, shopifyBlogId: blogId },
    update: { shopifyBlogId: blogId },
  });
  await prisma.auditEvent.create({
    data: { workspaceId: scope.workspaceId, brandId: scope.brandId, actorUserId: scope.userId, action: "blog.shopify-blog.picked", entityType: "BrandProfile", entityId: scope.brandId, metadata: { blogId } },
  });
}

/** The blog a new article goes to: the brand's pick, else the store's first; null only while writes aren't connected. */
async function blogFor(scope: { workspaceId: string; brandId: string }, adapter: ShopifyWriteAdapter) {
  const { blogs, selectedId, defaultId, connected } = await shopifyBlogs(scope, adapter);
  if (!connected) return selectedId;
  if (selectedId && blogs.some((b) => b.id === selectedId)) return selectedId;
  if (!defaultId) throw new PublishingError("The store has no blog yet. Add one in Shopify first.", 409, "blog.noBlog");
  return defaultId;
}

const NEEDS: Record<ArticleShopifyAction, { status: BlogArticle["status"]; inShopify: boolean; refusal: string }> = {
  create: { status: "APPROVED", inShopify: false, refusal: "Approve the article before sending it to Shopify" },
  update: { status: "APPROVED", inShopify: true, refusal: "Approve the changes before sending them to Shopify" },
  publish: { status: "HIDDEN_IN_SHOPIFY", inShopify: true, refusal: "Only an article waiting hidden in Shopify can be published" },
};

/** The payload as it would be written now, or a 409 when the article isn't in the state the action needs. */
async function build(scope: ArticleScope, article: BlogArticle, action: ArticleShopifyAction, adapter: ShopifyWriteAdapter): Promise<Payload> {
  const need = NEEDS[action];
  if (article.status !== need.status || !!article.shopifyId !== need.inShopify) throw new PublishingError(need.refusal, 409, "blog.notReady");
  if (action === "publish") return { shopifyId: article.shopifyId!, title: article.title, handle: article.handle };
  const blocks = articleBlocks(article.blocks);
  const brand = await prisma.brand.findFirstOrThrow({ where: { id: scope.brandId, workspaceId: scope.workspaceId }, select: { displayName: true } });
  return {
    blogId: action === "update" ? article.shopifyBlogId : await blogFor(scope, adapter),
    title: article.title,
    handle: article.handle,
    summary: article.summary ?? "",
    tags: article.tags,
    author: brand.displayName,
    bodyHtml: renderArticleHtml(blocks),
    links: articleLinks(blocks),
  };
}

/**
 * An article Shopify no longer has (deleted there): its Shopify id is cleared and it goes back to APPROVED, so a person
 * can send it again. Checked before an update or publish; a lookup that can't run (not connected) checks nothing.
 */
async function goneFromShopify(scope: ArticleScope, article: BlogArticle, adapter: ShopifyWriteAdapter) {
  if (!article.shopifyId) return;
  const found = await adapter.lookupArticle(target(scope), { id: article.shopifyId });
  if (!found.ok || found.value) return;
  await prisma.blogArticle.updateMany({
    where: { id: article.id, workspaceId: scope.workspaceId, brandId: scope.brandId, shopifyId: article.shopifyId },
    data: { shopifyId: null, shopifyBlogId: null, status: article.status === "HIDDEN_IN_SHOPIFY" || article.status === "PUBLISHED" ? "APPROVED" : article.status, publishedAt: null },
  });
  await prisma.auditEvent.create({
    data: { workspaceId: scope.workspaceId, brandId: scope.brandId, actorUserId: scope.userId, action: "blog.article.gone-from-shopify", entityType: "BlogArticle", entityId: article.id, metadata: { shopifyId: article.shopifyId } },
  });
  throw new PublishingError("This article was deleted in Shopify. Send it to Shopify again.", 409, "blog.deletedInShopify");
}

/** What a person confirms: the exact payload (every link target listed) and a token for it. */
export async function previewArticleWrite(scope: ArticleScope, articleId: string, action: ArticleShopifyAction, opts: { again?: boolean } = {}, adapter: ShopifyWriteAdapter = askCartWriteAdapter) {
  if (!scope.perms.has("publish.execute")) throw new AccessDeniedError("Missing permission publish.execute");
  const article = await loadArticle(scope, articleId);
  if (action !== "create") await goneFromShopify(scope, article, adapter);
  const payload = await build(scope, article, action, adapter);
  return previewWrite<Payload>(scope, { entityType: "BLOG_ARTICLE", entityId: article.id, action: ACTION[action], version: article.version, payload, again: opts.again }, adapter);
}

const HANDLE_TAKEN = "An article with this address exists in Shopify; change the address";

/** Writes what the person confirmed, at most once; the article follows Shopify's answer. Returns the article. */
export async function confirmArticleWrite(scope: ArticleScope, articleId: string, action: ArticleShopifyAction, token: string, adapter: ShopifyWriteAdapter = askCartWriteAdapter) {
  let article = await loadArticle(scope, articleId);
  let built: Payload | null = null;
  const where = { id: article.id, workspaceId: scope.workspaceId, brandId: scope.brandId };
  try {
    await confirmWrite<Payload, Article>(
      scope,
      token,
      { entityType: "BLOG_ARTICLE", entityId: article.id, action: ACTION[action] },
      {
        permission: "publish.execute",
        rebuild: async () => {
          article = await loadArticle(scope, articleId);
          built = await build(scope, article, action, adapter);
          return { version: article.version, payload: built };
        },
        run: async (a, payload, requestId) => {
          if (action === "publish") return a.publishArticle(target(scope), requestId, article.shopifyId!);
          const p = payload as ArticleWritePreview;
          if (!p.blogId) return { ok: false, reason: "NOT_CONNECTED" };
          const input = { blogId: p.blogId, title: p.title, handle: p.handle, bodyHtml: p.bodyHtml, summary: p.summary, tags: p.tags, author: p.author };
          // Created hidden (the adapter's createArticle never publishes); published only by ARTICLE_PUBLISH.
          return action === "create" ? a.createArticle(target(scope), requestId, input) : a.updateArticle(target(scope), requestId, article.shopifyId!, input);
        },
        reconcile: async (a, write) => {
          if (action === "create") {
            // By handle within the blog it was sent to (the rebuilt payload's, the same as the token's).
            const blogId = (built as ArticleWritePreview | null)?.blogId;
            return blogId ? a.lookupArticle(target(scope), { blogId, handle: article.handle }) : { ok: false, reason: "NOT_CONNECTED" };
          }
          const found = await a.lookupArticle(target(scope), { id: article.shopifyId! });
          if (!found.ok || !found.value) return found;
          const reached = action === "publish" ? found.value.isPublished : new Date(found.value.updatedAt) >= write.startedAt;
          return { ok: true, value: reached ? found.value : null };
        },
        onDone: async (tx, result, write) => {
          // The status moves only for the version that was confirmed; an edit since keeps its own (back to review).
          const confirmed = { ...where, version: write.version };
          if (action === "create") {
            await tx.blogArticle.updateMany({ where, data: { shopifyId: result.shopifyId, shopifyBlogId: result.blogId } });
            await tx.blogArticle.updateMany({ where: { ...confirmed, status: "APPROVED" }, data: { status: "HIDDEN_IN_SHOPIFY" } });
          } else if (action === "update") {
            await tx.blogArticle.updateMany({ where: { ...confirmed, status: "APPROVED" }, data: { status: "HIDDEN_IN_SHOPIFY" } });
          } else {
            const { count } = await tx.blogArticle.updateMany({ where: { ...where, status: "HIDDEN_IN_SHOPIFY" }, data: { status: "PUBLISHED", publishedAt: new Date() } });
            // The SEO task it came from hears about it and stays open: a person closes it.
            if (count && article.taskId) {
              await tx.taskComment.create({
                data: { workspaceId: scope.workspaceId, brandId: scope.brandId, taskId: article.taskId, authorId: null, kind: "SYSTEM", body: `The article "${article.title}" is published on the Shopify blog`, byClient: false, internal: false },
              });
            }
          }
        },
      },
      adapter,
    );
  } catch (e) {
    if (e instanceof ShopifyWriteError && e.code === "USER_ERROR" && e.fields?.some((f) => /handle/i.test(f))) throw new ShopifyWriteError(HANDLE_TAKEN, 422, "USER_ERROR", e.fields);
    throw e;
  }
  return toArticleDto(await loadArticle(scope, articleId));
}
