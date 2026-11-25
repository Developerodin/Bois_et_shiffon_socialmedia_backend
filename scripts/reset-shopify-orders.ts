/**
 * Make a brand's Shopify orders sync re-read the last 60 days on its next run (FIRST_RUN_DAYS): clears the cursor of
 * its SHOPIFY_ORDERS sources. For after AskCart starts sending line items, so orders already stored get theirs.
 * Safe to run twice (it only clears the cursor); the re-read upserts, so nothing is duplicated. It doesn't start a
 * run: the daily sync, or Sync now on the Data sources page, does.
 *   npm run reset:shopify-orders -- <brandId>
 */
import { prisma } from "@/server/db/prisma";

async function main() {
  const [brandId] = process.argv.slice(2);
  if (!brandId) {
    console.error("Usage: npm run reset:shopify-orders -- <brandId>");
    process.exit(1);
  }
  // Which database this will change (the .env it runs with), before it does.
  console.log(`Database: ${new URL(process.env.DATABASE_URL ?? "postgres://unknown").host}`);
  const { count } = await prisma.dataSource.updateMany({ where: { brandId, kind: "SHOPIFY_ORDERS" }, data: { cursor: null } });
  console.log(count ? `${count} orders source(s) reset: the next run reads the last 60 days.` : `No Shopify orders source for brand ${brandId}.`);
}

main().finally(() => prisma.$disconnect());
