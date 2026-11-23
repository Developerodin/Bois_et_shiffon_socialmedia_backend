import type { IntegrationConnection } from "@prisma/client";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { adsBackfillPlan, enqueueAdsBackfill, type AdSettings } from "@/server/data/meta-ads-sync";
import { DATA_SYNC_JOB } from "@/server/data/sources";
import { prisma } from "@/server/db/prisma";
import { metaAdAccounts, ProviderError, type MetaAdAccount } from "@/server/integrations/providers";
import { accessToken, markReconnect, ReconnectNeeded } from "@/server/services/connections";
import type { MetaAdAccountDto, MetaAdAccountsDto } from "@/shared";

/**
 * The Meta Ads account picker: which ad accounts a connected Meta Ads login can read, and choosing the one a brand's
 * ad data comes from. Read live from Meta; the connection is always loaded with its brand, workspace and provider, so
 * another brand's connection id is a 404. Meta's error text and request URLs stay out of logs and answers.
 */
type Scope = { workspaceId: string; brandId: string; userId: string };

export class MetaAdsError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** A picker route's error as its problem response; Meta's text never reaches it. */
export function metaAdsProblem(error: unknown) {
  if (error instanceof MetaAdsError) {
    return problemResponse({ type: "https://api.brandpilot/errors/meta-ads", title: error.status === 404 ? "Not found" : "Meta Ads", status: error.status, detail: error.message });
  }
  if (error instanceof ReconnectNeeded) {
    return problemResponse({ type: "https://api.brandpilot/errors/reconnect", title: "Reconnect needed", status: 409, detail: "Meta Ads access expired. Reconnect it in Connections." });
  }
  return fromAccessError(error);
}

const PICKS_PER_MIN = 10;

async function limit(scope: Scope) {
  if (!(await hitRateLimit(`meta-ads:accounts:${scope.brandId}:${scope.userId}`, PICKS_PER_MIN, 60_000)).allowed) {
    throw new MetaAdsError("Meta is being asked too often. Wait a minute and try again.", 429);
  }
}

async function adsConnection(scope: Scope, connectionId: string) {
  const conn = await prisma.integrationConnection.findFirst({
    where: { id: connectionId, brandId: scope.brandId, workspaceId: scope.workspaceId, provider: "META_ADS", status: { not: "REVOKED" } },
  });
  if (!conn) throw new MetaAdsError("Not found", 404);
  return conn;
}

async function liveAccounts(conn: IntegrationConnection): Promise<MetaAdAccount[]> {
  const token = await accessToken(conn); // ReconnectNeeded when expired or not connected
  try {
    return await metaAdAccounts(token);
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    const status = e.message.slice(0, 3);
    console.warn(`[meta-ads] accounts ${conn.id} ${status}`); // status only: no URL, no token, no Meta text
    // 190 (token expired or revoked) comes back as 400/401 "Error validating access token" / "Session has expired".
    if (/^40[01] /.test(e.message) && /access token|session/i.test(e.message)) {
      await markReconnect(conn.id, `Access expired. Reconnect ${conn.displayName}.`);
      throw new ReconnectNeeded(`${conn.displayName}'s access expired`);
    }
    throw new MetaAdsError("Meta didn't answer. Try again in a minute.", 502);
  }
}

const toDto = (a: MetaAdAccount): MetaAdAccountDto => ({ id: a.id, name: a.name, currency: a.currency, timeZone: a.timezone_name });

/** The active ad accounts the connection's Meta login can read now, and the connection's own account id. */
export async function listMetaAdAccounts(scope: Scope, connectionId: string): Promise<MetaAdAccountsDto> {
  const conn = await adsConnection(scope, connectionId);
  await limit(scope);
  return { accounts: (await liveAccounts(conn)).map(toDto), connectionAccountId: conn.externalAccountId };
}

/**
 * Choose the connection's ad account as the brand's ad data source (one per brand: its other META_ADS sources go
 * OFF, rows kept). The account must still be in the live list (active and readable by this login). Saves the
 * DataSource (kind META_ADS, externalId = account id, its name as label, its currency, zone and backfill plan) and
 * queues its first backfill window. Choosing the same account again with the same connection, currency and zone while
 * it's on changes nothing (a double press queues no second chain). Otherwise it switches back on and re-reads the
 * whole backfill: syncedThrough starts over, the old chain's queued windows are dropped in the same transaction (so
 * they can't advance syncedThrough past the new chain), and the backfill key carries the new updatedAt.
 * Returns the source's id.
 */
export async function chooseMetaAdAccount(scope: Scope, connectionId: string) {
  const conn = await adsConnection(scope, connectionId);
  await limit(scope);
  const account = (await liveAccounts(conn)).find((a) => a.id === conn.externalAccountId);
  if (!account) throw new MetaAdsError("This ad account isn't active or readable by the connected Meta login any more. Reconnect Meta Ads.", 409);
  const where = { workspaceId: scope.workspaceId, brandId: scope.brandId, kind: "META_ADS" as const };
  const label = account.name.slice(0, 200);
  const { source, restarted } = await prisma.$transaction(async (tx) => {
    await tx.dataSource.updateMany({ where: { ...where, externalId: { not: account.id }, status: { not: "OFF" } }, data: { status: "OFF" } });
    const existing = await tx.dataSource.findFirst({ where: { ...where, externalId: account.id } });
    const held = (existing?.settings ?? {}) as AdSettings;
    if (existing && existing.status !== "OFF" && existing.connectionId === conn.id && held.currency === account.currency && held.reportsIn === account.timezone_name) {
      return { source: existing, restarted: false };
    }
    const settings: AdSettings = { currency: account.currency, reportsIn: account.timezone_name, backfill: adsBackfillPlan(account.timezone_name) };
    if (existing) {
      await tx.job.deleteMany({ where: { type: DATA_SYNC_JOB, status: "PENDING", idempotencyKey: { startsWith: `data:${existing.id}:backfill:` } } });
    }
    const source = await tx.dataSource.upsert({
      where: { brandId_kind_externalId: { brandId: scope.brandId, kind: "META_ADS", externalId: account.id } },
      create: { ...where, externalId: account.id, connectionId: conn.id, label, settings },
      update: { connectionId: conn.id, label, settings, status: "ACTIVE", syncedThrough: null },
    });
    return { source, restarted: true };
  });
  if (restarted) await enqueueAdsBackfill(source);
  return source.id;
}
