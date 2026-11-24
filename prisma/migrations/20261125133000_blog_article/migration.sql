-- Blog articles written in our app (server/blog/articles.ts), sent to the brand's Shopify blog hidden, then published.
-- CreateEnum
CREATE TYPE "BlogArticleStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'HIDDEN_IN_SHOPIFY', 'PUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "BlogArticle" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "summary" TEXT,
    "blocks" JSONB NOT NULL,
    "tags" TEXT[],
    "productIds" TEXT[],
    "taskId" TEXT,
    "status" "BlogArticleStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "shopifyBlogId" TEXT,
    "shopifyId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "createdById" TEXT,
    "editedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlogArticle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BlogArticle_brandId_status_updatedAt_idx" ON "BlogArticle"("brandId", "status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BlogArticle_brandId_handle_key" ON "BlogArticle"("brandId", "handle");

-- AddForeignKey
ALTER TABLE "BlogArticle" ADD CONSTRAINT "BlogArticle_brandId_workspaceId_fkey" FOREIGN KEY ("brandId", "workspaceId") REFERENCES "Brand"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlogArticle" ADD CONSTRAINT "BlogArticle_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
