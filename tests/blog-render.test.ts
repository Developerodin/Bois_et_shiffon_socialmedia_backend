import { describe, expect, it } from "vitest";
import { articleLinks, capBlocks, renderArticleHtml } from "@/server/blog/render";
import { spansToText, textToSpans, type ArticleBlock, type ArticleSpan } from "@/shared";

const s = (text: string, o: Partial<ArticleSpan> = {}): ArticleSpan => ({ text, bold: false, italic: false, href: null, ...o });
const p = (...spans: ArticleSpan[]): ArticleBlock => ({ type: "p", lines: [spans] });

describe("renderArticleHtml", () => {
  it("escapes text and drops links that aren't http(s)", () => {
    const html = renderArticleHtml([
      { type: "h2", lines: [[s("<script>alert(1)</script>")]] },
      p(s("click", { href: "javascript:alert(1)" }), s(" and "), s("data", { href: "data:text/html,x" }), s(" or "), s("<b>", { href: 'https://x.test/a"onmouseover="y' })),
    ]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toMatch(/javascript:|data:text/);
    expect(html).toContain('<a href="https://x.test/a%22onmouseover=%22y">&lt;b&gt;</a>');
    expect(html).toContain("<p>click and data or ");
  });

  it("renders only the allow-listed tags", () => {
    const html = renderArticleHtml([
      { type: "h3", lines: [[s("Care")]] },
      { type: "ul", lines: [[s("Wash", { bold: true })], [s("Dry", { italic: true, href: "https://shop.test/dry" })]] },
      { type: "ol", lines: [[s("One")]] },
    ]);
    expect(html).toBe('<h3>Care</h3>\n<ul><li><strong>Wash</strong></li><li><a href="https://shop.test/dry"><em>Dry</em></a></li></ul>\n<ol><li>One</li></ol>');
    expect([...html.matchAll(/<\/?([a-z0-9]+)/g)].every((m) => ["h3", "ul", "li", "strong", "a", "em", "ol"].includes(m[1]!))).toBe(true);
  });

  it("lists every http(s) link target once", () => {
    const blocks = [p(s("a", { href: "https://a.test/x" }), s("b", { href: "javascript:x" })), p(s("again", { href: "https://a.test/x" }), s("c", { href: "http://c.test" }))];
    expect(articleLinks(blocks)).toEqual(["https://a.test/x", "http://c.test/"]);
  });
});

describe("capBlocks", () => {
  it("cuts a body over the cap at a block, never inside one", () => {
    const blocks = [p(s("a".repeat(40))), p(s("b".repeat(40))), p(s("c".repeat(40)))];
    expect(capBlocks(blocks, 100)).toEqual(blocks.slice(0, 2));
    expect(capBlocks(blocks, 120)).toEqual(blocks);
  });
});

describe("the editor's text format", () => {
  it("round-trips links, bold and italic", () => {
    const spans = [s("Read "), s("our guide", { href: "https://shop.test/g" }), s(" on "), s("linen", { bold: true }), s(", "), s("gently", { italic: true }), s(" "), s("both", { bold: true, italic: true })];
    const text = spansToText(spans);
    expect(text).toBe("Read [our guide](https://shop.test/g) on **linen**, *gently* ***both***");
    expect(textToSpans(text)).toEqual(spans);
  });

  it("keeps a non-http link as text", () => {
    expect(textToSpans("[x](javascript:alert(1))")).toEqual([s("[x](javascript:alert(1))")]);
  });
});
