import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { prisma } from "@/server/db/prisma";
import { disconnect } from "@/server/services/connections";
import { isAskCart } from "@/server/shopify/askcart";
import { revokeAskCart } from "@/server/shopify/askcart-token";

export async function DELETE(
  request: Request,
  context: { params: Promise<BrandRouteParams & { connectionId: string }> },
) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "integrations.manage");
    if (scope instanceof Response) return scope;
    const { connectionId } = await context.params;
    // An AskCart store: AskCart forgets the brand's token first (best effort), then ours is dropped as usual.
    const conn = await prisma.integrationConnection.findFirst({
      where: { id: connectionId, workspaceId: scope.workspaceId, brandId: scope.brandId, provider: "SHOPIFY", status: { not: "REVOKED" } },
    });
    if (conn && isAskCart(conn)) await revokeAskCart(conn);
    const result = await disconnect({ ...scope, connectionId });
    if (!result) return problemResponse({ type: "https://api.brandpilot/errors/not-found", title: "Not found", status: 404 });
    return Response.json(result);
  } catch (error) {
    return fromAccessError(error);
  }
}
