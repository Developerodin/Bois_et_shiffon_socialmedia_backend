import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { parseSheet } from "@/server/catalog/import-file";
import { toXlsx } from "@/server/api/xlsx";

const csv = (s: string) => parseSheet(strToU8(s));

// A minimal hand-made workbook: one sheet, optional shared strings.
const NS = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`;
function book(sheetData: string, shared?: string, sheet = `<?xml version="1.0"?><worksheet ${NS}><sheetData>${sheetData}</sheetData></worksheet>`) {
  return zipSync({
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook ${NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="P" sheetId="1" r:id="rId7"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Target="strings.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Id="rId2"/>` +
        `<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/products.xml"/></Relationships>`,
    ),
    "xl/worksheets/products.xml": strToU8(sheet),
    ...(shared ? { "xl/strings.xml": strToU8(`<?xml version="1.0"?><sst ${NS}>${shared}</sst>`) } : {}),
  });
}
const inline = (ref: string, s: string) => `<c r="${ref}" t="inlineStr"><is><t>${s}</t></is></c>`;

describe("parseSheet CSV", () => {
  it("detects comma, semicolon and tab", () => {
    expect(csv("Name,Price\nChair,10\n")).toEqual({ headers: ["Name", "Price"], rows: [["Chair", "10"]] });
    expect(csv("Nom;Prix\r\nChaise;1 299,00\r\n")).toEqual({ headers: ["Nom", "Prix"], rows: [["Chaise", "1 299,00"]] });
    expect(csv("Name\tPrice\nChair, oak\t10")).toEqual({ headers: ["Name", "Price"], rows: [["Chair, oak", "10"]] });
  });

  it("keeps quoted newlines, delimiters and doubled quotes; skips empty rows", () => {
    expect(csv('"Name;x",Desc\n\n,\n"Chair","Line 1\nsaid ""hi"", ok"\n')).toEqual({
      headers: ["Name;x", "Desc"],
      rows: [["Chair", 'Line 1\nsaid "hi", ok']],
    });
  });

  it("reads a UTF-8 BOM, UTF-16 (LE and BE) and Windows-1252", () => {
    expect(csv("﻿Name\nCafé")).toEqual({ headers: ["Name"], rows: [["Café"]] });
    const le = Buffer.from("﻿Name,Price\nCafé,1", "utf16le");
    expect(parseSheet(le)).toEqual({ headers: ["Name", "Price"], rows: [["Café", "1"]] });
    expect(parseSheet(Buffer.from(le).swap16())).toEqual({ headers: ["Name", "Price"], rows: [["Café", "1"]] });
    expect(parseSheet(new Uint8Array([...strToU8("Nom\nCaf"), 0xe9]))).toEqual({ headers: ["Nom"], rows: [["Café"]] });
  });

  it("stops at 5,001 rows and 51 columns, and cuts long cells", () => {
    expect(csv("Name\n" + "x\n".repeat(5000))).toMatchObject({ rows: { length: 5000 } });
    expect(csv("Name\n" + "x\n".repeat(5001))).toEqual({ error: expect.stringContaining("more than 5,000") });
    expect(csv(",".repeat(49) + "\n")).toEqual({ error: "The file is empty." });
    expect(csv("a" + ",".repeat(50) + "\n")).toEqual({ error: expect.stringContaining("more than 50 columns") });
    expect(csv("Name\n" + "y".repeat(20_000))).toEqual({ headers: ["Name"], rows: [["y".repeat(10_000)]] });
  });

  it("refuses an old .xls file and a file over 5 MB", () => {
    expect(parseSheet(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]))).toEqual({ error: expect.stringContaining("Save it as .xlsx or CSV") });
    expect(parseSheet(new Uint8Array(5 * 1024 * 1024 + 1))).toEqual({ error: expect.stringContaining("larger than 5 MB") });
  });
});

describe("parseSheet XLSX", () => {
  it("reads our own export", () => {
    const x = toXlsx("Products", [{ key: "t", label: "Title", width: 30 }, { key: "p", label: "Price", width: 10 }], [{ t: "Chair <oak> & co", p: 12.5 }, { t: "=1+1", p: null }]);
    expect(parseSheet(x)).toEqual({ headers: ["Title", "Price"], rows: [["Chair <oak> & co", "12.5"], ["=1+1", ""]] });
  });

  it("reads shared, rich-text and inline strings, booleans and numbers", () => {
    const shared = `<si><t>Title</t></si><si><r><t>Ch</t></r><r><rPr><b/></rPr><t xml:space="preserve">air &amp; co</t></r><rPh><t>ignored</t></rPh></si><si><t>In stock</t></si>`;
    const rows = `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c><c r="C1" t="str"><v>Price</v></c></row>` + `<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="b"><v>1</v></c><c r="C2"><v>1299</v></c></row>` + `<row r="3">${inline("A3", "Lamp &#233;")}</row>`;
    expect(parseSheet(book(rows, shared))).toEqual({ headers: ["Title", "In stock", "Price"], rows: [["Chair & co", "1", "1299"], ["Lamp é"]] });
  });

  it("places sparse cells by column and cells without r in sequence", () => {
    const rows = `<row r="1">${inline("A1", "a")}${inline("C1", "c")}</row><row r="4"><c t="inlineStr"><is><t>x</t></is></c><c t="inlineStr"><is><t>y</t></is></c>${inline("E4", "z")}</row>`;
    expect(parseSheet(book(rows))).toEqual({ headers: ["a", "", "c"], rows: [["x", "y", "", "", "z"]] });
  });

  it("reads a formula with no cached value as empty", () => {
    const rows = `<row r="1">${inline("A1", "Title")}${inline("B1", "Price")}</row><row r="2">${inline("A2", "Chair")}<c r="B2"><f>SUM(C2:D2)</f></c></row>`;
    expect(parseSheet(book(rows))).toEqual({ headers: ["Title", "Price"], rows: [["Chair", ""]] });
  });

  it("refuses a cell at XFD1 and column AY, accepts AX", () => {
    expect(parseSheet(book(`<row r="1">${inline("A1", "T")}<c r="XFD1"><v>1</v></c></row>`))).toEqual({ error: expect.stringContaining("more than 50 columns") });
    expect(parseSheet(book(`<row r="1">${inline("AY1", "T")}</row>`))).toEqual({ error: expect.stringContaining("more than 50 columns") });
    expect(parseSheet(book(`<row r="1">${inline("AX1", "T")}</row>`))).toMatchObject({ headers: { length: 50 } });
  });

  it("stops at 5,001 data rows", () => {
    const rows = (n: number) => Array.from({ length: n + 1 }, (_, i) => `<row r="${i + 1}">${inline(`A${i + 1}`, "x")}</row>`).join("");
    expect(parseSheet(book(rows(5000)))).toMatchObject({ rows: { length: 5000 } });
    expect(parseSheet(book(rows(5001)))).toEqual({ error: expect.stringContaining("more than 5,000") });
  });

  it("refuses a DOCTYPE", () => {
    const sheet = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><worksheet ${NS}><sheetData><row r="1">${inline("A1", "&a;")}</row></sheetData></worksheet>`;
    expect(parseSheet(book("", undefined, sheet))).toEqual({ error: expect.stringContaining("content we don't read") });
  });

  it("stops an entry that claims 1 KB but inflates to 50 MB", () => {
    const zip = book("", undefined, "<worksheet>" + " ".repeat(50 * 1024 * 1024));
    // Rewrite the sheet's local header so its uncompressed size claims 1 KB.
    const name = strToU8("xl/worksheets/products.xml");
    const view = new DataView(zip.buffer);
    for (let i = 0; i < zip.length - 30; i++) {
      if (view.getUint32(i, true) !== 0x04034b50) continue;
      const n = view.getUint16(i + 26, true);
      if (Buffer.from(zip.subarray(i + 30, i + 30 + n)).equals(Buffer.from(name))) view.setUint32(i + 22, 1024, true);
    }
    expect(zip.length).toBeLessThan(5 * 1024 * 1024);
    expect(parseSheet(zip)).toEqual({ error: expect.stringContaining("too large once unpacked") });
  });

  it("refuses a zip with no workbook", () => {
    expect(parseSheet(zipSync({ "index.xml": strToU8("<x/>") }))).toEqual({ error: expect.stringContaining("couldn't find a sheet") });
  });
});
