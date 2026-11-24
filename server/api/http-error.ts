import { NextResponse } from "next/server";
import { AccessDeniedError, BrandArchivedError } from "@/server/auth/errors";

import type { ApiProblem } from "@/shared";

export type { ApiProblem };

export function problemResponse(problem: ApiProblem) {
  return NextResponse.json(problem, { status: problem.status });
}

export function fromAccessError(error: unknown) {
  if (error instanceof AccessDeniedError) {
    return problemResponse({
      type: "https://api.brandpilot/errors/access-denied",
      title: "Forbidden",
      status: 403,
      detail: "Access denied",
    });
  }
  // auth.ts SessionUnverifiedError, matched by name (importing auth.ts here would pull Auth.js into every route).
  if (error instanceof Error && error.name === "SessionUnverifiedError") {
    return problemResponse({ type: "https://api.brandpilot/errors/session-unverified", title: "Service unavailable", status: 503, detail: error.message });
  }
  if (error instanceof BrandArchivedError) {
    return problemResponse({
      type: "https://api.brandpilot/errors/brand-archived",
      title: "Conflict",
      status: 409,
      detail: error.message,
    });
  }
  return problemResponse({
    type: "https://api.brandpilot/errors/internal",
    title: "Internal Server Error",
    status: 500,
  });
}

/**
 * Upload size guard, before formData() (which buffers the whole body): 411 for a missing Content-Length (a chunked
 * request) or one that isn't a number, 413 past `maxBytes`, else null. Callers word the problem themselves.
 */
export function uploadLengthStatus(request: Request, maxBytes: number): 411 | 413 | null {
  const length = request.headers.get("content-length");
  if (length === null || !/^\d+$/.test(length)) return 411;
  return Number(length) > maxBytes ? 413 : null;
}
