import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { badExport, csvResponse, exportAllowed, tooManyExports } from "@/server/api/csv-export";
import { toXlsx, xlsxResponse } from "@/server/api/xlsx";
import { ADS_MAX_DAYS, adsExportRows, EXPORT_COLUMNS } from "@/server/data/ads-read";
import { prisma } from "@/server/db/prisma";
import { badRange, parseDayRange } from "@/server/data/sources";
import { toCsv } from "@/shared";

/**
 * The ads table for `?from&to` as `?format=xlsx|csv`: one row per campaign day, numbers as numbers. Shares the
 * 20-an-hour export allowance. The filename is built only from the validated days.
 */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "ads.read");
    if (scope instanceof Response) return scope;
    const q = new URL(request.url).searchParams;
    const format = q.get("format");
    if (format !== "xlsx" && format !== "csv") return badExport("format must be xlsx or csv");
    const range = parseDayRange(q, ADS_MAX_DAYS);
    if (!range) return badRange(ADS_MAX_DAYS);
    if (!(await exportAllowed(scope.userId))) return tooManyExports();
    const rows = await adsExportRows(scope, range);
    await prisma.auditEvent.create({
      data: { workspaceId: scope.workspaceId, brandId: scope.brandId, actorUserId: scope.userId, action: "ads.export", entityType: "Brand", entityId: scope.brandId, metadata: { format, ...range, rows: rows.length } },
    });
    const name = `ads-${range.from}-${range.to}`;
    return format === "xlsx" ? xlsxResponse(toXlsx("Ads", EXPORT_COLUMNS, rows), `${name}.xlsx`) : csvResponse(toCsv(EXPORT_COLUMNS, rows), `${name}.csv`);
  } catch (error) {
    return fromAccessError(error);
  }
}
