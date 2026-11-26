import { ContentChannel, type Prisma } from "@prisma/client";
import { tool } from "ai";
import { z } from "zod";
import { ProductPageQuery, productPageWhere, STOCK_UNKNOWN } from "@/server/catalog/products";
import {
  OPEN_STATUSES, parseRange, SEARCH_PAGE_SORTS, SEARCH_RANGE_MAX_DAYS, STATUS_GROUPS, stockLabel, type CatalogSync, type DateRange, type PostInsightDto,
} from "@/shared";
import {
  BREAKDOWNS, hasOrderLines, MAX_ANALYSIS_ROWS, MAX_RISK_ROWS, PRODUCT_GROUPS, productSales, salesBreakdown, stockRisk, TIME_BREAKDOWNS, topProducts, truncatedOrders,
} from "@/server/data/sales-analysis";
import { MAX_SALES_DAYS, salesSummary } from "@/server/data/sales-read";
import { addDays, badRangeDetail, brandTimeZone, liveSources, previousRange, rangeDays, zoneToday } from "@/server/data/sources";
import { ADS_MAX_DAYS, adsCampaigns, adsDays, D, shopRevenueOverSpend, totalsOf, type AdsDayRow } from "@/server/data/ads-read";
import { currentMonth, listBudgets, MonthSchema } from "@/server/data/budgets";
import { MAX_POSTS, POSTS_MAX_DAYS, postsWithMetrics } from "@/server/data/post-metrics-read";
import { searchPages, searchSummary } from "@/server/data/search-read";
import { CHAT_DATA_TOOLS, hiddenFor, MAX_DATA_CALLS, MAX_GROUP_CALLS, type ToolGroup } from "@/server/chat/turn";
import { AGENTS } from "@/server/agents/registry";
import { effectivePermissions } from "@/server/auth/permissions";
import { DEFAULT_TIME_ZONE } from "@/server/catalog/campaigns";
import { isTimeZone, wallTime } from "@/server/content/offer-checks";
import { prisma } from "@/server/db/prisma";
import { latestAuditReports } from "@/server/services/audit-reports";
import { CONTEXT_DOC_KINDS, listContextDocs } from "@/server/services/context-docs";
import { cleanTitle } from "@/server/text";
import { listAlerts } from "@/server/ads/alerts";

export type ChatScope = { workspaceId: string; brandId: string; userId: string };

const KINDS = CONTEXT_DOC_KINDS.map((k) => k.kind) as [string, ...string[]];
/** listPosts' filters → the statuses each reads (the shared groups, so chat counts match the apps). */
const POST_FILTERS = {
  upcoming: [...OPEN_STATUSES],
  "awaiting-approval": [...STATUS_GROUPS.awaiting],
  published: [...STATUS_GROUPS.published],
} as const;
// A post whose time passed this recently may still be publishing: not overdue yet.
const OVERDUE_GRACE_MS = 15 * 60_000;

// Saved threads are validated against these schemas: they may only widen (new optional fields, higher caps), never narrow.
/** A tool's optional period: both days, or neither for the tool's default (`defaultHint` says which). */
const rangeInput = (defaultHint: string) =>
  z.object({
    from: z.string().max(10).optional().describe("YYYY-MM-DD, brand-local, inclusive; with to"),
    to: z.string().max(10).optional().describe(`YYYY-MM-DD, inclusive; ${defaultHint}`),
  });
const SalesRange = rangeInput("leave both out for the last 30 days");
const NEEDS_LINES =
  "Per-product sales need order line items, which only come through the AskCart connection once AskCart sends them; none are stored for this brand yet. salesSummary and salesBreakdown still work from order totals.";
const LINE_NOTE =
  "From order line items: units and revenue are net of refunds, revenue after every discount (order-level share included), and include VAT where the shop's prices do (unlike salesSummary's netExVat). Lines without a product (custom lines, deleted products) are 'Other / custom items'.";
const DATA_LIMIT = { error: "Data tool limit reached for this message." };
const GROUP_NAME: Record<ToolGroup, string> = { sales: "Sales", ads: "Ads", analytics: "Analytics" };
const NO_ADS = { note: "Meta Ads isn't connected or hasn't finished its first sync." };
const ADS_NOTES = {
  currencyNote: "Amounts are per ad account currency; never add currencies together.",
  attributionNote: "Meta keeps attributing purchases for 7 days, so the last few days can still grow.",
};
const OFF_NOTE = "Switched-off ad accounts are left out.";
/** Recent ads alerts adsSummary lists: seen in the last 7 days (conversion kinds dated 3 days back count from then). */
const ALERT_DAYS = 7;
const CHAT_ALERTS = 10;
const ALERTS_NOTE = "Alerts are checked once a day after the Meta Ads sync; ROAS and no-purchase alerts look at the day 3 days back.";
const RATIO_WHY: Record<string, string> = {
  no_spend: "No Meta spend in this period, so there is no ratio.",
  currencies: "The shop sold in several currencies in this period, so one ratio can't be given.",
  no_revenue: "Shop net sales without VAT aren't known for this whole period, so there is no ratio.",
  no_rate: "An exchange rate is missing to convert the ad spend, so there is no ratio.",
  vat_missing: "Some orders' VAT couldn't be read, so revenue would read low; no ratio given.",
};
const POST_METRICS = ["reach", "views", "likes", "comments", "shares", "saves", "interactions"] as const;
const POST_NOTES = [
  "Numbers are each post's latest read; posts under 30 days old can still grow (final: false).",
  "Story reach is the highest frame's reach.",
  "Unread: the platform hasn't been read yet or the account lacks insights permission.",
];
const SEARCH_NOTES = [
  "Days are Google's (Pacific time) and lag 2–3 days.",
  "Only site totals and the top pages per day are stored; search queries (keywords) aren't synced, so they can't be answered here.",
  "Page sums sit below the site total.",
];
const NO_SEARCH = { note: "Search Console isn't connected or hasn't finished its first sync." };

/**
 * Posts ranked by one metric, unread posts (and posts the platform gives no such number for) last; ties keep
 * postsWithMetrics' order (most reach first).
 */
function rankPosts(posts: PostInsightDto[], by: (typeof POST_METRICS)[number]) {
  const value = (p: PostInsightDto) => p.metrics?.[by] ?? null;
  return [...posts].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    return x === null ? (y === null ? 0 : 1) : y === null ? -1 : y - x;
  });
}

const PACING_NOTE: Record<string, string> = {
  no_data: "No Meta spend synced for this month yet.",
  no_rate: "No exchange rate yet to convert spend into the budget currency.",
  google_later: "Google Ads spend arrives in Phase 3.",
};

/**
 * adsDays rows folded per currency: the totals (totalsOf) plus impressions, clicks, CTR (clicks ÷ impressions) and
 * cost per click, each null when its divisor is 0. Never adds across currencies.
 */
function foldAds(rows: AdsDayRow[]) {
  const by = new Map<string, { spend: ReturnType<typeof D>; value: ReturnType<typeof D>; purchases: number; impressions: number; clicks: number }>();
  for (const r of rows) {
    const t = by.get(r.currency) ?? { spend: D(0), value: D(0), purchases: 0, impressions: 0, clicks: 0 };
    by.set(r.currency, { spend: t.spend.plus(r.spend), value: t.value.plus(r.purchaseValue), purchases: t.purchases + r.purchases, impressions: t.impressions + r.impressions, clicks: t.clicks + r.clicks });
  }
  return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([currency, t]) => ({
    ...totalsOf(currency, t.spend, t.purchases, t.value),
    impressions: t.impressions,
    clicks: t.clicks,
    ctr: t.impressions ? Math.round((t.clicks / t.impressions) * 10_000) / 10_000 : null,
    cpc: t.clicks ? t.spend.div(t.clicks).toFixed(2) : null,
  }));
}
const WEEKS_NOTE = "Weeks start on Monday and are labelled by that day; the first and last weeks can be partial.";
/** stockRisk flags a best seller with less stock than this many days of its average sales. */
const LOW_COVER_DAYS = 14;
/** A shop text cell (SKU and the like) cleaned like a title; null stays null. */
const clean = (v: string | null) => (v === null ? null : cleanTitle(v));

const RUNNABLE = AGENTS.filter((a) => a.key !== "systems-check" && !a.internal).map((a) => a.key) as [string, ...string[]];

/**
 * What the CMO chat may do. Read-only access to this brand's documents, reports, products, shop sales, posts and agents, and
 * offering an agent run (the person starts it with a button; same permission check as the Run button). Deliberately no tool that
 * publishes, posts, replies, spends or approves: drafts only, people decide (design §4.4).
 */
export function chatTools(scope: ChatScope) {
  // Chat sees exactly what the person's role can see on screen: same permissions as the matching pages.
  let perms: Promise<Set<string>> | undefined;
  const can = async (p: string) => (await (perms ??= effectivePermissions(scope.workspaceId, scope.userId, scope.brandId))).has(p);
  const denied = (what: string) => ({ error: `Your role can't see ${what}.` });
  // Data tools (CHAT_DATA_TOOLS): every key the tool needs, then at most MAX_GROUP_CALLS calls per group and
  // MAX_DATA_CALLS in all per message (one chatTools per message). Counted here as well as by the route's activeTools,
  // which can't stop several calls made in parallel within one step. A refused call counts against nothing.
  const groupCalls: Partial<Record<ToolGroup, number>> = {};
  let dataCalls = 0;
  const gate = async (name: string) => {
    const { keys, group } = CHAT_DATA_TOOLS[name];
    const refusal = hiddenFor(keys, await (perms ??= effectivePermissions(scope.workspaceId, scope.userId, scope.brandId)));
    if (refusal) return refusal;
    // No await between the checks and the counts, so calls made in parallel can't both take the last slot.
    if ((groupCalls[group] ?? 0) >= MAX_GROUP_CALLS) return { error: `${GROUP_NAME[group]} tool limit reached for this message.` };
    if (dataCalls >= MAX_DATA_CALLS) return DATA_LIMIT;
    groupCalls[group] = (groupCalls[group] ?? 0) + 1;
    dataCalls++;
    return null;
  };
  // A data tool's period: both days given (validated like the matching tab's, up to the tool's own maximum), or
  // `defaultDays` days ending at `defaultEnd` (default: brand-local today). A defaultEnd without a day gives its note.
  const rangeOf = async (
    { from, to }: { from?: string; to?: string },
    maxDays: number,
    defaultEnd?: () => Promise<string | { note: string }>,
    defaultDays = 30,
  ): Promise<DateRange | { error: string } | { note: string }> => {
    if (from || to) return parseRange(from, to, maxDays) ?? { error: badRangeDetail(maxDays) };
    let end: string | { note: string };
    if (defaultEnd) end = await defaultEnd();
    else {
      const zone = await brandTimeZone(scope);
      end = zoneToday(isTimeZone(zone) ? zone : DEFAULT_TIME_ZONE);
    }
    return typeof end === "string" ? { from: addDays(end, 1 - defaultDays), to: end } : end;
  };
  // The brand's Meta Ads accounts that are on, read once per message and shared by the ads tools (like perms).
  let ads: ReturnType<typeof liveSources> | undefined;
  const adSources = () => (ads ??= liveSources(scope, "META_ADS"));
  // The ads tools' period: both days given, or the 30 days ending at the last day every live account has synced.
  // Either way, no live account that has finished its first sync gives the not-connected note, not empty figures.
  const adsRange = async (input: { from?: string; to?: string }) => {
    const range = await rangeOf(input, ADS_MAX_DAYS, async () => (await adSources()).syncedThrough ?? NO_ADS);
    return "from" in range && (await adSources()).syncedThrough === null ? NO_ADS : range;
  };
  // Per-product numbers miss lines of orders AskCart sent incomplete (re-read by the sync within a day). Counted once
  // per period in a message: a report makes several sales calls over one period, often in parallel, so the promise is
  // kept and shared. A failed count is dropped, so a later call can try again.
  const truncated = new Map<string, Promise<string[]>>();
  const truncatedNote = (range: DateRange) => {
    const key = `${range.from}|${range.to}`;
    let note = truncated.get(key);
    if (!note) {
      note = truncatedOrders(scope, range).then((n) =>
        n ? [`${n} order${n === 1 ? "" : "s"} in this period have incomplete line items, so per-product numbers may be slightly low.`] : [],
      );
      note.catch(() => truncated.delete(key));
      truncated.set(key, note);
    }
    return note;
  };
  return {
    listDocuments: tool({
      description: "List the brand's five strategy documents with their status (draft or confirmed by the team).",
      inputSchema: z.object({}),
      execute: async () => {
        if (!(await can("agents.read"))) return denied("the strategy documents");
        const docs = await listContextDocs(scope.workspaceId, scope.brandId);
        return docs.map((d) => ({
          kind: d.kind,
          title: d.title,
          status: d.latest ? (d.latest.status === "CONFIRMED" ? "reviewed by the team" : "current") : "not written yet",
        }));
      },
    }),

    readDocument: tool({
      description:
        "Read one strategy document. Prefer it over guessing: product information, marketing strategy, competitor analysis, brand voice, content strategy.",
      inputSchema: z.object({ kind: z.enum(KINDS) }),
      execute: async ({ kind }) => {
        if (!(await can("agents.read"))) return denied("the strategy documents");
        const doc = (await listContextDocs(scope.workspaceId, scope.brandId)).find((d) => d.kind === kind);
        const use = doc?.latest;
        if (!doc || !use) return { kind, status: "not written yet" };
        return {
          kind,
          title: doc.title,
          status: use.status === "CONFIRMED" ? "reviewed by the team" : "current",
          markdown: use.markdown.slice(0, 12_000),
        };
      },
    }),

    getSiteReports: tool({
      description: "Latest SEO audit and AI-visibility (GEO) report: scores, summaries, top fixes, competitors AI recommends.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!(await can("analytics.read"))) return denied("the site reports");
        const { seo, geo } = await latestAuditReports(scope.workspaceId, scope.brandId);
        const brief = (r: typeof seo) =>
          r && {
            score: r.score,
            summary: r.summary,
            ranAt: r.createdAt.toISOString(),
            topFixes: (r.findings as { title: string; severity: string; fix: string }[]).slice(0, 6),
          };
        const m = (geo?.metrics ?? {}) as { competitors?: unknown; questions?: unknown; visibility?: number };
        return {
          seo: brief(seo) ?? "No SEO report yet",
          geo: geo ? { ...brief(geo), visibility: m.visibility, competitors: m.competitors, questions: m.questions } : "No GEO report yet",
        };
      },
    }),

    listAgents: tool({
      description: "List the agents for this brand and the status of their latest run.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!(await can("agents.read"))) return denied("the agents");
        const runs = await prisma.agentRun.findMany({
          where: { workspaceId: scope.workspaceId, brandId: scope.brandId },
          orderBy: { createdAt: "desc" },
          distinct: ["agentKey"],
          select: { agentKey: true, status: true, finishedAt: true, error: true },
        });
        return AGENTS.filter((a) => a.key !== "systems-check" && !a.internal).map((a) => {
          const r = runs.find((x) => x.agentKey === a.key);
          return { key: a.key, name: a.name, does: a.description, lastRun: r ? { status: r.status, finishedAt: r.finishedAt?.toISOString() ?? null, error: r.error?.slice(0, 200) ?? null } : null };
        });
      },
    }),

    catalogueSummary: tool({
      description:
        "Overview of the brand's product catalogue (each row is a variant, e.g. a size or colour): how many variants, how many in stock / out / unknown, price range and median per currency, top categories, when it last synced.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!(await can("brand.read"))) return denied("the products");
        // One scope for every query, from the session (never the model): this brand's active variants.
        const where = { workspaceId: scope.workspaceId, brandId: scope.brandId, archivedAt: null };
        const [total, inStock, unknown, categories, prices, profile] = await Promise.all([
          prisma.product.count({ where }),
          prisma.product.count({ where: { ...where, ...productPageWhere({ q: "", stock: "in" }) } }),
          prisma.product.count({ where: { ...where, ...STOCK_UNKNOWN } }),
          // Ordered by every row (id), not by category: a count of category skips nulls and would drop "uncategorised".
          prisma.product.groupBy({ by: ["category"], where, _count: { _all: true }, orderBy: { _count: { id: "desc" } }, take: 15 }),
          // Median in SQL: Prisma's Decimals would sort as text in JS, and this reads one row per currency, not every price.
          prisma.$queryRaw<{ currency: string; priced: number; min: string; median: string; max: string }[]>`
            SELECT coalesce(currency, 'unknown') AS currency, count(*)::int AS priced, min(price)::text AS min,
                   (percentile_cont(0.5) WITHIN GROUP (ORDER BY price))::numeric(12,2)::text AS median, max(price)::text AS max
            FROM "Product"
            WHERE "workspaceId" = ${scope.workspaceId} AND "brandId" = ${scope.brandId} AND "archivedAt" IS NULL AND price IS NOT NULL
            GROUP BY 1 ORDER BY priced DESC LIMIT 5`,
          prisma.brandProfile.findFirst({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId }, select: { catalogSync: true } }),
        ]);
        // Only when and how much: the sync's error/reason text is raw provider output and stays out of the model.
        const sync = profile?.catalogSync as CatalogSync | null | undefined;
        return {
          variants: total,
          // Three counts, not one snapshot: a sync landing between them must not make "out" negative.
          stock: { in: inStock, out: Math.max(0, total - inStock - unknown), unknown },
          prices,
          topCategories: categories.map((c) => ({ category: c.category ?? "uncategorised", variants: c._count._all })),
          lastSync: sync ? { at: sync.at, source: sync.source, variants: sync.count } : "never synced",
        };
      },
    }),

    // ponytail: offset-free top-N over the brand's rows; ILIKE and price sorts read every row of the brand, ~15–30 ms at
    // 20k variants. Past that add a pg_trgm GIN index on title/sku and an index on (brandId, price).
    findProducts: tool({
      description:
        "Find the brand's product variants by title/SKU text and stock, sorted by newest update or price. Returns a few rows as columns + rows. Use catalogueSummary for totals; ask for links only when the person wants them.",
      // Saved threads are validated against this schema: it may only widen (new optional fields, higher caps), never narrow.
      inputSchema: ProductPageQuery.pick({ q: true, stock: true }).extend({
        sort: z.enum(["updated", "price-asc", "price-desc"]).default("updated"),
        limit: z.number().int().min(1).max(25).default(10),
        withLinks: z.boolean().default(false),
      }),
      execute: async ({ q, stock, sort, limit, withLinks }) => {
        if (!(await can("brand.read"))) return denied("the products");
        // The Products table's own search and stock filter ("out" includes unknown; each row's stock label tells them apart).
        const where = { workspaceId: scope.workspaceId, brandId: scope.brandId, archivedAt: null, ...productPageWhere({ q, stock }) };
        const orderBy: Prisma.ProductOrderByWithRelationInput[] =
          sort === "updated"
            ? [{ updatedAt: "desc" }, { id: "desc" }]
            : [{ price: { sort: sort === "price-asc" ? "asc" : "desc", nulls: "last" } }, { id: "asc" }];
        const [total, rows] = await Promise.all([
          prisma.product.count({ where }),
          prisma.product.findMany({
            where,
            orderBy,
            take: limit,
            select: { title: true, sku: true, category: true, price: true, compareAtPrice: true, currency: true, inStock: true, stockQuantity: true, url: true },
          }),
        ]);
        // Columns once, not keys on every row (about 40% fewer tokens; the history resends them every turn), and a
        // column that's empty on every row (often SKU, compare-at price) left out.
        const all: [string, (p: (typeof rows)[number]) => string | null][] = [
          ["title", (p) => p.title],
          ["sku", (p) => p.sku],
          ["category", (p) => p.category],
          ["price", (p) => p.price?.toFixed(2) ?? null],
          ["compareAt", (p) => p.compareAtPrice?.toFixed(2) ?? null],
          ["currency", (p) => p.currency],
          ["stock", (p) => stockLabel(p)],
        ];
        if (withLinks) all.push(["url", (p) => p.url]);
        const used = all.filter(([, get]) => rows.some((p) => get(p) !== null));
        return {
          matchingVariants: total,
          columns: used.map(([name]) => name),
          rows: rows.map((p) => used.map(([, get]) => get(p))),
        };
      },
    }),

    // ponytail: filters by [workspaceId, brandId, status] and sorts the brand's matching posts in memory; add an index on (brandId, status, scheduledFor) if a brand
    // reaches ~100k posts.
    listPosts: tool({
      description:
        "List this brand's posts (titles, channel, status, date in the brand's time zone): upcoming = every open post, overdue ones included and flagged; awaiting-approval; or published. Use before saying what is planned or scheduled.",
      // Saved threads are validated against this schema: it may only widen (new optional fields, higher caps), never narrow.
      inputSchema: z.object({
        channel: z.nativeEnum(ContentChannel).optional(),
        status: z.enum(["upcoming", "awaiting-approval", "published"]).default("upcoming"),
        limit: z.number().int().min(1).max(20).default(10),
      }),
      execute: async ({ channel, status, limit }) => {
        if (!(await can("brand.read"))) return denied("the posts");
        // Scope from the session (never the model); CANCELLED is in no filter.
        const where: Prisma.ContentItemWhereInput = {
          workspaceId: scope.workspaceId,
          brandId: scope.brandId,
          status: { in: [...POST_FILTERS[status]] },
          ...(channel ? { channel } : {}),
        };
        const dir = status === "published" ? "desc" : "asc";
        const [rows, counts, profile] = await Promise.all([
          prisma.contentItem.findMany({
            where,
            orderBy: [{ scheduledFor: { sort: dir, nulls: "last" } }, { id: dir }],
            take: limit + 1,
            select: { title: true, channel: true, status: true, scheduledFor: true },
          }),
          prisma.contentItem.groupBy({ by: ["status"], where, _count: { _all: true } }),
          prisma.brandProfile.findFirst({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId }, select: { timeZone: true } }),
        ]);
        const timeZone = profile?.timeZone && isTimeZone(profile.timeZone) ? profile.timeZone : DEFAULT_TIME_ZONE;
        const now = new Date();
        // REVIEWED is a published post the team has looked back on: shown as Published.
        const shown = (s: string) => ((STATUS_GROUPS.published as readonly string[]).includes(s) ? "PUBLISHED" : s);
        const byStatus: Record<string, number> = {};
        for (const c of counts) byStatus[shown(c.status)] = (byStatus[shown(c.status)] ?? 0) + c._count._all;
        return {
          now: wallTime(now, timeZone),
          timeZone,
          posts: rows.slice(0, limit).map((p) => ({
            title: cleanTitle(p.title),
            channel: p.channel,
            status: shown(p.status),
            when: p.scheduledFor ? wallTime(p.scheduledFor, timeZone) : null,
            ...(status !== "published" && p.scheduledFor && p.scheduledFor.getTime() < now.getTime() - OVERDUE_GRACE_MS ? { overdue: true } : {}),
          })),
          byStatus,
          more: rows.length > limit,
        };
      },
    }),

    // Sales: read-only, from our own ShopOrder / ShopOrderLine / Product rows; crm.read, like the Sales tab. Every text
    // cell from the shop (titles, SKUs, codes, channels, collections, vendors) goes through cleanTitle.
    salesSummary: tool({
      description:
        "Shop sales totals for a period (brand-local days, default the last 30 days): orders, gross, discounts, net sales, total, refunded per currency, with the same-length previous period to compare; daily rows when the period is 31 days or less. Start any sales question or report here. netExVat: net sales without VAT, from exVatFrom when set (null: not known yet); exVatMissing orders are left out of it. The other totals include VAT where the shop's prices do.",
      inputSchema: SalesRange,
      execute: async (input) => {
        const refused = await gate("salesSummary");
        if (refused) return refused;
        const range = await rangeOf(input, MAX_SALES_DAYS);
        if (!("from" in range)) return range;
        const { currencies } = await salesSummary(scope, range);
        if (!currencies.length) return { ...range, note: "No orders in this period (test and cancelled orders are left out), or the shop's orders aren't synced." };
        const withDays = rangeDays(range) <= 31;
        return {
          ...range,
          currencies: currencies.map((c) => ({
            currency: c.currency,
            totals: c.totals,
            previous: c.previous,
            netExVat: c.netExVat,
            exVatFrom: c.exVatFrom,
            exVatMissing: c.exVatMissing,
            ...(withDays && {
              days: { columns: ["day", "orders", "netSales", "total"], rows: c.days.map((d) => [d.day, d.orders, d.netSales, d.total]) },
            }),
          })),
        };
      },
    }),

    salesBreakdown: tool({
      description:
        "Shop sales split by one dimension for a period: day, week, month or weekday (trends, best days), channel (sales channel), fulfillmentStatus, financialStatus (paid, refunded…), discountCode (which codes drive orders; codes used on fewer than 2 orders are grouped as '(other codes)' because one-time codes can be personal), collection or vendor (from line items and the catalogue). Per currency: orders, gross, discounts, net sales, total, refunded, average order value (collection/vendor: orders, net units, net revenue). Amounts include VAT where the shop's prices do (salesSummary's netExVat doesn't). At most 60 rows; use week or month for long periods.",
      inputSchema: SalesRange.extend({
        by: z.enum(BREAKDOWNS),
        limit: z.number().int().min(1).max(MAX_ANALYSIS_ROWS).default(MAX_ANALYSIS_ROWS),
      }),
      execute: async ({ by, limit, ...input }) => {
        const refused = await gate("salesBreakdown");
        if (refused) return refused;
        const range = await rangeOf(input, MAX_SALES_DAYS);
        if (!("from" in range)) return range;
        const lineBased = by === "collection" || by === "vendor";
        const [{ columns, rows, moreGroups }, truncated] = await Promise.all([
          salesBreakdown(scope, range, by, limit),
          lineBased ? truncatedNote(range) : Promise.resolve([]),
        ]);
        if (lineBased && !rows.length && !(await hasOrderLines(scope))) return { ...range, by, note: NEEDS_LINES };
        const notes = [
          ...(moreGroups ? [`${moreGroups} more groups not shown (each currency shows its top ones${TIME_BREAKDOWNS.includes(by) ? ", the most recent" : ""}).`] : []),
          ...(by === "week" ? [WEEKS_NOTE] : []),
          ...(by === "fulfillmentStatus" || by === "financialStatus" || by === "discountCode" ? ["Only orders read through AskCart carry statuses and codes; older ones show (not sent) / (none)."] : []),
          ...(lineBased ? [LINE_NOTE, ...truncated] : []),
        ];
        return { ...range, by, columns, rows: rows.map(([key, ...rest]) => [cleanTitle(String(key)), ...rest]), ...(notes.length && { notes }) };
      },
    }),

    topProducts: tool({
      description:
        "Best-selling products in a period, ranked by net revenue or net units, per currency (group: product, or collection / vendor). From order line items (AskCart). Use for 'what sells', top sellers and ranking products.",
      inputSchema: SalesRange.extend({
        rankBy: z.enum(["revenue", "units"]).default("revenue"),
        group: z.enum(PRODUCT_GROUPS).default("product"),
        limit: z.number().int().min(1).max(25).default(10),
      }),
      execute: async ({ rankBy, group, limit, ...input }) => {
        const refused = await gate("topProducts");
        if (refused) return refused;
        const range = await rangeOf(input, MAX_SALES_DAYS);
        if (!("from" in range)) return range;
        const [{ rows, moreGroups }, truncated] = await Promise.all([topProducts(scope, range, rankBy, group, limit), truncatedNote(range)]);
        if (!rows.length) return { ...range, rankBy, group, note: (await hasOrderLines(scope)) ? "No products sold in this period." : NEEDS_LINES };
        return {
          ...range,
          rankBy,
          group,
          columns: [group, "currency", "units", "revenue", "orders"],
          rows: rows.map(([name, ...rest]) => [cleanTitle(String(name)), ...rest]),
          notes: [...(moreGroups ? [`${moreGroups} more not shown.`] : []), LINE_NOTE, ...truncated],
        };
      },
    }),

    productSales: tool({
      description:
        "How one product (or every product, without q) is selling: its variants matching the title/SKU text with net units, net revenue, current price and stock, plus weekly units and revenue over the period. Use for 'how is X selling'.",
      inputSchema: SalesRange.extend({ q: z.string().max(100).default("") }),
      execute: async ({ q, ...input }) => {
        const refused = await gate("productSales");
        if (refused) return refused;
        const range = await rangeOf(input, MAX_SALES_DAYS);
        if (!("from" in range)) return range;
        const [{ variants, weeks }, truncated] = await Promise.all([productSales(scope, range, q.trim()), truncatedNote(range)]);
        if (!variants.length) {
          if (!(await hasOrderLines(scope))) return { ...range, q, note: NEEDS_LINES };
          return { ...range, q, note: "Nothing matching sold in this period. findProducts shows whether it is in the catalogue." };
        }
        return {
          ...range,
          q,
          variants: {
            columns: ["variant", "sku", "currency", "units", "revenue", "orders", "price", "stock"],
            rows: variants.map((v) => [
              cleanTitle(v.title), clean(v.sku), v.currency, v.units, v.revenue.toFixed(2), v.orders, v.price?.toFixed(2) ?? null,
              v.in_catalogue ? stockLabel({ inStock: v.in_stock, stockQuantity: v.stock_quantity }) : "not in catalogue",
            ]),
          },
          weeks: { columns: ["weekStarting", "currency", "units", "revenue"], rows: weeks.map((w) => [w.week, w.currency, w.units, w.revenue.toFixed(2)]) },
          notes: [LINE_NOTE, WEEKS_NOTE, ...truncated],
        };
      },
    }),

    stockRisk: tool({
      description:
        "Stock against sales: the period's best sellers (by net units) with current stock and estimated days of cover (stock ÷ average daily units), lowest cover first, flagging sold-out best sellers; plus slow movers (in stock, few sales for the stock held). Use for restock and clearance advice.",
      inputSchema: SalesRange.extend({ limit: z.number().int().min(1).max(MAX_RISK_ROWS).default(20) }),
      execute: async ({ limit, ...input }) => {
        const refused = await gate("stockRisk");
        if (refused) return refused;
        const range = await rangeOf(input, MAX_SALES_DAYS);
        if (!("from" in range)) return range;
        const [{ sellers, slow }, truncated] = await Promise.all([stockRisk(scope, range, limit), truncatedNote(range)]);
        if (!sellers.length) return { ...range, note: (await hasOrderLines(scope)) ? "No products sold in this period." : NEEDS_LINES };
        const n = rangeDays(range);
        const rows = sellers.map((s) => {
          const perDay = s.units / n;
          const soldOut = s.in_catalogue && ((s.stock_quantity !== null && s.stock_quantity <= 0) || (s.stock_quantity === null && s.in_stock === false));
          const cover = soldOut ? 0 : s.stock_quantity !== null && perDay > 0 ? Math.round(s.stock_quantity / perDay) : null;
          const flag = !s.in_catalogue ? "not in catalogue" : soldOut ? "sold out" : cover !== null && cover < LOW_COVER_DAYS ? "low cover" : null;
          return { row: [cleanTitle(s.title), clean(s.sku), s.units, Math.round(perDay * 100) / 100, s.in_catalogue ? s.stock_quantity : null, cover, flag], cover };
        });
        rows.sort((a, b) => (a.cover ?? Infinity) - (b.cover ?? Infinity));
        return {
          ...range,
          bestSellers: { columns: ["variant", "sku", "units", "unitsPerDay", "stock", "daysOfCover", "flag"], rows: rows.map((r) => r.row) },
          slowMovers: {
            columns: ["variant", "sku", "stock", "unitsSold", "daysOfCover"],
            rows: slow.map((s) => [cleanTitle(s.title), clean(s.sku), s.stock_quantity, s.units, s.units ? Math.round(s.stock_quantity / (s.units / n)) : null]),
          },
          notes: [
            `Stock is the catalogue's last sync; low cover = under ${LOW_COVER_DAYS} days; daysOfCover null = stock not tracked, or no sales (slow movers).`,
            ...truncated,
          ],
        };
      },
    }),

    // Meta Ads: read-only, from our own AdDay rows and budgets; ads.read, like the Ads tab. Unlike the tab, the chat
    // leaves switched-off ad accounts out (as pacing and the ratio do), so its figures never contradict each other.
    adsSummary: tool({
      description:
        "Meta Ads totals per currency for a period (default the last 30 synced days): spend, impressions, clicks, CTR, cost per click, purchases, purchase value, ROAS, cost per purchase, with the same-length previous period; daily rows when the period is 31 days or less; and recent ads alerts. Start any ads question here.",
      inputSchema: rangeInput("leave both out for the last 30 synced days"),
      execute: async (input) => {
        const refused = await gate("adsSummary");
        if (refused) return refused;
        const range = await adsRange(input);
        if (!("from" in range)) return range;
        const live = await adSources();
        const prev = previousRange(range);
        // adsDays, not the Ads tab's adsSummary reader: that one adds shop revenue ÷ spend, a sales figure.
        const [now, before, recent] = await Promise.all([
          adsDays(scope, range, live.externalIds),
          adsDays(scope, prev, live.externalIds),
          listAlerts(scope, { recentFrom: addDays(new Date().toISOString().slice(0, 10), -ALERT_DAYS) }, CHAT_ALERTS),
        ]);
        const roas = (r: AdsDayRow) => (r.spend.isZero() ? null : r.purchaseValue.div(r.spend).toDecimalPlaces(2).toNumber());
        return {
          ...range,
          syncedThrough: live.syncedThrough,
          totals: foldAds(now),
          previousRange: prev,
          previous: foldAds(before),
          ...(rangeDays(range) <= 31 && {
            days: {
              columns: ["day", "currency", "spend", "impressions", "clicks", "purchases", "roas"],
              rows: now.map((r) => [r.day, r.currency, r.spend.toFixed(2), r.impressions, r.clicks, r.purchases, roas(r)]),
            },
          }),
          // The alert text is adAlertText's: campaign names cleaned there. The prompt asks to mention the open ones.
          alerts: { columns: ["kind", "text", "day", "lastSeen", "open"], rows: recent.alerts.map((a) => [a.kind, a.text, a.firstDay, a.lastDay, a.open]) },
          ...(recent.more > 0 && { moreAlerts: recent.more }),
          ...(recent.alerts.length > 0 && { alertsNote: ALERTS_NOTE }),
          ...ADS_NOTES,
          ...(live.offCount > 0 && { offNote: OFF_NOTE }),
        };
      },
    }),

    // ponytail: sorts all of a period's campaigns in memory; a year at ~100 campaigns is fine. Past ~5k campaign rows
    // per range, rank in SQL.
    adCampaigns: tool({
      description:
        "Meta Ads campaigns for a period (default the last 30 synced days), ranked by spend, purchases or ROAS: spend, impressions, clicks, purchases, ROAS and cost per purchase per campaign, in its ad account's currency. Use for which campaigns work or waste money.",
      inputSchema: rangeInput("leave both out for the last 30 synced days").extend({
        limit: z.number().int().min(1).max(MAX_ANALYSIS_ROWS).default(20),
        rankBy: z.enum(["spend", "purchases", "roas"]).default("spend"),
      }),
      execute: async ({ limit, rankBy, ...input }) => {
        const refused = await gate("adCampaigns");
        if (refused) return refused;
        const range = await adsRange(input);
        if (!("from" in range)) return range;
        const live = await adSources();
        const ids = new Set(live.externalIds);
        // The Ads tab's reader, unchanged; switched-off accounts are dropped here.
        const all = (await adsCampaigns(scope, range)).filter((c) => ids.has(c.accountId));
        const key = (c: (typeof all)[number]) => (rankBy === "spend" ? Number(c.spend) : rankBy === "purchases" ? c.purchases : c.roas);
        all.sort((a, b) => (key(b) ?? -Infinity) - (key(a) ?? -Infinity));
        const shown = all.slice(0, limit);
        return {
          ...range,
          rankBy,
          columns: ["campaign", "account", "currency", "spend", "impressions", "clicks", "purchases", "roas", "costPerPurchase"],
          rows: shown.map((c) => [cleanTitle(c.campaignName), c.accountId, c.currency, c.spend, c.impressions, c.clicks, c.purchases, c.roas, c.costPerPurchase]),
          ...(all.length > limit && { moreCampaigns: all.length - limit }),
          ...ADS_NOTES,
          ...(live.offCount > 0 && { offNote: OFF_NOTE }),
        };
      },
    }),

    adBudgets: tool({
      description:
        "The month's ad budgets per platform and Meta's pacing against them (spend so far, converted to the budget currency, vs budget × days elapsed ÷ days in the month: under, on or over). Default the current month.",
      // The month is checked in execute, not in the schema: MonthSchema's window moves with today, and a saved
      // thread's month must keep validating once it falls out of it.
      inputSchema: z.object({ month: z.string().max(7).optional().describe("YYYY-MM; leave out for the current month") }),
      execute: async ({ month = currentMonth() }) => {
        const refused = await gate("adBudgets");
        if (refused) return refused;
        if (!MonthSchema.safeParse(month).success) return { error: "month must be YYYY-MM, from 24 months back to 12 ahead." };
        const { budgets, pacing } = await listBudgets(scope, month);
        const notes = pacing.map((p) =>
          p.state === "ok"
            ? p.staleRateFrom ? `Spend converted at ECB rates; uses a rate from ${p.staleRateFrom}.` : null
            : PACING_NOTE[p.state],
        ).filter((n): n is string => !!n);
        return {
          month,
          budgets: budgets.map((b) => ({ platform: b.platform, amount: b.amount, currency: b.currency })),
          pacing,
          ...(!budgets.length && { note: "No ad budget set for this month." }),
          ...(notes.length && { notes: [...new Set(notes)] }),
        };
      },
    }),

    revenuePerAdSpend: tool({
      description:
        "Shop revenue ÷ Meta ad spend for a period (default the last 30 synced days): shop net sales without VAT divided by the ad spend converted to the shop's currency. Needs sales access as well as ads.",
      inputSchema: rangeInput("leave both out for the last 30 synced days"),
      execute: async (input) => {
        const refused = await gate("revenuePerAdSpend");
        if (refused) return refused;
        const range = await adsRange(input);
        if (!("from" in range)) return range;
        const { ratio, currency, why, staleRateFrom } = await shopRevenueOverSpend(scope, range);
        const notes = [
          ...(currency ? [`Shop net sales without VAT ÷ Meta spend converted to ${currency} at the ECB daily rates.`] : []),
          "Shopify days and ad account days may differ by a few hours.",
          ...(staleRateFrom ? [`Uses a rate from ${staleRateFrom}.`] : []),
          ...(why ? [RATIO_WHY[why]] : []),
        ];
        return { ...range, ratio, currency, why, staleRateFrom, notes };
      },
    }),

    // Posts and Search Console: read-only, from our own PostMetric and SearchDay rows; analytics.read, like the
    // Performance tabs. Titles and page URLs are typed by people, so they go through cleanTitle.
    // ponytail: postsWithMetrics reads at most the top 500 posts by reach; a brand posting more than 500 in 90 days
    // gets a note, and its totals cover those 500.
    postPerformance: tool({
      description:
        "How the brand's Instagram, Facebook and Threads posts and Instagram stories did in a period (brand-local days, default the last 30): per-channel totals, then the top posts and the top stories ranked by one metric (reach, views, likes, comments, shares, saves or interactions).",
      inputSchema: rangeInput("leave both out for the last 30 days").extend({
        rankBy: z.enum(POST_METRICS).default("reach"),
        channel: z.nativeEnum(ContentChannel).optional(),
        limit: z.number().int().min(1).max(25).default(10),
      }),
      execute: async ({ rankBy, channel, limit, ...input }) => {
        const refused = await gate("postPerformance");
        if (refused) return refused;
        const range = await rangeOf(input, POSTS_MAX_DAYS);
        if (!("from" in range)) return range;
        const read = await postsWithMetrics(scope, range, new Date(), { stories: true });
        const all = channel ? read.filter((p) => p.channel === channel) : read;
        // Totals from every row read, before any cap.
        const totals = new Map<string, { posts: number; read: number } & Record<(typeof POST_METRICS)[number], number>>();
        for (const p of all) {
          const t = totals.get(p.channel) ?? { posts: 0, read: 0, reach: 0, views: 0, likes: 0, comments: 0, shares: 0, saves: 0, interactions: 0 };
          t.posts++;
          if (p.metrics) {
            t.read++;
            for (const m of POST_METRICS) t[m] += p.metrics[m] ?? 0;
          }
          totals.set(p.channel, t);
        }
        const posts = rankPosts(all.filter((p) => p.channel !== "INSTAGRAM_STORY"), rankBy);
        const stories = rankPosts(all.filter((p) => p.channel === "INSTAGRAM_STORY"), rankBy);
        const title = (p: PostInsightDto) => cleanTitle(p.title ?? "");
        return {
          ...range,
          rankBy,
          totals: [...totals].map(([ch, t]) => ({ channel: ch, ...t })),
          top: {
            columns: ["title", "channel", "published", "reach", "views", "likes", "comments", "shares", "saves"],
            rows: posts.slice(0, limit).map((p) => [title(p), p.channel, p.publishedAt, p.metrics?.reach ?? null, p.metrics?.views ?? null, p.metrics?.likes ?? null, p.metrics?.comments ?? null, p.metrics?.shares ?? null, p.metrics?.saves ?? null]),
          },
          ...(posts.length > limit && { morePosts: posts.length - limit }),
          stories: {
            // A story's comments are its replies, and its reach is the highest frame's.
            columns: ["title", "published", "reachHighestFrame", "views", "replies", "shares", "navigation"],
            rows: stories.slice(0, limit).map((p) => [title(p), p.publishedAt, p.metrics?.reach ?? null, p.metrics?.views ?? null, p.metrics?.comments ?? null, p.metrics?.shares ?? null, p.metrics?.navigation ?? null]),
          },
          ...(stories.length > limit && { moreStories: stories.length - limit }),
          notes: [...POST_NOTES, ...(read.length >= MAX_POSTS ? [`Only the top ${MAX_POSTS} posts by reach in this period were read.`] : [])],
        };
      },
    }),

    searchPerformance: tool({
      description:
        "Google Search Console results for the brand's site over a period (Google's days, default the last 28 synced days): clicks, impressions, CTR and average position with the previous period, daily rows when 31 days or less, and the top pages by clicks or impressions. Search keywords aren't available.",
      inputSchema: rangeInput("leave both out for the last 28 synced days").extend({
        pageSort: z.enum(SEARCH_PAGE_SORTS).default("clicks"),
        pages: z.number().int().min(0).max(25).default(10),
      }),
      execute: async ({ pageSort, pages, ...input }) => {
        const refused = await gate("searchPerformance");
        if (refused) return refused;
        const range = await rangeOf(input, SEARCH_RANGE_MAX_DAYS, async () => (await liveSources(scope, "SEARCH_CONSOLE")).syncedThrough ?? NO_SEARCH, 28);
        if (!("from" in range)) return range;
        // manage: false, so the site's URL never reaches the model (only integrations.manage sees it on screen).
        const [summary, top] = await Promise.all([searchSummary(scope, range, { manage: false }), searchPages(scope, range, { sort: pageSort, offset: 0 })]);
        if (!summary.hasSite) return { ...range, hasSite: false, ...NO_SEARCH };
        return {
          ...range,
          hasSite: true,
          totals: summary.totals,
          previousRange: summary.previousRange,
          previous: summary.previous,
          ...(rangeDays(range) <= 31 && {
            days: { columns: ["day", "clicks", "impressions", "ctr", "position"], rows: summary.days.map((d) => [d.day, d.clicks, d.impressions, d.ctr, d.position]) },
          }),
          topPages: {
            columns: ["page", "clicks", "impressions", "ctr", "position"],
            rows: top.pages.slice(0, pages).map((p) => [cleanTitle(p.page), p.clicks, p.impressions, p.ctr, p.position]),
          },
          notes: SEARCH_NOTES,
        };
      },
    }),

    // Proposes, never starts: the chat shows a Start button and the person presses it (the Run button's own route).
    // Text injected into a web page or document can steer the model into calling a tool; it can't press a button.
    // (Named startAgent still, so conversations saved before this change keep validating.)
    startAgent: tool({
      description:
        "Offer to start an agent run for this brand (research = re-read the website and redraft the documents; seo = website audit; geo = AI-visibility check; scout = find post ideas; planner = turn the ideas the team shortlisted on the Content calendar into dated post slots, and does nothing without shortlisted ideas; the Brief writer and Creator that draft them are separate runs). The person sees a Start button and starts it themselves; nothing runs until they press it. Only when the person asks for it.",
      inputSchema: z.object({ agentKey: z.enum(RUNNABLE) }),
      execute: async ({ agentKey }) => {
        if (!(await can("agents.run"))) return { proposed: false, reason: "Your role can't run agents. Ask an owner or admin." };
        return { proposed: true, agentKey, note: "A Start button is shown to the person; the agent runs only if they press it." };
      },
    }),
  };
}
