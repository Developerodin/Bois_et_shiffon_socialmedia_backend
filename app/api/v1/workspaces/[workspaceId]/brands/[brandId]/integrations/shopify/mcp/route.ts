import { z } from "zod";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { enqueueCatalogSync } from "@/server/catalog/sync";
import { prisma } from "@/server/db/prisma";
import { kickRunner } from "@/server/jobs/runner";
import { CrawlError } from "@/server/research/crawl";
import { saveConnections, toConnectionDto } from "@/server/services/connections";
import { CatalogMcpError, catalogMcpProfileUrl, checkCatalogMcp, isShopifyMcp, MCP_SCOPE, mcpStoreHost, storeHostMismatch } from "@/server/shopify/catalog-mcp";

// Queued work runs after the response (kickRunner); give it room to finish.
export const maxDuration = 300;

const Body = z.object({ shop: z.string().max(200) });

const problem = (status: number, title: string, detail: string) =>
  problemResponse({ type: `https://api.brandpilot/errors/${status === 409 ? "conflict" : status === 502 ? "upstream" : status === 429 ? "rate-limited" : "validation"}`, title, status, detail });

/** The store's address is already connected another way (AskCart or a token): connecting it here would replace that. */
class TakenOtherWay extends Error {}

/**
 * Connect the brand's Shopify store through Shopify's Storefront Catalog MCP (server/shopify/catalog-mcp.ts), products
 * only. Needs integrations.manage. `{ shop }`: the store's .myshopify.com or own domain. The store is asked for its
 * tools and one search before anything is saved; then a SHOPIFY connection (account id = the host, MCP_SCOPE marked,
 * no secret) and a catalogue sync are queued → 201 `{ connection, warning? }`; `warning` when the store's own domain
 * isn't the brand's website (storeHostMismatch), so a wrong store is noticed; it still connects. 409 when the same address is connected through
 * AskCart or a token (disconnect that first). 10 tries a minute per brand and person: each one calls the store.
 */
export async function POST(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "integrations.manage");
    if (scope instanceof Response) return scope;
    const profile = catalogMcpProfileUrl();
    if (!profile) return problem(422, "Shopify MCP isn't set up", "This platform has no public agent profile for Shopify MCP. Ask your platform admin to set UCP_PROFILE_URL.");
    const body = Body.safeParse(await request.json().catch(() => null));
    const host = body.success ? mcpStoreHost(body.data.shop) : null;
    if (!host) return problem(422, "Enter your store address", "Enter your store's address, like your-store.myshopify.com or your shop's own domain.");
    if (!(await hitRateLimit(`shopify-mcp:connect:${scope.brandId}:${scope.userId}`, 10, 60_000)).allowed) {
      return problem(429, "Slow down", "Your store was asked too often. Wait a minute and try again.");
    }

    try {
      await checkCatalogMcp(host, profile, AbortSignal.timeout(60_000));
    } catch (e) {
      console.warn("[shopify-mcp] connect check failed", scope.brandId, e instanceof Error ? e.message : e);
      if (e instanceof CatalogMcpError && e.profileProblem) {
        return problem(502, "Shopify couldn't read our profile", "Shopify couldn't read this platform's agent profile. Ask your platform admin to check UCP_PROFILE_URL.");
      }
      if (e instanceof CatalogMcpError && e.code === "redirected") {
        return problem(422, "Use your myshopify address", `${host} redirects somewhere else. Enter your store's your-store.myshopify.com address instead (Shopify admin → Settings → Domains).`);
      }
      if (e instanceof CatalogMcpError && e.busy) return problem(502, "The store is busy", "Your store is busy or down right now. Try again in a few minutes.");
      if (e instanceof CrawlError || (e instanceof CatalogMcpError && (e.code === "not_mcp" || e.code === "no_search_catalog"))) {
        return problem(422, "No Shopify catalogue there", `${host} doesn't answer as a Shopify store's catalogue. Check the address (your .myshopify.com address works too).`);
      }
      return problem(502, "Couldn't reach the store", "Couldn't read the store's catalogue. Try again in a minute.");
    }

    let conn;
    try {
      [conn] = await saveConnections({
        workspaceId: scope.workspaceId,
        brandId: scope.brandId,
        provider: "SHOPIFY",
        userId: scope.userId,
        // No secret: the Catalog MCP is public. The empty "token" is never sent anywhere (isShopifyMcp paths).
        accounts: [{ externalAccountId: host, displayName: host, credentials: { accessToken: "" }, tokenExpiresAt: null, scopes: [MCP_SCOPE] }],
        guard: async (tx) => {
          const same = await tx.integrationConnection.findFirst({
            where: { brandId: scope.brandId, provider: "SHOPIFY", externalAccountId: host, status: { not: "REVOKED" } },
            select: { scopes: true },
          });
          if (same && !isShopifyMcp(same)) throw new TakenOtherWay();
        },
      });
    } catch (e) {
      if (e instanceof TakenOtherWay) return problem(409, "Already connected", `${host} is already connected through AskCart or a token. Disconnect it first.`);
      throw e;
    }
    await enqueueCatalogSync(scope, `connect:${conn.updatedAt.toISOString()}`);
    kickRunner();
    const site = await prisma.brandProfile.findFirst({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId }, select: { websiteUrl: true } });
    const warning = storeHostMismatch(host, site?.websiteUrl)
      ? `${host} isn't this brand's website (${site?.websiteUrl}). If that's the wrong store, disconnect it and connect the right one.`
      : undefined;
    return Response.json({ connection: toConnectionDto(conn), ...(warning ? { warning } : {}) }, { status: 201 });
  } catch (error) {
    return fromAccessError(error);
  }
}
