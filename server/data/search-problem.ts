import { problemResponse, fromAccessError } from "@/server/api/http-error";
import { AccessDeniedError, BrandArchivedError } from "@/server/auth/errors";
import { SearchSiteError } from "@/server/data/search-sync";

/** Route error → problem response for the Search Console routes. Google's text stays in the logs. */
export function toSearchProblem(error: unknown) {
  if (error instanceof SearchSiteError) {
    return problemResponse({ type: "https://api.brandpilot/errors/search-console", title: error.message, status: error.status, detail: error.message });
  }
  if (!(error instanceof AccessDeniedError || error instanceof BrandArchivedError)) {
    console.error("[search-console] route failed", error instanceof Error ? error.message : error);
  }
  return fromAccessError(error);
}

