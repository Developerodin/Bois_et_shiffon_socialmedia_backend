-- The pipeline: deals and their stages (plan 2026-11-27-crm, Task A7; stages per owner decision O2).

-- CreateEnum
CREATE TYPE "DealStage" AS ENUM ('NEW', 'CONTACTED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST');

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "dealId" TEXT;

-- CreateTable
CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "stage" "DealStage" NOT NULL DEFAULT 'NEW',
    "title" TEXT NOT NULL,
    "customerId" TEXT,
    "companyId" TEXT,
    "conversationId" TEXT,
    "value" DECIMAL(14,2),
    "currency" TEXT,
    "ownerId" TEXT,
    "nextAction" TEXT,
    "nextActionDue" DATE,
    "closedReason" TEXT,
    "closedNote" TEXT,
    "stageChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Deal_brandId_stage_updatedAt_idx" ON "Deal"("brandId", "stage", "updatedAt");

CREATE INDEX "Deal_brandId_ownerId_idx" ON "Deal"("brandId", "ownerId");

CREATE INDEX "Deal_customerId_updatedAt_idx" ON "Deal"("customerId", "updatedAt");

CREATE INDEX "Deal_companyId_idx" ON "Deal"("companyId");

CREATE INDEX "Deal_conversationId_idx" ON "Deal"("conversationId");

CREATE INDEX "Deal_updatedAt_idx" ON "Deal"("updatedAt");

CREATE INDEX "Quote_dealId_idx" ON "Quote"("dealId");

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_brandId_workspaceId_fkey" FOREIGN KEY ("brandId", "workspaceId") REFERENCES "Brand"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

