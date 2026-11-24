import { z } from "zod";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { shopDomain } from "@/server/catalog/shopify";
import { enqueueCatalogSync } from "@/server/catalog/sync";
import { kickRunner } from "@/server/jobs/runner";
import { ReconnectNeeded, saveConnections, toConnectionDto } from "@/server/services/connections";
import { ASKCART_ACCOUNT, ASKCART_SCOPE, askCartConfig, askCartShop, AskCartTaken, guardAskCartBrand } from "@/server/shopify/askcart";
import { startAskCartConnect } from "@/server/shopify/askcart-connect";

// Queued work runs after the response (kickRunner); give it room to finish.
export const maxDuration = 300;

const Body = z.object({ shop: z.string().max(200).optional() });

const problem = (status: number, title: string, detail: string) =>
  problemResponse({ type: `https://api.brandpilot/errors/${status === 409 ? "conflict" : status === 502 ? "upstream" : "validation"}`, title, status, detail });

/**
 * Connect the brand's Shopify store through AskCart (server/shopify/askcart.ts). Needs integrations.manage.
 * - per-brand mode: `{ shop: "<store>.myshopify.com" }` → 200 `{ url }`, AskCart's connect page; the browser goes
 *   there and comes back through /api/v1/integrations/askcart/callback.
 * - single-store mode (INTERIM): no body. Asks AskCart for the shop to prove it answers, saves a SHOPIFY connection
 *   with the shop's name and no secret (it stays in ASKCART_SECRET), queues a catalogue sync → 201 `{ connection }`.
 *   409 when another brand already has it: that AskCart serves one store, so one brand per deployment.
 */
export async function POST(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "integrations.manage");
    if (scope instanceof Response) return scope;
    const cfg = askCartConfig();
    if (!cfg) return problem(422, "AskCart isn't set up", "This platform isn't linked to AskCart. Connect Shopify with a token instead.");

    if (cfg.mode === "per-brand") {
      const body = Body.safeParse(await request.json().catch(() => null));
      const shop = body.success && body.data.shop ? shopDomain(body.data.shop) : null;
      if (!shop) return problem(422, "Enter your store address", "Enter your store's .myshopify.com address.");
      return Response.json({ url: await startAskCartConnect({ workspaceId: scope.workspaceId, brandId: scope.brandId, userId: scope.userId, shop }) });
    }

    // INTERIM single-store mode: remove with ASKCART_SECRET once AskCart's per-store connect is live.
    let name: string;
    try {
      ({ name } = await askCartShop(cfg.secret));
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
        // No secret: the "token" is empty; reads take ASKCART_SECRET from env (askCartToken).
        accounts: [{ externalAccountId: ASKCART_ACCOUNT, displayName: String(name ?? "").slice(0, 200) || "Shopify (AskCart)", credentials: { accessToken: "" }, tokenExpiresAt: null, scopes: [ASKCART_SCOPE] }],
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
