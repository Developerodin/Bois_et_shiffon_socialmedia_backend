import { z } from "zod";
import { problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { listMetaAdAccounts, metaAdsProblem } from "@/server/integrations/meta-ads";

type Params = { params: Promise<BrandRouteParams> };

const ConnectionId = z.string().min(1).max(100);

const invalid = () => problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid request", status: 422 });

/**
 * The ad accounts a connected Meta Ads login can read now (`?connectionId=`). Names are for people who manage accounts.
 * Choosing one is PUT data-sources/meta-ads.
 */
export async function GET(request: Request, context: Params) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "integrations.manage");
    if (scope instanceof Response) return scope;
    const id = ConnectionId.safeParse(new URL(request.url).searchParams.get("connectionId"));
    if (!id.success) return invalid();
    return Response.json(await listMetaAdAccounts(scope, id.data));
  } catch (error) {
    return metaAdsProblem(error);
  }
}

