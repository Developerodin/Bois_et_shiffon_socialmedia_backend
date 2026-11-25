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

/**
 * The tools whose output is the brand's own catalogue or shop data: text in it (titles, discount codes, channels,
 * collections) comes from scraped sites and shop feeds, and sales figures must not travel into a web search.
 */
export const PRODUCT_TOOLS = new Set(["catalogueSummary", "findProducts", "salesSummary", "salesBreakdown", "topProducts", "productSales", "stockRisk"]);

/** Has product data entered the conversation the model sees (a product tool's step in a saved message)? */
export const readsProducts = (history: UIMessage[]) =>
  history.some((m) => m.parts.some((p) => p.type.startsWith("tool-") && PRODUCT_TOOLS.has(p.type.slice(5))));

/**
 * Did the person's own message ask for a web search (English or French)? Only their text counts: words planted in a
 * product title or a web page can't change it.
 */
export function askedToSearch(message: UIMessage | undefined) {
  const text = (message?.parts ?? []).map((p) => (p.type === "text" ? p.text : "")).join(" ");
  // Whole words ("website" is not "web"), verb endings allowed: search/searching, recherche/rechercher, cherche/chercher.
  return /\b(web|online|internet|google\w*|search\w*|look (it )?up|en ligne|recherch\w*|cherch\w*)\b/i.test(text);
}
