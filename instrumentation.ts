import { assertProductionEnv } from "@/server/production-env";

/** Runs once when the Next server starts. */
export function register() {
  assertProductionEnv();
}
