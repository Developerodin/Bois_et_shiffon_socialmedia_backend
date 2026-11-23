-- CreateEnum
CREATE TYPE "SearchDimension" AS ENUM ('SITE', 'PAGE');

-- CreateTable
CREATE TABLE "SearchDay" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "siteUrl" TEXT NOT NULL,
    "dimension" "SearchDimension" NOT NULL,
    "day" DATE NOT NULL,
    "page" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "positionSum" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "SearchDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: the only index; INCLUDE lets range reads (summary, top pages) run index-only. Prisma's schema can't say
-- INCLUDE, so it lives here only: `prisma migrate diff` lists it as a re-create (like the hand-made trgm indexes);
-- keep any generated migration from dropping it.
CREATE UNIQUE INDEX "SearchDay_brandId_siteUrl_dimension_day_page_key" ON "SearchDay"("brandId", "siteUrl", "dimension", "day", "page") INCLUDE ("clicks", "impressions", "positionSum");

-- AddForeignKey
ALTER TABLE "SearchDay" ADD CONSTRAINT "SearchDay_brandId_workspaceId_fkey" FOREIGN KEY ("brandId", "workspaceId") REFERENCES "Brand"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
