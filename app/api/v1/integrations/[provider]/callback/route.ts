import { auth } from "@/auth";
import { AccessDeniedError } from "@/server/auth/errors";
import { appUrl, hashToken } from "@/server/auth/tokens";
import { prisma } from "@/server/db/prisma";
import { PROVIDERS, PROVIDER_SLUGS, ProviderError } from "@/server/integrations/providers";
import { completeConnect, ConnectionError } from "@/server/services/connections";

/** Where the in-app browser hands a connect back to the app (scheme in apps/mobile/app.json). */
const MOBILE_RETURN = "espanda://connect";

/** OAuth redirect target for every provider. Always lands the user back on Settings → Connections. */
export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  const back = (params: Record<string, string>) =>
    Response.redirect(appUrl(`/settings?${new URLSearchParams({ tab: "connections", ...params })}`), 303);

  const slug = (await context.params).provider;
  const provider = PROVIDER_SLUGS[slug];
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!provider) return back({ connectError: "Unknown provider" });

  // Started in the app: the in-app browser has no web session, and connecting by state alone would let someone
  // send their own consent link to a victim and get the victim's account on their brand. So the code goes back
  // to the app, which completes with its own token (POST …/integrations/:provider/complete; user must match).
  const started = state ? await prisma.oAuthStateTransaction.findUnique({ where: { stateHash: hashToken(state) }, select: { client: true } }) : null;
  if (started?.client === "mobile") {
    const ok = code && !url.searchParams.get("error");
    return Response.redirect(`${MOBILE_RETURN}?${new URLSearchParams({ provider: slug, ...(ok ? { state: state!, code } : { error: "cancelled" }) })}`, 303);
  }
  if (url.searchParams.get("error") || !code || !state) {
    // The provider's reason (access_denied, invalid_scope, …) is only in the URL; keep it for whoever debugs a failed connect.
    console.warn(`[integrations] ${slug} connect refused:`, url.searchParams.get("error"), url.searchParams.get("error_description") ?? "");
    return back({ connectError: "Connection was cancelled or denied" });
  }

  const session = await auth();
  // Signed out mid-connect: sign in, then land back on Connections (the OAuth code is single-use, so they connect again).
  if (!session?.user?.id) return Response.redirect(appUrl(`/login?next=${encodeURIComponent("/settings?tab=connections")}`), 303);

  try {
    const done = await completeConnect({ provider, state, code, userId: session.user.id });
    const { connections } = done;
    // A repeated callback (replay) reports the connections only.
    const kept = "kept" in done ? done.kept : [];
    // One Meta Ads login saves a connection per ad account: listing every name would put them all in the URL
    // (history, logs) and can overflow it, so say how many instead.
    if (provider === "META_ADS") {
      const n = connections.length;
      // Accounts running on a working system user token keep it (saveConnections' keep rule).
      const k = kept.length ? `; ${kept.length} kept the system user token` : "";
      return back({ connected: `${PROVIDERS.META_ADS.label} (${n} account${n === 1 ? "" : "s"}${k})` });
    }
    return back({ connected: connections.map((c) => c.displayName).join(", ") });
  } catch (error) {
    if (error instanceof ConnectionError) return back({ connectError: error.message });
    if (error instanceof ProviderError) {
      // "<status> <provider text>" (e.g. "400 Error validating verification code") is for logs, not people.
      console.error(`[integrations] ${provider} connect failed:`, error.message);
      const raw = /^\d{3} /.test(error.message);
      return back({ connectError: raw ? `Couldn't connect ${PROVIDERS[provider].label}. Try again.` : error.message });
    }
    if (error instanceof AccessDeniedError) return back({ connectError: "You don't have permission to connect accounts for this brand" });
    console.error("[integrations] callback failed", error);
    return back({ connectError: "Something went wrong while connecting. Try again." });
  }
}
