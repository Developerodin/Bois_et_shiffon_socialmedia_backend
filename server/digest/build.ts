import "server-only";
import { Prisma, type DataSourceKind } from "@prisma/client";
import type { DataSyncResult, DateRange, DigestBody, DigestBrand, DigestSection } from "@/shared";
import { prisma } from "@/server/db/prisma";
import { isClientGrant, isClientMember, permissionsOf } from "@/server/auth/permissions";
import { rolePermissions, type PermissionKey } from "@/server/auth/permissions.catalog";
import { listAlerts } from "@/server/ads/alerts";
import { adsSummary } from "@/server/data/ads-read";
import { postsWithMetrics } from "@/server/data/post-metrics-read";
import { salesSummary } from "@/server/data/sales-read";
import { searchSummary } from "@/server/data/search-read";
import { addDays, brandTimeZone, zoneToday } from "@/server/data/sources";
import { handlesCustomers, memberAccess, taskViewer, visibleTaskSql } from "@/server/tasks/access";
import { openTaskSql } from "@/server/tasks/sql";

/**
 * The weekly digest's content (plan 2026-11-24-phase-3-crm.md, Task 2). Per non-archived brand the reader reaches, the
 * sections their permissions show, over that brand's own ended Monday–Sunday. Built only from the existing readers
 * (search, posts, sales, ads) plus two small counts (content, tasks); tasks are the one section counted per reader.
 * ponytail: brand sections are memoised per (brand, week, keys that matter) in this process for MEMO_MS, so readers
 * with the same keys share them: cost ~ brands × key sets × 6 queries + readers × brands × 2 task queries; at 500
 * reader-brands ≈ 1,500 queries per Monday. A second worker process builds its own memo (correct, just repeated).
 */

type Scope = { workspaceId: string; brandId: string };

/** The Monday–Sunday that ended before the week holding `today` ("YYYY-MM-DD"). */
export function endedWeek(today: string): DateRange {
  const sinceMonday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const monday = addDays(today, -sinceMonday);
  return { from: addDays(monday, -7), to: addDays(monday, -1) };
}
/** The digest row's label: the ended week's Monday in UTC. Each brand section carries its own week. */
export const digestWeekStart = (now: Date) => endedWeek(zoneToday("UTC", now)).from;
/**
 * Digests run this long after the Monday sweep (job.ts), so the Monday data syncs it queued (spread over 2 h) have
 * finished; it is also the cutoff for the week's ads alerts (adsSection).
 */
export const AFTER_SWEEP_MS = 3 * 60 * 60_000;
/** Ads alerts a digest lists per brand; the rest are counted. */
const DIGEST_ALERTS = 10;
/** The Monday 05:00 UTC sweep that queued the digest labelled `weekStart`: the instant each brand's week is read at. */
export const sweepAt = (weekStart: string) => new Date(Date.parse(`${weekStart}T05:00:00Z`) + 7 * 86_400_000);
/**
 * A brand's week: the Monday–Sunday ended in its zone at the sweep. The sweep's data syncs read up to the brand's
 * "yesterday", so west of UTC (Sunday evening at 05:00 UTC) that is the week before, the last one whose Sunday is
 * synced; east of UTC it is the week that just ended.
 */
export const brandWeek = (zone: string, weekAt: Date) => endedWeek(zoneToday(zone, weekAt));

/** Brand-local midnight of `day` as a UTC timestamp (the columns' own kind), as the sales reader cuts its range. */
const localMidnight = (day: string, zone: string) => Prisma.sql`(((${day}::date)::timestamp AT TIME ZONE ${zone}) AT TIME ZONE 'UTC')`;

/** Has this source ever finished a sync? Never synced (or turned off) reads as "No data yet", not 0. */
async function synced(scope: Scope, kind: DataSourceKind) {
  const s = await prisma.dataSource.findFirst({
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId, kind, status: { not: "OFF" } },
    select: { syncedThrough: true, lastResult: true },
  });
  if (!s || (!s.syncedThrough && !(s.lastResult as DataSyncResult | null)?.okAt)) return null;
  return { syncedThrough: s.syncedThrough ? s.syncedThrough.toISOString().slice(0, 10) : null };
}

async function contentSection(scope: Scope, week: DateRange, zone: string, now: Date): Promise<DigestSection> {
  const [row] = await prisma.$queryRaw<{ published: number; scheduled: number; awaitingApproval: number }[]>`
    SELECT
      (SELECT count(DISTINCT a."contentItemId")::int FROM "PublicationAttempt" a
        WHERE a."workspaceId" = ${scope.workspaceId} AND a."brandId" = ${scope.brandId} AND a.status = 'PUBLISHED'
          AND a."publishedAt" >= ${localMidnight(week.from, zone)} AND a."publishedAt" < ${localMidnight(addDays(week.to, 1), zone)}) AS published,
      (SELECT count(*)::int FROM "ContentItem" c
        WHERE c."workspaceId" = ${scope.workspaceId} AND c."brandId" = ${scope.brandId} AND c.status = 'SCHEDULED' AND c."scheduledFor" >= (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')) AS scheduled,
      (SELECT count(*)::int FROM "ContentItem" c
        WHERE c."workspaceId" = ${scope.workspaceId} AND c."brandId" = ${scope.brandId} AND c.status = 'AWAITING_APPROVAL') AS "awaitingApproval"`;
  return { kind: "content", key: "brand.read", published: row?.published ?? 0, scheduled: row?.scheduled ?? 0, awaitingApproval: row?.awaitingApproval ?? 0 };
}

async function seoSection(scope: Scope): Promise<DigestSection> {
  const s = await synced(scope, "SEARCH_CONSOLE");
  if (!s?.syncedThrough) return { kind: "seo", key: "analytics.read", data: null };
  // syncedThrough is the last complete day held: the 7 days ending there (Google lags 2-3 days behind the week).
  const range = { from: addDays(s.syncedThrough, -6), to: s.syncedThrough };
  const sum = await searchSummary(scope, range, { manage: false });
  return { kind: "seo", key: "analytics.read", data: sum.hasSite ? { range, totals: sum.totals, previous: sum.previous } : null };
}

async function postsSection(scope: Scope, week: DateRange, now: Date): Promise<DigestSection> {
  const posts = await postsWithMetrics(scope, week, now);
  return {
    kind: "posts",
    key: "analytics.read",
    published: posts.length,
    top: posts.slice(0, 3).map((p) => ({ title: p.title, channel: p.channel, reach: p.metrics?.reach ?? null })),
  };
}

async function salesSection(scope: Scope, week: DateRange): Promise<DigestSection> {
  if (!(await synced(scope, "SHOPIFY_ORDERS"))) return { kind: "sales", key: "crm.read", data: null };
  const sum = await salesSummary(scope, week);
  // Revenue is net of VAT (decision 2); a currency without it gets no revenue figure, never the VAT-included one.
  return {
    kind: "sales",
    key: "crm.read",
    data: sum.currencies.map((c) => ({ currency: c.currency, orders: c.totals.orders, netExVat: c.netExVat, exVatFrom: c.exVatFrom, exVatMissing: c.exVatMissing })),
  };
}

/**
 * The week's ads figures, and the ads alerts RAISED in the 7 days before this digest's cutoff (weekAt +
 * AFTER_SWEEP_MS), by when they were raised, not by their day: a conversion alert's day is 3 days before it is
 * raised, so a day-overlap rule would drop one raised early in the week. With one fixed cutoff each alert lands in
 * exactly one weekly digest. Alerts are read even without synced data (an alert implies one, but don't depend on it).
 * Ceiling: a Monday sync finishing after the cutoff puts its alert in the next week's digest (never lost).
 */
async function adsSection(scope: Scope, week: DateRange, weekAt: Date): Promise<DigestSection> {
  const cutoff = weekAt.getTime() + AFTER_SWEEP_MS;
  const [source, raised] = await Promise.all([
    synced(scope, "META_ADS"),
    listAlerts(scope, { createdFrom: new Date(cutoff - 7 * 86_400_000), createdBefore: new Date(cutoff) }, DIGEST_ALERTS),
  ]);
  // adAlertText cleaned each text (one line, no control or bidi characters), so the plain-text email can't be forged.
  const alerts = raised.alerts.map((a) => ({ kind: a.kind, text: a.text, firstDay: a.firstDay, lastDay: a.lastDay }));
  const extra = alerts.length ? { alerts, ...(raised.more ? { moreAlerts: raised.more } : {}) } : {};
  if (!source) return { kind: "ads", key: "ads.read", data: null, ...extra };
  const sum = await adsSummary(scope, week);
  return {
    kind: "ads",
    key: "ads.read",
    data: sum.totals.map((t) => ({ currency: t.currency, spend: t.spend, purchases: t.purchases, purchaseValue: t.purchaseValue, roas: t.roas })),
    ...extra,
  };
}

/** One section's failure drops only that section (logged with the brand id); the rest of the digest goes out. */
async function guarded(brandId: string, kind: string, run: () => Promise<DigestSection>): Promise<DigestSection[]> {
  try {
    return [await run()];
  } catch (e) {
    console.error(`[digest] brand ${brandId}: ${kind} section failed`, e);
    return [];
  }
}

/** The keys the shared (non-task) sections depend on: the memo key. */
const SHARED_KEYS = ["brand.read", "analytics.read", "crm.read", "ads.read"] as const satisfies readonly PermissionKey[];
const MEMO_MS = 2 * 60 * 60_000;
const MEMO_MAX = 2_000;
const memo = new Map<string, { at: number; sections: Promise<DigestSection[]> }>();
/** Tests: forget the memoised sections. */
export const clearSectionMemo = () => memo.clear();

/**
 * The brand's sections other than tasks for this set of keys, built once per (brand, week, sweep, keys) and shared.
 * `weekAt`: the sweep the digest belongs to (the ads alerts' cutoff); defaults to `now`.
 */
export function brandSections(scope: Scope, perms: ReadonlySet<string>, week: DateRange, zone: string, now: Date, weekAt = now): Promise<DigestSection[]> {
  const keys = SHARED_KEYS.filter((k) => perms.has(k));
  const memoKey = `${scope.brandId}|${week.from}|${weekAt.toISOString()}|${keys.join(",")}`;
  const hit = memo.get(memoKey);
  if (hit && now.getTime() - hit.at < MEMO_MS) return hit.sections;
  const g = (kind: string, run: () => Promise<DigestSection>) => guarded(scope.brandId, kind, run);
  const sections = Promise.all([
    keys.includes("brand.read") ? g("content", () => contentSection(scope, week, zone, now)) : [],
    keys.includes("analytics.read") ? g("seo", () => seoSection(scope)) : [],
    keys.includes("analytics.read") ? g("posts", () => postsSection(scope, week, now)) : [],
    keys.includes("crm.read") ? g("sales", () => salesSection(scope, week)) : [],
    keys.includes("ads.read") ? g("ads", () => adsSection(scope, week, weekAt)) : [],
  ]).then((parts) => parts.flat());
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(memoKey, { at: now.getTime(), sections });
  return sections;
}

/** The reader's task counts on the brand, through THE visibility rule (visibleTaskSql): an unseen task never counts. */
async function tasksSection(
  scope: Scope & { userId: string; perms: Set<PermissionKey>; clientReviewer: boolean },
  week: DateRange,
  zone: string,
  now: Date,
): Promise<DigestSection> {
  const v = taskViewer(scope);
  const today = zoneToday(zone, now);
  const overdue = Prisma.sql`${openTaskSql} AND t."dueOn" < ${today}::date`;
  const [[counts], late] = await Promise.all([
    prisma.$queryRaw<{ done: number; open: number; overdue: number }[]>`
      SELECT count(*) FILTER (WHERE t.status = 'DONE' AND t."completedAt" >= ${localMidnight(week.from, zone)} AND t."completedAt" < ${localMidnight(addDays(week.to, 1), zone)})::int AS done,
             count(*) FILTER (WHERE ${openTaskSql})::int AS open,
             count(*) FILTER (WHERE ${overdue})::int AS overdue
      FROM "Task" t WHERE ${visibleTaskSql(v)}`,
    prisma.$queryRaw<{ id: string; title: string }[]>`
      SELECT t.id, t.title FROM "Task" t WHERE ${visibleTaskSql(v)} AND ${overdue} ORDER BY t."dueOn", t.id LIMIT 5`,
  ]);
  return {
    kind: "tasks",
    key: "tasks.read",
    crm: v.crm,
    done: counts?.done ?? 0,
    open: counts?.open ?? 0,
    overdue: counts?.overdue ?? 0,
    overdueTasks: late,
  };
}

/** Does the section say anything? A digest of only zeros and "No data yet" isn't written. */
function hasNews(s: DigestSection) {
  switch (s.kind) {
    case "content": return s.published + s.scheduled + s.awaitingApproval > 0;
    case "tasks": return s.done + s.open + s.overdue > 0;
    case "seo": return !!s.data && s.data.totals.impressions + s.data.previous.impressions > 0;
    case "posts": return s.published > 0;
    case "sales": return !!s.data?.length;
    case "ads": return !!s.data?.length || !!s.alerts?.length;
  }
}

/**
 * The reader's CURRENT permissions on each non-archived brand of the workspace they open (brand.read), worked out as
 * brandAccess does; null when they are no longer a member. The digest's builder, its page and its email all use it.
 */
export async function readerAccess(userId: string, workspaceId: string) {
  // Role and grants from the bell's own load (memberAccess); the brands and permissionsOf per brand stay here.
  const [{ found, grants }, brands] = await Promise.all([
    memberAccess(workspaceId, userId),
    prisma.brand.findMany({ where: { workspaceId, status: { not: "ARCHIVED" } }, select: { id: true, displayName: true }, orderBy: { createdAt: "asc" } }),
  ]);
  if (!found?.role) return null;
  const own = rolePermissions(found.role);
  const access = new Map<string, { brandName: string; perms: Set<PermissionKey>; clientReviewer: boolean }>();
  for (const b of brands) {
    const grant = grants.find((g) => g.brandId === b.id) ?? null;
    const perms = await permissionsOf(found, workspaceId, userId, b.id, grant);
    if (!perms.has("brand.read")) continue;
    access.set(b.id, { brandName: b.displayName, perms, clientReviewer: isClientMember(!!grant && isClientGrant(grant.role), own) });
  }
  return access;
}

/**
 * The reader's digest, or null when nothing to say (or no member). `weekAt`: the instant each brand's week is read at
 * (brandWeek; the job passes its sweep); `now`: what is scheduled and overdue.
 */
export async function buildDigest(userId: string, workspaceId: string, now = new Date(), weekAt = now): Promise<DigestBody | null> {
  const access = await readerAccess(userId, workspaceId);
  if (!access) return null;
  const brands: DigestBrand[] = [];
  for (const [brandId, a] of access) {
    const scope = { workspaceId, brandId };
    const zone = await brandTimeZone(scope);
    const week = brandWeek(zone, weekAt);
    const [shared, tasks] = await Promise.all([
      brandSections(scope, a.perms, week, zone, now, weekAt),
      a.perms.has("tasks.read") ? guarded(brandId, "tasks", () => tasksSection({ ...scope, userId, perms: a.perms, clientReviewer: a.clientReviewer }, week, zone, now)) : [],
    ]);
    const sections = [...shared.filter((s) => s.kind === "content"), ...tasks, ...shared.filter((s) => s.kind !== "content")];
    if (sections.some(hasNews)) brands.push({ brandId, brandName: a.brandName, week, sections });
  }
  return brands.length ? { brands } : null;
}

/**
 * A stored body as the reader may see it NOW: brands they no longer reach are removed, sections whose key they lost are
 * dropped (a tasks section that counted CRM tasks also needs inbox.read or crm.manage still). Brand names are today's.
 */
type Access = NonNullable<Awaited<ReturnType<typeof readerAccess>>>;
export function refilterDigest(body: DigestBody, access: Access): DigestBody {
  const brands = body.brands.flatMap((b) => {
    const a = access.get(b.brandId);
    if (!a) return [];
    const sections = b.sections.filter((s) => a.perms.has(s.key) && !(s.kind === "tasks" && s.crm && !handlesCustomers(a.perms)));
    return sections.length ? [{ ...b, brandName: a.brandName, sections }] : [];
  });
  return { brands };
}

/**
 * refilterDigest, then each overdue task named is kept only while the reader can still see it (visibleTaskSql), so a
 * task moved away from them leaves the page and the email; one query per brand with a tasks section. The counts stay
 * as built (numbers only, no titles).
 */
export async function readableDigest(body: DigestBody, userId: string, workspaceId: string, access: Access): Promise<DigestBody> {
  const filtered = refilterDigest(body, access);
  for (const b of filtered.brands) {
    const a = access.get(b.brandId)!;
    for (const s of b.sections) {
      if (s.kind !== "tasks" || !s.overdueTasks.length) continue;
      const v = taskViewer({ userId, workspaceId, brandId: b.brandId, perms: a.perms, clientReviewer: a.clientReviewer });
      const seen = await prisma.$queryRaw<{ id: string }[]>`
        SELECT t.id FROM "Task" t WHERE t.id IN (${Prisma.join(s.overdueTasks.map((t) => t.id))}) AND ${visibleTaskSql(v)}`;
      const ids = new Set(seen.map((r) => r.id));
      s.overdueTasks = s.overdueTasks.filter((t) => ids.has(t.id));
    }
  }
  return filtered;
}
