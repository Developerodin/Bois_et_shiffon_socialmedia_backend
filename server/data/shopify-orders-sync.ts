import { randomUUID } from "node:crypto";
import { Prisma, type IntegrationConnection } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { grantedScopes, SHOPIFY_ORDER_SCOPES, SHOPIFY_REFUSED } from "@/server/catalog/shopify";
import { accessToken, markReconnect } from "@/server/services/connections";
import { ReconnectNeeded } from "@/server/services/reconnect-needed";
import { AskCartError, askCartReason, askCartShop, isAskCart } from "@/server/shopify/askcart";
import { isShopifyMcp } from "@/server/shopify/catalog-mcp";
import { askCartToken } from "@/server/shopify/askcart-token";
import { ASKCART_LINES_PER_ORDER, fetchAskCartOrders, fetchOrders, type ShopOrderLineRow, type ShopOrderRow } from "./shopify-orders";
import { enqueueSourceSync, registerSync, stopReason, type SyncOutcome } from "./sources";

/**
 * SHOPIFY_ORDERS runner: reads every order updated since `DataSource.cursor` (Shopify's updated_at high-water mark;
 * none yet = the last 60 days, all `read_orders` reaches) and upserts one ShopOrder row per order. Upserts are safe
 * to repeat, so a run that stopped short (capped, rate limited) still writes what it read and moves the cursor; the
 * next run carries on from there. A missing read_orders is a "permission" stop and never marks the connection.
 * AskCart only: a run that read to the end holds the cursor at an order AskCart sent with incomplete lines
 * (refetchFrom), so the next run reads it again, for at most REFETCH_HOURS.
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
 * value (merged from the stored row in the SELECT, since ON CONFLICT can't see what was sent); a status sent as null
 * clears it (the `*_sent` flags tell null from absent). Accepted gap: that merge reads the stored row when the
 * statement starts, so two runs of one source writing the same order at once (a manual run during the daily one), one
 * sending a status and one not (only while AskCart is mid-deploy), could keep the older status until the next read.
 *
 * When an order of the page came with line items, the page runs as one transaction: the upsert returns the orders it
 * actually wrote (inserted, or not older than stored) and only those orders' lines change, so a stale read never
 * touches newer lines and an order read without line items keeps its lines. Lines that disappeared are deleted, but
 * only for an order sent whole: one AskCart flagged incomplete (lineItemsTruncated) or with lines we couldn't read
 * keeps its other stored lines. The rest are upserted (a line id seen twice in the page keeps its last), and a line
 * that didn't change isn't rewritten. The order row's lock serialises two runs writing the same order's lines.
 */
export async function upsertOrders(scope: { workspaceId: string; brandId: string; connectionId: string }, rows: ShopOrderRow[]) {
  if (!rows.length) return 0;
  const page = JSON.stringify(rows.map((r) => ({
    id: randomUUID(), shopify_id: r.shopifyId, name: r.name, processed_at: r.processedAt.toISOString(), cancelled_at: r.cancelledAt?.toISOString() ?? null,
    test: r.test, currency: r.currency, net_sales: String(r.netSales), discounts: String(r.discounts), shipping: String(r.shipping),
    taxes: String(r.taxes), taxes_included: r.taxesIncluded, total: String(r.total), refunded: String(r.refunded),
    source_name: r.sourceName, shopify_updated_at: r.shopifyUpdatedAt.toISOString(),
    // undefined → left out of the JSON → NULL → the stored value is kept (a status says whether it was sent at all)
    fulfillment_status: r.fulfillmentStatus, fulfillment_sent: r.fulfillmentStatus !== undefined,
    financial_status: r.financialStatus, financial_sent: r.financialStatus !== undefined, discount_codes: r.discountCodes,
    line_items_truncated: r.lines ? (r.lineItemsTruncated ?? false) : undefined,
  })));
  // `WHERE true` ends the SELECT before ON CONFLICT, so the join's ON and the upsert's ON CONFLICT can't be misread.
  const upsert = Prisma.sql`
    INSERT INTO "ShopOrder" ("id", "workspaceId", "brandId", "connectionId", "shopifyId", "name", "processedAt", "cancelledAt", "test",
      "currency", "netSales", "discounts", "shipping", "taxes", "taxesIncluded", "total", "refunded", "sourceName", "shopifyUpdatedAt",
      "fulfillmentStatus", "financialStatus", "discountCodes", "lineItemsTruncated", "updatedAt")
    SELECT u.id, ${scope.workspaceId}, ${scope.brandId}, ${scope.connectionId}, u.shopify_id, u.name,
      u.processed_at AT TIME ZONE 'UTC', u.cancelled_at AT TIME ZONE 'UTC', u.test, u.currency, u.net_sales, u.discounts,
      u.shipping, u.taxes, u.taxes_included, u.total, u.refunded, u.source_name, u.shopify_updated_at AT TIME ZONE 'UTC',
      CASE WHEN u.fulfillment_sent THEN u.fulfillment_status ELSE s."fulfillmentStatus" END,
      CASE WHEN u.financial_sent THEN u.financial_status ELSE s."financialStatus" END,
      COALESCE(u.discount_codes, s."discountCodes", ARRAY[]::text[]), COALESCE(u.line_items_truncated, s."lineItemsTruncated", false), now()
    FROM jsonb_to_recordset(${page}::jsonb) AS u(id text, shopify_id text, name text, processed_at timestamptz, cancelled_at timestamptz,
      test boolean, currency text, net_sales numeric, discounts numeric, shipping numeric, taxes numeric, taxes_included boolean,
      total numeric, refunded numeric, source_name text, shopify_updated_at timestamptz, fulfillment_status text, fulfillment_sent boolean,
      financial_status text, financial_sent boolean, discount_codes text[], line_items_truncated boolean)
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

  // A page is 100 orders × up to 100 lines: lines are written LINE_CHUNK at a time. The transaction may take up to
  // 60 s (Prisma's default is 5 s) and waits up to 10 s for a connection.
  return prisma.$transaction(
    async (tx) => {
      const won = new Set((await tx.$queryRaw<{ shopifyId: string }[]>`${upsert} RETURNING "shopifyId"`).map((r) => r.shopifyId));
      const replace = withLines.filter((r) => won.has(r.shopifyId));
      if (!replace.length) return won.size;
      // One row per line id across the page (the last wins): a repeat would fail the whole upsert.
      const lines = [...new Map(replace.flatMap((r) => r.lines!.map((l) => [l.lineShopifyId, { ...l, orderShopifyId: r.shopifyId }] as const))).values()];
      const whole = replace.filter((r) => r.lineItemsTruncated !== true && !r.linesSkipped).map((r) => r.shopifyId);
      // Line ids are unique across a store, so "not among the lines just sent" is "disappeared from its order".
      // NOT IN over a subquery is a hashed lookup; `<> ALL(array)` would compare every pair.
      if (whole.length) {
        await tx.$executeRaw`
          DELETE FROM "ShopOrderLine" WHERE "brandId" = ${scope.brandId} AND "orderShopifyId" = ANY(${whole}::text[])
            AND "lineShopifyId" NOT IN (SELECT unnest(${lines.map((l) => l.lineShopifyId)}::text[]))`;
      }
      for (let i = 0; i < lines.length; i += LINE_CHUNK) await upsertLines(tx, scope, lines.slice(i, i + LINE_CHUNK));
      return won.size;
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}

const LINE_CHUNK = 2000;

/**
 * Upserts lines on (brandId, lineShopifyId); a line whose values didn't change isn't rewritten. ON CONFLICT also covers
 * a line id that moved to another order (Shopify doesn't; without it the whole page would fail).
 */
function upsertLines(tx: Prisma.TransactionClient, scope: { workspaceId: string; brandId: string }, lines: (ShopOrderLineRow & { orderShopifyId: string })[]) {
  const json = JSON.stringify(lines.map((l) => ({
    id: randomUUID(), order_id: l.orderShopifyId, line_id: l.lineShopifyId, product_id: l.productId, variant_id: l.variantId, title: l.title,
    variant_title: l.variantTitle, sku: l.sku, quantity: l.quantity, current_quantity: l.currentQuantity, unit_price: l.unitPrice,
    discounted_total: l.discountedTotal, net_unit_price: l.netUnitPrice, currency: l.currency,
  })));
  return tx.$executeRaw`
    INSERT INTO "ShopOrderLine" ("id", "workspaceId", "brandId", "orderShopifyId", "lineShopifyId", "productId", "variantId", "title",
      "variantTitle", "sku", "quantity", "currentQuantity", "unitPrice", "discountedTotal", "netUnitPrice", "currency")
    SELECT l.id, ${scope.workspaceId}, ${scope.brandId}, l.order_id, l.line_id, l.product_id, l.variant_id, l.title, l.variant_title,
      l.sku, l.quantity, l.current_quantity, l.unit_price, l.discounted_total, l.net_unit_price, l.currency
    FROM jsonb_to_recordset(${json}::jsonb) AS l(id text, order_id text, line_id text, product_id text, variant_id text, title text,
      variant_title text, sku text, quantity int, current_quantity int, unit_price numeric, discounted_total numeric,
      net_unit_price numeric, currency text)
    ON CONFLICT ("brandId", "lineShopifyId") DO UPDATE SET
      "orderShopifyId" = EXCLUDED."orderShopifyId", "productId" = EXCLUDED."productId", "variantId" = EXCLUDED."variantId",
      "title" = EXCLUDED."title", "variantTitle" = EXCLUDED."variantTitle", "sku" = EXCLUDED."sku", "quantity" = EXCLUDED."quantity",
      "currentQuantity" = EXCLUDED."currentQuantity", "unitPrice" = EXCLUDED."unitPrice",
      "discountedTotal" = EXCLUDED."discountedTotal", "netUnitPrice" = EXCLUDED."netUnitPrice", "currency" = EXCLUDED."currency"
    WHERE ("ShopOrderLine"."orderShopifyId", "ShopOrderLine"."productId", "ShopOrderLine"."variantId", "ShopOrderLine"."title",
           "ShopOrderLine"."variantTitle", "ShopOrderLine"."sku", "ShopOrderLine"."quantity", "ShopOrderLine"."currentQuantity",
           "ShopOrderLine"."unitPrice", "ShopOrderLine"."discountedTotal", "ShopOrderLine"."netUnitPrice", "ShopOrderLine"."currency")
      IS DISTINCT FROM (EXCLUDED."orderShopifyId", EXCLUDED."productId", EXCLUDED."variantId", EXCLUDED."title", EXCLUDED."variantTitle",
           EXCLUDED."sku", EXCLUDED."quantity", EXCLUDED."currentQuantity", EXCLUDED."unitPrice", EXCLUDED."discountedTotal",
           EXCLUDED."netUnitPrice", EXCLUDED."currency")`;
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
  // saved cursor where it was and the next run re-reads (upserts are idempotent). The job's deadline passing between
  // pages stops the run as capped, with the cursor at the last page written.
  let written = 0;
  let cursorEnd = read.cursorEnd;
  let reason = stopReason(stop);
  for (; written < read.orders.length; written += PAGE) {
    if (written > 0 && ctx.signal.aborted) {
      cursorEnd = read.orders.slice(0, written).reduce((max, o) => (o.shopifyUpdatedAt > max ? o.shopifyUpdatedAt : max), since);
      reason = stopReason("capped");
      break;
    }
    await upsertOrders(scope, read.orders.slice(written, written + PAGE));
  }
  // An order AskCart sent with incomplete lines is read again: the cursor stays at it (the next run re-reads from an
  // hour before it). Only a run that read to the end holds it; one that stopped short (capped, rate limited, deadline)
  // saves how far it got, or a busy store's cursor could stay pinned for REFETCH_HOURS. So the cursor can step back
  // after a stopped run: the next run that reads to the end returns it to the held order. Ceiling: a store whose
  // orders since the held one take more than one run alternates stopped and full runs until the order completes or
  // ages past REFETCH_HOURS; every run still moves new orders in.
  const held = isAskCart(conn) && !reason ? await refetchFrom(scope, now) : null;
  const cursor = held && held < cursorEnd ? held : cursorEnd;
  return { count: Math.min(written, read.orders.length), reason, cursor: cursor.toISOString() };
}

/**
 * How long an order with incomplete lines holds the cursor back, counted from the order's shopifyUpdatedAt: one that
 * never completes can't pin it for good.
 */
export const REFETCH_HOURS = 24;

/**
 * The earliest update time of this connection's orders whose stored lines are incomplete (AskCart's
 * lineItemsTruncated: it paused mid-order to protect the store's API budget) and worth reading again: updated in the
 * last REFETCH_HOURS, with fewer than ASKCART_LINES_PER_ORDER lines stored (that many means the order really has more
 * than AskCart sends, which no re-read fixes). Null when there are none.
 * ponytail: no index serves this (the (brandId, processedAt) one doesn't help with shopifyUpdatedAt), so it reads the
 * brand's order rows. Past ~100k orders a brand, add a partial index on ("brandId", "shopifyUpdatedAt") WHERE
 * "lineItemsTruncated" in raw SQL in a migration (Prisma can't express a partial index, so mark it in the schema
 * comment to keep `migrate diff` from flagging drift).
 */
async function refetchFrom(scope: { workspaceId: string; brandId: string; connectionId: string }, now: Date): Promise<Date | null> {
  const since = new Date(now.getTime() - REFETCH_HOURS * 3_600_000).toISOString();
  const [row] = await prisma.$queryRaw<{ at: string | null }[]>`
    SELECT to_char(min(o."shopifyUpdatedAt"), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
    FROM "ShopOrder" o
    WHERE o."workspaceId" = ${scope.workspaceId} AND o."brandId" = ${scope.brandId} AND o."connectionId" = ${scope.connectionId}
      AND o."lineItemsTruncated" AND o."shopifyUpdatedAt" >= (${since}::timestamptz AT TIME ZONE 'UTC')
      AND (SELECT count(*) FROM "ShopOrderLine" l WHERE l."brandId" = o."brandId" AND l."orderShopifyId" = o."shopifyId") < ${ASKCART_LINES_PER_ORDER}`;
  return row?.at ? new Date(row.at) : null;
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
