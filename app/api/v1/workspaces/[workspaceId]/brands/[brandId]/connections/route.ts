import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { AccessDeniedError } from "@/server/auth/errors";
import { CONNECTIONS_READ } from "@/shared";
import { listConnections, listProviders, toConnectionDto } from "@/server/services/connections";

/**
 * Which channels can be connected (keys present) and what this brand has connected. For the people who answer
 * customers (inbox.read), publish (they pick the account) or manage the accounts; not a client reviewer.
 */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "brand.read");
    if (scope instanceof Response) return scope;
    if (!CONNECTIONS_READ.some((k) => scope.perms.has(k))) throw new AccessDeniedError(`Missing one of ${CONNECTIONS_READ.join(", ")}`);
    const rows = await listConnections(scope.workspaceId, scope.brandId);
    return Response.json({ providers: listProviders(), connections: rows.map(toConnectionDto) });
  } catch (error) {
    return fromAccessError(error);
  }
}
