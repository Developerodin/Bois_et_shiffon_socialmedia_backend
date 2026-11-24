import { Unzip, UnzipInflate } from "fflate";

/**
 * Reads an uploaded product spreadsheet (CSV, or the first sheet of an .xlsx) into a header row and data rows, in
 * memory only: nothing is stored. Limits are enforced while scanning, so a hostile file (a zip bomb with a lying size,
 * a cell at XFD1, a million rows, huge cells) is refused before it costs memory. Cells are plain text: no formula is
 * evaluated and no date converted. The first non-empty row is the header; empty rows are skipped; cells are trimmed.
 */
/** `lines[i]`: where data row i starts in the file (CSV line, Excel row number), so a problem names the row people see. */
export type Sheet = { headers: string[]; rows: string[][]; lines: number[] };

const MAX_FILE = 5 * 1024 * 1024;
const MAX_ROWS = 5_000;
const MAX_COLS = 50;
const MAX_CELL = 10_000;
const MAX_ENTRY = 20 * 1024 * 1024;
const MAX_INFLATED = 30 * 1024 * 1024;
// Compressed bytes pushed at a time. Deflate expands at most ~1,032x, so one push inflates at most ~4 MB before the
// byte counter gets to stop it; the zip header's size is never trusted.
const CHUNK = 4096;

const TOO_LARGE = "The file is larger than 5 MB. Split it into smaller files and import them one by one.";
const OLD_FORMAT = "This is an old Excel file. Save it as .xlsx or CSV and try again.";
const TOO_MANY_ROWS = "The file has more than 5,000 products. Split it into smaller files and import them one by one.";
const TOO_MANY_COLS = "The file has more than 50 columns. Remove the columns you don't need and try again.";
const EMPTY = "The file is empty.";
const DAMAGED = "We couldn't read this Excel file. Save it as .xlsx or CSV and try again.";
const UNPACKS_TOO_BIG = "This Excel file is too large once unpacked. Save it as CSV or split it, then try again.";
const DOCTYPE = "This Excel file contains content we don't read. Save it again from Excel or as CSV and try again.";
const NO_SHEET = "We couldn't find a sheet in this file. Save it as .xlsx or CSV and try again.";

class Refused extends Error {}

export function parseSheet(bytes: Uint8Array): Sheet | { error: string } {
  try {
    if (bytes.length > MAX_FILE) return { error: TOO_LARGE };
    if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return parseXlsx(bytes);
    if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) return { error: OLD_FORMAT };
    return parseCsv(decode(bytes));
  } catch (e) {
    if (e instanceof Refused) return { error: e.message };
    throw e;
  }
}

const startsWith = (b: Uint8Array, magic: number[]) => magic.every((x, i) => b[i] === x);

/** Collects rows; throws at the 5,001st data row so a huge file stops there. */
function table() {
  let headers: string[] | null = null;
  const rows: string[][] = [];
  const lines: number[] = [];
  return {
    add(cells: string[], line: number) {
      const row = cells.map((c) => c.trim());
      if (!row.some(Boolean)) return;
      if (!headers) headers = row;
      else if (rows.push(row) > MAX_ROWS) throw new Refused(TOO_MANY_ROWS);
      else lines.push(line);
    },
    done(): Sheet {
      if (!headers) throw new Refused(EMPTY);
      return { headers, rows, lines };
    },
  };
}

// --- CSV ---

// UTF-16 only with a BOM; UTF-8 (BOM stripped) when it decodes cleanly, else Windows-1252 (Excel's "CSV" on Windows).
function decode(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return new TextDecoder("windows-1252").decode(b);
  }
}

// The most frequent of , ; tab in the first line outside quotes; comma on a tie or none. A quote opens only at the
// start of a cell, so a header like `5" screen` doesn't hide the delimiters after it.
function delimiter(text: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  let cellStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') continue;
      if (text[i + 1] === '"') i++;
      else quoted = false;
    } else if (ch === "\n" || ch === "\r") break;
    else if (ch === '"' && cellStart) {
      quoted = true;
      cellStart = false;
    } else {
      cellStart = ch in counts;
      if (cellStart) counts[ch]++;
    }
  }
  return Object.keys(counts).reduce((a, b) => (counts[b] > counts[a] ? b : a));
}

// RFC 4180: quoted cells may hold the delimiter, newlines and "" for a quote; CRLF, LF or CR end a row.
function parseCsv(text: string): Sheet {
  const delim = delimiter(text);
  const t = table();
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let cellStart = true; // `cell === ""` can't tell a fresh cell from a quoted empty one ("")
  let line = 1; // the line being read; a newline inside quotes moves it on too
  let rowStart = 1;
  const add = (ch: string) => {
    if (cell.length < MAX_CELL) cell += ch;
    cellStart = false;
  };
  const endCell = () => {
    row.push(cell);
    cell = "";
    cellStart = true;
    if (row.length > MAX_COLS) throw new Refused(TOO_MANY_COLS);
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n")) line++;
      if (ch !== '"') add(ch);
      else if (text[i + 1] !== '"') quoted = false;
      else {
        add('"');
        i++;
      }
    } else if (ch === '"' && cellStart) {
      quoted = true;
      cellStart = false;
    }
    else if (ch === delim) endCell();
    else if (ch === "\n" || ch === "\r") {
      endCell();
      t.add(row, rowStart);
      row = [];
      rowStart = ++line;
      if (ch === "\r" && text[i + 1] === "\n") i++;
    } else add(ch);
  }
  if (cell || row.length) {
    endCell();
    t.add(row, rowStart);
  }
  return t.done();
}

// --- XLSX ---

/**
 * Inflates only the named entries, counting real inflated bytes: past 20 MB for one entry or 30 MB in all (shared
 * across passes through `budget`) it stops pushing and refuses. Any DOCTYPE is refused (no entity expansion).
 */
function unzip(bytes: Uint8Array, names: string[], budget: { total: number }): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Set<string>();
  let failure: string | null = null;
  const uz = new Unzip((file) => {
    if (!names.includes(file.name) || seen.has(file.name)) return;
    seen.add(file.name);
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (err, data, final) => {
      if (failure) return;
      if (err) return void (failure = DAMAGED);
      size += data.length;
      budget.total += data.length;
      if (size > MAX_ENTRY || budget.total > MAX_INFLATED) return void (failure = UNPACKS_TOO_BIG);
      chunks.push(data);
      if (!final) return;
      const xml = new TextDecoder().decode(Buffer.concat(chunks));
      if (/<!DOCTYPE/i.test(xml)) failure = DOCTYPE;
      else out.set(file.name, xml);
    };
    file.start();
  });
  uz.register(UnzipInflate);
  try {
    for (let i = 0; i < bytes.length && !failure; i += CHUNK) uz.push(bytes.subarray(i, i + CHUNK), i + CHUNK >= bytes.length);
  } catch {
    failure ??= DAMAGED;
  }
  if (failure) throw new Refused(failure);
  return out;
}

const attr = (tag: string, name: string) => new RegExp(`\\b${name}=["']([^"']*)["']`).exec(tag)?.[1];
const partPath = (target: string) => (target.startsWith("/") ? target.slice(1) : `xl/${target}`);

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (s: string) =>
  s.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g, (_, hex, dec, name) => {
    if (name) return NAMED[name];
    const code = hex ? parseInt(hex, 16) : Number(dec);
    return code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });

type Element = { attrs: string; body: string; start: number; end: number };

/**
 * Each `<name …>…</name>` or `<name …/>` in order, with an optional namespace prefix (`<x:row>`, as the .NET OpenXML
 * SDK writes). One pass: each open tag's `>` and close tag are looked up once and the cursor moves past them, so a
 * file of unclosed tags costs one scan, not one per tag; a missing `>` or close tag refuses the file as damaged.
 * Same-name elements never nest in the parts read here. Ceiling: a `>` inside an attribute value would end the tag
 * early; OOXML writers escape it.
 */
function* elements(xml: string, name: string): Generator<Element> {
  const open = new RegExp(`<((?:[A-Za-z_][\\w.-]*:)?${name})(?=[\\s/>])`, "g");
  for (let m = open.exec(xml); m; m = open.exec(xml)) {
    const tagEnd = xml.indexOf(">", m.index);
    if (tagEnd < 0) throw new Refused(DAMAGED);
    if (xml[tagEnd - 1] === "/") {
      yield { attrs: xml.slice(m.index + m[0].length, tagEnd - 1), body: "", start: m.index, end: tagEnd + 1 };
      open.lastIndex = tagEnd + 1;
      continue;
    }
    const closeTag = `</${m[1]}>`;
    const close = xml.indexOf(closeTag, tagEnd + 1);
    if (close < 0) throw new Refused(DAMAGED);
    const end = close + closeTag.length;
    yield { attrs: xml.slice(m.index + m[0].length, tagEnd), body: xml.slice(tagEnd + 1, close), start: m.index, end };
    open.lastIndex = end;
  }
}

const first = (xml: string, name: string) => elements(xml, name).next().value as Element | undefined;

// A string item: plain <t>, or rich-text <r><t> runs joined; phonetic <rPh> runs are not part of the text.
function text(xml: string): string {
  let kept = "";
  let at = 0;
  for (const ph of elements(xml, "rPh")) {
    kept += xml.slice(at, ph.start);
    at = ph.end;
  }
  kept += xml.slice(at);
  return unescapeXml([...elements(kept, "t")].map((e) => e.body).join("")).slice(0, MAX_CELL);
}

// "AX" -> 49. Throws as soon as the letters pass column 50, so XFD1 never allocates a 16,384-cell row.
function column(letters: string): number {
  let n = 0;
  for (const ch of letters) {
    n = n * 26 + ch.charCodeAt(0) - 64;
    if (n > MAX_COLS) throw new Refused(TOO_MANY_COLS);
  }
  return n - 1;
}

function value(attrs: string, body: string, shared: string[]): string {
  const type = attr(attrs, "t");
  if (type === "inlineStr") return text(first(body, "is")?.body ?? "");
  // A formula with no cached <v> reads as empty.
  const v = unescapeXml(first(body, "v")?.body ?? "");
  if (type === "s") return v === "" ? "" : (shared[Number(v)] ?? "");
  if (type === "e") return "";
  return v.slice(0, MAX_CELL); // n, str, b ("1"/"0"), dates as their serial number
}

function parseXlsx(bytes: Uint8Array): Sheet {
  const budget = { total: 0 };
  // Pass 1: which part is the first sheet, and where the shared strings are.
  const book = unzip(bytes, ["xl/workbook.xml", "xl/_rels/workbook.xml.rels"], budget);
  const rels = [...elements(book.get("xl/_rels/workbook.xml.rels") ?? "", "Relationship")].map((e) => e.attrs);
  const firstSheet = first(book.get("xl/workbook.xml") ?? "", "sheet")?.attrs;
  // The relationship id is a prefixed attribute (r:id); anchored on whitespace so the scan stays linear.
  const rid = firstSheet && /\s[A-Za-z_][\w.-]*:id=["']([^"']*)["']/.exec(firstSheet)?.[1];
  const sheetTarget = rid && rels.map((r) => (attr(r, "Id") === rid ? attr(r, "Target") : undefined)).find(Boolean);
  if (!sheetTarget) throw new Refused(NO_SHEET);
  const sharedTarget = rels.map((r) => (attr(r, "Type")?.endsWith("/sharedStrings") ? attr(r, "Target") : undefined)).find(Boolean);
  const sheetPath = partPath(sheetTarget);
  const sharedPath = sharedTarget ? partPath(sharedTarget) : "xl/sharedStrings.xml";

  // Pass 2: the sheet and its shared strings.
  const parts = unzip(bytes, [sheetPath, sharedPath], budget);
  const sheet = parts.get(sheetPath);
  if (sheet == null) throw new Refused(NO_SHEET);
  const shared = [...elements(parts.get(sharedPath) ?? "", "si")].map((e) => text(e.body));

  const t = table();
  let rowNumber = 0;
  for (const row of elements(sheet, "row")) {
    // <row r="7"> is Excel's row number; a row without r follows the previous one.
    rowNumber = Number(/\br=["'](\d+)/.exec(row.attrs)?.[1] ?? rowNumber + 1);
    const cells: string[] = [];
    let next = 0;
    for (const c of elements(row.body, "c")) {
      // Cells with r="B3" go to their column; cells without r follow the previous one.
      const ref = /\br=["']([A-Z]+)/.exec(c.attrs)?.[1];
      const col = ref ? column(ref) : next;
      if (col >= MAX_COLS) throw new Refused(TOO_MANY_COLS);
      while (cells.length < col) cells.push("");
      cells[col] = value(c.attrs, c.body, shared);
      next = col + 1;
    }
    t.add(cells, rowNumber);
  }
  return t.done();
}
