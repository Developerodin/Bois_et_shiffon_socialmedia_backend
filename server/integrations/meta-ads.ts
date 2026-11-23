import type { IntegrationConnection } from "@prisma/client";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { enqueueAdsBackfill } from "@/server/data/meta-ads-sync";
import { prisma } from "@/server/db/prisma";
import { metaAdAccounts, ProviderError, type MetaAdAccount } from "@/server/integrations/providers";
import { accessToken, markReconnect, ReconnectNeeded } from "@/server/services/connections";

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

const toDto = (a: MetaAdAccount) => ({ id: a.id, name: a.name, currency: a.currency, timeZone: a.timezone_name });

/** The active ad accounts the connection's Meta login can read now. */
export async function listMetaAdAccounts(scope: Scope, connectionId: string) {
  const conn = await adsConnection(scope, connectionId);
  await limit(scope);
  return (await liveAccounts(conn)).map(toDto);
}

/**
 * Choose the connection's ad account as the brand's ad data source. The account must still be in the live list
 * (active and readable by this login). Saves the DataSource (kind META_ADS, externalId = account id, its name as
 * label, its currency and zone) and queues its first backfill window. Choosing it again (a new login, a changed
 * currency or zone) switches it back on and re-reads the whole backfill: syncedThrough starts over and the backfill
 * key carries the new updatedAt. A double press queues two chains; their delete-then-insert writes give the same rows.
 */
export async function chooseMetaAdAccount(scope: Scope, connectionId: string) {
  const conn = await adsConnection(scope, connectionId);
  await limit(scope);
  const account = (await liveAccounts(conn)).find((a) => a.id === conn.externalAccountId);
  if (!account) throw new MetaAdsError("This ad account isn't active or readable by the connected Meta login any more. Reconnect Meta Ads.", 409);
  const chosen = {
    connectionId: conn.id,
    externalId: account.id,
    label: account.name.slice(0, 200),
    settings: { currency: account.currency, timeZone: account.timezone_name },
  };
  const source = await prisma.dataSource.upsert({
    where: { brandId_kind_externalId: { brandId: scope.brandId, kind: "META_ADS", externalId: chosen.externalId } },
    create: { workspaceId: scope.workspaceId, brandId: scope.brandId, kind: "META_ADS", ...chosen },
    update: { connectionId: chosen.connectionId, label: chosen.label, settings: chosen.settings, status: "ACTIVE", syncedThrough: null },
  });
  await enqueueAdsBackfill(source);
  return chosen;
}
