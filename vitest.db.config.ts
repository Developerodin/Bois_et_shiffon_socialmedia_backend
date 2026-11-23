import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { defineConfig } from "vitest/config";

/**
 * Tests against a real Postgres (npm run test:db): tests/db/**\/*.db.test.ts only. TEST_DATABASE_URL names a
 * throwaway database; every table in it is emptied before each test file. Without it, nothing runs.
 */
const url = process.env.TEST_DATABASE_URL;
if (!url) console.log("test:db skipped: set TEST_DATABASE_URL to a throwaway Postgres database to run the DB tests.");

// The suite empties every table, so it never runs against the app's own database (.env or the shell's).
const app = existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {};
if (url && [app.DATABASE_URL, app.DATABASE_URL_UNPOOLED, process.env.DATABASE_URL, process.env.DATABASE_URL_UNPOOLED].includes(url)) {
  throw new Error("TEST_DATABASE_URL is the app's database; the DB tests empty every table. Use a throwaway database.");
}

export default defineConfig({
  test: {
    environment: "node",
    include: url ? ["tests/db/**/*.db.test.ts"] : [],
    passWithNoTests: true,
    globals: false,
    // One database: files run one after another, each starting from empty tables.
    fileParallelism: false,
    globalSetup: url ? ["tests/db/setup.ts"] : [],
    setupFiles: url ? ["tests/db/reset.ts"] : [],
    // Set before Prisma reads .env, which never overrides a variable that is already set.
    env: url ? { DATABASE_URL: url, DATABASE_URL_UNPOOLED: url } : {},
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
});
