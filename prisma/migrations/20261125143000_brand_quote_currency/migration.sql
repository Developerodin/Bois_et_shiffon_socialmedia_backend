-- The currency of a brand's quotes when it has no Shopify catalogue: the first quote's, required after that (server/quotes/quotes.ts).
ALTER TABLE "BrandProfile" ADD COLUMN "quoteCurrency" TEXT;
