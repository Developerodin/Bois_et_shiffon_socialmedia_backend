-- Research may replace a name guessed from the web address with the one the site uses; a person's name stays.
ALTER TABLE "Brand" ADD COLUMN "nameGuessed" BOOLEAN NOT NULL DEFAULT false;

-- Existing businesses: a one-word name that is the start of their website's host ("Boisetchiffons" for
-- boisetchiffons.fr, "www.tikamoon" for tikamoon.com) was almost certainly guessed from it.
UPDATE "Brand" b SET "nameGuessed" = true
FROM "BrandProfile" p
WHERE p."brandId" = b.id AND p."websiteUrl" IS NOT NULL AND b."displayName" !~ '\s'
  AND regexp_replace(lower(p."websiteUrl"), '^https?://(www\.)?', '')
      LIKE regexp_replace(lower(b."displayName"), '^www\.', '') || '%';
