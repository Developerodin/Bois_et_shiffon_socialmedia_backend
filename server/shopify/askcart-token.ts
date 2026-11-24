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
 * ponytail: two refreshes at once both run and the last write wins; fine if AskCart lets the old refresh token
 * live briefly, else the loser's next call needs a reconnect (check when AskCart's refresh exists).
 */
export async function askCartToken(conn: IntegrationConnection): Promise<string> {
  if (conn.status !== "ACTIVE") throw new ReconnectNeeded(`${conn.displayName} isn't connected`);
  const cfg = askCartConfig();
  if (conn.externalAccountId === ASKCART_ACCOUNT) {
    if (cfg?.mode !== "single-store") throw new ReconnectNeeded("AskCart's single-store key isn't set");
    return cfg.secret;
  }
  if (!conn.encryptedCredentials) throw new ReconnectNeeded(`${conn.displayName} isn't connected`);
  const creds = decryptCredentials<Creds>(conn.encryptedCredentials);
  const expiresAt = conn.tokenExpiresAt?.getTime();
  if (!expiresAt || expiresAt - Date.now() > REFRESH_AHEAD_MS) return creds.accessToken;
  const lost = async () => {
    await prisma.integrationConnection.updateMany({ where: { id: conn.id, status: "ACTIVE" }, data: { status: "ERROR", lastError: "AskCart's access to the store expired. Connect Shopify via AskCart again." } });
    return new ReconnectNeeded("AskCart 401 expired");
  };
  if (!creds.refreshToken) {
    if (expiresAt > Date.now()) return creds.accessToken;
    throw await lost();
  }
  try {
    const next = tokenFields(await askCartTokenRequest({ grant_type: "refresh_token", refresh_token: creds.refreshToken }));
    // A refresh that answers without a new refresh token keeps the old one.
    const credentials = { ...next.credentials, refreshToken: next.credentials.refreshToken ?? creds.refreshToken };
    const keyVersion = currentKeyVersion();
    const { count } = await prisma.integrationConnection.updateMany({
      where: { id: conn.id, status: "ACTIVE" }, // a Disconnect during the refresh keeps its credentials gone
      data: { encryptedCredentials: encryptCredentials(credentials, keyVersion), credentialKeyVersion: keyVersion, tokenExpiresAt: next.tokenExpiresAt, lastError: null },
    });
    if (count !== 1) throw new ReconnectNeeded(`${conn.displayName} isn't connected`);
    return credentials.accessToken;
  } catch (e) {
    if (e instanceof ReconnectNeeded) throw e;
    if (e instanceof AskCartError && e.status >= 400 && e.status < 500 && !e.rateLimited) throw await lost();
    if (expiresAt > Date.now()) return creds.accessToken;
    throw e;
  }
}

/**
 * Disconnect, per-brand mode: ask AskCart to forget the brand's token before ours is dropped. Best effort: AskCart
 * being down never blocks a disconnect (the token stays valid on its side until the merchant removes the app).
 */
export async function revokeAskCart(conn: IntegrationConnection) {
  if (conn.externalAccountId === ASKCART_ACCOUNT || !conn.encryptedCredentials) return;
  try {
    await askCartRevoke(decryptCredentials<Creds>(conn.encryptedCredentials).accessToken);
  } catch (e) {
    console.warn("[askcart] token revoke failed", conn.brandId, e instanceof Error ? e.message : e);
  }
}
