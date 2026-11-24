-- Product pages the site reader found in a website's sitemap, with their read state across days.
-- CreateTable
CREATE TABLE "CatalogPage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "lastmod" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "triedAt" TIMESTAMP(3),
    "etag" TEXT,
    "modifiedAt" TEXT,
    "productKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "state" TEXT,

    CONSTRAINT "CatalogPage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CatalogPage_brandId_triedAt_idx" ON "CatalogPage"("brandId", "triedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogPage_brandId_url_key" ON "CatalogPage"("brandId", "url");

-- AddForeignKey
ALTER TABLE "CatalogPage" ADD CONSTRAINT "CatalogPage_brandId_workspaceId_fkey" FOREIGN KEY ("brandId", "workspaceId") REFERENCES "Brand"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

