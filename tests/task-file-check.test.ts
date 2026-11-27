import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { checkTaskFile, cleanFileName, downloadName } from "@/server/tasks/file-check";
import { TASK_FILE_TYPES, taskFileType, type TaskFileType } from "@/shared";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const CT = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`;

/** A minimal ZIP (stored, or deflated with `deflate`) holding these entries, with a central directory and one end record. */
function zip(entries: Record<string, string>, opts: { deflate?: boolean; comment?: string; extraEnd?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text);
    const data = opts.deflate ? deflateRawSync(raw) : raw;
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(opts.deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(opts.deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const comment = Buffer.from(opts.comment ?? "");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, cd, end, comment]);
}

const ok = (b: Buffer, t: TaskFileType) => checkTaskFile(b, t);
const refused = (b: Buffer, t: TaskFileType) => expect(() => checkTaskFile(b, t)).toThrow();

describe("checkTaskFile", () => {
  it("PDF, JPG and PNG by their first bytes", () => {
    expect(ok(Buffer.from("%PDF-1.7\n..."), "application/pdf")).toBe("application/pdf");
    expect(ok(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), "image/jpeg")).toBe("image/jpeg");
    expect(ok(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10]), "image/png")).toBe("image/png");
  });

  it("Word, Excel and PowerPoint by their package parts, stored or deflated", () => {
    expect(ok(zip({ "[Content_Types].xml": CT, "word/document.xml": "<w/>" }), DOCX)).toBe(DOCX);
    expect(ok(zip({ "[Content_Types].xml": CT, "xl/workbook.xml": "<x/>" }, { deflate: true }), XLSX)).toBe(XLSX);
    expect(ok(zip({ "[Content_Types].xml": CT, "ppt/presentation.xml": "<p/>" }, { comment: "made by hand" }), PPTX)).toBe(PPTX);
  });

  it("UTF-8 text is a CSV or a text file, whichever was announced", () => {
    const csv = Buffer.from("name,price\nCafé crème,4.50\n");
    expect(ok(csv, "text/csv")).toBe("text/csv");
    expect(ok(csv, "text/plain")).toBe("text/plain");
  });

  it("a file that isn't what its name says is refused", () => {
    refused(Buffer.from("%PDF-1.7"), DOCX);
    refused(zip({ "[Content_Types].xml": CT, "xl/workbook.xml": "<x/>" }), DOCX);
    refused(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/png");
    refused(Buffer.from("<html><script>alert(1)</script></html>"), "application/pdf");
    // A ZIP that is no Office file, or one with two main parts.
    refused(zip({ "a.txt": "hi" }), DOCX);
    refused(zip({ "[Content_Types].xml": CT, "word/document.xml": "<w/>", "xl/workbook.xml": "<x/>" }), DOCX);
    refused(zip({ "word/document.xml": "<w/>" }), DOCX);
  });

  it("macros and ActiveX are refused however the file is named", () => {
    refused(zip({ "[Content_Types].xml": CT, "word/document.xml": "<w/>", "word/vbaProject.bin": "x" }), DOCX);
    refused(zip({ "[Content_Types].xml": CT, "xl/workbook.xml": "<x/>", "xl/activeX/activeX1.xml": "x" }), XLSX);
    const macro = CT.replace("</Types>", `<Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>`);
    refused(zip({ "[Content_Types].xml": macro, "word/document.xml": "<w/>" }, { deflate: true }), DOCX);
  });

  it("broken, ZIP64-looking or doubled archives are refused", () => {
    const good = zip({ "[Content_Types].xml": CT, "word/document.xml": "<w/>" });
    refused(good.subarray(0, good.length - 5), DOCX);
    const z64 = Buffer.from(good);
    z64.writeUInt16LE(0xffff, z64.length - 22 + 10);
    refused(z64, DOCX);
    refused(Buffer.concat([good, good]), DOCX);
    refused(Buffer.from([0x50, 0x4b, 0x03, 0x04]), DOCX);
  });

  it("binary that isn't one of the types, and non-UTF-8 text, are refused with a reason", () => {
    expect(() => checkTaskFile(Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0]), "text/plain")).toThrow(/isn't supported/);
    expect(() => checkTaskFile(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]), "text/csv")).toThrow(/CSV UTF-8/);
  });
});

describe("names", () => {
  it("the display name loses control and direction characters only", () => {
    expect(cleanFileName("  Rapport‮fdp.exe  final.pdf ")).toBe("Rapportfdp.exe final.pdf");
    expect(cleanFileName("a\u0000b\nc.pdf")).toBe("abc.pdf");
    expect(cleanFileName("​ \u0007")).toBe("file");
    expect(cleanFileName("x".repeat(300))).toHaveLength(120);
  });

  it("the download name always passes the storage name check and ends in the verified type's extension", () => {
    const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
    const cases: [string, TaskFileType, string][] = [
      ["Devis été 2026.pdf", "application/pdf", "Devis-ete-2026.pdf"],
      ["_notes.txt", "text/plain", "notes.txt"],
      ["-x.pdf", "application/pdf", "x.pdf"],
      [".env.txt", "text/plain", "env.txt"],
      ["契約書.docx", DOCX, "file.docx"],
      ["", "application/pdf", "file.pdf"],
      ["report.exe", "application/pdf", "report.pdf"],
      ['a"b\r\nc..d.csv', "text/csv", "a-b-c.d.csv"],
    ];
    for (const [name, type, want] of cases) {
      const got = downloadName(name, type);
      expect(got, name).toBe(want);
      expect(FILE_NAME.test(got) && !got.includes("..")).toBe(true);
    }
    expect(downloadName("y".repeat(200) + ".pdf", "application/pdf")).toHaveLength(84);
  });
});

describe("taskFileType", () => {
  it("names the type from the extension, never from the browser", () => {
    expect(taskFileType("Budget.XLSX")).toBe(XLSX);
    expect(taskFileType("photo.jpeg")).toBe("image/jpeg");
    expect(taskFileType("list.csv")).toBe("text/csv");
    expect(taskFileType("macro.docm")).toBeNull();
    expect(taskFileType("noext")).toBeNull();
    expect(Object.values(TASK_FILE_TYPES).every((t) => taskFileType(`a.${t.ext}`) !== null)).toBe(true);
  });
});
