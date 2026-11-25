-- Fail fast instead of queueing every Product read behind a long catalogue-sync lock; re-run if it times out.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "collections" JSONB,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "vendor" TEXT;

-- AlterTable
ALTER TABLE "ShopOrder" ADD COLUMN     "discountCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "financialStatus" TEXT,
ADD COLUMN     "fulfillmentStatus" TEXT,
ADD COLUMN     "lineItemsTruncated" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ShopOrderLine" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "orderShopifyId" TEXT NOT NULL,
    "lineShopifyId" TEXT NOT NULL,
    "productId" TEXT,
    "variantId" TEXT,
    "title" TEXT,
    "variantTitle" TEXT,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "currentQuantity" INTEGER,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "discountedTotal" DECIMAL(14,2) NOT NULL,
    "netUnitPrice" DECIMAL(14,2),
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopOrderLine_brandId_orderShopifyId_idx" ON "ShopOrderLine"("brandId", "orderShopifyId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopOrderLine_brandId_lineShopifyId_key" ON "ShopOrderLine"("brandId", "lineShopifyId");

-- AddForeignKey
ALTER TABLE "ShopOrderLine" ADD CONSTRAINT "ShopOrderLine_brandId_workspaceId_fkey" FOREIGN KEY ("brandId", "workspaceId") REFERENCES "Brand"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

