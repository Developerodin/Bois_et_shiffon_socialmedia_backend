-- Imported products (from a spreadsheet, person-owned) and products read from a website's product pages.
ALTER TYPE "ProductSource" ADD VALUE 'IMPORT';
ALTER TYPE "ProductSource" ADD VALUE 'SITE';
