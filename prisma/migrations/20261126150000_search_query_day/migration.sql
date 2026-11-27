-- CreateEnum
CREATE TYPE "SearchQueryDimension" AS ENUM ('QUERY', 'QUERY_PAGE');

-- CreateTable
CREATE TABLE "SearchQueryDay" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "siteUrl" TEXT NOT NULL,
    "dimension" "SearchQueryDimension" NOT NULL,
    "day" DATE NOT NULL,
    "query" TEXT NOT NULL,
    "page" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "positionSum" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "SearchQueryDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: housekeeping deletes rows older than 400 days by day.
CREATE INDEX "SearchQueryDay_day_idx" ON "SearchQueryDay"("day");

-- CreateIndex: INCLUDE lets range reads (top queries, a page's queries) run index-only, as SearchDay's. Prisma's schema
-- can't say INCLUDE, so it lives here only: `prisma migrate diff` lists it as a re-create; keep any generated
-- migration from dropping it.
CREATE UNIQUE INDEX "SearchQueryDay_brandId_siteUrl_dimension_day_query_page_key" ON "SearchQueryDay"("brandId", "siteUrl", "dimension", "day", "query", "page") INCLUDE ("clicks", "impressions", "positionSum");

-- AddForeignKey
ALTER TABLE "SearchQueryDay" ADD CONSTRAINT "SearchQueryDay_brandId_workspaceId_fkey" FOREIGN KEY ("brandId", "workspaceId") REFERENCES "Brand"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
