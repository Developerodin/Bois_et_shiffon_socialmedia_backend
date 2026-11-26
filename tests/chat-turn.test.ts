import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { productPageWhere } from "@/server/catalog/products";
import { activeTools, askedToSearch, hideSalesOutputs, historyWindow, MAX_SALES_CALLS, MODEL_HISTORY, readsShopData, SALES_HIDDEN } from "@/server/chat/turn";

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

  it(`switches the sales tools off after ${MAX_SALES_CALLS} sales calls in a turn`, () => {
    const calls = Array.from({ length: MAX_SALES_CALLS - 1 }, () => "salesSummary");
    expect(activeTools(ALL, { history: [], calls, searchAsked: false })).toEqual(["findProducts", "salesSummary", "topProducts", "readDocument"]);
    expect(activeTools(ALL, { history: [], calls: [...calls, "topProducts"], searchAsked: false })).toEqual(["findProducts", "readDocument"]);
  });

  it("counts only the person's own words asking for a search, in English or French", () => {
    expect(askedToSearch(msg("Search the web for competitor prices"))).toBe(true);
    expect(askedToSearch(msg("look it up online"))).toBe(true);
    expect(askedToSearch(msg("Peux-tu rechercher les prix ?"))).toBe(true);
    expect(askedToSearch(msg("What's on my website?"))).toBe(false);
    expect(askedToSearch(msg("Analyse my pricing"))).toBe(false);
    expect(askedToSearch(undefined)).toBe(false);
  });
});

describe("product search text", () => {
  it("treats a typed % or _ as a character, not a wildcard", () => {
    const where = productPageWhere({ q: "50%_off", stock: "" });
    expect(where).toEqual({ AND: [{ OR: [{ title: { contains: "50\\%\\_off", mode: "insensitive" } }, { sku: { contains: "50\\%\\_off", mode: "insensitive" } }] }] });
  });
});

describe("hideSalesOutputs", () => {
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
    const out = hideSalesOutputs(thread) as unknown as { parts: Record<string, unknown>[] }[];
    expect(JSON.stringify(out)).not.toContain("900.00");
    expect(out[1].parts[0]).toEqual({ type: "tool-salesSummary", toolCallId: "1", state: "output-available", input: { from: "2026-11-01" }, output: SALES_HIDDEN });
    expect(out[1].parts.slice(1)).toEqual((thread[1].parts as unknown[]).slice(1));
    expect(out[0]).toBe(thread[0]);
    expect(JSON.stringify(thread)).toBe(before); // the saved thread itself is untouched
  });
});
