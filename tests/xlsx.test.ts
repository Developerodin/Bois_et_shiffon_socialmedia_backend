import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { toXlsx } from "@/server/api/xlsx";

describe("toXlsx", () => {
  const files = unzipSync(toXlsx("SEO findings", [{ key: "a", label: "Title", width: 40 }, { key: "n", label: "Pages", width: 8 }], [{ a: '=HYPERLINK("x") & <b>\u0001', n: 3 }]));
  const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]!);

  it("has every part Excel needs", () => {
    expect(Object.keys(files).sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
  });

  it("sets widths, freezes the header and filters it", () => {
    expect(sheet).toContain('<col min="1" max="1" width="40" customWidth="1"/>');
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<autoFilter ref="A1:B2"/>');
  });

  it("writes text as escaped inline strings (never a formula) and numbers as numbers", () => {
    expect(sheet).toContain("=HYPERLINK(&quot;x&quot;) &amp; &lt;b&gt;</t>");
    expect(sheet).not.toContain("<f>");
    expect(sheet).toContain('<c r="B2" s="2"><v>3</v></c>');
  });
});
