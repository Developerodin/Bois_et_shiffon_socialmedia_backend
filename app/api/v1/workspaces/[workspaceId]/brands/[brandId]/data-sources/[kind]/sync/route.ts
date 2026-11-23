import { z } from "zod";
import { DATA_SOURCE_KINDS, DATA_SOURCE_SLUGS, READ_KEY } from "@/shared";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { requestSourceSync } from "@/server/data/sources";
import { kickRunner } from "@/server/jobs/runner";

// Queued work runs after the response (kickRunner); give it room to finish.
export const maxDuration = 300;

const Kind = z.enum(Object.values(DATA_SOURCE_SLUGS) as [string, ...string[]]);
const notFound = () => problemResponse({ type: "https://api.brandpilot/errors/not-found", title: "Data source not found", status: 404 });

/**
 * "Sync now" for one kind: needs that kind's read key. Queues a run per source unless it synced in the last 5 minutes
 * or one is queued or running (`queued: false`); 429 once every due source is over 3 presses an hour for this person.
 */
export async function POST(request: Request, context: { params: Promise<BrandRouteParams & { kind: string }> }) {
  try {
    const slug = Kind.safeParse((await context.params).kind);
    if (!slug.success) return notFound();
    const kind = DATA_SOURCE_KINDS.find((k) => DATA_SOURCE_SLUGS[k] === slug.data)!;
    const scope = await authorizeBrandRoute(request, context.params, READ_KEY[kind]);
    if (scope instanceof Response) return scope;
    const result = await requestSourceSync(scope, kind);
    if (!result.found) return notFound();
    if (result.limited) {
      return problemResponse({ type: "https://api.brandpilot/errors/rate-limited", title: "Slow down", status: 429, detail: "Synced 3 times this hour. Try again later." });
    }
    if (result.queued) kickRunner();
    return Response.json({ queued: result.queued }, { status: 202 });
  } catch (error) {
    return fromAccessError(error);
  }
}
