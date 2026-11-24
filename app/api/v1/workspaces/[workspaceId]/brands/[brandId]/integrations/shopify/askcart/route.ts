import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { enqueueCatalogSync } from "@/server/catalog/sync";
import { kickRunner } from "@/server/jobs/runner";
import { ReconnectNeeded, saveConnections, toConnectionDto } from "@/server/services/connections";
import { ASKCART_ACCOUNT, askCartConfig, askCartShop, AskCartTaken, guardAskCartBrand } from "@/server/shopify/askcart";

// Queued work runs after the response (kickRunner); give it room to finish.
export const maxDuration = 300;

const problem = (status: number, title: string, detail: string) =>
  problemResponse({ type: `https://api.brandpilot/errors/${status === 409 ? "conflict" : status === 502 ? "upstream" : "validation"}`, title, status, detail });

/**
 * Connect the brand's Shopify store through AskCart (server/shopify/askcart.ts): ask AskCart for the shop to prove it
 * answers, save a SHOPIFY connection with the shop's name and no secret (it stays in ASKCART_SECRET), queue a catalogue
 * sync. No body. 409 when another brand already has it: AskCart is locked to one store, so one brand per deployment.
 * Pressing it again on the same brand reconnects it in place (after AskCart was fixed).
 */
export async function POST(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "integrations.manage");
    if (scope instanceof Response) return scope;
    if (!askCartConfig()) return problem(422, "AskCart isn't set up", "This platform has no AskCart address and key. Connect Shopify with a token instead.");

    let name: string;
    try {
      ({ name } = await askCartShop());
    } catch (e) {
      console.warn("[askcart] connect check failed", scope.brandId, e instanceof Error ? e.message : e);
      return e instanceof ReconnectNeeded
        ? problem(422, "AskCart can't reach the store", "AskCart refused the request. Open AskCart in Shopify admin to reconnect the store, then try again.")
        : problem(502, "Couldn't reach AskCart", "Couldn't reach AskCart. Try again in a minute.");
    }

    let conn;
    try {
      [conn] = await saveConnections({
        workspaceId: scope.workspaceId,
        brandId: scope.brandId,
        provider: "SHOPIFY",
        userId: scope.userId,
        // No secret: the "token" is empty and AskCart's reads never use it (isAskCart branches before accessToken).
        accounts: [{ externalAccountId: ASKCART_ACCOUNT, displayName: String(name ?? "").slice(0, 200) || "Shopify (AskCart)", credentials: { accessToken: "" }, tokenExpiresAt: null, scopes: [] }],
        guard: (tx) => guardAskCartBrand(tx, scope.brandId),
      });
    } catch (e) {
      if (e instanceof AskCartTaken) return problem(409, "AskCart is already in use", "AskCart reads one store and another brand already reads it. Connect this brand's Shopify with a token instead.");
      throw e;
    }
    await enqueueCatalogSync(scope, `connect:${conn.updatedAt.toISOString()}`);
    kickRunner();
    return Response.json({ connection: toConnectionDto(conn) }, { status: 201 });
  } catch (error) {
    return fromAccessError(error);
  }
}
