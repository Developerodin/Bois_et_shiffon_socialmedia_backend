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

export const badRange = (detail = "from and to must be YYYY-MM-DD, from not after to, at most 90 days.") =>
  problemResponse({ type: "https://api.brandpilot/errors/invalid-range", title: "Invalid range", status: 400, detail });
