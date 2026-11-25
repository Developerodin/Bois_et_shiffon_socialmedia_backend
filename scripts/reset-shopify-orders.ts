/**
 * Make a brand's Shopify orders sync re-read the last FIRST_RUN_DAYS (60) days on its next run: clears the cursor of
 * its SHOPIFY_ORDERS sources. For after AskCart starts sending line items, so orders already stored get theirs.
 * Safe to run twice (it only clears the cursor); the re-read upserts, so nothing is duplicated. It doesn't start a
 * run: the daily sync, or Sync now on the Data sources page, does. It refuses while a run of the source is going (that
 * run would save its own cursor over the reset when it ends): try again once it has finished.
 *   npm run reset:shopify-orders -- <brandId>
 */
import { prisma } from "@/server/db/prisma";
import { FIRST_RUN_DAYS } from "@/server/data/shopify-orders-sync";
import { DATA_SYNC_JOB } from "@/server/data/sources";

async function main() {
  const [brandId] = process.argv.slice(2);
  if (!brandId) {
    console.error("Usage: npm run reset:shopify-orders -- <brandId>   (not while the brand's orders sync is running)");
    process.exit(1);
  }
  // Which database this will change (the .env it runs with), before it does.
  console.log(`Database: ${new URL(process.env.DATABASE_URL ?? "postgres://unknown").host}`);
  const sources = await prisma.dataSource.findMany({ where: { brandId, kind: "SHOPIFY_ORDERS" }, select: { id: true } });
  if (!sources.length) return console.log(`No Shopify orders source for brand ${brandId}.`);
  for (const { id } of sources) {
    const running = await prisma.job.findFirst({
      where: { type: DATA_SYNC_JOB, status: "RUNNING", payload: { path: ["dataSourceId"], equals: id } },
      select: { id: true },
    });
    if (running) {
      console.error(`Source ${id} is syncing now (job ${running.id}); nothing changed. Run this again once it has finished.`);
      process.exitCode = 1;
      return;
    }
  }
  const { count } = await prisma.dataSource.updateMany({ where: { brandId, kind: "SHOPIFY_ORDERS" }, data: { cursor: null } });
  console.log(`${count} orders source(s) reset: the next run reads the last ${FIRST_RUN_DAYS} days.`);
}

main().finally(() => prisma.$disconnect());
