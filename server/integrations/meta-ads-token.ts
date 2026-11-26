import { call, form, GRAPH, metaAdAccounts, ProviderError, providerConfig, type MetaAdAccount } from "@/server/integrations/providers";

/**
 * A pasted Meta System User token for Meta Ads (plan 2026-11-26-phase-2-followup, Task 4): checked against our app
 * with debug_token, then its ad accounts read. Graph's error text never leaves this module (it can echo the token):
 * every failure is one of the fixed messages below, and logs carry the HTTP status only.
 * Ceiling: a system token revoked or stripped of the ad account shows on the next sync as 190 (reconnect) or a
 * permission stop; either lets a personal login take over again (saveConnections' keep rule).
 */
export const SYSTEM_TOKEN_MESSAGES = {
  invalid: "This token isn't valid. Generate a new one in Business Manager and paste it again.",
  otherApp: "This token is for another app",
  personal: "This is a personal token, not a system user token",
  expires: "This token expires: in Business Manager choose 'Never' when generating it",
  noAds: "This token can't read ads",
  noAccounts: "This token can't see any ad account",
  unreachable: "Meta didn't answer. Try again in a few minutes.",
  notConfigured: "Meta Ads isn't set up on this server.",
} as const;

export class SystemTokenRefused extends Error {
  constructor(readonly status: 422 | 502 | 503, message: string) {
    super(message);
  }
}

type DebugToken = { data?: { app_id?: string; type?: string; is_valid?: boolean; expires_at?: number; scopes?: string[] } };

/** Logs a failed Graph call by status only (ProviderError's message holds Graph's text). */
function upstream(step: string, e: unknown): never {
  console.warn(`[meta-ads] system token ${step} failed`, e instanceof ProviderError ? (e.status ?? "no status") : e instanceof Error ? e.name : "error");
  throw new SystemTokenRefused(502, SYSTEM_TOKEN_MESSAGES.unreachable);
}

/**
 * debug_token with the app token in a POST body (never a URL): a GET-override POST first; if Graph refuses that, the
 * same request as a one-call batch, whose relative URL travels inside the POST body too.
 */
async function debugToken(token: string, appToken: string): Promise<DebugToken> {
  try {
    return await call<DebugToken>(`${GRAPH}/debug_token`, form({ method: "GET", input_token: token, access_token: appToken }));
  } catch (first) {
    if (!(first instanceof ProviderError)) upstream("debug_token", first);
    const batch = await call<{ code?: number; body?: string }[]>(
      `${GRAPH}/`,
      form({ access_token: appToken, batch: JSON.stringify([{ method: "GET", relative_url: `debug_token?input_token=${encodeURIComponent(token)}` }]) }),
    ).catch((e) => upstream("debug_token batch", e));
    const answer = Array.isArray(batch) ? batch[0] : undefined;
    if (!answer || answer.code !== 200 || typeof answer.body !== "string") upstream("debug_token batch", new ProviderError("batch", answer?.code));
    try {
      return JSON.parse(answer.body) as DebugToken;
    } catch (e) {
      return upstream("debug_token batch", e);
    }
  }
}

/** Checks a system user token; returns its granted scopes and active ad accounts, or throws SystemTokenRefused. */
export async function checkSystemToken(token: string): Promise<{ scopes: string[]; accounts: MetaAdAccount[] }> {
  const cfg = providerConfig("META_ADS");
  if (!cfg) throw new SystemTokenRefused(503, SYSTEM_TOKEN_MESSAGES.notConfigured);
  const info = (await debugToken(token, `${cfg.clientId}|${cfg.secret}`)).data;
  if (!info?.is_valid) throw new SystemTokenRefused(422, SYSTEM_TOKEN_MESSAGES.invalid);
  if (String(info.app_id) !== cfg.clientId) throw new SystemTokenRefused(422, SYSTEM_TOKEN_MESSAGES.otherApp);
  if (info.type !== "SYSTEM_USER") throw new SystemTokenRefused(422, SYSTEM_TOKEN_MESSAGES.personal);
  if (info.expires_at !== 0) throw new SystemTokenRefused(422, SYSTEM_TOKEN_MESSAGES.expires);
  const scopes = Array.isArray(info.scopes) ? info.scopes.filter((s): s is string => typeof s === "string") : [];
  if (!scopes.includes("ads_read")) throw new SystemTokenRefused(422, SYSTEM_TOKEN_MESSAGES.noAds);
  let accounts: MetaAdAccount[];
  try {
    accounts = await metaAdAccounts(token);
  } catch (e) {
    return upstream("ad accounts", e);
  }
  if (!accounts.length) throw new SystemTokenRefused(422, SYSTEM_TOKEN_MESSAGES.noAccounts);
  return { scopes, accounts };
}
