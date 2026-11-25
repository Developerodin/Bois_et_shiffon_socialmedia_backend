import { randomUUID } from "node:crypto";
import { Prisma, type IntegrationConnection } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { grantedScopes, SHOPIFY_ORDER_SCOPES, SHOPIFY_REFUSED } from "@/server/catalog/shopify";
import { accessToken, markReconnect } from "@/server/services/connections";
import { ReconnectNeeded } from "@/server/services/reconnect-needed";
import { AskCartError, askCartReason, askCartShop, isAskCart } from "@/server/shopify/askcart";
import { isShopifyMcp } from "@/server/shopify/catalog-mcp";
import { askCartToken } from "@/server/shopify/askcart-token";
import { fetchAskCartOrders, fetchOrders, type ShopOrderRow } from "./shopify-orders";
import { enqueueSourceSync, registerSync, stopReason, type SyncOutcome } from "./sources";

/**
 * SHOPIFY_ORDERS runner: reads every order updated since `DataSource.cursor` (Shopify's updated_at high-water mark;
 * none yet = the last 60 days, all `read_orders` reaches) and upserts one ShopOrder row per order. Upserts are safe
 * to repeat, so a run that stopped short (capped, rate limited) still writes what it read and moves the cursor; the
 * next run carries on from there. A missing read_orders is a "permission" stop and never marks the connection.
 */

export const FIRST_RUN_DAYS = 60;
const PAGE = 100;

/**
 * One `INSERT … ON CONFLICT (brandId, shopifyId) DO UPDATE` for up to a page of orders, the page sent as one JSON
 * parameter and unpacked by `jsonb_to_recordset` (typed columns: Prisma can't type an array param holding nulls, so
 * `unnest` of per-column arrays fails on cancelledAt/sourceName). Amounts go as exact decimal strings (string or
 * Prisma.Decimal in); timestamps as UTC instants, stored as the UTC wall time (Prisma's `timestamp(3)` convention).
 * An older read never overwrites a newer one (two overlapping runs), so a row always holds its latest update.
 *
 * AskCart's optional fields: a status, the discount codes or the truncated flag left out of a read keeps the stored
 * value (merged from the stored row in the SELECT, since ON CONFLICT can't see what was sent). Caveat: a status that
 * really went back to null keeps its old value. When an order of the page came with line items, the page runs as one
 * transaction: the upsert returns the orders it actually wrote (inserted, or not older than stored) and only those
 * orders' lines are replaced (delete, then insert), so a stale read never replaces newer lines and an order read
 * without line items keeps its lines. The order row's lock serialises two runs replacing the same order's lines.
 */
export async function upsertOrders(scope: { workspaceId: string; brandId: string; connectionId: string }, rows: ShopOrderRow[]) {
  if (!rows.length) return 0;
  const page = JSON.stringify(rows.map((r) => ({
    id: randomUUID(), shopify_id: r.shopifyId, name: r.name, processed_at: r.processedAt.toISOString(), cancelled_at: r.cancelledAt?.toISOString() ?? null,
    test: r.test, currency: r.currency, net_sales: String(r.netSales), discounts: String(r.discounts), shipping: String(r.shipping),
    taxes: String(r.taxes), taxes_included: r.taxesIncluded, total: String(r.total), refunded: String(r.refunded),
    source_name: r.sourceName, shopify_updated_at: r.shopifyUpdatedAt.toISOString(),
    // undefined → left out of the JSON → NULL → the stored value is kept
    fulfillment_status: r.fulfillmentStatus, financial_status: r.financialStatus, discount_codes: r.discountCodes,
    line_items_truncated: r.lines ? (r.lineItemsTruncated ?? false) : undefined,
  })));
  const upsert = Prisma.sql`
    INSERT INTO "ShopOrder" ("id", "workspaceId", "brandId", "connectionId", "shopifyId", "name", "processedAt", "cancelledAt", "test",
      "currency", "netSales", "discounts", "shipping", "taxes", "taxesIncluded", "total", "refunded", "sourceName", "shopifyUpdatedAt",
      "fulfillmentStatus", "financialStatus", "discountCodes", "lineItemsTruncated", "updatedAt")
    SELECT u.id, ${scope.workspaceId}, ${scope.brandId}, ${scope.connectionId}, u.shopify_id, u.name,
      u.processed_at AT TIME ZONE 'UTC', u.cancelled_at AT TIME ZONE 'UTC', u.test, u.currency, u.net_sales, u.discounts,
      u.shipping, u.taxes, u.taxes_included, u.total, u.refunded, u.source_name, u.shopify_updated_at AT TIME ZONE 'UTC',
      COALESCE(u.fulfillment_status, s."fulfillmentStatus"), COALESCE(u.financial_status, s."financialStatus"),
      COALESCE(u.discount_codes, s."discountCodes", ARRAY[]::text[]), COALESCE(u.line_items_truncated, s."lineItemsTruncated", false), now()
    FROM jsonb_to_recordset(${page}::jsonb) AS u(id text, shopify_id text, name text, processed_at timestamptz, cancelled_at timestamptz,
      test boolean, currency text, net_sales numeric, discounts numeric, shipping numeric, taxes numeric, taxes_included boolean,
      total numeric, refunded numeric, source_name text, shopify_updated_at timestamptz, fulfillment_status text,
      financial_status text, discount_codes text[], line_items_truncated boolean)
    LEFT JOIN "ShopOrder" s ON s."brandId" = ${scope.brandId} AND s."shopifyId" = u.shopify_id
    WHERE true
    ON CONFLICT ("brandId", "shopifyId") DO UPDATE SET
      "connectionId" = EXCLUDED."connectionId", "name" = EXCLUDED."name", "processedAt" = EXCLUDED."processedAt",
      "cancelledAt" = EXCLUDED."cancelledAt", "test" = EXCLUDED."test", "currency" = EXCLUDED."currency",
      "netSales" = EXCLUDED."netSales", "discounts" = EXCLUDED."discounts", "shipping" = EXCLUDED."shipping",
      "taxes" = EXCLUDED."taxes", "taxesIncluded" = EXCLUDED."taxesIncluded", "total" = EXCLUDED."total",
      "refunded" = EXCLUDED."refunded", "sourceName" = EXCLUDED."sourceName", "shopifyUpdatedAt" = EXCLUDED."shopifyUpdatedAt",
      "fulfillmentStatus" = EXCLUDED."fulfillmentStatus", "financialStatus" = EXCLUDED."financialStatus",
      "discountCodes" = EXCLUDED."discountCodes", "lineItemsTruncated" = EXCLUDED."lineItemsTruncated",
      "updatedAt" = now()
    WHERE "ShopOrder"."shopifyUpdatedAt" <= EXCLUDED."shopifyUpdatedAt"`;
  const withLines = rows.filter((r) => r.lines);
  // No line items on this page (the pasted-token path, or an AskCart that doesn't send them): one statement, as before.
  if (!withLines.length) return prisma.$executeRaw(upsert);

  const lines = JSON.stringify(withLines.flatMap((r) => r.lines!.map((l) => ({
    id: randomUUID(), order_id: r.shopifyId, line_id: l.lineShopifyId, product_id: l.productId, variant_id: l.variantId, title: l.title,
    variant_title: l.variantTitle, sku: l.sku, quantity: l.quantity, current_quantity: l.currentQuantity, unit_price: l.unitPrice,
    discounted_total: l.discountedTotal, currency: l.currency,
  }))));
  const sent = new Set(withLines.map((r) => r.shopifyId));
  return prisma.$transaction(async (tx) => {
    const won = (await tx.$queryRaw<{ shopifyId: string }[]>`${upsert} RETURNING "shopifyId"`).map((r) => r.shopifyId);
    const replace = won.filter((id) => sent.has(id));
    if (replace.length) {
      await tx.$executeRaw`DELETE FROM "ShopOrderLine" WHERE "brandId" = ${scope.brandId} AND "orderShopifyId" = ANY(${replace}::text[])`;
      // ON CONFLICT covers a line id that moved to another order (Shopify doesn't; without it the whole page would fail).
      await tx.$executeRaw`
        INSERT INTO "ShopOrderLine" ("id", "workspaceId", "brandId", "orderShopifyId", "lineShopifyId", "productId", "variantId", "title",
          "variantTitle", "sku", "quantity", "currentQuantity", "unitPrice", "discountedTotal", "currency")
        SELECT l.id, ${scope.workspaceId}, ${scope.brandId}, l.order_id, l.line_id, l.product_id, l.variant_id, l.title, l.variant_title,
          l.sku, l.quantity, l.current_quantity, l.unit_price, l.discounted_total, l.currency
        FROM jsonb_to_recordset(${lines}::jsonb) AS l(id text, order_id text, line_id text, product_id text, variant_id text, title text,
          variant_title text, sku text, quantity int, current_quantity int, unit_price numeric, discounted_total numeric, currency text)
        WHERE l.order_id = ANY(${replace}::text[])
        ON CONFLICT ("brandId", "lineShopifyId") DO UPDATE SET
          "orderShopifyId" = EXCLUDED."orderShopifyId", "productId" = EXCLUDED."productId", "variantId" = EXCLUDED."variantId",
          "title" = EXCLUDED."title", "variantTitle" = EXCLUDED."variantTitle", "sku" = EXCLUDED."sku", "quantity" = EXCLUDED."quantity",
          "currentQuantity" = EXCLUDED."currentQuantity", "unitPrice" = EXCLUDED."unitPrice",
          "discountedTotal" = EXCLUDED."discountedTotal", "currency" = EXCLUDED."currency"`;
    }
    return won.length;
  });
}

export async function syncShopifyOrders(
  ctx: { source: { workspaceId: string; brandId: string; cursor: string | null }; connection: IntegrationConnection | null; signal: AbortSignal },
  now = new Date(),
): Promise<SyncOutcome> {
  const conn = ctx.connection;
  if (!conn) return { count: 0, reason: stopReason("reconnect") };
  // The Catalog MCP has no orders (turnOnShopifyOrders refuses it); a source left on a store reconnected that way stops.
  if (isShopifyMcp(conn)) return { count: 0, reason: stopReason("missing_scope") };
  const since = ctx.source.cursor ? new Date(ctx.source.cursor) : new Date(now.getTime() - FIRST_RUN_DAYS * 86_400_000);
  const read = isAskCart(conn)
    ? await (async () => fetchAskCartOrders(await askCartToken(conn), since, ctx.signal))().catch(async (e: unknown) => {
        // AskCart refused our access, lost the store, or the connection is from the other mode: the connection's
        // fault, like a refused token.
        if (e instanceof ReconnectNeeded) await markReconnect(conn.id, askCartReason(e));
        throw e;
      })
    : await fetchOrders({ shop: conn.externalAccountId, accessToken: await accessToken(conn) }, since, ctx.signal);
  const stop = read.stoppedReason;
  // A refused token is the connection's fault (products stop too); a missing scope or permission is not.
  if (stop === "reconnect") await markReconnect(conn.id, SHOPIFY_REFUSED);
  if (stop === "reconnect" || stop === "failed" || stop === "permission" || stop === "missing_scope") {
    return { count: 0, reason: stopReason(stop) };
  }
  const scope = { workspaceId: ctx.source.workspaceId, brandId: ctx.source.brandId, connectionId: conn.id };
  // One statement per page of rows; the client returns them oldest update first, so a write that throws leaves the
  // saved cursor where it was and the next run re-reads (upserts are idempotent).
  for (let i = 0; i < read.orders.length; i += PAGE) await upsertOrders(scope, read.orders.slice(i, i + PAGE));
  return { count: read.orders.length, reason: stopReason(stop), cursor: read.cursorEnd.toISOString() };
}

registerSync("SHOPIFY_ORDERS", (ctx) => syncShopifyOrders(ctx));

export type TurnOn =
  | { ok: true; sourceId: string }
  /** askCart: the connection reads through AskCart, so the problem is worded without tokens. */
  | { ok: false; problem: "not-connected" | "missing-scope" | "refused" | "unreachable" | "needs-askcart"; askCart?: true };

/**
 * Turn the orders sync on for one of the brand's Shopify connections: its stored token only (a token never comes in a
 * request),
 * its scopes asked of Shopify now (the stored list may be what we requested, not what was granted) and saved back.
 * Without read_orders nothing is created. Upserts the source (switching an OFF one back on) and queues its first run,
 * which reads the last 60 days. Re-running it queues another run; the upserts make that harmless.
 */
export async function turnOnShopifyOrders(scope: { workspaceId: string; brandId: string }, connectionId: string): Promise<TurnOn> {
  // Loaded with the route's brand and workspace: another brand's connection id finds nothing (404).
  const conn = await prisma.integrationConnection.findFirst({
    where: { id: connectionId, workspaceId: scope.workspaceId, brandId: scope.brandId, provider: "SHOPIFY", status: "ACTIVE" },
  });
  if (!conn) return { ok: false, problem: "not-connected" };
  const shop = conn.externalAccountId;
  // Shopify MCP reads the catalogue only: orders need AskCart (or a token).
  if (isShopifyMcp(conn)) return { ok: false, problem: "needs-askcart" };
  if (isAskCart(conn)) {
    // AskCart holds the scopes; asking for the shop proves it answers. access_denied on orders shows on the first run.
    try {
      await askCartShop(await askCartToken(conn));
    } catch (e) {
      console.warn("[askcart] orders turn-on check failed", scope.brandId, e instanceof Error ? e.message : e);
      if (e instanceof ReconnectNeeded) {
        await markReconnect(conn.id, askCartReason(e));
        return { ok: false, problem: "refused", askCart: true };
      }
      return { ok: false, problem: e instanceof AskCartError && e.code === "access_denied" ? "missing-scope" : "unreachable", askCart: true };
    }
    return { ok: true, sourceId: await startOrders(scope, conn, shop, conn.displayName) };
  }
  let scopes: string[];
  try {
    ({ scopes } = await grantedScopes(shop, await accessToken(conn)));
  } catch (e) {
    console.warn("[shopify] orders scope check failed", scope.brandId, e instanceof Error ? e.message : e);
    if (!(e instanceof ReconnectNeeded)) return { ok: false, problem: "unreachable" };
    await markReconnect(conn.id, SHOPIFY_REFUSED);
    return { ok: false, problem: "refused" };
  }
  await prisma.integrationConnection.updateMany({ where: { id: conn.id, workspaceId: scope.workspaceId, brandId: scope.brandId }, data: { scopes } });
  if (!SHOPIFY_ORDER_SCOPES.every((s) => scopes.includes(s))) return { ok: false, problem: "missing-scope" };

  return { ok: true, sourceId: await startOrders(scope, conn, shop, shop) };
}

/** Upserts the orders source (switching an OFF one back on) and queues its first run. */
async function startOrders(scope: { workspaceId: string; brandId: string }, conn: IntegrationConnection, shop: string, label: string) {
  const source = await prisma.dataSource.upsert({
    where: { brandId_kind_externalId: { brandId: scope.brandId, kind: "SHOPIFY_ORDERS", externalId: shop } },
    create: { workspaceId: scope.workspaceId, brandId: scope.brandId, kind: "SHOPIFY_ORDERS", externalId: shop, connectionId: conn.id, label },
    update: { connectionId: conn.id, label, status: "ACTIVE" },
  });
  await enqueueSourceSync(source, "manual", { key: `data:${source.id}:turn-on:${source.updatedAt.getTime()}` });
  return source.id;
}
