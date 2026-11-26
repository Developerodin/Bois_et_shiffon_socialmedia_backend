import type { UIMessage } from "ai";
import type { PermissionKey } from "@/shared";

/** Most messages the model reads per turn, and the step the window's start moves by once a thread is longer. */
export const MODEL_HISTORY = 40;
const WINDOW_STEP = 20;

/**
 * The part of a thread the model reads: at most MODEL_HISTORY messages, with a start that moves WINDOW_STEP messages at
 * a time rather than one per turn. Sliding by one changed the first message every turn and missed OpenAI's prompt cache
 * entirely on long threads; this way the start (and the cached prefix) holds for WINDOW_STEP turns. Reads 20–40.
 */
export function historyWindow<M>(messages: M[]): M[] {
  const over = messages.length - MODEL_HISTORY;
  return over > 0 ? messages.slice(Math.ceil(over / WINDOW_STEP) * WINDOW_STEP) : messages;
}

export type ToolGroup = "sales" | "ads" | "analytics";
/**
 * Chat tools that read the brand's data (server/chat/tools.ts): the keys a person needs (all of them; the same keys as
 * the matching Sales or Performance tab), the call group, and strict = web search always off once its output is in.
 * Gating, the call caps, the web-search lock and saved-chat redaction (hideOutputs) all read from this one map.
 */
export const CHAT_DATA_TOOLS: Record<string, { keys: PermissionKey[]; group: ToolGroup; strict?: true }> = {
  salesSummary: { keys: ["crm.read"], group: "sales", strict: true },
  salesBreakdown: { keys: ["crm.read"], group: "sales", strict: true },
  topProducts: { keys: ["crm.read"], group: "sales", strict: true },
  productSales: { keys: ["crm.read"], group: "sales", strict: true },
  stockRisk: { keys: ["crm.read"], group: "sales", strict: true },
  // Revenue ÷ spend, times spend, gives revenue: a sales figure, so it needs crm.read too and counts as sales.
  revenuePerAdSpend: { keys: ["ads.read", "crm.read"], group: "sales", strict: true },
  adsSummary: { keys: ["ads.read"], group: "ads" },
  adCampaigns: { keys: ["ads.read"], group: "ads" },
  adBudgets: { keys: ["ads.read"], group: "ads" },
  postPerformance: { keys: ["analytics.read"], group: "analytics" },
  searchPerformance: { keys: ["analytics.read"], group: "analytics" },
};
/** Calls one group may make per message (a full sales report takes four or five): past it the group is switched off. */
export const MAX_GROUP_CALLS = 8;
/**
 * Data-tool calls per message in all. Each output is saved in the thread and resent with later turns (within the
 * 40-message window), so three full groups (24 calls, ~60k tokens) would weigh on every turn after it.
 * Ceiling: this bounds one message; a long thread of data questions still grows the prompt until the window moves.
 */
export const MAX_DATA_CALLS = 12;
/** Tools after whose output web search stays off even when the person asks: the sales figures. */
const STRICT_TOOLS = new Set(Object.keys(CHAT_DATA_TOOLS).filter((n) => CHAT_DATA_TOOLS[n].strict));
/**
 * The tools whose output is the brand's catalogue, sales, ads and performance data: text in it (titles, discount
 * codes, campaign names, page URLs) comes from scraped sites, shop feeds and people, and none of it may travel out in
 * a web search.
 */
export const SHOP_DATA_TOOLS = new Set(["catalogueSummary", "findProducts", ...Object.keys(CHAT_DATA_TOOLS)]);

/**
 * Has one of `tools` run in the conversation the model sees (its step in a saved message)? By default: any tool that
 * reads the brand's catalogue, sales, ads and performance data.
 */
export const readsShopData = (history: UIMessage[], tools: ReadonlySet<string> = SHOP_DATA_TOOLS) =>
  history.some((m) => m.parts.some((p) => p.type.startsWith("tool-") && tools.has(p.type.slice(5))));

/** What a sales step holds for someone without crm.read: the sales tools' refusal, and a saved step's output once hidden. */
export const SALES_HIDDEN = { error: "Your role can't see sales." };
/** The fixed refusal for each key a data tool needs. */
const HIDDEN: Partial<Record<PermissionKey, { error: string }>> = {
  "crm.read": SALES_HIDDEN,
  "ads.read": { error: "Your role can't see ads." },
  "analytics.read": { error: "Your role can't see performance numbers." },
};

/** The refusal for the first of `keys` not in `perms`, or null when every key is held. */
export function hiddenFor(keys: readonly PermissionKey[], perms: ReadonlySet<string>) {
  const missing = keys.find((k) => !perms.has(k));
  return missing ? (HIDDEN[missing] ?? { error: "Your role can't see this." }) : null;
}

/**
 * A saved thread as a viewer may see it: each data tool's output whose keys the viewer doesn't all hold is swapped for
 * that key's refusal, the step and its input kept (the chat lists the steps it took). Someone who loses a key keeps
 * their old threads, and the figures the tools returned then must not stay readable in them. A tool CHAT_DATA_TOOLS
 * doesn't list (catalogue, documents) is never hidden. For reading only: never saved back, so the figures are there
 * again if the role regains the key. Returns `messages` itself when nothing is hidden (cheap for full readers).
 * Ceiling: it hides the raw tool payloads only; figures the assistant already wrote in its own text stay visible.
 */
export function hideOutputs(messages: UIMessage[], perms: ReadonlySet<string>): UIMessage[] {
  const hidden = (p: UIMessage["parts"][number]) => {
    const entry = p.type.startsWith("tool-") && "output" in p ? CHAT_DATA_TOOLS[p.type.slice(5)] : undefined;
    return entry ? hiddenFor(entry.keys, perms) : null;
  };
  let changed = false;
  const out = messages.map((m) => {
    if (!m.parts.some(hidden)) return m;
    changed = true;
    return {
      ...m,
      parts: m.parts.map((p) => {
        const refusal = hidden(p);
        return refusal ? ({ ...p, output: refusal } as typeof p) : p;
      }),
    };
  });
  return changed ? out : messages;
}

/**
 * The tools a step of the turn may use (undefined: all of them). Text planted in a product title, campaign name or
 * page URL could steer a web search that carries the brand's data out, so once such data is in what the model sees
 * (history, or this turn's calls), web search is off for the rest of the turn. The person's own explicit request for
 * a web search turns it back on, never once sales figures (the strict tools) are in. A group's tools are off after
 * MAX_GROUP_CALLS calls in a turn and every data tool after MAX_DATA_CALLS, so a looping model can't run up queries.
 */
export function activeTools<T extends string>(all: T[], turn: { history: UIMessage[]; calls: string[]; searchAsked: boolean }): T[] | undefined {
  const reads = (tools: ReadonlySet<string>) => readsShopData(turn.history, tools) || turn.calls.some((c) => tools.has(c));
  const noSearch = reads(STRICT_TOOLS) || (reads(SHOP_DATA_TOOLS) && !turn.searchAsked);
  const groupCalls: Partial<Record<ToolGroup, number>> = {};
  let dataCalls = 0;
  for (const c of turn.calls) {
    const entry = CHAT_DATA_TOOLS[c];
    if (!entry) continue;
    dataCalls++;
    groupCalls[entry.group] = (groupCalls[entry.group] ?? 0) + 1;
  }
  const capped = (n: string) => {
    const entry = CHAT_DATA_TOOLS[n];
    return !!entry && (dataCalls >= MAX_DATA_CALLS || (groupCalls[entry.group] ?? 0) >= MAX_GROUP_CALLS);
  };
  const active = all.filter((n) => !(noSearch && n === "webSearch") && !capped(n));
  return active.length === all.length ? undefined : active;
}

/**
 * Explicit requests to search the web, in English and French: a short list of phrases, not "a search word near a web
 * word" (which would pass "Search Console clicks for my web shop"). Words that merely name the data never count:
 * "Google Ads", "Google search clicks", "Search Console", "search results", "search terms", "online sales", "web shop",
 * "rechercher les prix". They are the very words of a turn that reads ads or search data, so planted text in a
 * campaign name or page URL could otherwise steer a search that carries figures out.
 * Ceiling: a request worded outside the list ("could you check the internet") doesn't count; the model says web search
 * is off and the person can rephrase. Add phrases here as they turn up.
 */
const SEARCH_ASKS = new RegExp(
  "\\b(?:" +
    [
      "search(?:ing)? (?:on )?(?:the )?(?:web|internet)",
      "search(?:ing)? online",
      "web ?search",
      "look (?:it |that |this )?up online",
      "look online",
      "google (?:it|that)",
      "(?:re)?cherch(?:e|er|es|ez)? (?:sur (?:le web|internet)|en ligne)",
      "recherche web",
    ].join("|") +
    ")\\b",
  "i",
);

/**
 * Did the person's own message explicitly ask for a web search (English or French)? Only their text counts: words
 * planted in a product title or a web page can't change it.
 */
export function askedToSearch(message: UIMessage | undefined) {
  const text = (message?.parts ?? []).map((p) => (p.type === "text" ? p.text : "")).join(" ");
  return SEARCH_ASKS.test(text);
}
