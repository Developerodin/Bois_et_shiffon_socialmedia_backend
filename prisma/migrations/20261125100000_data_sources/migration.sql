-- CreateEnum
CREATE TYPE "DataSourceKind" AS ENUM ('SEARCH_CONSOLE', 'POST_METRICS', 'SHOPIFY_ORDERS', 'META_ADS');

-- CreateEnum
CREATE TYPE "DataSourceStatus" AS ENUM ('ACTIVE', 'ERROR', 'OFF');

-- CreateTable
CREATE TABLE "DataSource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "kind" "DataSourceKind" NOT NULL,
    "connectionId" TEXT,
    "externalId" TEXT NOT NULL,
    "label" TEXT,
    "settings" JSONB,
    "status" "DataSourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "syncedThrough" DATE,
    "cursor" TEXT,
    "lastResult" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DataSource_status_idx" ON "DataSource"("status");

-- CreateIndex
CREATE UNIQUE INDEX "DataSource_brandId_kind_externalId_key" ON "DataSource"("brandId", "kind", "externalId");

-- AddForeignKey
ALTER TABLE "DataSource" ADD CONSTRAINT "DataSource_brandId_workspaceId_fkey" FOREIGN KEY ("brandId", "workspaceId") REFERENCES "Brand"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

