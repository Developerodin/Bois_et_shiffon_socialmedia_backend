import { execSync } from "node:child_process";

/** Global setup for npm run test:db: brings the test database up to the current migrations once per run. */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL!;
  // Both URLs: migrate uses directUrl (DATABASE_URL_UNPOOLED), and .env would otherwise supply the app's database.
  execSync("npx prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url, DATABASE_URL_UNPOOLED: url } });
}
