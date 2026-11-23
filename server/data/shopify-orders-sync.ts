import { randomUUID } from "node:crypto";
import type { IntegrationConnection } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { SHOPIFY_REFUSED } from "@/server/catalog/shopify";
import { accessToken, markReconnect } from "@/server/services/connections";
import { fetchOrders, type ShopOrderRow, type StoppedReason } from "./shopify-orders";
import { registerSync, stopReason, type SyncOutcome, type SyncStop } from "./sources";

/**
 * SHOPIFY_ORDERS runner: reads every order updated since `DataSource.cursor` (Shopify's updated_at high-water mark;
 * none yet = the last 60 days, all `read_orders` reaches) and upserts one ShopOrder row per order. Upserts are safe
 * to repeat, so a run that stopped short (capped, rate limited) still writes what it read and moves the cursor; the
 * next run carries on from there. A missing read_orders is a "permission" stop and never marks the connection.
 */

export const FIRST_RUN_DAYS = 60;
const PAGE = 100;

// Adapter over the client's stop names. Once shopify-orders.ts returns `stoppedReason: SyncStop`, this map goes and
// `readOrders` passes `r.stoppedReason` through.
const STOP: Record<StoppedReason, SyncStop> = { throttled: "rate_limited", reconnect: "reconnect", page_cap: "capped", time_cap: "capped" };
async function readOrders(conn: { shop: string; accessToken: string }, since: Date, signal: AbortSignal) {
  const r = await fetchOrders(conn, since, signal);
  return { orders: r.orders, cursorEnd: r.cursorEnd, stop: r.stoppedReason && STOP[r.stoppedReason] };
}

/** Amounts arrive as decimal strings or Prisma.Decimal; both print as the exact decimal. */
const dec = (v: unknown) => String(v);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * One `INSERT … ON CONFLICT (brandId, shopifyId) DO UPDATE` for up to a page of orders. Timestamps go in as UTC
 * instants and are stored as the UTC wall time (Prisma's convention for `timestamp(3)`). An older read never
 * overwrites a newer one (two overlapping runs), so the row always holds the latest `shopifyUpdatedAt`.
 */
export async function upsertOrders(scope: { workspaceId: string; brandId: string; connectionId: string }, rows: ShopOrderRow[]) {
  if (!rows.length) return 0;
  const col = <T>(f: (r: ShopOrderRow) => T) => rows.map(f);
  return prisma.$executeRaw`
    INSERT INTO "ShopOrder" ("id", "workspaceId", "brandId", "connectionId", "shopifyId", "name", "processedAt", "cancelledAt", "test",
      "currency", "netSales", "discounts", "shipping", "taxes", "taxesIncluded", "total", "refunded", "sourceName", "shopifyUpdatedAt", "updatedAt")
    SELECT u.id, ${scope.workspaceId}, ${scope.brandId}, ${scope.connectionId}, u.shopify_id, u.name,
      u.processed_at AT TIME ZONE 'UTC', u.cancelled_at AT TIME ZONE 'UTC', u.test, u.currency, u.net_sales, u.discounts,
      u.shipping, u.taxes, u.taxes_included, u.total, u.refunded, u.source_name, u.shopify_updated_at AT TIME ZONE 'UTC', now()
    FROM unnest(
      ${col(() => randomUUID())}::text[], ${col((r) => r.shopifyId)}::text[], ${col((r) => r.name)}::text[],
      ${col((r) => iso(r.processedAt))}::timestamptz[], ${col((r) => iso(r.cancelledAt))}::timestamptz[], ${col((r) => r.test)}::boolean[],
      ${col((r) => r.currency)}::text[], ${col((r) => dec(r.netSales))}::numeric[], ${col((r) => dec(r.discounts))}::numeric[],
      ${col((r) => dec(r.shipping))}::numeric[], ${col((r) => dec(r.taxes))}::numeric[], ${col((r) => r.taxesIncluded)}::boolean[],
      ${col((r) => dec(r.total))}::numeric[], ${col((r) => dec(r.refunded))}::numeric[], ${col((r) => r.sourceName)}::text[],
      ${col((r) => iso(r.shopifyUpdatedAt))}::timestamptz[]
    ) AS u(id, shopify_id, name, processed_at, cancelled_at, test, currency, net_sales, discounts, shipping, taxes, taxes_included,
      total, refunded, source_name, shopify_updated_at)
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
  const read = await readOrders({ shop: conn.externalAccountId, accessToken: await accessToken(conn) }, since, ctx.signal);
  // A refused token is the connection's fault (products stop too); a missing scope or permission is not.
  if (read.stop === "reconnect") await markReconnect(conn.id, SHOPIFY_REFUSED);
  if (read.stop === "reconnect" || read.stop === "failed" || read.stop === "permission" || read.stop === "missing_scope") {
    return { count: 0, reason: stopReason(read.stop) };
  }
  const scope = { workspaceId: ctx.source.workspaceId, brandId: ctx.source.brandId, connectionId: conn.id };
  // One statement per page of rows; the client returns them oldest update first, so a write that throws leaves the
  // saved cursor where it was and the next run re-reads (upserts are idempotent).
  for (let i = 0; i < read.orders.length; i += PAGE) await upsertOrders(scope, read.orders.slice(i, i + PAGE));
  return { count: read.orders.length, reason: stopReason(read.stop), cursor: read.cursorEnd.toISOString() };
}

registerSync("SHOPIFY_ORDERS", (ctx) => syncShopifyOrders(ctx));
