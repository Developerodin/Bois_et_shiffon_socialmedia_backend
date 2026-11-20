import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { badExport, csvResponse, exportAllowed, tooManyExports } from "@/server/api/csv-export";
import { prisma } from "@/server/db/prisma";
import type { Finding } from "@/server/seo/checks";
import { toCsv } from "@/shared";

const COLUMNS = ["Severity", "Category", "Title", "Detail", "URLs", "Fix"].map((label) => ({ key: label, label }));

/** The findings of the latest SEO or GEO report (?kind=SEO|GEO, default SEO) as CSV. */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "analytics.read");
    if (scope instanceof Response) return scope;
    const kind = new URL(request.url).searchParams.get("kind") ?? "SEO";
    if (kind !== "SEO" && kind !== "GEO") return badExport("kind must be SEO or GEO");
    if (!(await exportAllowed(scope.userId))) return tooManyExports();
    const report = await prisma.auditReport.findFirst({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId, kind }, orderBy: { createdAt: "desc" }, select: { findings: true } });
    const findings = (Array.isArray(report?.findings) ? report.findings : []) as Finding[];
    const csv = toCsv(
      COLUMNS,
      findings.map((f) => ({ Severity: f.severity, Category: f.category, Title: f.title, Detail: f.detail, URLs: (f.urls ?? []).join("\n"), Fix: f.fix })),
    );
    await prisma.auditEvent.create({
      data: { workspaceId: scope.workspaceId, brandId: scope.brandId, actorUserId: scope.userId, action: "report.export", entityType: "Brand", entityId: scope.brandId, metadata: { kind, rows: findings.length } },
    });
    return csvResponse(csv, `${kind.toLowerCase()}-findings-${new Date().toISOString().slice(0, 10)}.csv`);
  } catch (error) {
    return fromAccessError(error);
  }
}
