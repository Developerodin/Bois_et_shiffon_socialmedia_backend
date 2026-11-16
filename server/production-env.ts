/**
 * Refuses to start a production api or worker with settings that would only fail later, or quietly: a non-https
 * AUTH_URL mints http links (email tokens in cleartext) and insecure cookies, and missing storage keys show up only as
 * signature errors on the first upload. Called from instrumentation.ts (api) and worker/main.ts (worker).
 * Each variable is read by name, not process.env[name], so Next's edge bundle sees it.
 */
export function assertProductionEnv() {
  if (process.env.NODE_ENV !== "production") return;
  if (!process.env.AUTH_URL?.startsWith("https://")) throw new Error("AUTH_URL must be an https:// URL in production");
  if (!process.env.STORAGE_ACCESS_KEY_ID || !process.env.STORAGE_SECRET_ACCESS_KEY) {
    throw new Error("STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY must be set in production");
  }
}
