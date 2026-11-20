-- CreateIndex
CREATE INDEX "ApprovalDecision_brandId_verdict_createdAt_idx" ON "ApprovalDecision"("brandId", "verdict", "createdAt");
