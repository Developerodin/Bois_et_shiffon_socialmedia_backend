import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { badExport, csvResponse, exportAllowed, tooManyExports } from "@/server/api/csv-export";
import { prisma } from "@/server/db/prisma";
import type { Finding } from "@/server/seo/checks";
import { toCsv } from "@/shared";

// One flat row per finding, in report order (most important first), so a spreadsheet row stays one line high: Fix next to
// Detail, the URLs last and on one line. ponytail: CSV can't set column widths; an .xlsx export if people want those.
const COLUMNS = ["#", "Severity", "Category", "Title", "Detail", "Fix", "Pages", "URLs"].map((label) => ({ key: label, label }));
const SEVERITY: Record<string, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
/** Report text is markdown-ish: drop the backticks and fold line breaks, so each cell reads as one line. */
const flatCell = (s: string | undefined) => (s ?? "").replace(/`/g, "").replace(/\s*\n+\s*/g, " ").trim();

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
      findings.map((f, i) => ({
        "#": i + 1,
        Severity: SEVERITY[f.severity] ?? f.severity,
        Category: f.category,
        Title: flatCell(f.title),
        Detail: flatCell(f.detail),
        Fix: flatCell(f.fix),
        Pages: f.urls?.length ?? 0,
        URLs: (f.urls ?? []).join(" ; "),
      })),
    );
    await prisma.auditEvent.create({
      data: { workspaceId: scope.workspaceId, brandId: scope.brandId, actorUserId: scope.userId, action: "report.export", entityType: "Brand", entityId: scope.brandId, metadata: { kind, rows: findings.length } },
    });
    return csvResponse(csv, `${kind.toLowerCase()}-findings-${new Date().toISOString().slice(0, 10)}.csv`);
  } catch (error) {
    return fromAccessError(error);
  }
}
