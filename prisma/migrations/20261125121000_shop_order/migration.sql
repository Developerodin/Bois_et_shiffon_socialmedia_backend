-- CreateTable
CREATE TABLE "ShopOrder" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "shopifyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "test" BOOLEAN NOT NULL,
    "currency" TEXT NOT NULL,
    "netSales" DECIMAL(14,2) NOT NULL,
    "discounts" DECIMAL(14,2) NOT NULL,
    "shipping" DECIMAL(14,2) NOT NULL,
    "taxes" DECIMAL(14,2) NOT NULL,
    "taxesIncluded" BOOLEAN NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "refunded" DECIMAL(14,2) NOT NULL,
    "sourceName" TEXT,
    "shopifyUpdatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopOrder_brandId_processedAt_idx" ON "ShopOrder"("brandId", "processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopOrder_brandId_shopifyId_key" ON "ShopOrder"("brandId", "shopifyId");

-- AddForeignKey
ALTER TABLE "ShopOrder" ADD CONSTRAINT "ShopOrder_brandId_workspaceId_fkey" FOREIGN KEY ("brandId", "workspaceId") REFERENCES "Brand"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
