import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { ProductInput, ProductPageQuery, cannotVouch, productData, productPageWhere, toProductDto, toProductListDto, vouchedIn } from "@/server/catalog/products";
import { catalogSource, catalogSyncRunning } from "@/server/catalog/sync";
import { effectivePermissions } from "@/server/auth/permissions";
import { prisma } from "@/server/db/prisma";
import { kickIfDue } from "@/server/jobs/runner";

/**
 * The brand's products (active by default; ?archived=1 for the archived ones), newest-updated first, with the
 * last sync's outcome, which source syncs, and whether a sync is queued or running. ?status=1 leaves the products
 * out: screens poll that while a sync runs and read the list once it's done.
 * ?page= (with limit, q, stock: ProductPageQuery) returns one page and its `pagination`; without it, the whole list
 * (the phone and the product pickers read that).
 * ponytail: offset paging over the [workspaceId, brandId] index; fine for a few thousand rows per brand. Past tens of
 * thousands add an index on (brandId, archivedAt, updatedAt, id), and trigram indexes if title search gets slow.
 */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "brand.read");
    if (scope instanceof Response) return scope;
    // Screens poll this after "Sync now": start the queue if it stalled (as the other polled routes do).
    await kickIfDue().catch(() => {});
    const params = new URL(request.url).searchParams;
    const archived = params.get("archived") === "1";
    const where = { workspaceId: scope.workspaceId, brandId: scope.brandId };
    if (params.has("page")) return await pageOf(where, archived, params);
    const [products, profile, found, running] = await Promise.all([
      params.get("status") === "1"
        ? null
        : prisma.product.findMany({ where: { ...where, archivedAt: archived ? { not: null } : null }, orderBy: { updatedAt: "desc" }, omit: { description: true } }),
      prisma.brandProfile.findFirst({ where, select: { catalogSync: true } }),
      catalogSource(where),
      catalogSyncRunning(where),
    ]);
    // An AskCart walk (catalogSync.walk: its cursor) is the sync's own bookkeeping, not for the screen.
    const sync = profile?.catalogSync as Record<string, unknown> | null | undefined;
    const catalogSync = sync ? Object.fromEntries(Object.entries(sync).filter(([k]) => k !== "walk")) : null;
    const status = { source: found.source, catalogSync, running };
    return Response.json(products ? { products: products.map(toProductListDto), ...status } : status);
  } catch (error) {
    return fromAccessError(error);
  }
}

/** One page of the list, the page clamped to the last one (a page emptied by a delete lands on the one before). */
async function pageOf(where: { workspaceId: string; brandId: string }, archived: boolean, params: URLSearchParams) {
  const query = ProductPageQuery.safeParse({
    page: params.get("page"),
    limit: params.get("limit") ?? undefined,
    q: params.get("q") ?? undefined,
    stock: params.get("stock") ?? undefined,
  });
  if (!query.success) {
    return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid page", status: 400, detail: query.error.issues[0]?.message });
  }
  const { limit, ...q } = query.data;
  const filter = { ...where, archivedAt: archived ? { not: null } : null, ...productPageWhere(q) };
  // id breaks updatedAt ties (a sync writes many rows in one instant), so a row never shows on two pages.
  const rowsOf = (page: number) =>
    prisma.product.findMany({
      where: filter,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
      omit: { description: true },
    });
  // The rows are fetched alongside the count (one round trip, not two); only a page past the end fetches again.
  const [total, rows] = await Promise.all([prisma.product.count({ where: filter }), rowsOf(q.page)]);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(q.page, totalPages);
  const products = page === q.page ? rows : await rowsOf(page);
  // Sync status isn't here: the board reads it from the full list (and ?status=1), not from each page.
  return Response.json({ products: products.map(toProductListDto), pagination: { page, limit, total, totalPages } });
}

/** Add a product by hand (MANUAL). Stock, prices and facts need rules.approve (VOUCHED_FIELDS). */
export async function POST(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "context.edit");
    if (scope instanceof Response) return scope;
    const body = ProductInput.safeParse(await request.json().catch(() => null));
    if (!body.success || !body.data.title) {
      return problemResponse({
        type: "https://api.brandpilot/errors/validation",
        title: "Invalid product",
        status: 400,
        detail: body.success ? "Give the product a name." : body.error.issues[0]?.message,
      });
    }
    if (vouchedIn(body.data).length && !(await effectivePermissions(scope.workspaceId, scope.userId, scope.brandId)).has("rules.approve")) return cannotVouch();
    const product = await prisma.product.create({
      data: { ...productData(body.data), title: body.data.title, workspaceId: scope.workspaceId, brandId: scope.brandId, source: "MANUAL" },
    });
    await prisma.auditEvent.create({
      data: { workspaceId: scope.workspaceId, brandId: scope.brandId, actorUserId: scope.userId, action: "product.created", entityType: "Product", entityId: product.id, metadata: { source: "MANUAL" } },
    });
    return Response.json({ product: toProductDto(product) }, { status: 201 });
  } catch (error) {
    return fromAccessError(error);
  }
}
