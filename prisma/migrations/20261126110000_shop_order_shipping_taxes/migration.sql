-- Fail fast instead of queueing every ShopOrder read behind a long sync lock; re-run if it times out.
SET lock_timeout = '5s';

-- AlterTable: nullable, no default, so no table rewrite.
ALTER TABLE "ShopOrder" ADD COLUMN     "shippingTaxes" DECIMAL(14,2);
