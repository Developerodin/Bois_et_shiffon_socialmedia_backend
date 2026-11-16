import NextAuth from "next-auth";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { authConfig } from "@/auth.config";

// Auth.js types `auth` as many overloads; as middleware it takes (request, event) and returns a Response.
const authMiddleware = NextAuth(authConfig).auth as unknown as (request: NextRequest, event: NextFetchEvent) => Promise<Response>;

// Every /api/v1 call runs the Auth.js middleware: it rolls the session cookie forward on each call, so an active
// person stays signed in. Each route still checks the session itself. Pages live on the Web Frontend (apps/web).
export default async function middleware(request: NextRequest, event: NextFetchEvent) {
  const result = await authMiddleware(request, event);
  if (result.status >= 300 && result.status < 400) return result;
  const next = NextResponse.next();
  for (const cookie of result.headers.getSetCookie()) next.headers.append("set-cookie", cookie);
  return next;
}

export const config = {
  matcher: ["/api/v1/:path*"],
};
