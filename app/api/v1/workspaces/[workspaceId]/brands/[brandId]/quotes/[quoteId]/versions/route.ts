import { invalidBody } from "@/server/crm/common";
import { crmRoute, json } from "@/server/crm/route";
import { quoteVersions } from "@/server/quotes/quotes";

type Params = { workspaceId: string; brandId: string; quoteId: string };

/** The quote's earlier versions, newest first; `?version=N` returns that one with its lines and totals (crm.manage). */
export const GET = crmRoute<Params>(["crm.manage"], async (scope, p, request) => {
  const v = new URL(request.url).searchParams.get("version");
  if (v !== null && !/^[1-9]\d{0,8}$/.test(v)) return invalidBody("version must be a positive whole number");
  return json({ versions: await quoteVersions(scope, p.quoteId, v ? Number(v) : undefined) });
});
