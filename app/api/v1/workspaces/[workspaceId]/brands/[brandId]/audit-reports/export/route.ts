import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { badExport, exportAllowed, tooManyExports } from "@/server/api/csv-export";
import { toXlsx, xlsxResponse, type XlsxColumn } from "@/server/api/xlsx";
import { prisma } from "@/server/db/prisma";
import type { Finding } from "@/server/seo/checks";

// One row per finding, in report order (most important first). Widths are in Excel characters; long text wraps.
const COLUMNS: XlsxColumn[] = [
  { key: "n", label: "#", width: 5 },
  { key: "severity", label: "Severity", width: 10 },
  { key: "category", label: "Category", width: 18 },
  { key: "title", label: "Title", width: 40 },
  { key: "detail", label: "Detail", width: 60 },
  { key: "fix", label: "Fix", width: 60 },
  { key: "pages", label: "Pages", width: 8 },
  { key: "urls", label: "URLs", width: 70 },
];
const SEVERITY: Record<string, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
/** Report text is markdown-ish: drop the backticks. */
const plain = (s: string | undefined) => (s ?? "").replace(/`/g, "").trim();

/** The findings of the latest SEO or GEO report (?kind=SEO|GEO, default SEO) as an Excel sheet. */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "analytics.read");
    if (scope instanceof Response) return scope;
    const kind = new URL(request.url).searchParams.get("kind") ?? "SEO";
    if (kind !== "SEO" && kind !== "GEO") return badExport("kind must be SEO or GEO");
    if (!(await exportAllowed(scope.userId))) return tooManyExports();
    const report = await prisma.auditReport.findFirst({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId, kind }, orderBy: { createdAt: "desc" }, select: { findings: true } });
    const findings = (Array.isArray(report?.findings) ? report.findings : []) as Finding[];
    const xlsx = toXlsx(
      `${kind} findings`,
      COLUMNS,
      findings.map((f, i) => ({
        n: i + 1,
        severity: SEVERITY[f.severity] ?? f.severity,
        category: f.category,
        title: plain(f.title),
        detail: plain(f.detail),
        fix: plain(f.fix),
        pages: f.urls?.length ?? 0,
        urls: (f.urls ?? []).join("\n"),
      })),
    );
    await prisma.auditEvent.create({
      data: { workspaceId: scope.workspaceId, brandId: scope.brandId, actorUserId: scope.userId, action: "report.export", entityType: "Brand", entityId: scope.brandId, metadata: { kind, rows: findings.length } },
    });
    return xlsxResponse(xlsx, `${kind.toLowerCase()}-findings-${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (error) {
    return fromAccessError(error);
  }
}
