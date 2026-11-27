import { isUtf8 } from "node:buffer";
import { inflateRawSync } from "node:zlib";
import { imageType } from "@/server/storage/media";
import { TASK_FILE_TYPES, type TaskFileType } from "@/shared";

/**
 * What a task file really is, from its bytes alone (never its name or the browser's claim), and the names it is shown
 * and downloaded under. Pure: server/tasks/files.ts reads the bytes and acts on the answer.
 */

/** A refusal the person reads. */
export class FileRefused extends Error {}

const OOXML: Record<string, { part: string; type: TaskFileType }> = {
  docx: { part: "word/document.xml", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  xlsx: { part: "xl/workbook.xml", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  pptx: { part: "ppt/presentation.xml", type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
};
const TEXT_TYPES: readonly TaskFileType[] = ["text/csv", "text/plain"];
const CONTENT_TYPES_MAX = 1024 * 1024;
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const EOCD_MAX_TAIL = 22 + 0xffff;

/**
 * The type the bytes are, if it is the announced one: the stored and served content type. CSV and plain text can't be
 * told apart by bytes, so UTF-8 text is either. Throws FileRefused with the reason otherwise.
 */
export function checkTaskFile(bytes: Buffer, announced: TaskFileType): TaskFileType {
  const found = sniff(bytes);
  if (found === "text") {
    if (TEXT_TYPES.includes(announced)) return announced;
  } else if (found === announced) return announced;
  throw new FileRefused(`That file isn't the ${TASK_FILE_TYPES[announced].label} file its name says.`);
}

/** The kind of file the bytes are, "text" for UTF-8 text, or a refusal. */
function sniff(b: Buffer): TaskFileType | "text" {
  if (b.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  const image = imageType(b);
  if (image) return image.type as TaskFileType;
  if (b.length >= 4 && b.readUInt32LE(0) === LOCAL) return officeType(b);
  // Text: valid UTF-8 and no NUL byte (checked without decoding the file to a string). UTF-16 (Excel's "Unicode Text",
  // a byte-order mark first) has NULs, but it is text: the UTF-8 hint, not "not supported".
  const utf16 = (b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff);
  if (utf16) throw new FileRefused("That text file isn't UTF-8. If it's a CSV from Excel, save it as CSV UTF-8 and try again.");
  if (b.indexOf(0) !== -1) throw new FileRefused("That file type isn't supported. Attach a PDF, Word, Excel, PowerPoint, CSV, text, JPG or PNG file.");
  if (!isUtf8(b)) throw new FileRefused("That text file isn't UTF-8. If it's a CSV from Excel, save it as CSV UTF-8 and try again.");
  return "text";
}

type Entry = { name: string; method: number; compressed: number; size: number; local: number };

/**
 * A Word, Excel or PowerPoint file (Office Open XML), from its ZIP central directory: one end record, no ZIP64, the
 * package's `[Content_Types].xml` and main part. Active content is refused: a VBA project, ActiveX controls, embedded
 * OLE objects (`embeddings/*.bin`, which can carry programs), or a content type naming macros, a VBA project, ActiveX
 * or an OLE object (a renamed part still declares its type there). Entry contents other than `[Content_Types].xml` are
 * never read, so external links in `_rels` (remote templates) are not checked (a ceiling in the plan).
 */
function officeType(b: Buffer): TaskFileType {
  const refuse = (why = "That file couldn't be read as a Word, Excel or PowerPoint file.") => new FileRefused(why);
  const active = "Files with macros, ActiveX controls or embedded objects can't be attached. Save it as a plain .docx, .xlsx or .pptx.";
  const entries = centralDirectory(b);
  if (!entries) throw refuse();
  const names = new Set(entries.map((e) => e.name));
  if (entries.some((e) => /(^|\/)vbaproject\.bin$/i.test(e.name) || /(^|\/)activex\//i.test(e.name) || /(^|\/)embeddings\/[^/]*\.bin$/i.test(e.name))) throw refuse(active);
  const kinds = Object.values(OOXML).filter((k) => names.has(k.part));
  const types = entries.find((e) => e.name === "[Content_Types].xml");
  if (kinds.length !== 1 || !types) throw refuse();
  if (/macroEnabled|vbaProject|activeX|oleObject/i.test(readEntry(b, types).toString("utf8"))) throw refuse(active);
  return kinds[0]!.type;
}

/** The central directory's entries, or null for anything but one plain (not ZIP64, single-disk) archive. */
function centralDirectory(b: Buffer): Entry[] | null {
  const from = Math.max(0, b.length - EOCD_MAX_TAIL);
  const ends: number[] = [];
  for (let p = b.length - 22; p >= from; p--) if (b.readUInt32LE(p) === EOCD) ends.push(p);
  if (ends.length !== 1) return null;
  const e = ends[0]!;
  const [disk, cdDisk, onDisk, total] = [b.readUInt16LE(e + 4), b.readUInt16LE(e + 6), b.readUInt16LE(e + 8), b.readUInt16LE(e + 10)];
  const [cdSize, cdOffset, comment] = [b.readUInt32LE(e + 12), b.readUInt32LE(e + 16), b.readUInt16LE(e + 20)];
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total || total === 0 || total === 0xffff || cdOffset === 0xffffffff) return null;
  if (e + 22 + comment !== b.length || cdOffset + cdSize > e) return null;
  const out: Entry[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > e || b.readUInt32LE(p) !== CENTRAL) return null;
    const nameLen = b.readUInt16LE(p + 28);
    const next = p + 46 + nameLen + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
    if (next > e) return null;
    out.push({ name: b.toString("utf8", p + 46, p + 46 + nameLen), method: b.readUInt16LE(p + 10), compressed: b.readUInt32LE(p + 20), size: b.readUInt32LE(p + 24), local: b.readUInt32LE(p + 42) });
    p = next;
  }
  return out;
}

/** One entry's bytes (stored or deflated), at most CONTENT_TYPES_MAX. */
function readEntry(b: Buffer, en: Entry): Buffer {
  const bad = () => new FileRefused("That file couldn't be read as a Word, Excel or PowerPoint file.");
  if (en.size > CONTENT_TYPES_MAX || en.local + 30 > b.length || b.readUInt32LE(en.local) !== LOCAL) throw bad();
  const start = en.local + 30 + b.readUInt16LE(en.local + 26) + b.readUInt16LE(en.local + 28);
  if (start + en.compressed > b.length) throw bad();
  const data = b.subarray(start, start + en.compressed);
  if (en.method === 0) return data;
  if (en.method !== 8) throw bad();
  try {
    return inflateRawSync(data, { maxOutputLength: CONTENT_TYPES_MAX });
  } catch {
    throw bad();
  }
}

/**
 * The name a file is shown under: as the person gave it, trimmed, without control or direction-changing characters
 * (Unicode Cc/Cf), at most 120 characters; "file" when nothing is left. Only ever shown as text.
 */
export function cleanFileName(name: string): string {
  const s = name.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim().slice(0, 120).trim();
  return s || "file";
}

/**
 * The name a file downloads under (Content-Disposition): plain ASCII that `signedMediaUrl` accepts, so one odd name can
 * never fail the task view. The display name's stem with accents dropped, every other character outside
 * `[A-Za-z0-9._-]` turned into "-", no leading or trailing `._-`, no "..", at most 80 characters, then the verified
 * type's own extension (a renamed file keeps the right one); `file.<ext>` when nothing is left.
 */
export function downloadName(fileName: string, type: TaskFileType): string {
  const stem = fileName.replace(/\.[^.]*$/, "");
  const ascii = stem
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .slice(0, 80)
    .replace(/^[._-]+|[._-]+$/g, "");
  return `${ascii || "file"}.${TASK_FILE_TYPES[type].ext}`;
}
