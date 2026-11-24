import { beforeEach, describe, expect, it, vi } from "vitest";
import { guessMapping, matchStored, toRows } from "@/server/catalog/import-products";

const { authorize, hit, perms, save, audit } = vi.hoisted(() => ({
  authorize: vi.fn(async (): Promise<Response | { userId: string; workspaceId: string; brandId: string }> => ({ userId: "u1", workspaceId: "w1", brandId: "b1" })),
  hit: vi.fn(async () => ({ allowed: true, count: 1 })),
  perms: { set: new Set<string>() },
  save: vi.fn(async () => ({ seen: 1, created: 1, updated: 0, unchanged: 0, archived: 0 })),
  audit: vi.fn(),
}));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: authorize }));
vi.mock("@/server/auth/rate-limit", () => ({ hitRateLimit: hit }));
vi.mock("@/server/auth/permissions", () => ({ effectivePermissions: vi.fn(async () => perms.set) }));
vi.mock("@/server/catalog/sync", async (orig) => ({ ...(await orig<object>()), lockedSave: save }));
vi.mock("@/server/db/prisma", () => ({ prisma: { auditEvent: { create: audit } } }));

import { POST } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/products/import/route";

const sheet = (headers: string[], ...rows: string[][]) => ({ headers, rows, lines: rows.map((_, i) => i + 2) });

describe("guessMapping", () => {
  it("matches French and English headers, accents and punctuation aside", () => {
    expect(guessMapping(["Désignation", "Référence", "Prix TTC (€)", "Prix barré", "Quantité", "Disponibilité", "Lien", "Visuel", "Matières", "Notes"]))
      .toEqual(["title", "sku", "price", "compareAtPrice", "stockQuantity", "inStock", "url", "imageUrl", "materials", null]);
    expect(guessMapping(["Product Name", "SKU", "Sale price", "Image URL"])).toEqual(["title", "sku", "price", "imageUrl"]);
  });

  it("gives each field to one column only: the first", () => {
    expect(guessMapping(["Name", "Titre", "Price", "Prix"])).toEqual(["title", null, "price", null]);
  });
});

describe("toRows", () => {
  const map = guessMapping(["Nom", "Prix", "En stock", "Lien", "SKU", "Matières"]);

  it("reads prices as written in France or elsewhere, and yes/no stock in either language", () => {
    const { rows } = toRows(sheet(["Nom", "Prix", "En stock"], ["Milo", "1 299,00 €", "oui"], ["Oslo", "€1,299.50", "Non"], ["Ava", "", "rupture"]), guessMapping(["Nom", "Prix", "En stock"]));
    expect(rows.map((r) => [r.price, r.inStock])).toEqual([["1299.00", true], ["1299.50", false], [null, false]]);
  });

  it("drops a link that isn't http(s), not the row", () => {
    const { rows, skipped } = toRows(sheet(["Nom", "Prix", "En stock", "Lien"], ["Milo", "10", "", "javascript:alert(1)"]), map);
    expect(skipped).toBe(0);
    expect(rows[0]).toMatchObject({ title: "Milo", url: null, externalId: "title:milo" });
  });

  it("skips and reports rows without a name or with a price that isn't one", () => {
    const { rows, skipped, problems } = toRows(sheet(["Nom", "Prix"], ["", "10"], ["Milo", "ask us"], ["Oslo", "-5"], ["Ava", "12"]), map);
    expect(rows.map((r) => r.title)).toEqual(["Ava"]);
    expect(skipped).toBe(3);
    expect(problems).toEqual([{ row: 2, reason: "it has no name", skipped: true }, { row: 3, reason: "the price isn't an amount", skipped: true }, { row: 4, reason: "the price isn't an amount", skipped: true }]);
  });

  it("keys rows by SKU, else link, else name; a repeated SKU keeps the last row and is counted", () => {
    const { rows, duplicates } = toRows(
      sheet(["Nom", "Prix", "En stock", "Lien", "SKU"], ["Milo", "10", "", "", "M-1"], ["Milo v2", "11", "", "", "M-1"], ["Oslo", "", "", "https://shop.fr/oslo/#reviews", ""], ["Ava  Chair", "", "", "", ""]),
      map,
    );
    expect(rows.map((r) => [r.externalId, r.title])).toEqual([["sku:M-1", "Milo v2"], ["url:https://shop.fr/oslo", "Oslo"], ["title:ava chair", "Ava  Chair".replace(/\s+/g, " ")]]);
    expect(duplicates).toBe(1);
  });

  it("keys names in any script apart: Greek, CJK, Arabic and Hindi names aren't one product", () => {
    const { rows, duplicates } = toRows(sheet(["Nom"], ["Χαλί"], ["Καρέκλα"], ["木椅"], ["木桌"], ["سجادة"], ["किताब"], ["कताब"], ["★★★"]), guessMapping(["Nom"]));
    expect(duplicates).toBe(0);
    expect(rows.map((r) => r.externalId)).toEqual(["title:χαλι", "title:καρεκλα", "title:木椅", "title:木桌", "title:سجادة", "title:किताब", "title:कताब", "title:★★★"]);
  });

  it("reports a row's own line, and an in-stock value it can't read (the row is still imported)", () => {
    const { rows, skipped, problems } = toRows({ headers: ["Nom", "En stock"], rows: [["", "oui"], ["Milo", "bientôt"]], lines: [5, 9] }, guessMapping(["Nom", "En stock"]));
    expect([rows.length, rows[0]!.inStock, skipped]).toEqual([1, null, 1]);
    expect(problems).toEqual([{ row: 5, reason: "it has no name", skipped: true }, { row: 9, reason: "the in-stock value isn't yes or no, so its stock was left unknown", skipped: false }]);
  });

  it("an empty facts cell is null, so the save keeps what's stored", () => {
    expect(toRows(sheet(["Nom", "Prix", "En stock", "Lien", "SKU", "Matières"], ["Milo", "", "", "", "", ""]), map).rows[0]!.materials).toBeNull();
  });

  it("matchStored finds a stored row by SKU, then link, then name", () => {
    const stored = [{ id: "a", sku: "M-1", url: null, title: "x" }, { id: "b", sku: null, url: "https://shop.fr/oslo/", title: "y" }, { id: "c", sku: null, url: null, title: "Ava Chair" }];
    const { rows } = toRows(sheet(["Nom", "Prix", "En stock", "Lien", "SKU"], ["Milo", "", "", "", "M-1"], ["Oslo", "", "", "https://shop.fr/oslo", "O-1"], ["ava chair", "", "", "", "A-1"], ["New", "", "", "", "N-1"]), map);
    expect([...matchStored(rows, stored)]).toEqual([["sku:M-1", "a"], ["sku:O-1", "b"], ["sku:A-1", "c"]]);
  });

  it("matchStored passes over a claimed row to the next way of matching, and survives a malformed stored link", () => {
    const stored = [{ id: "a", sku: "M-1", url: "not a link", title: "x" }, { id: "b", sku: null, url: null, title: "Milo" }];
    const { rows } = toRows(sheet(["Nom", "Prix", "En stock", "Lien", "SKU"], ["Milo", "", "", "", "M-1"]), map);
    expect([...matchStored(rows, stored, new Set(["a"]))]).toEqual([["sku:M-1", "b"]]);
  });

  it("reads plain numbers (Excel's number cells) as decimals rounded to cents, written prices with amountOf", () => {
    const { rows } = toRows(sheet(["Nom", "Prix"], ["A", "35.880000000000003"], ["B", "1299.999"], ["C", "12.5"], ["D", "1.299,00 €"]), map);
    expect(rows.map((r) => r.price)).toEqual(["35.88", "1300.00", "12.50", "1299.00"]);
  });

  it("stays fast on hostile descriptions: 5,000 rows of 10,000 '<'", () => {
    const hostile = { headers: ["Nom", "Description"], rows: Array.from({ length: 5000 }, (_, i) => [`P${i}`, "<".repeat(10_000)]), lines: [] };
    const start = performance.now();
    const { rows } = toRows(hostile, guessMapping(hostile.headers));
    expect(performance.now() - start).toBeLessThan(1000);
    expect(rows).toHaveLength(5000);
  });
});

const params = Promise.resolve({ workspaceId: "w1", brandId: "b1" });
async function upload(csv: string, mapping?: unknown, dryRun = false) {
  const form = new FormData();
  form.set("file", new File([csv], "p.csv"));
  if (mapping !== undefined) form.set("mapping", JSON.stringify(mapping));
  const body = new Response(form);
  const bytes = await body.arrayBuffer();
  return POST(
    new Request(`http://x/import${dryRun ? "?dryRun=1" : ""}`, { method: "POST", body: bytes, headers: { "content-type": body.headers.get("content-type")!, "content-length": String(bytes.byteLength) } }),
    { params },
  );
}

describe("import route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    perms.set = new Set(["context.edit"]);
  });

  it("asks for context.edit: a viewer gets 403", async () => {
    authorize.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect((await upload("Name\nMilo", ["title"])).status).toBe(403);
    expect(authorize).toHaveBeenCalledWith(expect.anything(), params, "context.edit");
  });

  it("is rate limited per brand and person, and per person across brands", async () => {
    hit.mockResolvedValueOnce({ allowed: true, count: 1 }).mockResolvedValueOnce({ allowed: false, count: 61 });
    expect((await upload("Name\nMilo", ["title"])).status).toBe(429);
    expect(hit.mock.calls).toEqual([["product-import:b1:u1", 30, 3_600_000], ["product-import:u1", 60, 3_600_000]]);
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses a chunked upload (no Content-Length), or a Content-Length that isn't a number, with 411", async () => {
    expect((await POST(new Request("http://x/import", { method: "POST", body: "x" }), { params })).status).toBe(411);
    expect((await POST(new Request("http://x/import", { method: "POST", body: "x", headers: { "content-length": "1e3" } }), { params })).status).toBe(411);
  });

  it("previews have their own higher limits", async () => {
    await upload("Nom\nMilo", undefined, true);
    expect(hit.mock.calls).toEqual([["product-import-preview:b1:u1", 120, 3_600_000], ["product-import-preview:u1", 240, 3_600_000]]);
  });

  it("names the file's own line for a problem, blank lines included", async () => {
    const res = await upload("Nom;Prix\n\nMilo;10\n\n;12", undefined, true);
    expect((await res.json()).problems).toEqual([{ row: 5, reason: "it has no name", skipped: true }]);
  });

  it("another import or sync holding the catalogue: 409, try again", async () => {
    const { CatalogBusy } = await import("@/server/catalog/sync");
    save.mockRejectedValueOnce(new CatalogBusy());
    expect((await upload("Nom\nMilo", ["title"])).status).toBe(409);
    expect(audit).not.toHaveBeenCalled();
  });

  it("previews: guessed mapping, sample, problems, and the fields this person can't import", async () => {
    const res = await upload("Nom;Prix;Couleur\nMilo;10;red\n;12;blue", undefined, true);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      headers: ["Nom", "Prix", "Couleur"], mapping: ["title", "price", null], sample: [["Milo", "10", "red"], ["", "12", "blue"]], rowCount: 2, skipped: 1,
      problems: [{ row: 3, reason: "it has no name", skipped: true }], needsApproval: ["price", "compareAtPrice", "inStock", "stockQuantity", "materials", "dimensions", "certifications"],
    });
    expect(save).not.toHaveBeenCalled();
    perms.set.add("rules.approve");
    expect((await (await upload("Nom;Prix\nMilo;10", undefined, true)).json()).needsApproval).toEqual([]);
  });

  it("needs a mapping with the name column to import", async () => {
    expect((await upload("Nom,Couleur\nMilo,red", [null, null])).status).toBe(400);
    expect((await upload("Nom,Couleur\nMilo,red")).status).toBe(400);
    expect((await upload("Nom,Couleur\nMilo,red", ["title", "title"])).status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it("a price column without rules.approve is refused with 403; with it the import runs", async () => {
    expect((await upload("Nom,Prix\nMilo,10", ["title", "price"])).status).toBe(403);
    expect(save).not.toHaveBeenCalled();
    perms.set.add("rules.approve");
    expect((await upload("Nom,Prix\nMilo,10", ["title", "price"])).status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("imports without price or stock columns, keeping stored prices and stock, and audits", async () => {
    const res = await upload("Nom,Catégorie\nMilo,Sofas", ["title", "category"]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 1, updated: 0, unchanged: 0, archived: 0, skipped: 0, duplicates: 0, problems: [] });
    const [scope, source, fetched, opts, wait] = save.mock.calls[0] as unknown as [unknown, string, { complete: boolean; rows: unknown[] }, { keep: string[] }, number];
    expect(wait).toBe(15_000);
    expect([scope, source, fetched.complete, opts.keep]).toEqual([{ userId: "u1", workspaceId: "w1", brandId: "b1" }, "IMPORT", true, ["price", "compareAtPrice", "inStock", "stockQuantity"]]);
    expect(audit.mock.calls[0]![0].data).toMatchObject({ action: "product.import", entityId: "b1", metadata: { fields: ["title", "category"], created: 1 } });
  });

  it("keeps price and stock in pairs: mapping only in-stock writes the quantity empty, prices are kept", async () => {
    perms.set.add("rules.approve");
    await upload("Nom,En stock\nMilo,non", ["title", "inStock"]);
    expect((save.mock.calls[0] as unknown as [unknown, unknown, unknown, { keep: string[] }])[3].keep).toEqual(["price", "compareAtPrice"]);
  });

  it("reads at most two files at once in a process; a third is asked to retry", async () => {
    let finish!: () => void;
    const held = new Promise<void>((r) => (finish = r));
    save.mockImplementation(async () => { await held; return { seen: 1, created: 1, updated: 0, unchanged: 0, archived: 0 }; });
    const first = [upload("Nom\nA", ["title"]), upload("Nom\nB", ["title"])];
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect((await upload("Nom\nC", undefined, true)).status).toBe(429);
    finish();
    expect((await Promise.all(first)).map((r) => r.status)).toEqual([200, 200]);
    save.mockReset();
    save.mockResolvedValue({ seen: 1, created: 1, updated: 0, unchanged: 0, archived: 0 });
    expect((await upload("Nom\nC", undefined, true)).status).toBe(200);
  });

  it("all rows bad: nothing written or archived", async () => {
    expect((await upload("Nom,Catégorie\n,Sofas", ["title", "category"])).status).toBe(422);
    expect(save).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});
