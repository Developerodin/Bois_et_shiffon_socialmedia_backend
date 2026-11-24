/**
 * Shopify Storefront Catalog MCP answers, recorded 2026-11-24 from https://www.boisetchiffons.fr/api/ucp/mcp
 * (myshopify 687541-22.myshopify.com) with Shopify's example agent profile, trimmed: one product, long texts cut.
 * The tool list follows the profile's capabilities (that profile also declares cart, checkout and order).
 */
// recorded 2026-11-24
export const RECORDED_TOOLS = ["get_checkout","create_checkout","update_checkout","complete_checkout","cancel_checkout","get_cart","create_cart","update_cart","cancel_cart","get_order","search_catalog","lookup_catalog","get_product"];

/** search_catalog inputSchema.properties.catalog */
export const SEARCH_CATALOG_INPUT = {
  "type": "object",
  "description": "Catalog search parameters.",
  "properties": {
    "query": {
      "type": "string",
      "description": "Search query string."
    },
    "context": {
      "type": "object",
      "description": "Buyer signals for localization and personalization.",
      "additionalProperties": true,
      "properties": {
        "address_country": {
          "type": "string",
          "description": "Country code in ISO 3166-1 alpha-2 format."
        },
        "address_region": {
          "type": "string",
          "description": "Region or state."
        },
        "postal_code": {
          "type": "string",
          "description": "Postal code."
        },
        "language": {
          "type": "string",
          "description": "Language tag in IETF BCP 47 format."
        },
        "currency": {
          "type": "string",
          "description": "Currency code in ISO 4217 format."
        },
        "intent": {
          "type": "string",
          "description": "Buyer intent."
        }
      }
    },
    "signals": {
      "type": "object",
      "description": "Platform environment data.",
      "additionalProperties": true,
      "properties": {
        "dev.ucp.buyer_ip": {
          "type": "string",
          "description": "Buyer IP address."
        },
        "dev.ucp.user_agent": {
          "type": "string",
          "description": "Buyer user agent."
        }
      }
    },
    "filters": {
      "type": "object",
      "description": "Narrowing criteria for catalog results.",
      "additionalProperties": true,
      "properties": {
        "categories": {
          "type": "array",
          "description": "Category filters combined with OR logic.",
          "items": {
            "type": "string"
          }
        },
        "price": {
          "type": "object",
          "description": "Price range filter.",
          "properties": {
            "min": {
              "type": "integer",
              "description": "Minimum price in minor currency units."
            },
            "max": {
              "type": "integer",
              "description": "Maximum price in minor currency units."
            }
          }
        },
        "available": {
          "type": "boolean",
          "description": "Filter by availability. Default true (only sale-ready items).",
          "default": true
        }
      }
    },
    "pagination": {
      "type": "object",
      "description": "Pagination parameters.",
      "properties": {
        "cursor": {
          "type": "string",
          "description": "Pagination cursor."
        },
        "limit": {
          "type": "integer",
          "description": "Number of results to return.",
          "default": 10,
          "minimum": 1
        }
      }
    }
  }
};

/** result.structuredContent of search_catalog { filters: { price: { min: 0 } }, pagination: { limit: 3 } }, first product only */
export const RECORDED_SEARCH = {
  ucp: { version: "2026-08-25", status: "success" },
  products: [{
  "id": "gid://shopify/Product/7760202465456",
  "title": "Meuble TV en Bois Massif | Acacia Moon",
  "description": {
    "html": "\"Ce meuble bois massif de la ligne Meuble TV en Bois Massif | Acacia Moon apporte une présence calme et confiante à votre salon. Ainsi, le bois d'acacia massif …"
  },
  "url": "https://www.boisetchiffons.fr/products/meuble-tv-en-bois-massif-acacia-moon",
  "handle": "meuble-tv-en-bois-massif-acacia-moon",
  "price_range": {
    "min": {
      "amount": 53958,
      "currency": "EUR"
    },
    "max": {
      "amount": 53958,
      "currency": "EUR"
    }
  },
  "list_price_range": {
    "min": {
      "amount": 107917,
      "currency": "EUR"
    },
    "max": {
      "amount": 107917,
      "currency": "EUR"
    }
  },
  "variants": [
    {
      "id": "gid://shopify/ProductVariant/44096216924336",
      "sku": "BC001055",
      "title": "Default Title",
      "description": {
        "html": "\"Ce meuble bois massif de la ligne Meuble TV en Bois Massif …"
      },
      "price": {
        "amount": 53958,
        "currency": "EUR"
      },
      "list_price": {
        "amount": 107917,
        "currency": "EUR"
      },
      "availability": {
        "available": true
      },
      "options": [
        {
          "name": "Title",
          "label": "Default Title"
        }
      ],
      "media": [
        {
          "type": "image",
          "url": "https://cdn.shopify.com/s/files/1/0655/2970/8720/files/01-cover_0ff9bcfc-adb9-4b86-84dc-174e35e4a9f5.png?v=1795087585"
        }
      ],
      "requires": {
        "shipping": true
      },
      "checkout_url": "https://687541-22.myshopify.com/cart/44096216924336:1"
    }
  ],
  "options": [
    {
      "name": "Title",
      "values": [
        {
          "label": "Default Title"
        }
      ]
    }
  ],
  "media": [
    {
      "type": "image",
      "url": "https://cdn.shopify.com/s/files/1/0655/2970/8720/files/01-cover_0ff9bcfc-adb9-4b86-84dc-174e35e4a9f5.png?v=1795087585"
    }
  ],
  "categories": [
    {
      "value": "gid://shopify/TaxonomyCategory/fr-9",
      "taxonomy": "shopify"
    }
  ],
  "tags": [
    "Accueil",
    "All catalogue",
    "BAZAR CHIC"
  ],
  "gift_card": false,
  "collections": [
    {
      "id": "gid://shopify/Collection/313443877040",
      "handle": "meuble-bois-acacia",
      "title": "Meuble Bois Acacia"
    }
  ]
}],
  pagination: {"has_next_page":true,"cursor":"eyJncmFwaHFsX2N1cnNvciI6ImV5SndZV2RsSWpveUxDSnNZWE4wWDJsa0lqbzNOell3TWpBek9EYzBORGd3TENKeVpYWmxjbk5sSWpwMGNuVmxMQ0p2Wm1aelpYUWlPako5IiwicGFnZSI6Mn0="},
  messages: [{"type":"info","content":"Price filter applied using shop currency (EUR). Pass context.currency to specify the intended denomination."}],
};

/** The answer (HTTP 422) when the profile URL can't be fetched, and when it isn't https (e.g. localhost). */
export const RECORDED_PROFILE_UNREACHABLE = { jsonrpc: "2.0", id: 4, error: { code: -32001, message: "UCP discovery failed", data: { code: "profile_unreachable", content: "Unable to fetch agent profile: Http error", continue_url: "https://687541-22.myshopify.com/" } } };
export const RECORDED_PROFILE_NOT_HTTPS = { jsonrpc: "2.0", id: 4, error: { code: -32001, message: "UCP discovery failed", data: { code: "invalid_profile_url", content: "Unable to fetch agent profile: Https required", continue_url: "https://687541-22.myshopify.com/" } } };
