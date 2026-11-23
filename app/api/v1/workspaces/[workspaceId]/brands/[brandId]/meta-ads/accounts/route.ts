import { z } from "zod";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { chooseMetaAdAccount, listMetaAdAccounts, MetaAdsError } from "@/server/integrations/meta-ads";
import { ReconnectNeeded } from "@/server/services/connections";

type Params = { params: Promise<BrandRouteParams> };

const ConnectionId = z.string().min(1).max(100);
const Body = z.object({ connectionId: ConnectionId }).strict();

const invalid = () => problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid request", status: 422 });

function toProblem(error: unknown) {
  if (error instanceof MetaAdsError) {
    return problemResponse({ type: "https://api.brandpilot/errors/meta-ads", title: error.status === 404 ? "Not found" : "Meta Ads", status: error.status, detail: error.message });
  }
  if (error instanceof ReconnectNeeded) {
    return problemResponse({ type: "https://api.brandpilot/errors/reconnect", title: "Reconnect needed", status: 409, detail: "Meta Ads access expired. Reconnect it in Connections." });
  }
  return fromAccessError(error);
}

/** The ad accounts a connected Meta Ads login can read now (`?connectionId=`). Names are for people who manage accounts. */
export async function GET(request: Request, context: Params) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "integrations.manage");
    if (scope instanceof Response) return scope;
    const id = ConnectionId.safeParse(new URL(request.url).searchParams.get("connectionId"));
    if (!id.success) return invalid();
    return Response.json({ accounts: await listMetaAdAccounts(scope, id.data) });
  } catch (error) {
    return toProblem(error);
  }
}

/** Choose this connection's ad account as the brand's ad data: checked against Meta's live list. */
export async function PUT(request: Request, context: Params) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "integrations.manage");
    if (scope instanceof Response) return scope;
    const body = Body.safeParse(await request.json().catch(() => null));
    if (!body.success) return invalid();
    return Response.json({ source: await chooseMetaAdAccount(scope, body.data.connectionId) });
  } catch (error) {
    return toProblem(error);
  }
}
