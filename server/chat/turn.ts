import type { UIMessage } from "ai";

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

/** The sales tools (server/chat/tools.ts): the shop's own sales figures. */
export const SALES_TOOLS = new Set(["salesSummary", "salesBreakdown", "topProducts", "productSales", "stockRisk"]);
/**
 * The tools whose output is the brand's catalogue or shop data: text in it (titles, discount codes, channels,
 * collections) comes from scraped sites and shop feeds, and none of it may travel out in a web search.
 */
export const SHOP_DATA_TOOLS = new Set(["catalogueSummary", "findProducts", ...SALES_TOOLS]);
/** Sales tool calls a turn may make (a full report takes four or five): past it they're switched off for the turn. */
export const MAX_SALES_CALLS = 8;

/** Has one of `tools` run in the conversation the model sees (its step in a saved message)? */
export const readsShopData = (history: UIMessage[], tools: ReadonlySet<string> = SHOP_DATA_TOOLS) =>
  history.some((m) => m.parts.some((p) => p.type.startsWith("tool-") && tools.has(p.type.slice(5))));

/** What a sales step holds for someone without crm.read: the sales tools' refusal, and a saved step's output once hidden. */
export const SALES_HIDDEN = { error: "Your role can't see sales." };
const isSalesOutput = (p: UIMessage["parts"][number]) => p.type.startsWith("tool-") && SALES_TOOLS.has(p.type.slice(5)) && "output" in p;

/**
 * A saved thread as a viewer without crm.read may see it: the sales tools' figures swapped for SALES_HIDDEN, the step
 * and its input kept (the chat lists the steps it took). Someone who loses crm.read keeps their old threads, and
 * the figures the tools returned then must not stay readable in them. For reading only: never saved back, so the
 * figures are there again if the role regains crm.read. It hides the raw tool payloads only: figures the assistant
 * already wrote in its own text stay visible.
 */
export const hideSalesOutputs = (messages: UIMessage[]): UIMessage[] =>
  messages.map((m) => (m.parts.some(isSalesOutput) ? { ...m, parts: m.parts.map((p) => (isSalesOutput(p) ? ({ ...p, output: SALES_HIDDEN } as typeof p) : p)) } : m));

/**
 * The tools a step of the turn may use (undefined: all of them). Text planted in a product title could steer a web
 * search that carries shop data out, so once shop data is in what the model sees (history, or this turn's calls), web
 * search is off for the rest of the turn; the person's own request for a search turns it back on for catalogue data,
 * never once sales figures are in (they're the more sensitive). After MAX_SALES_CALLS sales calls in a turn the sales
 * tools are off too, so a looping model can't run up queries.
 */
export function activeTools<T extends string>(all: T[], turn: { history: UIMessage[]; calls: string[]; searchAsked: boolean }): T[] | undefined {
  const sales = readsShopData(turn.history, SALES_TOOLS) || turn.calls.some((c) => SALES_TOOLS.has(c));
  const shop = sales || readsShopData(turn.history) || turn.calls.some((c) => SHOP_DATA_TOOLS.has(c));
  const noSearch = sales || (shop && !turn.searchAsked);
  const noSales = turn.calls.filter((c) => SALES_TOOLS.has(c)).length >= MAX_SALES_CALLS;
  const active = all.filter((n) => !(noSearch && n === "webSearch") && !(noSales && SALES_TOOLS.has(n)));
  return active.length === all.length ? undefined : active;
}

/**
 * Did the person's own message ask for a web search (English or French)? Only their text counts: words planted in a
 * product title or a web page can't change it.
 */
export function askedToSearch(message: UIMessage | undefined) {
  const text = (message?.parts ?? []).map((p) => (p.type === "text" ? p.text : "")).join(" ");
  // Whole words ("website" is not "web"), verb endings allowed: search/searching, recherche/rechercher, cherche/chercher.
  return /\b(web|online|internet|google\w*|search\w*|look (it )?up|en ligne|recherch\w*|cherch\w*)\b/i.test(text);
}
