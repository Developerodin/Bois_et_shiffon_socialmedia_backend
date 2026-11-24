import { z } from "zod";
import { ARTICLE_LIMITS, type ArticleBlock, type ArticleSpan } from "@/shared";

/**
 * An article body as structured blocks (shared/blog.ts), and its HTML for Shopify from an allow-list: h2 h3 p ul ol li
 * strong em a[href http(s)]. Text is always escaped; a link that isn't http(s) is kept as plain text.
 * The same schema is the writer's output (OpenAI strict mode: every field present, href null when none).
 */
export const ArticleSpanSchema = z.object({
  text: z.string().max(5000),
  bold: z.boolean(),
  italic: z.boolean(),
  href: z.string().max(2000).nullable(),
});
export const ArticleBlockSchema = z
  .object({
    type: z.enum(["h2", "h3", "p", "ul", "ol"]),
    lines: z.array(z.array(ArticleSpanSchema).max(ARTICLE_LIMITS.spans)).min(1).max(ARTICLE_LIMITS.lines),
  })
  .refine((b) => b.type === "ul" || b.type === "ol" || b.lines.length === 1, "A heading or paragraph has exactly one line");
export const ArticleBlocksSchema = z.array(ArticleBlockSchema).max(ARTICLE_LIMITS.blocks);

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

/** The URL if it is an absolute http(s) link, else null. */
export function safeHref(href: string | null): string | null {
  if (!href) return null;
  try {
    const u = new URL(href.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function span(s: ArticleSpan) {
  let t = escape(s.text);
  if (s.italic) t = `<em>${t}</em>`;
  if (s.bold) t = `<strong>${t}</strong>`;
  const href = safeHref(s.href);
  return href ? `<a href="${escape(href)}">${t}</a>` : t;
}
const line = (spans: ArticleSpan[]) => spans.map(span).join("");

export function renderArticleHtml(blocks: ArticleBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === "ul" || b.type === "ol") return `<${b.type}>${b.lines.map((l) => `<li>${line(l)}</li>`).join("")}</${b.type}>`;
      return `<${b.type}>${line(b.lines[0] ?? [])}</${b.type}>`;
    })
    .join("\n");
}

/** The summary as Shopify's themes print it (raw HTML): escaped text in one paragraph, "" when there is none. */
export const renderSummaryHtml = (summary: string) => (summary.trim() ? `<p>${escape(summary.trim())}</p>` : "");

/** The links whose host isn't the brand's website (or a subdomain of it): the confirm dialog flags them. No website: all. */
export function externalLinks(links: string[], websiteUrl: string | null) {
  let own: string | null = null;
  try {
    own = websiteUrl ? new URL(websiteUrl).hostname.replace(/^www\./, "") : null;
  } catch {}
  return links.filter((l) => {
    const host = new URL(l).hostname.replace(/^www\./, "");
    return !own || (host !== own && !host.endsWith(`.${own}`));
  });
}

/** Every link target the HTML will carry, in order, once each: the confirm dialog lists them all. */
export function articleLinks(blocks: ArticleBlock[]): string[] {
  const hrefs = blocks.flatMap((b) => b.lines.flat().map((s) => safeHref(s.href)));
  return [...new Set(hrefs.filter((h): h is string => !!h))];
}

const chars = (b: ArticleBlock) => b.lines.flat().reduce((n, s) => n + s.text.length, 0);
/** Whole blocks up to ARTICLE_LIMITS.chars of text: a longer body is cut at a block, never mid-sentence. */
export function capBlocks(blocks: ArticleBlock[], max: number = ARTICLE_LIMITS.chars): ArticleBlock[] {
  let total = 0;
  const kept: ArticleBlock[] = [];
  for (const b of blocks) {
    total += chars(b);
    if (total > max) break;
    kept.push(b);
  }
  return kept;
}
