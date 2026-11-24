-- Confirmed writes to Shopify (server/shopify/writes.ts): one row per entity version, action and attempt, so a write
-- happens at most once and an unanswered one is reconciled before anything is sent again.
-- CreateEnum
CREATE TYPE "ShopifyWriteEntity" AS ENUM ('QUOTE', 'BLOG_ARTICLE');

-- CreateEnum
CREATE TYPE "ShopifyWriteAction" AS ENUM ('DRAFT_ORDER_CREATE', 'DRAFT_ORDER_UPDATE', 'DRAFT_ORDER_INVOICE_SEND', 'ARTICLE_CREATE', 'ARTICLE_UPDATE', 'ARTICLE_PUBLISH');

-- CreateEnum
CREATE TYPE "ShopifyWriteStatus" AS ENUM ('PENDING', 'DONE', 'FAILED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "ShopifyWrite" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "entityType" "ShopifyWriteEntity" NOT NULL,
    "entityId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "action" "ShopifyWriteAction" NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "payloadHash" TEXT NOT NULL,
    "status" "ShopifyWriteStatus" NOT NULL DEFAULT 'PENDING',
    "runs" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shopifyId" TEXT,
    "actorUserId" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyWrite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopifyWrite_status_startedAt_idx" ON "ShopifyWrite"("status", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyWrite_entityType_entityId_version_action_attempt_key" ON "ShopifyWrite"("entityType", "entityId", "version", "action", "attempt");

-- AddForeignKey
ALTER TABLE "ShopifyWrite" ADD CONSTRAINT "ShopifyWrite_brandId_workspaceId_fkey" FOREIGN KEY ("brandId", "workspaceId") REFERENCES "Brand"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

