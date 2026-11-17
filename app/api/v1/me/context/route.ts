import { cookies } from "next/headers";
import { SHELL_COOKIE_BRAND, SHELL_COOKIE_MAX_AGE, SHELL_COOKIE_WORKSPACE, type ContextRequest } from "@/shared";
import { problemResponse } from "@/server/api/http-error";
import { requireBrandAccess, requireWorkspaceMember } from "@/server/auth/access";
import { AccessDeniedError } from "@/server/auth/errors";
import { requestUserId } from "@/server/auth/request-user";

const problem = (status: number, title: string, detail?: string) =>
  problemResponse({ type: `https://api.brandpilot/errors/${title.toLowerCase().replace(/ /g, "-")}`, title, status, detail });

const cookieOptions = { httpOnly: true, sameSite: "lax", path: "/", maxAge: SHELL_COOKIE_MAX_AGE, secure: process.env.NODE_ENV === "production" } as const;

/**
 * Pick the active workspace (and brand). The choice lives in cookies, so this is a cookie-authenticated write:
 * it takes JSON only, and the middleware refuses it from any other origin (crossOriginWrite).
 */
export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return problem(415, "Unsupported media type", "Send JSON");
  }
  const userId = await requestUserId(request);
  if (!userId) return problem(401, "Unauthorized", "Sign in required");

  const body = (await request.json().catch(() => null)) as Partial<ContextRequest> | null;
  const { workspaceId, brandId } = body ?? {};
  if (typeof workspaceId !== "string" || !workspaceId || (brandId !== undefined && typeof brandId !== "string")) {
    return problem(422, "Unprocessable entity", "workspaceId is required");
  }

  try {
    if (brandId) await requireBrandAccess(workspaceId, brandId, userId, { allowArchived: true });
    else await requireWorkspaceMember(workspaceId, userId);
  } catch (error) {
    // Not found rather than forbidden: don't confirm that a workspace or brand exists.
    if (error instanceof AccessDeniedError) return problem(404, "Not found", "No such workspace or brand");
    throw error;
  }

  const cookieStore = await cookies();
  cookieStore.set(SHELL_COOKIE_WORKSPACE, workspaceId, cookieOptions);
  if (brandId) cookieStore.set(SHELL_COOKIE_BRAND, brandId, cookieOptions);
  else cookieStore.delete(SHELL_COOKIE_BRAND);
  return Response.json({ ok: true });
}
