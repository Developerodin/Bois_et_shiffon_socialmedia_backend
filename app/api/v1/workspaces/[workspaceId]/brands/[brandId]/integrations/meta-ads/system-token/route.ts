import { z } from "zod";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { prisma } from "@/server/db/prisma";
import { checkSystemToken, SystemTokenRefused } from "@/server/integrations/meta-ads-token";
import { metaAccountsToConnections } from "@/server/integrations/providers";
import { saveConnections, toConnectionDto } from "@/server/services/connections";

// Only the token is read. It is never logged, echoed or stored unencrypted; no request body is logged.
const Body = z.object({ token: z.string().trim().regex(/^[A-Za-z0-9]{20,512}$/) });

const refused = (status: number, detail: string) =>
  problemResponse({ type: `https://api.brandpilot/errors/${status === 422 ? "validation" : "upstream"}`, title: "Couldn't use this token", status, detail });

/**
 * Run the brand's Meta ad accounts on a pasted System User token `{ token }` (integrations.manage), which never
 * expires. Checked with debug_token (our app, a system user, no expiry, ads_read) and saved for every active ad
 * account it can see, replacing a personal login's connection in place (its data source keeps working). 5 tries an
 * hour per brand and person, counted before any Meta call, so failed checks count too.
 */
export async function POST(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "integrations.manage");
    if (scope instanceof Response) return scope;
    if (!(await hitRateLimit(`meta-ads:system-token:${scope.brandId}:${scope.userId}`, 5, 60 * 60_000)).allowed) {
      return problemResponse({ type: "https://api.brandpilot/errors/rate-limited", title: "Slow down", status: 429, detail: "Too many tokens tried this hour. Try again later." });
    }
    const body = Body.safeParse(await request.json().catch(() => null));
    if (!body.success) return refused(422, "Paste the system user token from Business Manager: letters and digits only.");
    const { token } = body.data;

    let checked: Awaited<ReturnType<typeof checkSystemToken>>;
    try {
      checked = await checkSystemToken(token);
    } catch (e) {
      if (e instanceof SystemTokenRefused) return refused(e.status, e.message);
      console.warn("[meta-ads] system token check failed", e instanceof Error ? e.name : "error");
      return refused(502, "Meta didn't answer. Try again in a few minutes.");
    }
    // Personal logins this token replaces (they had an expiry), for the audit. Read before the save's transaction: a
    // personal login saved in between is still replaced, only missing from this list (an audit detail, accepted).
    const replaced = await prisma.integrationConnection.findMany({
      where: { workspaceId: scope.workspaceId, brandId: scope.brandId, provider: "META_ADS", externalAccountId: { in: checked.accounts.map((a) => a.id) }, tokenExpiresAt: { not: null } },
      select: { externalAccountId: true },
    });
    const rows = await saveConnections({
      workspaceId: scope.workspaceId,
      brandId: scope.brandId,
      provider: "META_ADS",
      userId: scope.userId,
      accounts: metaAccountsToConnections(checked.accounts, token, null, checked.scopes),
      auditMetadata: { kind: "system_user", replaced: replaced.map((r) => r.externalAccountId) },
      // The stop a broken earlier token left on these accounts' sources is about that token, not this one: cleared
      // with the save, so the keep rule doesn't let a personal login replace this token on an old reason.
      after: async (tx, saved) => {
        await tx.$executeRaw`
          UPDATE "DataSource" SET "status" = CASE WHEN "status" = 'ERROR' THEN 'ACTIVE'::"DataSourceStatus" ELSE "status" END,
            "lastResult" = CASE WHEN "lastResult" ? 'reason' THEN "lastResult" || '{"reason": null, "error": null}'::jsonb ELSE "lastResult" END
          WHERE "workspaceId" = ${scope.workspaceId} AND "brandId" = ${scope.brandId} AND "kind" = 'META_ADS'
            AND "connectionId" = ANY(${saved.map((r) => r.id)}::text[])`;
      },
    });
    return Response.json({ connections: rows.map(toConnectionDto) }, { status: 201 });
  } catch (error) {
    return fromAccessError(error);
  }
}
