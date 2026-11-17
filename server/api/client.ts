import { problemResponse } from "@/server/api/http-error";

/** Which app is calling, from `X-Client: web/<version>` or `mobile/<version>`, else from how it signs in. */
export function clientOf(request: Request): { kind: "web" | "mobile" | "unknown"; version: string | null } {
  const m = /^(web|mobile)\/(\S{1,40})$/.exec(request.headers.get("x-client")?.trim() ?? "");
  if (m) return { kind: m[1] as "web" | "mobile", version: m[2] };
  // Untagged (older app builds, and the website until it sends the tag): Bearer is the phone, a cookie the website.
  if (request.headers.get("authorization")?.startsWith("Bearer ")) return { kind: "mobile", version: null };
  if (request.headers.get("cookie")) return { kind: "web", version: null };
  return { kind: "unknown", version: null };
}

/**
 * Kill switch for paid starts from one client (PAID_STARTS_OFF_FOR=web): a bug in a new web flow can be stopped from
 * spending without stopping the phone. Returns the 503 to send, or null to go on.
 */
export function paidStartsPaused(request: Request): Response | null {
  const off = (process.env.PAID_STARTS_OFF_FOR ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const { kind } = clientOf(request);
  if (kind === "unknown" || !off.includes(kind)) return null;
  const title = kind === "web" ? "Making this from the website is paused" : "Making this from the app is paused";
  return problemResponse({ type: "https://api.brandpilot/errors/paused", title, status: 503, detail: title, code: "paid.pausedForClient" });
}

/** One JSON log line per paid start, whatever its outcome, for spend and duplicate-start monitoring. */
export function logPaidStart(e: { feature: string; client: string; workspaceId: string; refId: string | null; outcome: string; ms: number }) {
  console.log(JSON.stringify({ event: "paid.start", ...e }));
}

/**
 * A paid route's work after authorization: refused while paused for this client, otherwise run, with every outcome
 * logged ("started" 201/202, "repeated" 200, else the status). `toResponse` is the route's own error-to-response.
 */
export async function paidStart(
  request: Request,
  e: { feature: string; workspaceId: string; refId?: string | null },
  run: () => Promise<Response>,
  toResponse: (error: unknown) => Response,
): Promise<Response> {
  const paused = paidStartsPaused(request);
  if (paused) return paused;
  const t0 = Date.now();
  const log = (outcome: string) => logPaidStart({ feature: e.feature, client: clientOf(request).kind, workspaceId: e.workspaceId, refId: e.refId ?? null, outcome, ms: Date.now() - t0 });
  let res: Response;
  try {
    res = await run().catch(toResponse);
  } catch (error) {
    log("error");
    throw error;
  }
  log(res.status === 200 ? "repeated" : res.status === 201 || res.status === 202 ? "started" : String(res.status));
  return res;
}
