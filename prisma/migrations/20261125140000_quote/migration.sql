-- Quotes drafted in our app (server/quotes/quotes.ts) and created in Shopify as draft orders; a per-brand quote counter.
-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'CREATED', 'SENT', 'ACCEPTED', 'EXPIRED', 'CANCELLED');

-- AlterTable
ALTER TABLE "BrandProfile" ADD COLUMN     "nextQuoteNumber" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "customerId" TEXT,
    "conversationId" TEXT,
    "currency" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "discount" JSONB,
    "note" TEXT,
    "internalNote" TEXT,
    "validUntil" DATE NOT NULL,
    "shopifyId" TEXT,
    "shopifyName" TEXT,
    "syncedVersion" INTEGER,
    "shopifySubtotal" TEXT,
    "subtotalAccepted" TEXT,
    "invoiceUrl" TEXT,
    "orderId" TEXT,
    "sentAt" TIMESTAMP(3),
    "sentById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Quote_brandId_status_updatedAt_idx" ON "Quote"("brandId", "status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_brandId_number_key" ON "Quote"("brandId", "number");

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_brandId_workspaceId_fkey" FOREIGN KEY ("brandId", "workspaceId") REFERENCES "Brand"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
