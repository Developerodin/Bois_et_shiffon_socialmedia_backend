-- A quote is valid 30 days from its invoice send (server/quotes/shopify-draft-orders.ts confirmInvoice); never-sent quotes
-- have no validity and never expire.
ALTER TABLE "Quote" ALTER COLUMN "validUntil" DROP NOT NULL;
UPDATE "Quote" SET "validUntil" = NULL WHERE "sentAt" IS NULL;
