import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { productPageWhere } from "@/server/catalog/products";
import { activeTools, askedToSearch, hideOutputs, historyWindow, MAX_DATA_CALLS, MAX_GROUP_CALLS, MODEL_HISTORY, readsShopData, SALES_HIDDEN } from "@/server/chat/turn";

const msg = (text: string, role: "user" | "assistant" = "user"): UIMessage => ({ id: text, role, parts: [{ type: "text", text }] });

describe("historyWindow", () => {
  const thread = (n: number) => Array.from({ length: n }, (_, i) => i);

  it("keeps a short thread whole and never reads more than the limit", () => {
    expect(historyWindow(thread(40))).toHaveLength(40);
    for (let n = 41; n < 200; n++) {
      const w = historyWindow(thread(n));
      expect(w.length).toBeLessThanOrEqual(MODEL_HISTORY);
      expect(w.length).toBeGreaterThanOrEqual(20);
      expect(w.at(-1)).toBe(n - 1); // the newest message is always in
    }
  });

  it("holds its first message for 20 turns at a time, so the cached prefix keeps matching", () => {
    const starts = [41, 50, 60].map((n) => historyWindow(thread(n))[0]);
    expect(starts).toEqual([20, 20, 20]);
    expect(historyWindow(thread(61))[0]).toBe(40);
  });
});

describe("web search guard", () => {
  it("sees product data only in a product tool's step", () => {
    const read = { id: "a", role: "assistant", parts: [{ type: "tool-findProducts", toolCallId: "1", state: "output-available", input: {}, output: {} }] } as unknown as UIMessage;
    const docs = { id: "b", role: "assistant", parts: [{ type: "tool-readDocument", toolCallId: "2", state: "output-available", input: {}, output: {} }] } as unknown as UIMessage;
    expect(readsShopData([msg("hi"), read])).toBe(true);
    expect(readsShopData([msg("hi"), docs])).toBe(false);
  });

  const step = (tool: string) => ({ id: tool, role: "assistant", parts: [{ type: `tool-${tool}`, toolCallId: "1", state: "output-available", input: {}, output: {} }] }) as unknown as UIMessage;
  const ALL = ["webSearch", "findProducts", "salesSummary", "topProducts", "readDocument"];

  it("catalogue data switches web search off, unless the person asked for a search", () => {
    expect(activeTools(ALL, { history: [msg("hi")], calls: [], searchAsked: false })).toBeUndefined();
    expect(activeTools(ALL, { history: [step("findProducts")], calls: [], searchAsked: false })).not.toContain("webSearch");
    expect(activeTools(ALL, { history: [msg("hi")], calls: ["findProducts"], searchAsked: false })).not.toContain("webSearch");
    expect(activeTools(ALL, { history: [step("findProducts")], calls: [], searchAsked: true })).toBeUndefined();
  });

  it("sales figures switch web search off even when the person asked for a search", () => {
    expect(activeTools(ALL, { history: [step("salesSummary")], calls: [], searchAsked: true })).not.toContain("webSearch");
    expect(activeTools(ALL, { history: [msg("hi")], calls: ["topProducts"], searchAsked: true })).not.toContain("webSearch");
  });

  it(`switches the sales tools off after ${MAX_GROUP_CALLS} sales calls in a turn`, () => {
    const calls = Array.from({ length: MAX_GROUP_CALLS - 1 }, () => "salesSummary");
    expect(activeTools(ALL, { history: [], calls, searchAsked: false })).toEqual(["findProducts", "salesSummary", "topProducts", "readDocument"]);
    expect(activeTools(ALL, { history: [], calls: [...calls, "topProducts"], searchAsked: false })).toEqual(["findProducts", "readDocument"]);
  });

  it("a group's tools go off at its cap, every data tool at the total cap", () => {
    const tools = ["webSearch", "salesSummary", "adsSummary", "adCampaigns", "postPerformance", "readDocument"];
    const ads = Array.from({ length: MAX_GROUP_CALLS }, () => "adsSummary");
    expect(activeTools(tools, { history: [], calls: ads, searchAsked: true })).toEqual(["webSearch", "salesSummary", "postPerformance", "readDocument"]);
    const mixed = [...Array.from({ length: MAX_DATA_CALLS - 4 }, () => "salesSummary"), "adsSummary", "adsSummary", "postPerformance", "postPerformance"];
    expect(activeTools(tools, { history: [], calls: mixed.slice(0, -1), searchAsked: false })).toEqual(["adsSummary", "adCampaigns", "postPerformance", "readDocument"]);
    expect(activeTools(tools, { history: [], calls: mixed, searchAsked: false })).toEqual(["readDocument"]);
  });

  it("web search stays off after revenuePerAdSpend even when asked", () => {
    expect(activeTools(ALL, { history: [step("revenuePerAdSpend")], calls: [], searchAsked: true })).not.toContain("webSearch");
    expect(activeTools(ALL, { history: [msg("hi")], calls: ["revenuePerAdSpend"], searchAsked: true })).not.toContain("webSearch");
  });

  it("web search is off after ads, posts or search data unless the person asked", () => {
    for (const tool of ["adsSummary", "adCampaigns", "adBudgets", "postPerformance", "searchPerformance"]) {
      expect(activeTools(ALL, { history: [step(tool)], calls: [], searchAsked: false })).not.toContain("webSearch");
      expect(activeTools(ALL, { history: [step(tool)], calls: [], searchAsked: true })).toBeUndefined();
    }
  });

  it.each([
    "Search the web for competitor prices",
    "search the web for CTR benchmarks",
    "look it up online",
    "do a web search on competitor pricing",
    "use web search for this",
    "google it",
    "recherche sur internet",
    "cherche en ligne",
    "Cherchez sur le web les tendances",
    "fais une recherche web",
  ])("counts %j as asking for a web search", (text) => {
    expect(askedToSearch(msg(text))).toBe(true);
  });

  it.each([
    "how are my Google Ads doing",
    "Google search clicks this month",
    "Search Console clicks for my web shop",
    "search results for our online store",
    "top search terms",
    "how are my online sales",
    // Matched before the explicit-phrase rule: naming a search no longer turns web search back on.
    "Peux-tu rechercher les prix ?",
    "What's on my website?",
    "Analyse my pricing",
    // A search named without a verb, or followed by shop or sales words.
    "web search",
    "websearch",
    "How did web search impressions do?",
    "recherche web",
    "Comment vont mes recherches en ligne ?",
    "search the web shop's pages",
    "search the web store",
    "search the web shops",
    "search online stores",
    "recherche en ligne boutiques",
    "search online sales",
    "look up online sales",
    "look online orders",
    "cherche en ligne ventes",
    "recherche sur le web boutique",
  ])("doesn't count %j as asking for a web search", (text) => {
    expect(askedToSearch(msg(text))).toBe(false);
  });

  it("counts only the person's own words", () => {
    expect(askedToSearch(undefined)).toBe(false);
    expect(askedToSearch(msg("search the web", "assistant"))).toBe(true); // the route passes the person's message only
  });
});

describe("product search text", () => {
  it("treats a typed % or _ as a character, not a wildcard", () => {
    const where = productPageWhere({ q: "50%_off", stock: "" });
    expect(where).toEqual({ AND: [{ OR: [{ title: { contains: "50\\%\\_off", mode: "insensitive" } }, { sku: { contains: "50\\%\\_off", mode: "insensitive" } }] }] });
  });
});

describe("hideOutputs", () => {
  it("blanks saved sales figures and keeps the step, its input and every other part", () => {
    const thread = [
      msg("how are sales?"),
      {
        id: "a", role: "assistant", parts: [
          { type: "tool-salesSummary", toolCallId: "1", state: "output-available", input: { from: "2026-11-01" }, output: { currencies: [{ total: "900.00" }] } },
          { type: "tool-findProducts", toolCallId: "2", state: "output-available", input: {}, output: { products: ["Oak table"] } },
          { type: "tool-topProducts", toolCallId: "3", state: "output-error", input: {}, errorText: "failed" },
          { type: "text", text: "Sales were up." },
        ],
      },
    ] as unknown as UIMessage[];
    const before = JSON.stringify(thread);
    const out = hideOutputs(thread, new Set(["agents.read"])) as unknown as { parts: Record<string, unknown>[] }[];
    expect(JSON.stringify(out)).not.toContain("900.00");
    expect(out[1].parts[0]).toEqual({ type: "tool-salesSummary", toolCallId: "1", state: "output-available", input: { from: "2026-11-01" }, output: SALES_HIDDEN });
    expect(out[1].parts.slice(1)).toEqual((thread[1].parts as unknown[]).slice(1));
    expect(out[0]).toBe(thread[0]);
    expect(JSON.stringify(thread)).toBe(before); // the saved thread itself is untouched
  });

  const part = (tool: string, output: object, id = tool) => ({ type: `tool-${tool}`, toolCallId: id, state: "output-available", input: {}, output });
  const thread = (...parts: object[]) => [msg("how are we doing?"), { id: "a", role: "assistant", parts }] as unknown as UIMessage[];
  const outputs = (messages: UIMessage[]) => (messages[1].parts as unknown as { output: unknown }[]).map((p) => p.output);

  it("hides an ads step without ads.read and keeps the sales step with crm.read", () => {
    const out = hideOutputs(thread(part("adsSummary", { spend: "120.00" }), part("salesSummary", { total: "900.00" })), new Set(["crm.read"]));
    expect(outputs(out)).toEqual([{ error: "Your role can't see ads." }, { total: "900.00" }]);
  });

  it("hides revenuePerAdSpend when either of its keys is missing", () => {
    const t = thread(part("revenuePerAdSpend", { ratio: "4.20" }));
    expect(outputs(hideOutputs(t, new Set(["crm.read"])))).toEqual([{ error: "Your role can't see ads." }]);
    expect(outputs(hideOutputs(t, new Set(["ads.read"])))).toEqual([SALES_HIDDEN]);
    expect(outputs(hideOutputs(t, new Set(["ads.read", "crm.read"])))).toEqual([{ ratio: "4.20" }]);
  });

  it("hides post and search steps without analytics.read", () => {
    const out = hideOutputs(thread(part("postPerformance", { reach: 1 }), part("searchPerformance", { clicks: 2 })), new Set(["ads.read"]));
    expect(outputs(out)).toEqual([{ error: "Your role can't see performance numbers." }, { error: "Your role can't see performance numbers." }]);
  });

  it("never hides catalogue and document steps", () => {
    const t = thread(part("findProducts", { rows: [] }), part("readDocument", { markdown: "x" }), part("catalogueSummary", { variants: 3 }));
    expect(hideOutputs(t, new Set())).toBe(t);
  });

  it("returns the same array when nothing is hidden", () => {
    const t = thread(part("adsSummary", { spend: "1" }), part("salesSummary", { total: "2" }), part("postPerformance", {}));
    expect(hideOutputs(t, new Set(["ads.read", "crm.read", "analytics.read"]))).toBe(t);
  });
});
