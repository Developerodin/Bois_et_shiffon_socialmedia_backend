import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ $queryRaw: vi.fn(), shopOrderLine: { findFirst: vi.fn() } }));
const perms = vi.hoisted(() => ({ set: new Set(["crm.read"]) }));
const data = vi.hoisted(() => ({ salesSummary: vi.fn(), brandTimeZone: vi.fn(async () => "Europe/Paris") }));

vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/auth/permissions", () => ({ effectivePermissions: vi.fn(async () => perms.set) }));
vi.mock("@/server/services/audit-reports", () => ({ latestAuditReports: vi.fn() }));
vi.mock("@/server/services/context-docs", () => ({ CONTEXT_DOC_KINDS: [{ kind: "brand-voice" }], listContextDocs: vi.fn() }));
vi.mock("@/server/data/sales-read", () => ({ MAX_SALES_DAYS: 366, salesSummary: data.salesSummary }));
vi.mock("@/server/data/sources", async (orig) => ({ ...(await orig<object>()), brandTimeZone: data.brandTimeZone }));

import { chatTools } from "@/server/chat/tools";
import { PRODUCT_TOOLS } from "@/server/chat/turn";
import { chatSystemPrompt } from "@/server/chat/prompt";

const scope = { workspaceId: "w1", brandId: "b1", userId: "u1" };
type AnyTool = { execute?: (input: never, o: never) => unknown; inputSchema: unknown };
// Input goes through the tool's schema first (defaults filled), as the AI SDK does; a refused input never reaches execute.
const run = (t: AnyTool, input: object) =>
  t.execute!((t.inputSchema as { parse: (v: unknown) => never }).parse(input), {} as never) as Promise<Record<string, unknown>>;
const parse = (t: AnyTool, input: object) => (t.inputSchema as { safeParse: (v: unknown) => { success: boolean } }).safeParse(input).success;
const SALES = ["salesSummary", "salesBreakdown", "topProducts", "productSales", "stockRisk"] as const;
const range = { from: "2026-11-01", to: "2026-11-30" };
/** A raw call's SQL text and bound values (tagged template: strings, ...values). */
const sqlOf = (call: unknown[]) => Prisma.sql(call[0] as unknown as TemplateStringsArray, ...call.slice(1));

beforeEach(() => {
  vi.clearAllMocks();
  perms.set = new Set(["crm.read"]);
  db.$queryRaw.mockResolvedValue([]);
  db.shopOrderLine.findFirst.mockResolvedValue({ id: "l1" });
});
afterEach(() => vi.useRealTimers());

describe("sales tools: access and input", () => {
  it.each(SALES)("%s needs crm.read (the Sales tab's permission) and reads nothing without it", async (name) => {
    perms.set = new Set(["brand.read", "analytics.read"]);
    const out = await run(chatTools(scope)[name], name === "salesBreakdown" ? { ...range, by: "week" } : range);
    expect(out).toEqual({ error: "Your role can't see sales." });
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(data.salesSummary).not.toHaveBeenCalled();
  });

  it.each([
    [{ from: "2026-11-30", to: "2026-11-01" }],
    [{ from: "2026-11-01" }],
    [{ from: "2025-01-01", to: "2026-11-01" }],
    [{ from: "2026-02-30", to: "2026-03-01" }],
    [{ from: "2026-11-1'", to: "2026-11-02" }],
  ])("refuses a bad period %j before reading", async (input) => {
    for (const name of SALES) {
      const out = await run(chatTools(scope)[name], name === "salesBreakdown" ? { ...input, by: "week" } : input);
      expect(out.error).toMatch(/YYYY-MM-DD/);
    }
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(data.salesSummary).not.toHaveBeenCalled();
  });

  it("defaults to the last 30 days in the brand's time zone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-30T23:30:00Z")); // already 1 December in Paris
    data.salesSummary.mockResolvedValue({ currencies: [] });
    const out = await run(chatTools(scope).salesSummary, {});
    expect(data.salesSummary).toHaveBeenCalledWith(scope, { from: "2026-11-02", to: "2026-12-01" });
    expect(out).toMatchObject({ from: "2026-11-02", to: "2026-12-01", note: expect.stringContaining("No orders") });
  });

  it("schemas cap sizes and only take known groupings", () => {
    const t = chatTools(scope);
    expect(parse(t.topProducts, { limit: 26 })).toBe(false);
    expect(parse(t.topProducts, { limit: 25, by: "units", group: "vendor" })).toBe(true);
    expect(parse(t.topProducts, { group: "customer" })).toBe(false);
    expect(parse(t.salesBreakdown, { by: "customer" })).toBe(false);
    expect(parse(t.salesBreakdown, { by: "discountCode", limit: 61 })).toBe(false);
    expect(parse(t.stockRisk, { limit: 41 })).toBe(false);
    expect(parse(t.productSales, { q: "x".repeat(101) })).toBe(false);
  });

  it("sales output is kept away from web search, and the prompt names the tools", () => {
    for (const name of ["salesBreakdown", "topProducts", "productSales", "stockRisk"]) expect(PRODUCT_TOOLS.has(name)).toBe(true);
    const prompt = chatSystemPrompt({ name: "Oak & Co", website: null });
    for (const name of SALES) expect(prompt).toContain(name);
  });
});

describe("salesSummary", () => {
  const totals = { orders: 2, gross: "10.00", discounts: "0.00", netSales: "10.00", total: "12.00", refunded: "0.00" };
  const currencies = [{ currency: "EUR", totals, previous: totals, days: [{ day: "2026-11-02", ...totals }] }];

  it("includes days as columns + rows for a month, not for a longer period", async () => {
    data.salesSummary.mockResolvedValue({ currencies });
    const month = await run(chatTools(scope).salesSummary, { from: "2026-11-01", to: "2026-12-01" });
    expect(month.currencies).toEqual([{ currency: "EUR", totals, previous: totals, days: { columns: ["day", "orders", "netSales", "total"], rows: [["2026-11-02", 2, "10.00", "12.00"]] } }]);
    const longer = await run(chatTools(scope).salesSummary, { from: "2026-11-01", to: "2026-12-02" });
    expect((longer.currencies as object[])[0]).not.toHaveProperty("days");
  });
});

describe("topProducts / productSales / stockRisk without line items", () => {
  it.each(["topProducts", "productSales", "stockRisk"] as const)("%s says per-product sales need AskCart's line items, not an error", async (name) => {
    db.shopOrderLine.findFirst.mockResolvedValue(null);
    const out = await run(chatTools(scope)[name], range);
    expect(out.error).toBeUndefined();
    expect(out.note).toMatch(/line items/);
    expect(db.shopOrderLine.findFirst.mock.calls[0][0].where).toEqual({ workspaceId: "w1", brandId: "b1" });
  });

  it("with line items stored but none in the period, says nothing sold", async () => {
    expect((await run(chatTools(scope).topProducts, range)).note).toBe("No products sold in this period.");
  });
});

describe("topProducts", () => {
  it("returns columns + rows, and the grouping falls back from product id to SKU to title", async () => {
    db.$queryRaw.mockResolvedValue([{ name: "Oak‮ table", currency: "EUR", units: 3, revenue: new Prisma.Decimal("90.5"), orders: 2 }]);
    const out = await run(chatTools(scope).topProducts, { ...range, by: "units", group: "product", limit: 5 });
    expect(out).toMatchObject({ columns: ["product", "currency", "units", "revenue", "orders"], rows: [["Oak  table", "EUR", 3, "90.50", 2]] });
    const sql = sqlOf(db.$queryRaw.mock.calls[0]);
    expect(sql.sql).toContain(`COALESCE(l."productId", 'sku:' || l.sku, 'title:' || l.title)`);
    expect(sql.sql).toContain("units DESC, revenue DESC");
    expect(sql.sql).toContain(`NOT o."test" AND o."cancelledAt" IS NULL`);
    // scope and cap are bound values, not SQL text
    expect(sql.values).toEqual(expect.arrayContaining(["w1", "b1", 5]));
  });
});

describe("salesBreakdown", () => {
  it("maps each grouping to fixed SQL and adds average order value", async () => {
    const d = (v: string) => new Prisma.Decimal(v);
    db.$queryRaw.mockResolvedValue([{ key: "XMAS", currency: "EUR", n_groups: 3, orders: 4, gross: d("110"), discounts: d("10"), net_sales: d("100"), total: d("105"), refunded: d("0") }]);
    const out = await run(chatTools(scope).salesBreakdown, { ...range, by: "discountCode", limit: 1 });
    expect(out).toMatchObject({
      by: "discountCode",
      columns: ["discountCode", "currency", "orders", "gross", "discounts", "netSales", "total", "refunded", "avgOrderValue"],
      rows: [["XMAS", "EUR", 4, "110.00", "10.00", "100.00", "105.00", "0.00", "25.00"]],
      moreGroups: 2,
    });
    expect(sqlOf(db.$queryRaw.mock.calls[0]).sql).toContain(`unnest(o."discountCodes")`);
  });
});

describe("productSales", () => {
  it("sends the search text as an escaped bound value", async () => {
    await run(chatTools(scope).productSales, { ...range, q: "100%_oak" });
    const sql = sqlOf(db.$queryRaw.mock.calls[0]);
    expect(sql.sql).not.toContain("100%");
    expect(sql.values).toContain("%100\\%\\_oak%");
  });
});

describe("stockRisk", () => {
  it("works out days of cover, flags sold-out best sellers and sorts lowest cover first", async () => {
    db.$queryRaw
      .mockResolvedValueOnce([
        { title: "Plenty", sku: "A", units: 30, stock_quantity: 300, in_stock: true, in_catalogue: true },
        { title: "Gone", sku: "B", units: 20, stock_quantity: 0, in_stock: false, in_catalogue: true },
        { title: "Low", sku: "C", units: 60, stock_quantity: 10, in_stock: true, in_catalogue: true },
        { title: "Deleted", sku: null, units: 5, stock_quantity: null, in_stock: null, in_catalogue: false },
      ])
      .mockResolvedValueOnce([{ title: "Lamp", sku: null, stock_quantity: 200, units: 0 }]);
    const out = await run(chatTools(scope).stockRisk, range); // 30 days
    expect((out.bestSellers as { rows: unknown[][] }).rows).toEqual([
      ["Gone", "B", 20, 0.67, 0, 0, "sold out"],
      ["Low", "C", 60, 2, 10, 5, "low cover"],
      ["Plenty", "A", 30, 1, 300, 300, null],
      ["Deleted", null, 5, 0.17, null, null, "not in catalogue"],
    ]);
    expect((out.slowMovers as { rows: unknown[][] }).rows).toEqual([["Lamp", null, 200, 0, null]]);
  });
});
