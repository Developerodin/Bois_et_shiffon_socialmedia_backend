-- The Shopify blog a brand's articles go to (server/blog/shopify-articles.ts); null = the store's first blog.
-- AlterTable
ALTER TABLE "BrandProfile" ADD COLUMN "shopifyBlogId" TEXT;
