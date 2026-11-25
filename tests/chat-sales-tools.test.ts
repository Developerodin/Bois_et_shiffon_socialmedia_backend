import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The tools over a stubbed data layer: what they let through, refuse, clean and say. The SQL itself is checked against
// a real Postgres (see the branch's handover notes), not by matching its text here.
const perms = vi.hoisted(() => ({ set: new Set(["crm.read"]) }));
const data = vi.hoisted(() => ({
  salesSummary: vi.fn(),
  brandTimeZone: vi.fn(async () => "Europe/Paris"),
  salesBreakdown: vi.fn(),
  topProducts: vi.fn(),
  productSales: vi.fn(),
  stockRisk: vi.fn(),
  hasOrderLines: vi.fn(async () => true),
  truncatedOrders: vi.fn(async () => 0),
}));

vi.mock("@/server/db/prisma", () => ({ prisma: {} }));
vi.mock("@/server/auth/permissions", () => ({ effectivePermissions: vi.fn(async () => perms.set) }));
vi.mock("@/server/services/audit-reports", () => ({ latestAuditReports: vi.fn() }));
vi.mock("@/server/services/context-docs", () => ({ CONTEXT_DOC_KINDS: [{ kind: "brand-voice" }], listContextDocs: vi.fn() }));
vi.mock("@/server/data/sales-read", () => ({ MAX_SALES_DAYS: 366, salesSummary: data.salesSummary }));
vi.mock("@/server/data/sources", async (orig) => ({ ...(await orig<object>()), brandTimeZone: data.brandTimeZone }));
vi.mock("@/server/data/sales-analysis", async (orig) => ({
  ...(await orig<object>()),
  salesBreakdown: data.salesBreakdown,
  topProducts: data.topProducts,
  productSales: data.productSales,
  stockRisk: data.stockRisk,
  hasOrderLines: data.hasOrderLines,
  truncatedOrders: data.truncatedOrders,
}));

import { chatTools } from "@/server/chat/tools";
import { MAX_SALES_CALLS, SALES_TOOLS, SHOP_DATA_TOOLS } from "@/server/chat/turn";
import { chatSystemPrompt } from "@/server/chat/prompt";

const scope = { workspaceId: "w1", brandId: "b1", userId: "u1" };
type AnyTool = { execute?: (input: never, o: never) => unknown; inputSchema: unknown };
// Input goes through the tool's schema first (defaults filled), as the AI SDK does; a refused input never reaches execute.
const run = (t: AnyTool, input: object) =>
  t.execute!((t.inputSchema as { parse: (v: unknown) => never }).parse(input), {} as never) as Promise<Record<string, unknown>>;
const parse = (t: AnyTool, input: object) => (t.inputSchema as { safeParse: (v: unknown) => { success: boolean } }).safeParse(input).success;
const SALES = ["salesSummary", "salesBreakdown", "topProducts", "productSales", "stockRisk"] as const;
const range = { from: "2026-11-01", to: "2026-11-30" };
const inputFor = (name: string, r: object) => (name === "salesBreakdown" ? { ...r, by: "week" } : r);
const d = (v: string) => new Prisma.Decimal(v);
const BIDI = "‮";

beforeEach(() => {
  vi.clearAllMocks();
  perms.set = new Set(["crm.read"]);
  data.hasOrderLines.mockResolvedValue(true);
  data.truncatedOrders.mockResolvedValue(0);
  data.salesBreakdown.mockResolvedValue({ basis: "orders", columns: [], rows: [], moreGroups: 0 });
  data.topProducts.mockResolvedValue({ rows: [], moreGroups: 0 });
  data.productSales.mockResolvedValue({ variants: [], weeks: [] });
  data.stockRisk.mockResolvedValue({ sellers: [], slow: [] });
});
afterEach(() => vi.useRealTimers());

const reads = () => [data.salesSummary, data.salesBreakdown, data.topProducts, data.productSales, data.stockRisk].some((f) => f.mock.calls.length);

describe("sales tools: access and input", () => {
  it.each(SALES)("%s needs crm.read (the Sales tab's permission) and reads nothing without it", async (name) => {
    perms.set = new Set(["brand.read", "analytics.read"]);
    expect(await run(chatTools(scope)[name], inputFor(name, range))).toEqual({ error: "Your role can't see sales." });
    expect(reads()).toBe(false);
  });

  it.each([
    [{ from: "2026-11-30", to: "2026-11-01" }],
    [{ from: "2026-11-01" }],
    [{ from: "2025-01-01", to: "2026-11-01" }],
    [{ from: "2026-02-30", to: "2026-03-01" }],
    [{ from: "2026-11-1'", to: "2026-11-02" }],
  ])("refuses a bad period %j before reading", async (input) => {
    for (const name of SALES) expect((await run(chatTools(scope)[name], inputFor(name, input))).error).toMatch(/YYYY-MM-DD/);
    expect(reads()).toBe(false);
  });

  it("defaults to the last 30 days in the brand's time zone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-30T23:30:00Z")); // already 1 December in Paris
    data.salesSummary.mockResolvedValue({ currencies: [] });
    const out = await run(chatTools(scope).salesSummary, {});
    expect(data.salesSummary).toHaveBeenCalledWith(scope, { from: "2026-11-02", to: "2026-12-01" });
    expect(out).toMatchObject({ from: "2026-11-02", to: "2026-12-01", note: expect.stringContaining("No orders") });
  });

  it(`allows ${MAX_SALES_CALLS} sales calls a message, even made in parallel in one step`, async () => {
    data.salesSummary.mockResolvedValue({ currencies: [] });
    const tools = chatTools(scope);
    const outs = await Promise.all(Array.from({ length: MAX_SALES_CALLS + 2 }, (_, i) => run(i % 2 ? tools.salesSummary : tools.topProducts, range)));
    expect(outs.filter((o) => o.error === "Sales tool limit reached for this message.")).toHaveLength(2);
    expect(data.salesSummary.mock.calls.length + data.topProducts.mock.calls.length).toBe(MAX_SALES_CALLS);
    // a new message gets a new allowance
    expect((await run(chatTools(scope).salesSummary, range)).error).toBeUndefined();
  });

  it("schemas cap sizes and only take known groupings", () => {
    const t = chatTools(scope);
    expect(parse(t.topProducts, { limit: 26 })).toBe(false);
    expect(parse(t.topProducts, { limit: 25, rankBy: "units", group: "vendor" })).toBe(true);
    expect(parse(t.topProducts, { group: "customer" })).toBe(false);
    expect(parse(t.topProducts, { rankBy: "margin" })).toBe(false);
    expect(parse(t.salesBreakdown, { by: "customer" })).toBe(false);
    expect(parse(t.salesBreakdown, { by: "discountCode", limit: 61 })).toBe(false);
    expect(parse(t.stockRisk, { limit: 41 })).toBe(false);
    expect(parse(t.productSales, { q: "x".repeat(101) })).toBe(false);
  });

  it("every sales tool counts as shop data, and the prompt names them all", () => {
    for (const name of SALES) expect(SALES_TOOLS.has(name) && SHOP_DATA_TOOLS.has(name)).toBe(true);
    const prompt = chatSystemPrompt({ name: "Oak & Co", website: null });
    for (const name of SALES) expect(prompt).toContain(name);
    expect(prompt).toContain("rankBy");
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

describe("per-product tools without line items", () => {
  it.each(["topProducts", "productSales", "stockRisk"] as const)("%s says per-product sales need AskCart's line items, not an error", async (name) => {
    data.hasOrderLines.mockResolvedValue(false);
    const out = await run(chatTools(scope)[name], range);
    expect(out.error).toBeUndefined();
    expect(out.note).toMatch(/line items/);
  });

  it("a line-based breakdown says so too", async () => {
    data.hasOrderLines.mockResolvedValue(false);
    data.salesBreakdown.mockResolvedValue({ basis: "lines", columns: [], rows: [], moreGroups: 0 });
    expect((await run(chatTools(scope).salesBreakdown, { ...range, by: "vendor" })).note).toMatch(/line items/);
  });

  it("with line items stored but none in the period, says nothing sold", async () => {
    expect((await run(chatTools(scope).topProducts, range)).note).toBe("No products sold in this period.");
  });
});

describe("salesBreakdown", () => {
  it("passes the grouping through, cleans shop text and says how many groups are hidden", async () => {
    data.salesBreakdown.mockResolvedValue({ basis: "orders", columns: ["channel", "currency", "orders"], rows: [[`web${BIDI}shop`, "EUR", 4]], moreGroups: 3 });
    const out = await run(chatTools(scope).salesBreakdown, { ...range, by: "channel", limit: 1 });
    expect(data.salesBreakdown).toHaveBeenCalledWith(scope, range, "channel", 1);
    expect(out.rows).toEqual([["web shop", "EUR", 4]]);
    expect(out.notes).toEqual([expect.stringMatching(/^3 more groups/)]);
  });

  it("weeks: says the first and last can be partial, and time groups keep the most recent", async () => {
    data.salesBreakdown.mockResolvedValue({ basis: "orders", columns: [], rows: [["2026-11-02", "EUR", 1]], moreGroups: 1 });
    const out = await run(chatTools(scope).salesBreakdown, { ...range, by: "week" });
    expect(out.notes).toEqual([expect.stringContaining("most recent"), expect.stringContaining("partial")]);
  });

  it("line-based groups say revenue is net and count incomplete orders", async () => {
    data.truncatedOrders.mockResolvedValue(2);
    data.salesBreakdown.mockResolvedValue({ basis: "lines", columns: [], rows: [["Tables", "EUR", 1, 2, "90.00"]], moreGroups: 0 });
    const out = await run(chatTools(scope).salesBreakdown, { ...range, by: "collection" });
    expect(out.notes).toEqual([expect.stringContaining("net of refunds"), expect.stringMatching(/^2 orders .* incomplete/)]);
  });
});

describe("topProducts", () => {
  it("ranks by the input's rankBy and returns cleaned columns + rows", async () => {
    data.topProducts.mockResolvedValue({ rows: [[`Oak${BIDI}table`, "EUR", 3, "90.50", 2]], moreGroups: 0 });
    const out = await run(chatTools(scope).topProducts, { ...range, rankBy: "units", limit: 5 });
    expect(data.topProducts).toHaveBeenCalledWith(scope, range, "units", "product", 5);
    expect(out).toMatchObject({ rankBy: "units", group: "product", columns: ["product", "currency", "units", "revenue", "orders"], rows: [["Oak table", "EUR", 3, "90.50", 2]] });
  });
});

describe("productSales", () => {
  it("shows price and stock from the live catalogue, and 'not in catalogue' otherwise; SKUs cleaned", async () => {
    data.productSales.mockResolvedValue({
      variants: [
        { title: "Oak table — Large", sku: `OAK${BIDI}L`, currency: "EUR", units: 3, revenue: d("120"), orders: 2, price: d("50"), in_stock: true, stock_quantity: 4, in_catalogue: true },
        { title: "Other / custom items", sku: null, currency: "EUR", units: 1, revenue: d("5"), orders: 1, price: null, in_stock: null, stock_quantity: null, in_catalogue: false },
      ],
      weeks: [{ week: "2026-11-02", currency: "EUR", units: 4, revenue: d("125") }],
    });
    const out = await run(chatTools(scope).productSales, { ...range, q: " oak " });
    expect(data.productSales).toHaveBeenCalledWith(scope, range, "oak");
    expect((out.variants as { rows: unknown[][] }).rows).toEqual([
      ["Oak table — Large", "OAK L", "EUR", 3, "120.00", 2, "50.00", "4 in stock"],
      ["Other / custom items", null, "EUR", 1, "5.00", 1, null, "not in catalogue"],
    ]);
    expect(out.weeks).toEqual({ columns: ["weekStarting", "currency", "units", "revenue"], rows: [["2026-11-02", "EUR", 4, "125.00"]] });
  });
});

describe("stockRisk", () => {
  it("works out days of cover, flags sold-out best sellers and sorts lowest cover first", async () => {
    data.stockRisk.mockResolvedValue({
      sellers: [
        { title: "Plenty", sku: "A", units: 30, stock_quantity: 300, in_stock: true, in_catalogue: true },
        { title: "Gone", sku: "B", units: 20, stock_quantity: 0, in_stock: false, in_catalogue: true },
        { title: "Low", sku: "C", units: 60, stock_quantity: 10, in_stock: true, in_catalogue: true },
        { title: "Other / custom items", sku: null, units: 5, stock_quantity: null, in_stock: null, in_catalogue: false },
      ],
      slow: [{ title: "Lamp", sku: null, stock_quantity: 200, units: 0 }],
    });
    const out = await run(chatTools(scope).stockRisk, range); // 30 days
    expect((out.bestSellers as { rows: unknown[][] }).rows).toEqual([
      ["Gone", "B", 20, 0.67, 0, 0, "sold out"],
      ["Low", "C", 60, 2, 10, 5, "low cover"],
      ["Plenty", "A", 30, 1, 300, 300, null],
      ["Other / custom items", null, 5, 0.17, null, null, "not in catalogue"],
    ]);
    expect((out.slowMovers as { rows: unknown[][] }).rows).toEqual([["Lamp", null, 200, 0, null]]);
  });
});
