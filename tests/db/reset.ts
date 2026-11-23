import { beforeAll } from "vitest";
import { prisma } from "@/server/db/prisma";

/** Runs before each DB test file: every table but Prisma's migration record is emptied, so files don't share rows. */
beforeAll(async () => {
  await prisma.$executeRaw`DO $$
    DECLARE tables text;
    BEGIN
      SELECT string_agg(format('%I', tablename), ', ') INTO tables
      FROM pg_tables WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations';
      IF tables IS NOT NULL THEN EXECUTE 'TRUNCATE ' || tables || ' CASCADE'; END IF;
    END $$`;
});
