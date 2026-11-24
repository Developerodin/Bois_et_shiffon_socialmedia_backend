import type { BlogArticle, BlogArticleStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { hasOtherHolder } from "@/server/auth/permissions";
import { prisma } from "@/server/db/prisma";
import { ArticleBlocksSchema } from "@/server/blog/render";
import { PublishingError } from "@/server/services/publishing";
import { slugify } from "@/server/services/slug";
import { findVisibleTask, taskViewer } from "@/server/tasks/access";
import { isUniqueViolation } from "@/server/tasks/errors";
import { ARTICLE_LIMITS, type ArticleBlock, type BlogArticleDto, type PermissionKey } from "@/shared";

/**
 * Blog articles in our app (plan 2026-11-24-phase-3-crm, Task 5): made from a task or a topic, written by the article
 * writer (server/blog/writer.ts) or by hand, approved under the posts' own-work rule, then sent to Shopify
 * (server/blog/shopify-articles.ts). Only an edit (a person's or the writer's) bumps `version`, which a Shopify confirm
 * token binds; an edit after approval sends the article back to review. Concurrent edits: the second gets a 409
 * (each update is conditional on the version it read).
 */
export type ArticleScope = { workspaceId: string; brandId: string; userId: string; perms: Set<PermissionKey>; clientReviewer: boolean };

export const ArticleCreate = z
  .object({
    topic: z.string().trim().min(1).max(ARTICLE_LIMITS.title).optional(),
    taskId: z.string().min(1).max(40).optional(),
    productIds: z.array(z.string().min(1).max(40)).max(ARTICLE_LIMITS.products).default([]),
  })
  .refine((v) => v.topic || v.taskId, "Give a topic or a task");

const HANDLE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const ArticleEdit = z
  .object({
    version: z.number().int().positive(),
    title: z.string().trim().min(1).max(ARTICLE_LIMITS.title).optional(),
    handle: z.string().max(ARTICLE_LIMITS.handle).regex(HANDLE, "Use lower-case letters, digits and dashes").optional(),
    summary: z.string().trim().max(ARTICLE_LIMITS.summary).nullable().optional(),
    blocks: ArticleBlocksSchema.optional(),
    tags: z.array(z.string().trim().min(1).max(ARTICLE_LIMITS.tag)).max(ARTICLE_LIMITS.tags).optional(),
    productIds: z.array(z.string().min(1).max(40)).max(ARTICLE_LIMITS.products).optional(),
  })
  .strict();

export const ArticleDecision = z.object({
  version: z.number().int().positive(),
  verdict: z.enum(["APPROVED", "CHANGES_REQUESTED"]),
  note: z.string().trim().max(1000).optional(),
});

/** States in which the text can still change here (a published article is changed in Shopify). */
const EDITABLE: BlogArticleStatus[] = ["DRAFT", "IN_REVIEW", "APPROVED", "HIDDEN_IN_SHOPIFY"];
/** Back to review after an edit: an approval covered the text as it was. */
const afterEdit = (s: BlogArticleStatus): BlogArticleStatus => (s === "APPROVED" || s === "HIDDEN_IN_SHOPIFY" ? "IN_REVIEW" : s);

export const articleBlocks = (json: unknown): ArticleBlock[] => ArticleBlocksSchema.safeParse(json).data ?? [];
const textLength = (blocks: ArticleBlock[]) => blocks.reduce((n, b) => n + b.lines.flat().reduce((m, s) => m + s.text.length, 0), 0);

export function toArticleDto(a: BlogArticle): BlogArticleDto {
  return {
    id: a.id,
    title: a.title,
    handle: a.handle,
    summary: a.summary,
    blocks: articleBlocks(a.blocks),
    tags: a.tags,
    productIds: a.productIds,
    taskId: a.taskId,
    status: a.status,
    version: a.version,
    shopifyId: a.shopifyId,
    publishedAt: a.publishedAt?.toISOString() ?? null,
    approvedById: a.approvedById,
    createdById: a.createdById,
    editedById: a.editedById,
    updatedAt: a.updatedAt.toISOString(),
  };
}

const notFound = () => new PublishingError("Article not found", 404);
const changed = () => new PublishingError("This article changed since you opened it. Reload it and try again.", 409, "blog.changed");

/** The brand's article, or 404 (another brand's id included). */
export async function loadArticle(scope: { workspaceId: string; brandId: string }, id: string, db: Prisma.TransactionClient | typeof prisma = prisma) {
  const a = await db.blogArticle.findFirst({ where: { id, workspaceId: scope.workspaceId, brandId: scope.brandId } });
  if (!a) throw notFound();
  return a;
}

/** Every id a product of this brand (not archived), else 404. */
async function checkProducts(scope: { workspaceId: string; brandId: string }, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return unique;
  const found = await prisma.product.count({ where: { id: { in: unique }, workspaceId: scope.workspaceId, brandId: scope.brandId, archivedAt: null } });
  if (found !== unique.length) throw new PublishingError("Product not found", 404);
  return unique;
}

/** A free handle for the brand from the title: "summer-linen", then "summer-linen-2", … */
async function freeHandle(scope: { brandId: string }, title: string) {
  const base = slugify(title, { max: ARTICLE_LIMITS.handle - 4, fallback: "article" });
  const taken = new Set((await prisma.blogArticle.findMany({ where: { brandId: scope.brandId, handle: { startsWith: base } }, select: { handle: true } })).map((r) => r.handle));
  for (let n = 1; ; n++) {
    const handle = n === 1 ? base : `${base}-${n}`;
    if (!taken.has(handle)) return handle;
  }
}

export async function listArticles(scope: { workspaceId: string; brandId: string }) {
  // ponytail: the latest 100; a brand writes a few a month. Page by updatedAt if one ever has more.
  const rows = await prisma.blogArticle.findMany({
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId, status: { not: "ARCHIVED" } },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  return rows.map(toArticleDto);
}

/** A new, empty draft from a task the person can see (its title is the topic) or a topic. */
export async function createArticle(scope: ArticleScope, input: z.infer<typeof ArticleCreate>) {
  let title = input.topic ?? "";
  if (input.taskId) {
    if (!(await findVisibleTask(prisma, taskViewer(scope), input.taskId))) throw new PublishingError("Task not found", 404);
    const task = await prisma.task.findUniqueOrThrow({ where: { id: input.taskId }, select: { title: true } });
    title ||= task.title.slice(0, ARTICLE_LIMITS.title);
  }
  const productIds = await checkProducts(scope, input.productIds);
  for (let tries = 0; ; tries++) {
    try {
      const article = await prisma.blogArticle.create({
        data: {
          workspaceId: scope.workspaceId, brandId: scope.brandId, title, handle: await freeHandle(scope, title), blocks: [], tags: [], productIds,
          taskId: input.taskId ?? null, createdById: scope.userId, editedById: scope.userId,
        },
      });
      await audit(scope, "blog.article.created", article.id, { taskId: article.taskId, version: 1 });
      return toArticleDto(article);
    } catch (e) {
      // Two creates with one title at once: the loser takes the next free handle.
      if (!isUniqueViolation(e) || tries >= 3) throw e;
    }
  }
}

/** A person's edit: bumps the version and sends an approved (or hidden-in-Shopify) article back to review. */
export async function editArticle(scope: ArticleScope, id: string, patch: z.infer<typeof ArticleEdit>) {
  const { version, ...fields } = patch;
  const current = await loadArticle(scope, id);
  if (current.version !== version) throw changed();
  if (!EDITABLE.includes(current.status)) throw new PublishingError("A published article is changed in Shopify", 409, "blog.published");
  if (patch.blocks && textLength(patch.blocks) > ARTICLE_LIMITS.chars) throw new PublishingError(`The article is longer than ${ARTICLE_LIMITS.chars} characters`, 400);
  const productIds = patch.productIds && (await checkProducts(scope, patch.productIds));
  // An unconfirmed create is found again in Shopify by its handle (shopify-articles.ts earlierCreates): keep it.
  if (fields.handle !== undefined && fields.handle !== current.handle && (await unsettledCreate(scope, id))) {
    throw new PublishingError("The address can't change while a send to Shopify is unconfirmed. Try again in a few minutes.", 409, "blog.handleLocked");
  }
  const status = afterEdit(current.status);
  try {
    const { count } = await prisma.blogArticle.updateMany({
      where: { id, workspaceId: scope.workspaceId, brandId: scope.brandId, version: current.version, status: { in: EDITABLE } },
      data: {
        ...fields,
        ...(productIds ? { productIds } : {}),
        ...(fields.blocks ? { blocks: fields.blocks as Prisma.InputJsonValue } : {}),
        version: { increment: 1 },
        status,
        ...(status !== current.status ? { approvedById: null } : {}),
        editedById: scope.userId,
      },
    });
    if (!count) throw changed();
  } catch (e) {
    if (isUniqueViolation(e)) throw new PublishingError("Another article of this brand uses this address", 409, "blog.handle");
    throw e;
  }
  await audit(scope, "blog.article.edited", id, { fields: Object.keys(fields), version: current.version + 1, status });
  return toArticleDto(await loadArticle(scope, id));
}

const unsettledCreate = (scope: { workspaceId: string; brandId: string }, id: string) =>
  prisma.shopifyWrite.findFirst({
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId, entityType: "BLOG_ARTICLE", entityId: id, action: "ARTICLE_CREATE", status: { in: ["PENDING", "UNKNOWN"] } },
    select: { id: true },
  });

/**
 * Remove an article: one never sent to Shopify is deleted; one that was is archived here and left as it is in Shopify
 * (removing it there is a person's call in Shopify).
 */
export async function deleteArticle(scope: ArticleScope, id: string) {
  const a = await loadArticle(scope, id);
  if (a.shopifyId) await prisma.blogArticle.updateMany({ where: { id, workspaceId: scope.workspaceId, brandId: scope.brandId }, data: { status: "ARCHIVED" } });
  else await prisma.blogArticle.deleteMany({ where: { id, workspaceId: scope.workspaceId, brandId: scope.brandId } });
  await audit(scope, a.shopifyId ? "blog.article.archived" : "blog.article.deleted", id, { shopifyId: a.shopifyId });
}

/**
 * Approve or send back (content.approve, checked by the route), on the version the person read. As for posts, your own
 * text (you edited it last) needs someone else's approval, unless nobody else holds content.approve here.
 */
export async function decideArticle(scope: ArticleScope, id: string, input: z.infer<typeof ArticleDecision>) {
  const a = await loadArticle(scope, id);
  if (a.version !== input.version) throw changed();
  if (a.status !== "DRAFT" && a.status !== "IN_REVIEW") throw new PublishingError("This article isn't waiting for a decision", 409, "blog.notInReview");
  if (input.verdict === "CHANGES_REQUESTED" && !input.note) throw new PublishingError("Say what needs to change", 400);
  if (input.verdict === "APPROVED") {
    if (!articleBlocks(a.blocks).length) throw new PublishingError("The article has no text yet", 409, "blog.empty");
    // An author is whoever started it or changed its text last (the writer's run counts as the person who ran it).
    if ((a.editedById === scope.userId || a.createdById === scope.userId) && (await hasOtherHolder(scope.workspaceId, scope.brandId, scope.userId, "content.approve"))) {
      throw new PublishingError("You wrote this article, so someone else has to approve it", 403, "blog.ownWork");
    }
  }
  const approved = input.verdict === "APPROVED";
  const { count } = await prisma.blogArticle.updateMany({
    where: { id, workspaceId: scope.workspaceId, brandId: scope.brandId, version: a.version, status: a.status },
    data: { status: approved ? "APPROVED" : "DRAFT", approvedById: approved ? scope.userId : null },
  });
  if (!count) throw changed();
  // The note is the team's own words about the text, never customer data.
  await audit(scope, approved ? "blog.article.approved" : "blog.article.changes-requested", id, { version: a.version, note: input.note ?? null, byClient: scope.clientReviewer });
  return toArticleDto(await loadArticle(scope, id));
}

const audit = (scope: { workspaceId: string; brandId: string; userId: string }, action: string, id: string, metadata: Prisma.InputJsonObject) =>
  prisma.auditEvent.create({ data: { workspaceId: scope.workspaceId, brandId: scope.brandId, actorUserId: scope.userId, action, entityType: "BlogArticle", entityId: id, metadata } });

/** The problem response for a refused blog request, else the access-error mapping. */
export function blogProblem(error: unknown) {
  if (error instanceof PublishingError) {
    return problemResponse({ type: "https://api.brandpilot/errors/blog", title: error.message, status: error.status, detail: error.message, code: error.code, ...error.data });
  }
  return fromAccessError(error);
}

export const invalidBody = (detail?: string) => problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid article", status: 400, detail });
