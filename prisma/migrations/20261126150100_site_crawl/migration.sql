-- CreateEnum
CREATE TYPE "SiteCrawlStatus" AS ENUM ('RUNNING', 'COMPLETE', 'STOPPED', 'PARTIAL', 'ABANDONED');

-- CreateEnum
CREATE TYPE "SiteCrawlUrlKind" AS ENUM ('PAGE', 'TARGET');

-- CreateTable
CREATE TABLE "SiteCrawl" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "status" "SiteCrawlStatus" NOT NULL DEFAULT 'RUNNING',
    "startedOn" DATE NOT NULL,
    "discoveryComplete" BOOLEAN NOT NULL DEFAULT false,
    "followLinks" BOOLEAN NOT NULL DEFAULT false,
    "pausedUntil" TIMESTAMP(3),
    "runNo" INTEGER NOT NULL DEFAULT 0,
    "stopReason" TEXT,
    "pages" INTEGER NOT NULL DEFAULT 0,
    "targets" INTEGER NOT NULL DEFAULT 0,
    "checked" INTEGER NOT NULL DEFAULT 0,
    "overflow" INTEGER NOT NULL DEFAULT 0,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteCrawl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteCrawlUrl" (
    "id" TEXT NOT NULL,
    "crawlId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "kind" "SiteCrawlUrlKind" NOT NULL,
    "checkedAt" TIMESTAMP(3),
    "status" INTEGER,
    "redirects" INTEGER NOT NULL DEFAULT 0,
    "outcome" TEXT,
    "carryCount" INTEGER NOT NULL DEFAULT 0,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "sources" TEXT[],

    CONSTRAINT "SiteCrawlUrl_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SiteCrawl_brandId_status_finishedAt_idx" ON "SiteCrawl"("brandId", "status", "finishedAt");

-- CreateIndex
CREATE INDEX "SiteCrawlUrl_crawlId_checkedAt_kind_carryCount_idx" ON "SiteCrawlUrl"("crawlId", "checkedAt", "kind", "carryCount");

-- CreateIndex
CREATE UNIQUE INDEX "SiteCrawlUrl_crawlId_url_key" ON "SiteCrawlUrl"("crawlId", "url");

-- AddForeignKey
ALTER TABLE "SiteCrawl" ADD CONSTRAINT "SiteCrawl_brandId_workspaceId_fkey" FOREIGN KEY ("brandId", "workspaceId") REFERENCES "Brand"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteCrawlUrl" ADD CONSTRAINT "SiteCrawlUrl_crawlId_fkey" FOREIGN KEY ("crawlId") REFERENCES "SiteCrawl"("id") ON DELETE CASCADE ON UPDATE CASCADE;

