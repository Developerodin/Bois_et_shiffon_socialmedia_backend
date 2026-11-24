import { auth } from "@/auth";
import { AccessDeniedError } from "@/server/auth/errors";
import { appUrl } from "@/server/auth/tokens";
import { kickRunner } from "@/server/jobs/runner";
import { ConnectionError } from "@/server/services/connections";
import { completeAskCartConnect } from "@/server/shopify/askcart-connect";

// Queued work runs after the response (kickRunner); give it room to finish.
export const maxDuration = 300;

/**
 * Where AskCart sends the browser back after a per-brand connect (server/shopify/askcart-connect.ts), always landing on
 * Settings → Connections like the OAuth callback. Web only: a connect is never started from the app. Signed in is
 * required (the state is bound to the person), and the code never connects by state alone.
 */
export async function GET(request: Request) {
  const back = (params: Record<string, string>) =>
    Response.redirect(appUrl(`/settings?${new URLSearchParams({ tab: "connections", ...params })}`), 303);
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error") || !code || !state) {
    console.warn("[askcart] connect refused:", url.searchParams.get("error"));
    return back({ connectError: "Connection was cancelled or denied" });
  }

  const session = await auth();
  // Signed out mid-connect: the code is single-use and bound to the person, so it isn't carried through sign-in; they
  // land on Connections after signing in with a message to connect again.
  if (!session?.user?.id) {
    const next = `/settings?${new URLSearchParams({ tab: "connections", connectError: "You were signed out. Connect Shopify via AskCart again." })}`;
    return Response.redirect(appUrl(`/login?next=${encodeURIComponent(next)}`), 303);
  }

  try {
    const { connections } = await completeAskCartConnect({ state, code, shop: url.searchParams.get("shop"), userId: session.user.id });
    kickRunner();
    return back({ connected: connections.map((c) => c.displayName).join(", ") });
  } catch (error) {
    if (error instanceof ConnectionError) return back({ connectError: error.message });
    if (error instanceof AccessDeniedError) return back({ connectError: "You don't have permission to connect accounts for this brand" });
    console.error("[askcart] callback failed", error instanceof Error ? error.message : error);
    return back({ connectError: "Something went wrong while connecting. Try again." });
  }
}
