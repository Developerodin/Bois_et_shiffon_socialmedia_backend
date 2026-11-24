import { z } from "zod";
import { IMPORT_FIELDS, type ImportPreviewDto, type ImportResultDto } from "@/shared";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { effectivePermissions } from "@/server/auth/permissions";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { parseSheet } from "@/server/catalog/import-file";
import { guessMapping, matchStored, toRows, vouchedMapped } from "@/server/catalog/import-products";
import { cannotVouch, VOUCHED_FIELDS } from "@/server/catalog/products";
import { lockedSave } from "@/server/catalog/sync";
import { prisma } from "@/server/db/prisma";

export const maxDuration = 60;

const MAX_BYTES = 5 * 1024 * 1024;
const invalid = (detail: string, status = 400) =>
  problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid import", status, detail });

/** One field or null per header; each field at most once, the name exactly once. */
const Mapping = (columns: number) =>
  z
    .array(z.enum(IMPORT_FIELDS).nullable())
    .length(columns, "Choose a field (or none) for every column.")
    .refine((m) => new Set(m.filter(Boolean)).size === m.filter(Boolean).length, "Each field can be chosen for one column only.")
    .refine((m) => m.includes("title"), "Choose the column that holds the product name.");

/**
 * Import products from a CSV or .xlsx file (form field `file`), as IMPORT rows. `?dryRun=1` previews: the columns
 * matched to fields (or the `mapping` sent), the first rows and what would be skipped; nothing is written. Without it,
 * `mapping` (JSON, one field or null per column) is required and the import updates the rows a previous import made
 * (by SKU, link, then name), adds new ones and archives the ones the file no longer has. A file with no good row
 * changes nothing. Stock, prices and facts need rules.approve. The file is never stored.
 * ponytail: parsing is synchronous; a 5 MB file holds the request for about a second, bounded by the rate limits.
 */
export async function POST(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "context.edit");
    if (scope instanceof Response) return scope;
    const busy = () => invalid("Too many imports. Try again in a while.", 429);
    if (!(await hitRateLimit(`product-import:${scope.brandId}:${scope.userId}`, 30, 3_600_000)).allowed) return busy();
    if (!(await hitRateLimit(`product-import:${scope.userId}`, 60, 3_600_000)).allowed) return busy();
    // A chunked request has no Content-Length and formData() would buffer all of it before the size is checked.
    const length = request.headers.get("content-length");
    if (length === null) return invalid("Send the file with a Content-Length", 411);
    if (Number(length) > MAX_BYTES + 64 * 1024) return invalid("Files can be up to 5 MB", 413);

    const form = (await request.formData().catch(() => null)) ?? new FormData();
    const file = form.get("file");
    if (!(file instanceof File)) return invalid("Choose a CSV or Excel file to import");
    const sheet = parseSheet(new Uint8Array(await file.arrayBuffer()));
    if ("error" in sheet) return invalid(sheet.error);

    const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
    const sent = form.get("mapping");
    let mapping = guessMapping(sheet.headers);
    if (typeof sent === "string" || !dryRun) {
      let json: unknown = null;
      try {
        json = typeof sent === "string" ? JSON.parse(sent) : null;
      } catch {
        // refused below
      }
      const parsed = Mapping(sheet.headers.length).safeParse(json);
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? "Choose a field for every column.");
      mapping = parsed.data;
    }
    const approves = (await effectivePermissions(scope.workspaceId, scope.userId, scope.brandId)).has("rules.approve");
    const { rows, skipped, duplicates, problems } = toRows(sheet, mapping);

    if (dryRun) {
      const preview: ImportPreviewDto = {
        headers: sheet.headers,
        mapping,
        sample: sheet.rows.slice(0, 20),
        rowCount: sheet.rows.length,
        skipped,
        duplicates,
        problems,
        needsApproval: approves ? [] : IMPORT_FIELDS.filter((f) => (VOUCHED_FIELDS as readonly string[]).includes(f)),
      };
      return Response.json(preview);
    }
    const vouched = vouchedMapped(mapping);
    if (vouched.length && !approves) return cannotVouch();
    if (!rows.length) return invalid("No row in this file could be imported, so nothing was changed.", 422);

    // Price and stock columns the file doesn't have keep what's stored (writing them needs rules.approve).
    const keep = (["price", "compareAtPrice", "inStock", "stockQuantity"] as const).filter((f) => !mapping.includes(f));
    const saved = await lockedSave(scope, "IMPORT", { rows, complete: true }, { match: matchStored, keep });
    const result: ImportResultDto = { created: saved.created, updated: saved.updated, unchanged: saved.unchanged, archived: saved.archived, skipped, duplicates, problems };
    await prisma.auditEvent.create({
      data: {
        workspaceId: scope.workspaceId, brandId: scope.brandId, actorUserId: scope.userId, action: "product.import", entityType: "Brand", entityId: scope.brandId,
        metadata: { fields: mapping.filter(Boolean), created: result.created, updated: result.updated, unchanged: result.unchanged, archived: result.archived, skipped, duplicates },
      },
    });
    return Response.json(result);
  } catch (error) {
    return fromAccessError(error);
  }
}
