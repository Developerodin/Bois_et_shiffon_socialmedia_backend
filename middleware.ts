import NextAuth from "next-auth";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { authConfig } from "@/auth.config";

// Auth.js types `auth` as many overloads; as middleware it takes (request, event) and returns a Response.
const authMiddleware = NextAuth(authConfig).auth as unknown as (request: NextRequest, event: NextFetchEvent) => Promise<Response>;

const READS = new Set(["GET", "HEAD", "OPTIONS"]);
// Callers that never hold the session cookie: providers (webhooks), the job trigger, the phone's own sign-in routes, a
// mail provider's one-click unsubscribe (signed link).
const NO_COOKIE_PATHS = ["/api/v1/webhooks/", "/api/v1/jobs/run", "/api/v1/mobile/", "/api/v1/integrations/", "/api/v1/digest/unsubscribe"];

/** AUTH_URL's origin (the website) plus WEB_ORIGINS, a comma list for dev hosts such as a LAN address. */
function allowedOrigins() {
  const list = (process.env.WEB_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  if (process.env.AUTH_URL) list.push(new URL(process.env.AUTH_URL).origin);
  return list;
}

/**
 * A cookie-authenticated write the browser didn't send from our own site (CSRF). SameSite=lax alone still lets a
 * same-site subdomain send it. Bearer calls (the phone) carry no cookie and pass.
 */
export function crossOriginWrite(request: NextRequest) {
  if (READS.has(request.method)) return false;
  if (request.headers.get("authorization")?.startsWith("Bearer ")) return false;
  const path = request.nextUrl.pathname;
  if (NO_COOKIE_PATHS.some((p) => path === p || path.startsWith(p))) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return false;
  const origin = request.headers.get("origin");
  return !origin || !allowedOrigins().includes(origin);
}

// Every /api/v1 call runs the Auth.js middleware: it rolls the session cookie forward on each call, so an active
// person stays signed in. Each route still checks the session itself. Pages live on the Web Frontend (apps/web).
export default async function middleware(request: NextRequest, event: NextFetchEvent) {
  if (crossOriginWrite(request)) {
    const seen = { method: request.method, path: request.nextUrl.pathname, origin: request.headers.get("origin"), secFetchSite: request.headers.get("sec-fetch-site") };
    // CSRF_MODE=log for a first deploy: shows what would be refused without refusing it.
    if (process.env.CSRF_MODE === "log") console.warn("csrf.crossOrigin", JSON.stringify(seen));
    else return NextResponse.json({ type: "https://api.brandpilot/errors/forbidden", title: "Forbidden", status: 403, detail: "Cross-origin request", code: "csrf.crossOrigin" }, { status: 403 });
  }
  const result = await authMiddleware(request, event);
  if (result.status >= 300 && result.status < 400) return result;
  const next = NextResponse.next();
  for (const cookie of result.headers.getSetCookie()) next.headers.append("set-cookie", cookie);
  return next;
}

export const config = {
  matcher: ["/api/v1/:path*"],
};
