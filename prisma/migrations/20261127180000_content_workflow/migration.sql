-- Content workflows: one row per "create posts with agents" request, and the workflowId/connectionId/productIds
-- columns that carry its context through the agents. All additive: nullable or defaulted, no backfill.

-- CreateEnum
CREATE TYPE "ContentWorkflowStatus" AS ENUM ('DRAFT', 'SCOUTING', 'REVIEW_IDEAS', 'PLANNING', 'REVIEW_PLAN', 'RUNNING', 'DONE', 'NEEDS_ATTENTION', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "workflowId" TEXT;

-- AlterTable
ALTER TABLE "Opportunity" ADD COLUMN     "productIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "productReasons" JSONB,
ADD COLUMN     "workflowId" TEXT;

-- AlterTable
ALTER TABLE "ContentItem" ADD COLUMN     "connectionId" TEXT,
ADD COLUMN     "workflowId" TEXT;

-- CreateTable
CREATE TABLE "ContentWorkflow" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" "ContentWorkflowStatus" NOT NULL DEFAULT 'PLANNING',
    "input" JSONB NOT NULL,
    "chargeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentWorkflow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentWorkflow_brandId_createdAt_idx" ON "ContentWorkflow"("brandId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContentWorkflow_brandId_requestId_key" ON "ContentWorkflow"("brandId", "requestId");

-- CreateIndex
CREATE INDEX "AgentRun_workflowId_idx" ON "AgentRun"("workflowId");

-- CreateIndex
CREATE INDEX "ContentItem_workflowId_idx" ON "ContentItem"("workflowId");

-- AddForeignKey
ALTER TABLE "ContentWorkflow" ADD CONSTRAINT "ContentWorkflow_brandId_workspaceId_fkey" FOREIGN KEY ("brandId", "workspaceId") REFERENCES "Brand"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

