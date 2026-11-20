import { problemResponse } from "@/server/api/http-error";
import { hitRateLimit } from "@/server/auth/rate-limit";

/** CSV downloads (calendar, audit findings): one allowance per person across them, 20 an hour. */
export async function exportAllowed(userId: string) {
  return (await hitRateLimit(`export:${userId}`, 20, 3_600_000)).allowed;
}

export const tooManyExports = () => problemResponse({ type: "https://api.brandpilot/errors/rate-limited", title: "Too many exports. Try again later.", status: 429 });

export const badExport = (detail: string) => problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Bad Request", status: 400, detail });

/** A download that is never cached and never sniffed into something other than CSV. */
export function csvResponse(csv: string, filename: string) {
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
