import { randomUUID } from "node:crypto";
import type { IntegrationConnection } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { grantedScopes, SHOPIFY_ORDER_SCOPES, SHOPIFY_REFUSED } from "@/server/catalog/shopify";
import { accessToken, markReconnect } from "@/server/services/connections";
import { ReconnectNeeded } from "@/server/services/reconnect-needed";
import { fetchOrders, type ShopOrderRow } from "./shopify-orders";
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
 */
export async function upsertOrders(scope: { workspaceId: string; brandId: string; connectionId: string }, rows: ShopOrderRow[]) {
  if (!rows.length) return 0;
  const page = JSON.stringify(rows.map((r) => ({
    id: randomUUID(), shopify_id: r.shopifyId, name: r.name, processed_at: r.processedAt.toISOString(), cancelled_at: r.cancelledAt?.toISOString() ?? null,
    test: r.test, currency: r.currency, net_sales: String(r.netSales), discounts: String(r.discounts), shipping: String(r.shipping),
    taxes: String(r.taxes), taxes_included: r.taxesIncluded, total: String(r.total), refunded: String(r.refunded),
    source_name: r.sourceName, shopify_updated_at: r.shopifyUpdatedAt.toISOString(),
  })));
  return prisma.$executeRaw`
    INSERT INTO "ShopOrder" ("id", "workspaceId", "brandId", "connectionId", "shopifyId", "name", "processedAt", "cancelledAt", "test",
      "currency", "netSales", "discounts", "shipping", "taxes", "taxesIncluded", "total", "refunded", "sourceName", "shopifyUpdatedAt", "updatedAt")
    SELECT u.id, ${scope.workspaceId}, ${scope.brandId}, ${scope.connectionId}, u.shopify_id, u.name,
      u.processed_at AT TIME ZONE 'UTC', u.cancelled_at AT TIME ZONE 'UTC', u.test, u.currency, u.net_sales, u.discounts,
      u.shipping, u.taxes, u.taxes_included, u.total, u.refunded, u.source_name, u.shopify_updated_at AT TIME ZONE 'UTC', now()
    FROM jsonb_to_recordset(${page}::jsonb) AS u(id text, shopify_id text, name text, processed_at timestamptz, cancelled_at timestamptz,
      test boolean, currency text, net_sales numeric, discounts numeric, shipping numeric, taxes numeric, taxes_included boolean,
      total numeric, refunded numeric, source_name text, shopify_updated_at timestamptz)
    ON CONFLICT ("brandId", "shopifyId") DO UPDATE SET
      "connectionId" = EXCLUDED."connectionId", "name" = EXCLUDED."name", "processedAt" = EXCLUDED."processedAt",
      "cancelledAt" = EXCLUDED."cancelledAt", "test" = EXCLUDED."test", "currency" = EXCLUDED."currency",
      "netSales" = EXCLUDED."netSales", "discounts" = EXCLUDED."discounts", "shipping" = EXCLUDED."shipping",
      "taxes" = EXCLUDED."taxes", "taxesIncluded" = EXCLUDED."taxesIncluded", "total" = EXCLUDED."total",
      "refunded" = EXCLUDED."refunded", "sourceName" = EXCLUDED."sourceName", "shopifyUpdatedAt" = EXCLUDED."shopifyUpdatedAt",
      "updatedAt" = now()
    WHERE "ShopOrder"."shopifyUpdatedAt" <= EXCLUDED."shopifyUpdatedAt"`;
}

export async function syncShopifyOrders(
  ctx: { source: { workspaceId: string; brandId: string; cursor: string | null }; connection: IntegrationConnection | null; signal: AbortSignal },
  now = new Date(),
): Promise<SyncOutcome> {
  const conn = ctx.connection;
  if (!conn) return { count: 0, reason: stopReason("reconnect") };
  const since = ctx.source.cursor ? new Date(ctx.source.cursor) : new Date(now.getTime() - FIRST_RUN_DAYS * 86_400_000);
  const read = await fetchOrders({ shop: conn.externalAccountId, accessToken: await accessToken(conn) }, since, ctx.signal);
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
  | { ok: false; problem: "not-connected" | "missing-scope" | "refused" | "unreachable" };

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

  const source = await prisma.dataSource.upsert({
    where: { brandId_kind_externalId: { brandId: scope.brandId, kind: "SHOPIFY_ORDERS", externalId: shop } },
    create: { workspaceId: scope.workspaceId, brandId: scope.brandId, kind: "SHOPIFY_ORDERS", externalId: shop, connectionId: conn.id, label: shop },
    update: { connectionId: conn.id, label: shop, status: "ACTIVE" },
  });
  await enqueueSourceSync(source, "manual", { key: `data:${source.id}:turn-on:${source.updatedAt.getTime()}` });
  return { ok: true, sourceId: source.id };
}
