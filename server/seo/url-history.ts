import { Prisma } from "@prisma/client";
import { SEARCH_CONSOLE_ZONE, urlKey, urlPath, urlVariants, type DateRange, type PermissionKey, type UrlHistoryDto } from "@/shared";
import { prisma } from "@/server/db/prisma";
import { metrics, chosenSite, searchQueries } from "@/server/data/search-read";
import { addDays, liveSources, previousRange, zoneToday } from "@/server/data/sources";
import { taskViewer, visibleTaskSql } from "@/server/tasks/access";
import { pageSeoAlerts } from "@/server/seo/declines";

/**
 * One URL's SEO story for the Performance page's URL view (docs/superpowers/plans/2026-11-26-seo-depth.md, Task 3):
 * its Search Console numbers, the audit findings that listed it (raised and cleared), its tasks and its articles.
 * The route checks the URL is on the brand's own site first (pageOnBrandSite); every read here is scoped to the
 * brand and its workspace.
 */

type Scope = { userId: string; workspaceId: string; brandId: string; perms: Set<PermissionKey>; clientReviewer: boolean };

/** Audit history read for findings: the last year, at most this many reports of each kind. */
export const HISTORY_DAYS = 365;
export const HISTORY_REPORTS = 60;
export const URL_TASKS_MAX = 50;
/** The default range: the last 90 synced days. */
const DEFAULT_DAYS = 90;

const asDate = (day: string) => new Date(`${day}T00:00:00Z`);
const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
// LIKE's own characters in the URL's path are matched literally.
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The range asked for, else the last 90 days up to the site's synced day (or Google's today with no sync yet). */
export async function urlHistoryRange(scope: Scope, asked: DateRange | null): Promise<DateRange> {
  if (asked) return asked;
  const synced = (await liveSources(scope, "SEARCH_CONSOLE")).syncedThrough ?? zoneToday(SEARCH_CONSOLE_ZONE);
  return { from: addDays(synced, -(DEFAULT_DAYS - 1)), to: synced };
}

async function searchSection(scope: Scope, url: string, range: DateRange): Promise<UrlHistoryDto["search"]> {
  const siteUrl = await chosenSite(scope);
  if (!siteUrl) return null;
  const pages = urlVariants(url);
  const where = (r: DateRange) => ({ brandId: scope.brandId, siteUrl, dimension: "PAGE" as const, page: { in: pages }, day: { gte: asDate(r.from), lte: asDate(r.to) } });
  const prev = previousRange(range);
  const sum = { clicks: true, impressions: true, positionSum: true } as const;
  const [days, previous, queries] = await Promise.all([
    // Summed across the spellings: one row per day.
    prisma.searchDay.groupBy({ by: ["day"], where: where(range), _sum: sum, orderBy: { day: "asc" } }),
    prisma.searchDay.aggregate({ where: where(prev), _sum: sum }),
    searchQueries(scope, range, { sort: "clicks", offset: 0, page: url }),
  ]);
  const total = days.reduce((t, d) => ({ clicks: t.clicks + (d._sum.clicks ?? 0), impressions: t.impressions + (d._sum.impressions ?? 0), positionSum: t.positionSum + (d._sum.positionSum ?? 0) }), { clicks: 0, impressions: 0, positionSum: 0 });
  return {
    totals: metrics(total),
    previous: metrics(previous._sum),
    previousRange: prev,
    days: days.map((d) => ({ day: dayOf(d.day)!, ...metrics(d._sum) })),
    topQueries: queries.queries.slice(0, 10),
  };
}

type ReportHead = { id: string; kind: "SEO" | "GEO"; createdAt: Date; pagesChecked: unknown; linksComplete: boolean };
type StoredFinding = { id?: unknown; title?: unknown; severity?: unknown; urls?: unknown; url?: unknown };

/**
 * Findings that listed this URL, from the last year's SEO and GEO reports (at most HISTORY_REPORTS of each kind).
 * Two reads: every report's head (pagesChecked, links.complete), then the findings of only the reports whose text
 * contains the URL's path (a LIKE pre-filter that urlKey confirms). `clearedOn`: the first report after the last
 * listing that measured the page without listing it, where "measured" is clearFindings' rule: the page was in
 * pagesChecked, or, for a links-* finding, the report's link check was complete.
 */
async function findingsSection(scope: Scope, key: string, path: string): Promise<UrlHistoryDto["findings"]> {
  const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000);
  const heads = await prisma.$queryRaw<ReportHead[]>`
    SELECT id, kind, "createdAt", "pagesChecked", "linksComplete" FROM (
      SELECT id, kind::text AS kind, "createdAt", metrics->'pagesChecked' AS "pagesChecked",
             COALESCE(metrics->'links'->>'complete' = 'true', false) AS "linksComplete",
             row_number() OVER (PARTITION BY kind ORDER BY "createdAt" DESC) AS n
      FROM "AuditReport"
      WHERE "workspaceId" = ${scope.workspaceId} AND "brandId" = ${scope.brandId} AND kind::text IN ('SEO', 'GEO') AND "createdAt" >= ${since}
    ) r WHERE n <= ${HISTORY_REPORTS} ORDER BY "createdAt" ASC, id ASC`;
  if (!heads.length) return [];
  const pattern = `%${likeEscape(path)}%`;
  const withPath = await prisma.$queryRaw<{ id: string; findings: unknown }[]>`
    SELECT id, findings FROM "AuditReport"
    WHERE "workspaceId" = ${scope.workspaceId} AND "brandId" = ${scope.brandId}
      AND id IN (${Prisma.join(heads.map((h) => h.id))}) AND findings::text ILIKE ${pattern} ESCAPE '\\'`;
  const findingsOf = new Map(withPath.map((r) => [r.id, Array.isArray(r.findings) ? (r.findings as StoredFinding[]) : []]));

  const listsPage = (f: StoredFinding) => {
    const urls = [...(Array.isArray(f.urls) ? f.urls : []), ...(typeof f.url === "string" ? [f.url] : [])];
    return urls.some((u) => typeof u === "string" && urlKey(u) === key);
  };
  const measured = (h: ReportHead, findingId: string) =>
    findingId.startsWith("links-") ? h.linksComplete : Array.isArray(h.pagesChecked) && h.pagesChecked.some((u) => typeof u === "string" && urlKey(u) === key);

  type Entry = { kind: "SEO" | "GEO"; findingId: string; title: string; severity: string; first: ReportHead; last: ReportHead };
  const entries = new Map<string, Entry>();
  for (const h of heads) {
    for (const f of findingsOf.get(h.id) ?? []) {
      if (typeof f.id !== "string" || !listsPage(f)) continue;
      const title = typeof f.title === "string" ? f.title : f.id;
      // GEO's content-* ids are made from a slug of the title and can shift: group them by title.
      const group = `${h.kind}:${f.id.startsWith("content-") ? `title:${title}` : f.id}`;
      const seen = entries.get(group);
      const severity = typeof f.severity === "string" ? f.severity : "low";
      if (seen) Object.assign(seen, { last: h, title, severity });
      else entries.set(group, { kind: h.kind, findingId: f.id, title, severity, first: h, last: h });
    }
  }
  const latest = new Map<string, string>();
  for (const h of heads) latest.set(h.kind, h.id);
  return [...entries.values()].map((e) => {
    const open = latest.get(e.kind) === e.last.id;
    const cleared = open ? undefined : heads.find((h) => h.kind === e.kind && h.createdAt > e.last.createdAt && measured(h, e.findingId));
    return {
      kind: e.kind,
      findingId: e.findingId,
      title: e.title,
      severity: e.severity,
      firstSeen: dayOf(e.first.createdAt)!,
      lastSeen: dayOf(e.last.createdAt)!,
      clearedOn: cleared ? dayOf(cleared.createdAt) : null,
      open,
    };
  });
}

type TaskRow = {
  id: string; title: string; status: string; changeKind: string | null; dueOn: Date | null; completedAt: Date | null;
  checkedLiveAt: Date | null; recheckOn: Date | null; findingClearedAt: Date | null;
};

/**
 * Tasks naming this URL (its `url` or one of its `findingUrls`, any spelling), the ones the caller can see.
 * ponytail: no index on Task.url, so this scans the brand's tasks; add a partial (brandId, url) index past ~10k tasks
 * per brand.
 */
async function tasksSection(scope: Scope, url: string): Promise<UrlHistoryDto["tasks"]> {
  if (!scope.perms.has("tasks.read") || scope.clientReviewer) return null;
  const variants = urlVariants(url);
  const rows = await prisma.$queryRaw<TaskRow[]>`
    SELECT t.id, t.title, t.status::text AS status, t."changeKind"::text AS "changeKind", t."dueOn", t."completedAt",
           t."checkedLiveAt", t."recheckOn", t."findingClearedAt"
    FROM "Task" t
    WHERE ${visibleTaskSql(taskViewer(scope))} AND t."workspaceId" = ${scope.workspaceId} AND t."brandId" = ${scope.brandId}
      AND (t.url = ANY(${variants}::text[]) OR t."findingUrls" && ${variants}::text[])
    ORDER BY t."createdAt" DESC LIMIT ${URL_TASKS_MAX}`;
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return rows.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status as NonNullable<UrlHistoryDto["tasks"]>[number]["status"],
    changeKind: t.changeKind as NonNullable<UrlHistoryDto["tasks"]>[number]["changeKind"],
    dueOn: dayOf(t.dueOn),
    completedAt: iso(t.completedAt),
    checkedLiveAt: iso(t.checkedLiveAt),
    recheckOn: dayOf(t.recheckOn),
    findingClearedAt: iso(t.findingClearedAt),
  }));
}

/** Published articles at this path (Shopify's /blogs/<blog>/<handle>), and articles written for the tasks above. */
async function articlesSection(scope: Scope, path: string, taskIds: string[]): Promise<UrlHistoryDto["articles"]> {
  if (!scope.perms.has("brand.read")) return [];
  const raw = /^\/blogs\/[^/]+\/([^/]+)$/.exec(path)?.[1];
  let handle: string | undefined;
  try {
    handle = raw && decodeURIComponent(raw);
  } catch {
    handle = undefined; // a malformed escape names no article
  }
  const or = [
    ...(handle ? [{ status: "PUBLISHED" as const, handle }] : []),
    ...(taskIds.length ? [{ taskId: { in: taskIds } }] : []),
  ];
  if (!or.length) return [];
  const rows = await prisma.blogArticle.findMany({
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId, OR: or },
    select: { id: true, title: true, status: true, publishedAt: true },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return rows.map((a) => ({ id: a.id, title: a.title, status: a.status, publishedAt: a.publishedAt ? a.publishedAt.toISOString() : null }));
}

/** The whole story. `u` is already checked to be an http(s) URL on the brand's site. */
export async function urlHistory(scope: Scope, u: string, range: DateRange): Promise<UrlHistoryDto> {
  const parsed = new URL(u);
  const key = urlKey(u)!;
  const path = urlPath(u)!;
  const [search, findings, tasks, alerts] = await Promise.all([
    searchSection(scope, u, range), findingsSection(scope, key, path), tasksSection(scope, u), pageSeoAlerts(scope, key),
  ]);
  const articles = await articlesSection(scope, path, (tasks ?? []).map((t) => t.id));
  // Rebuilt from the parsed URL: https, its host and the key's path, never the caller's text.
  return { url: `https://${parsed.host}${path}`, key, range, search, findings, tasks, articles, alerts };
}
