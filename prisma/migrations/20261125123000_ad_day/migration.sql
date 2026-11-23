-- CreateEnum
CREATE TYPE "AdPlatform" AS ENUM ('META');

-- CreateTable
CREATE TABLE "AdDay" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "platform" "AdPlatform" NOT NULL,
    "accountId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "campaignName" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "currency" TEXT NOT NULL,
    "spend" DECIMAL(14,2) NOT NULL,
    "impressions" INTEGER NOT NULL,
    "clicks" INTEGER NOT NULL,
    "purchases" INTEGER NOT NULL,
    "purchaseValue" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "AdDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdDay_brandId_platform_accountId_day_idx" ON "AdDay"("brandId", "platform", "accountId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "AdDay_brandId_platform_accountId_campaignId_day_key" ON "AdDay"("brandId", "platform", "accountId", "campaignId", "day");

-- AddForeignKey
ALTER TABLE "AdDay" ADD CONSTRAINT "AdDay_brandId_workspaceId_fkey" FOREIGN KEY ("brandId", "workspaceId") REFERENCES "Brand"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
