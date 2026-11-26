-- CreateEnum
CREATE TYPE "AdAlertKind" AS ENUM ('SPEND_UP', 'ROAS_DOWN', 'NO_PURCHASES', 'OVER_PACE');

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "adAlertId" TEXT;

-- CreateTable
CREATE TABLE "AdAlert" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "kind" "AdAlertKind" NOT NULL,
    "accountId" TEXT,
    "campaignId" TEXT,
    "campaignName" TEXT,
    "currency" TEXT NOT NULL,
    "firstDay" DATE NOT NULL,
    "lastDay" DATE NOT NULL,
    "values" JSONB NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

CONSTRAINT "AdAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdAlert_dedupeKey_key" ON "AdAlert"("dedupeKey");

-- CreateIndex
CREATE INDEX "AdAlert_brandId_subjectKey_lastDay_idx" ON "AdAlert"("brandId", "subjectKey", "lastDay");

-- CreateIndex
CREATE INDEX "AdAlert_brandId_lastDay_idx" ON "AdAlert"("brandId", "lastDay");

-- CreateIndex
CREATE INDEX "AdAlert_brandId_createdAt_idx" ON "AdAlert"("brandId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_adAlertId_idx" ON "Notification"("adAlertId");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_adAlertId_fkey" FOREIGN KEY ("adAlertId") REFERENCES "AdAlert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdAlert" ADD CONSTRAINT "AdAlert_brandId_workspaceId_fkey" FOREIGN KEY ("brandId", "workspaceId") REFERENCES "Brand"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
