import { z } from "zod";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { listDataSources } from "@/server/data/sources";
import { turnOnShopifyOrders, type TurnOn } from "@/server/data/shopify-orders-sync";
import { kickRunner } from "@/server/jobs/runner";

// Queued work runs after the response (kickRunner); give it room to finish.
export const maxDuration = 300;

// Only the connection id is read; any other field (a token above all) is ignored.
const Body = z.object({ connectionId: z.string().min(1).max(100) });

const PROBLEMS: Record<Extract<TurnOn, { ok: false }>["problem"], { status: number; title: string; detail: string }> = {
  "not-connected": { status: 404, title: "Shopify connection not found", detail: "That Shopify store isn't connected to this brand. Connect it first." },
  "missing-scope": { status: 422, title: "Shopify needs order access", detail: "Add read_orders to the app in Shopify, reinstall it and paste the new token." },
  refused: { status: 422, title: "Shopify refused the token", detail: "Shopify refused the stored token. Reconnect Shopify with a new token." },
  unreachable: { status: 502, title: "Couldn't reach Shopify", detail: "Couldn't reach Shopify. Try again in a minute." },
  "needs-askcart": { status: 422, title: "Orders need our app (AskCart)", detail: "This store is connected through Shopify MCP, which reads products only. Orders need our app (AskCart): connect Shopify with AskCart in Connections." },
};
/** The same problems for a store read through AskCart: there is no token to paste. */
const ASKCART_PROBLEMS: typeof PROBLEMS = {
  ...PROBLEMS,
  "missing-scope": { status: 422, title: "AskCart needs order access", detail: "AskCart can't read this store's orders yet. Allow order access in AskCart in Shopify admin, then try again." },
  refused: { status: 422, title: "AskCart can't reach the store", detail: "AskCart no longer has access to this store. Connect Shopify via AskCart again in Connections." },
  unreachable: { status: 502, title: "Couldn't reach AskCart", detail: "Couldn't reach AskCart. Try again in a minute." },
};

/**
 * Turn on the orders sync (Sales tab) for one of the brand's Shopify connections, `{ connectionId }`. Needs
 * integrations.manage. The token is the stored connection's, never one sent here. A connection of another brand or
 * provider is 404; 422 without read_orders (detail shown as-is); else queues the first run. Each press asks Shopify for
 * the token's scopes, so 10 a minute per brand and person (429).
 */
export async function PUT(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "integrations.manage");
    if (scope instanceof Response) return scope;
    if (!(await hitRateLimit(`shopify-orders:turn-on:${scope.brandId}:${scope.userId}`, 10, 60_000)).allowed) {
      return problemResponse({ type: "https://api.brandpilot/errors/rate-limited", title: "Slow down", status: 429, detail: "Shopify was asked too often. Wait a minute and try again." });
    }
    const body = Body.safeParse(await request.json().catch(() => null));
    if (!body.success) return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Pick a Shopify connection", status: 422, detail: "Pick the Shopify store to read orders from." });
    const result = await turnOnShopifyOrders(scope, body.data.connectionId);
    if (!result.ok) {
      const p = (result.askCart ? ASKCART_PROBLEMS : PROBLEMS)[result.problem];
      return problemResponse({ type: `https://api.brandpilot/errors/${p.status === 422 ? "validation" : p.status === 404 ? "not-found" : "upstream"}`, ...p });
    }
    kickRunner();
    const source = (await listDataSources(scope, scope.perms)).find((s) => s.id === result.sourceId) ?? null;
    return Response.json({ source }, { status: 200 });
  } catch (error) {
    return fromAccessError(error);
  }
}
