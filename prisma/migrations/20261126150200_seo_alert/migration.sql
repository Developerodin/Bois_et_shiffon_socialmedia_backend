-- CreateEnum
CREATE TYPE "SeoAlertKind" AS ENUM ('CLICKS_DOWN', 'POSITION_DOWN', 'SITE_DOWN');

-- CreateTable
CREATE TABLE "SeoAlert" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "kind" "SeoAlertKind" NOT NULL,
    "siteUrl" TEXT NOT NULL,
    "page" TEXT NOT NULL,
    "pageKey" TEXT NOT NULL,
    "runKey" TEXT NOT NULL,
    "firstDay" DATE NOT NULL,
    "lastDay" DATE NOT NULL,
    "values" JSONB NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SeoAlert_dedupeKey_key" ON "SeoAlert"("dedupeKey");

-- CreateIndex
CREATE INDEX "SeoAlert_brandId_subjectKey_lastDay_idx" ON "SeoAlert"("brandId", "subjectKey", "lastDay");

-- CreateIndex
CREATE INDEX "SeoAlert_brandId_lastDay_idx" ON "SeoAlert"("brandId", "lastDay");

-- CreateIndex
CREATE INDEX "SeoAlert_brandId_createdAt_idx" ON "SeoAlert"("brandId", "createdAt");

-- CreateIndex
CREATE INDEX "SeoAlert_brandId_pageKey_idx" ON "SeoAlert"("brandId", "pageKey");

-- CreateIndex
CREATE INDEX "SeoAlert_brandId_runKey_idx" ON "SeoAlert"("brandId", "runKey");

-- AddForeignKey
ALTER TABLE "SeoAlert" ADD CONSTRAINT "SeoAlert_brandId_workspaceId_fkey" FOREIGN KEY ("brandId", "workspaceId") REFERENCES "Brand"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

