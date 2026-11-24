import { describe, expect, it } from "vitest";
import { htmlText } from "@/server/research/crawl";

describe("htmlText", () => {
  it("drops scripts, styles and tags, keeps line breaks, decodes entities", () => {
    expect(htmlText("<p>Oak &amp; linen</p><SCRIPT>x()</script><style>p{}</STYLE>Soft<br>chair <b>bold</b>")).toBe("Oak & linen\n Soft\nchair bold");
    expect(htmlText("a <script>never closed <b>b</b>")).toBe("a never closed b");
    expect(htmlText("1 < 2 and <i>3</i> > 2")).toBe("1 < 2 and 3 > 2");
  });

  it("is linear on hostile text: runs of '<' and unclosed scripts", () => {
    const start = performance.now();
    htmlText("<".repeat(200_000));
    htmlText("<script".repeat(50_000));
    htmlText("<style>".repeat(20_000) + "</style>".repeat(20_000));
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
