import type { IntegrationConnection } from "@prisma/client";
import { currentKeyVersion, decryptCredentials, encryptCredentials } from "@/server/crypto/credentials";
import { prisma } from "@/server/db/prisma";
import { ReconnectNeeded } from "@/server/services/reconnect-needed";
import { ASKCART_ACCOUNT, AskCartError, askCartConfig, askCartRevoke, askCartTokenRequest } from "@/server/shopify/askcart";

type Creds = { accessToken: string; refreshToken?: string };
const REFRESH_AHEAD_MS = 5 * 60_000;

/** Token response → what a connection stores: expiresAt only when AskCart gave a lifetime (none = long-lived). */
export const tokenFields = (tok: { access_token: string; refresh_token?: string | null; expires_in?: number | null }) => ({
  credentials: { accessToken: tok.access_token, ...(tok.refresh_token ? { refreshToken: tok.refresh_token } : {}) } as Creds,
  tokenExpiresAt: typeof tok.expires_in === "number" && tok.expires_in > 0 ? new Date(Date.now() + tok.expires_in * 1000) : null,
});

/**
 * The bearer an AskCart connection reads with. INTERIM single-store: ASKCART_SECRET from env (none in the DB).
 * Per-brand: the stored token, refreshed first when AskCart gave it a lifetime and it ends within 5 minutes (only
 * when it also gave a refresh token; a long-lived opaque token is used as is). A refused refresh, or an expired token
 * with no refresh, marks the connection and throws ReconnectNeeded; a network failure keeps a still-valid token.
 * A connection left from the other mode (single-store after the switch to per-brand) throws ReconnectNeeded("AskCart
 * mode …"), which askCartReason words as "connect again".
 */
export async function askCartToken(conn: IntegrationConnection): Promise<string> {
  if (conn.status !== "ACTIVE") throw new ReconnectNeeded(`${conn.displayName} isn't connected`);
  const cfg = askCartConfig();
  if (conn.externalAccountId === ASKCART_ACCOUNT) {
    if (cfg?.mode !== "single-store") throw new ReconnectNeeded("AskCart mode changed");
    return cfg.secret;
  }
  if (!conn.encryptedCredentials) throw new ReconnectNeeded(`${conn.displayName} isn't connected`);
  const creds = decryptCredentials<Creds>(conn.encryptedCredentials);
  const expiresAt = conn.tokenExpiresAt?.getTime();
  if (!expiresAt || expiresAt - Date.now() > REFRESH_AHEAD_MS) return creds.accessToken;
  return refreshLocked(conn.id);
}

/**
 * The refresh, one at a time per connection: under an advisory lock, the stored row is read again, so a run that waited
 * behind another refresh uses the token it just stored instead of spending the (possibly rotated) refresh token again
 * and marking a working connection ERROR. A refusal only marks the row it read (same credentials), never a newer one.
 * ponytail: the AskCart call runs inside the transaction, holding one DB connection for up to its 30 s timeout per
 * refresh; fine at a refresh an hour per brand.
 */
async function refreshLocked(id: string) {
  // A lost token comes back as the error to throw, not thrown inside: throwing would roll back the ERROR mark.
  const got = await prisma.$transaction(async (tx): Promise<string | ReconnectNeeded> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('askcart-refresh:' || ${id}))`;
    const row = await tx.integrationConnection.findUnique({ where: { id } });
    if (!row || row.status !== "ACTIVE" || !row.encryptedCredentials) throw new ReconnectNeeded("AskCart connection isn't connected");
    const creds = decryptCredentials<Creds>(row.encryptedCredentials);
    const expiresAt = row.tokenExpiresAt?.getTime();
    if (!expiresAt || expiresAt - Date.now() > REFRESH_AHEAD_MS) return creds.accessToken; // refreshed while we waited
    const lost = async () => {
      await tx.integrationConnection.updateMany({
        where: { id, status: "ACTIVE", encryptedCredentials: row.encryptedCredentials },
        data: { status: "ERROR", lastError: "AskCart's access to the store expired. Connect Shopify via AskCart again." },
      });
      return new ReconnectNeeded("AskCart 401 expired");
    };
    if (!creds.refreshToken) {
      if (expiresAt > Date.now()) return creds.accessToken;
      return lost();
    }
    let next;
    try {
      next = tokenFields(await askCartTokenRequest({ grant_type: "refresh_token", refresh_token: creds.refreshToken }));
    } catch (e) {
      if (e instanceof AskCartError && e.status >= 400 && e.status < 500 && !e.rateLimited) return lost();
      if (expiresAt > Date.now()) return creds.accessToken;
      throw e;
    }
    // A refresh that answers without a new refresh token keeps the old one.
    const credentials = { ...next.credentials, refreshToken: next.credentials.refreshToken ?? creds.refreshToken };
    const keyVersion = currentKeyVersion();
    const { count } = await tx.integrationConnection.updateMany({
      where: { id, status: "ACTIVE" },
      data: { encryptedCredentials: encryptCredentials(credentials, keyVersion), credentialKeyVersion: keyVersion, tokenExpiresAt: next.tokenExpiresAt, lastError: null },
    });
    if (count !== 1) throw new ReconnectNeeded("AskCart connection isn't connected");
    return credentials.accessToken;
  }, { timeout: 45_000, maxWait: 45_000 });
  if (got instanceof ReconnectNeeded) throw got;
  return got;
}

/**
 * Disconnect, per-brand mode: ask AskCart to forget the brand's token before ours is dropped. Best effort: AskCart
 * being down never blocks a disconnect (the token stays valid on its side until the merchant removes the app).
 * AskCart's announced DELETE /api/partner/token takes only the bearer, so the refresh token isn't sent; it relies on
 * AskCart ending the whole grant (check when its refresh exists).
 */
const REVOKE_TIMEOUT_MS = 5_000;

export async function revokeAskCart(conn: IntegrationConnection) {
  if (conn.externalAccountId === ASKCART_ACCOUNT || !conn.encryptedCredentials) return;
  try {
    // Short and single: a person is waiting on Disconnect, and our side is already dropped.
    await askCartRevoke(decryptCredentials<Creds>(conn.encryptedCredentials).accessToken, AbortSignal.timeout(REVOKE_TIMEOUT_MS));
  } catch (e) {
    console.warn("[askcart] token revoke failed", conn.brandId, e instanceof Error ? e.message : e);
  }
}
