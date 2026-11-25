import { createHash, randomBytes } from "node:crypto";
import { appUrl } from "@/server/auth/tokens";
import { shopDomain } from "@/server/catalog/shopify";
import { enqueueCatalogSync } from "@/server/catalog/sync";
import { claimConnectState, ConnectionError, createConnectState, saveConnections } from "@/server/services/connections";
import { AskCartError, askCartConfig, askCartRevoke, askCartTokenRequest, ASKCART_SCOPE } from "@/server/shopify/askcart";
import { tokenFields } from "@/server/shopify/askcart-token";

/**
 * Per-brand AskCart connect, started in our portal (AskCart merchants never sign in here):
 * 1. startAskCartConnect: a single-use state (connections' OAuth state, provider SHOPIFY) bound to workspace, brand and
 *    person, with a PKCE verifier kept beside it; the browser goes to AskCart's /partner/connect with the shop, state,
 *    redirect_uri, client_id and the S256 code_challenge. AskCart installs itself on the shop if needed and asks consent.
 * 2. AskCart redirects to /api/v1/integrations/askcart/callback?code&state&shop → completeAskCartConnect: the state is
 *    consumed and access re-checked, the code is exchanged server to server (client secret + verifier), and the
 *    brand's token is saved encrypted on its SHOPIFY connection (account id = the shop domain, ASKCART_SCOPE marked).
 * ponytail: built against AskCart's announced contract before AskCart built it; the token answer's shape (opaque vs
 * access+refresh, `scopes`) is read leniently and is the first thing to check on the first live connect.
 */
export const askCartRedirectUri = () => appUrl("/api/v1/integrations/askcart/callback");

const b64url = (b: Buffer) => b.toString("base64url");

export async function startAskCartConnect(input: { workspaceId: string; brandId: string; userId: string; shop: string }) {
  const cfg = askCartConfig();
  if (cfg?.mode !== "per-brand") throw new ConnectionError("AskCart isn't set up for per-store connects");
  const codeVerifier = b64url(randomBytes(32));
  const state = await createConnectState({ workspaceId: input.workspaceId, brandId: input.brandId, userId: input.userId, provider: "SHOPIFY", codeVerifier, shop: input.shop });
  const q = new URLSearchParams({
    shop: input.shop,
    state,
    redirect_uri: askCartRedirectUri(),
    client_id: cfg.clientId,
    code_challenge: b64url(createHash("sha256").update(codeVerifier).digest()),
    code_challenge_method: "S256",
  });
  return `${cfg.url}/partner/connect?${q}`;
}

/**
 * The callback's work. ConnectionError messages are shown to the person; AskCart's answer is never echoed (status and
 * code go to the log). The shop AskCart names in the token answer must be a .myshopify.com domain and match the shop
 * the connect was started for (kept with the state) and the callback's `shop`, when one is given.
 */
export async function completeAskCartConnect(input: { state: string; code: string; shop: string | null; userId: string }) {
  const claimed = await claimConnectState({ provider: "SHOPIFY", state: input.state, userId: input.userId });
  if (claimed.replay) return claimed.replay;
  const { st } = claimed;
  if (!st.codeVerifier) throw new ConnectionError("This connect link expired or was already used. Try again.");

  let tok;
  try {
    tok = await askCartTokenRequest({ grant_type: "authorization_code", code: input.code, redirect_uri: askCartRedirectUri(), code_verifier: st.codeVerifier });
  } catch (e) {
    console.error("[askcart] code exchange failed", st.brandId, e instanceof Error ? e.message : e);
    if (e instanceof AskCartError && e.code === "not_configured") throw new ConnectionError("AskCart isn't set up on this platform any more.");
    throw new ConnectionError("Couldn't finish connecting through AskCart. Try again.");
  }
  const domain = shopDomain(String(tok.shop?.domain ?? ""));
  if (!domain || (st.shop && st.shop !== domain) || (input.shop && shopDomain(input.shop) !== domain)) {
    console.error("[askcart] token answer named another or no shop", st.brandId);
    // Not stored, so revoke it (AskCart's spec requires this); best effort, the person sees the error either way.
    await askCartRevoke(tok.access_token).catch((e) => console.warn("[askcart] revoke after shop mismatch failed", e instanceof Error ? e.message : e));
    throw new ConnectionError("AskCart answered for a different store. Try again.");
  }
  const scopes = Array.isArray(tok.scopes) ? tok.scopes.filter((s): s is string => typeof s === "string").slice(0, 50) : [];
  const { credentials, tokenExpiresAt } = tokenFields(tok);
  const scope = { workspaceId: st.workspaceId, brandId: st.brandId };
  const connections = await saveConnections({
    ...scope,
    provider: "SHOPIFY",
    userId: input.userId,
    accounts: [{
      externalAccountId: domain,
      displayName: String(tok.shop?.name ?? "").slice(0, 200) || domain,
      credentials,
      tokenExpiresAt,
      scopes: [ASKCART_SCOPE, ...scopes.filter((s) => s !== ASKCART_SCOPE)],
    }],
  });
  await enqueueCatalogSync(scope, `connect:${connections[0].updatedAt.toISOString()}`);
  return { ...scope, connections };
}
