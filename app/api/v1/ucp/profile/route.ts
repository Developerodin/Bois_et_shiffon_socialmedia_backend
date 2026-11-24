/**
 * Our UCP agent profile (https://shopify.dev/docs/agents/get-started/profile), public and static: Shopify fetches it
 * on every Catalog MCP request (server/shopify/catalog-mcp.ts sends its URL, UCP_PROFILE_URL by default this route).
 * Catalogue search and lookup only: no cart, checkout or order capability, so the store offers us no tools for them.
 * Served under /api so it reaches the Server on the public origin (the website's middleware sends other paths to
 * sign-in). Capability ids and version as Shopify's example profile names them (2026-08-25).
 */
const V = "2026-08-25";
const UCP_PROFILE = {
  ucp: {
    version: V,
    services: {
      "dev.ucp.shopping": [{ version: V, spec: `https://ucp.dev/${V}/specification/overview`, transport: "mcp", schema: `https://ucp.dev/${V}/services/shopping/mcp.openrpc.json` }],
    },
    capabilities: {
      "dev.ucp.shopping.catalog.search": [{ version: V, spec: `https://ucp.dev/${V}/specification/catalog/search`, schema: `https://ucp.dev/${V}/schemas/shopping/catalog_search.json` }],
      "dev.ucp.shopping.catalog.lookup": [{ version: V, spec: `https://ucp.dev/${V}/specification/catalog/lookup`, schema: `https://ucp.dev/${V}/schemas/shopping/catalog_lookup.json` }],
      "dev.shopify.catalog": [{ version: V, spec: "https://shopify.dev/docs/agents/catalog/storefront-catalog", schema: `https://shopify.dev/ucp/schemas/${V}/shopify_catalog.json`, extends: ["dev.ucp.shopping.catalog.lookup", "dev.ucp.shopping.catalog.search"] }],
    },
  },
};

export function GET() {
  return Response.json(UCP_PROFILE, { headers: { "cache-control": "public, max-age=3600" } });
}
