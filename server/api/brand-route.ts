import { requestUserId } from "@/server/auth/request-user";
import { problemResponse } from "@/server/api/http-error";
import { assertWorkspaceHeaderMatchesPath } from "@/server/api/workspace-headers";
import { brandAccess } from "@/server/auth/access";
import { AccessDeniedError } from "@/server/auth/errors";
import type { PermissionKey } from "@/server/auth/permissions.catalog";

export type BrandRouteParams = { workspaceId: string; brandId: string };

/**
 * Shared guard for /workspaces/:workspaceId/brands/:brandId/* routes:
 * session → header/path match (AT-017) → brand access (AT-001/019) → permission.
 * Returns the scope, or a Response to return as-is. Throws access errors for fromAccessError.
 */
export async function authorizeBrandRoute(
  request: Request,
  params: Promise<BrandRouteParams>,
  permission: PermissionKey,
) {
  const userId = await requestUserId(request);
  if (!userId) {
    return problemResponse({
      type: "https://api.brandpilot/errors/unauthorized",
      title: "Unauthorized",
      status: 401,
    });
  }
  const { workspaceId, brandId } = await params;
  assertWorkspaceHeaderMatchesPath(workspaceId, request.headers.get("X-Workspace-Id"));
  const { perms } = await brandAccess(workspaceId, brandId, userId);
  if (!perms.has(permission)) throw new AccessDeniedError(`Missing permission ${permission}`);
  return { userId: userId, workspaceId, brandId };
}
