import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { hitRateLimit } from "@/server/auth/rate-limit";
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
    if (kind !== "SEO" && kind !== "GEO") {
      return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Bad Request", status: 400, detail: "kind must be SEO or GEO" });
    }
    if (!(await hitRateLimit(`export:${scope.userId}`, 20, 3_600_000)).allowed) {
      return problemResponse({ type: "https://api.brandpilot/errors/rate-limited", title: "Too many exports. Try again later.", status: 429 });
    }
    const report = await prisma.auditReport.findFirst({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId, kind }, orderBy: { createdAt: "desc" }, select: { findings: true } });
    const findings = (Array.isArray(report?.findings) ? report.findings : []) as Finding[];
    const csv = toCsv(
      COLUMNS,
      findings.map((f) => ({ Severity: f.severity, Category: f.category, Title: f.title, Detail: f.detail, URLs: (f.urls ?? []).join("\n"), Fix: f.fix })),
    );
    await prisma.auditEvent.create({
      data: { workspaceId: scope.workspaceId, brandId: scope.brandId, actorUserId: scope.userId, action: "report.export", entityType: "Brand", entityId: scope.brandId, metadata: { kind, rows: findings.length } },
    });
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${kind.toLowerCase()}-findings-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return fromAccessError(error);
  }
}
