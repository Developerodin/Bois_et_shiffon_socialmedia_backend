import { ContentChannel, type Prisma } from "@prisma/client";
import { tool } from "ai";
import { z } from "zod";
import { ProductPageQuery, productPageWhere, STOCK_UNKNOWN } from "@/server/catalog/products";
import { OPEN_STATUSES, parseRange, STATUS_GROUPS, stockLabel, type CatalogSync, type DateRange } from "@/shared";
import {
  BREAKDOWNS, hasOrderLines, MAX_ANALYSIS_ROWS, MAX_RISK_ROWS, PRODUCT_GROUPS, productSales, salesBreakdown, stockRisk, TIME_BREAKDOWNS, topProducts, truncatedOrders,
} from "@/server/data/sales-analysis";
import { MAX_SALES_DAYS, salesSummary } from "@/server/data/sales-read";
import { addDays, badRangeDetail, brandTimeZone, rangeDays, zoneToday } from "@/server/data/sources";
import { MAX_SALES_CALLS, SALES_HIDDEN } from "@/server/chat/turn";
import { AGENTS } from "@/server/agents/registry";
import { effectivePermissions } from "@/server/auth/permissions";
import { DEFAULT_TIME_ZONE } from "@/server/catalog/campaigns";
import { isTimeZone, wallTime } from "@/server/content/offer-checks";
import { prisma } from "@/server/db/prisma";
import { latestAuditReports } from "@/server/services/audit-reports";
import { CONTEXT_DOC_KINDS, listContextDocs } from "@/server/services/context-docs";

export type ChatScope = { workspaceId: string; brandId: string; userId: string };

const KINDS = CONTEXT_DOC_KINDS.map((k) => k.kind) as [string, ...string[]];
/** listPosts' filters → the statuses each reads (the shared groups, so chat counts match the apps). */
const POST_FILTERS = {
  upcoming: [...OPEN_STATUSES],
  "awaiting-approval": [...STATUS_GROUPS.awaiting],
  published: [...STATUS_GROUPS.published],
} as const;
// Titles are data written by agents and people: one line, no control characters, short.
// Zero-width and bidi characters go too, so a title can't hide or reorder text.
const cleanTitle = (t: string) =>
  t.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/g, " ").trim().slice(0, 100) || "(untitled)";
// A post whose time passed this recently may still be publishing: not overdue yet.
const OVERDUE_GRACE_MS = 15 * 60_000;

// Saved threads are validated against these schemas: they may only widen (new optional fields, higher caps), never narrow.
const SalesRange = z.object({
  from: z.string().max(10).optional().describe("YYYY-MM-DD, brand-local, inclusive; with to"),
  to: z.string().max(10).optional().describe("YYYY-MM-DD, inclusive; leave both out for the last 30 days"),
});
const BAD_RANGE = { error: badRangeDetail(MAX_SALES_DAYS) };
const NEEDS_LINES =
  "Per-product sales need order line items, which only come through the AskCart connection once AskCart sends them; none are stored for this brand yet. salesSummary and salesBreakdown still work from order totals.";
const LINE_NOTE =
  "From order line items: units and revenue are net of refunds, revenue after every discount (order-level share included). Lines without a product (custom lines, deleted products) are 'Other / custom items'.";
const SALES_LIMIT = { error: "Sales tool limit reached for this message." };
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
  // Sales tools: crm.read, and at most MAX_SALES_CALLS calls per message (one chatTools per message). Counted here as
  // well as by the route's activeTools, which can't stop several calls made in parallel within one step.
  let salesCalls = 0;
  const salesGate = async () => {
    if (!(await can("crm.read"))) return SALES_HIDDEN;
    if (++salesCalls > MAX_SALES_CALLS) return SALES_LIMIT;
    return null;
  };
  // The sales tools' period: both days given (validated like the Sales tab's), or the last 30 brand-local days.
  const rangeOf = async ({ from, to }: { from?: string; to?: string }): Promise<DateRange | null> => {
    if (from || to) return parseRange(from, to, MAX_SALES_DAYS);
    const zone = await brandTimeZone(scope);
    const today = zoneToday(isTimeZone(zone) ? zone : DEFAULT_TIME_ZONE);
    return { from: addDays(today, -29), to: today };
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
        "Shop sales totals for a period (brand-local days, default the last 30 days): orders, gross, discounts, net sales, total, refunded per currency, with the same-length previous period to compare; daily rows when the period is 31 days or less. Start any sales question or report here.",
      inputSchema: SalesRange,
      execute: async (input) => {
        const refused = await salesGate();
        if (refused) return refused;
        const range = await rangeOf(input);
        if (!range) return BAD_RANGE;
        const { currencies } = await salesSummary(scope, range);
        if (!currencies.length) return { ...range, note: "No orders in this period (test and cancelled orders are left out), or the shop's orders aren't synced." };
        const withDays = rangeDays(range) <= 31;
        return {
          ...range,
          currencies: currencies.map((c) => ({
            currency: c.currency,
            totals: c.totals,
            previous: c.previous,
            ...(withDays && {
              days: { columns: ["day", "orders", "netSales", "total"], rows: c.days.map((d) => [d.day, d.orders, d.netSales, d.total]) },
            }),
          })),
        };
      },
    }),

    salesBreakdown: tool({
      description:
        "Shop sales split by one dimension for a period: day, week, month or weekday (trends, best days), channel (sales channel), fulfillmentStatus, financialStatus (paid, refunded…), discountCode (which codes drive orders; codes used on fewer than 2 orders are grouped as '(other codes)' because one-time codes can be personal), collection or vendor (from line items and the catalogue). Per currency: orders, gross, discounts, net sales, total, refunded, average order value (collection/vendor: orders, net units, net revenue). At most 60 rows; use week or month for long periods.",
      inputSchema: SalesRange.extend({
        by: z.enum(BREAKDOWNS),
        limit: z.number().int().min(1).max(MAX_ANALYSIS_ROWS).default(MAX_ANALYSIS_ROWS),
      }),
      execute: async ({ by, limit, ...input }) => {
        const refused = await salesGate();
        if (refused) return refused;
        const range = await rangeOf(input);
        if (!range) return BAD_RANGE;
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
        const refused = await salesGate();
        if (refused) return refused;
        const range = await rangeOf(input);
        if (!range) return BAD_RANGE;
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
        const refused = await salesGate();
        if (refused) return refused;
        const range = await rangeOf(input);
        if (!range) return BAD_RANGE;
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
        const refused = await salesGate();
        if (refused) return refused;
        const range = await rangeOf(input);
        if (!range) return BAD_RANGE;
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
