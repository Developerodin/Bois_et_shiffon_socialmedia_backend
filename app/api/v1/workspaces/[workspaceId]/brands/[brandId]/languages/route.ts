import { z } from "zod";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { prisma } from "@/server/db/prisma";
import { contentLanguageOf, savePreferences, workLanguageOf } from "@/server/research/brand-summary";
import type { TenantScope } from "@/server/tenant/scope";
import { CONTENT_LANGUAGES, type BrandLanguages } from "@/shared";

const Edit = z
  .object({ workLanguage: z.enum(CONTENT_LANGUAGES).optional(), contentLanguage: z.enum(CONTENT_LANGUAGES).optional() })
  .strict()
  .refine((b) => b.workLanguage !== undefined || b.contentLanguage !== undefined, "Nothing to change");

async function read(scope: Required<TenantScope>): Promise<BrandLanguages> {
  const p = await prisma.brandProfile.findFirst({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId }, select: { preferences: true, locales: true } });
  return { workLanguage: workLanguageOf(p?.preferences), contentLanguage: contentLanguageOf(p?.locales) };
}

/**
 * The business's two languages: the team working language (what agents write for the team) and the post language
 * (what customers read). Small on purpose: the run dialog reads it before a first run, so not the assets GET.
 */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "brand.read");
    if (scope instanceof Response) return scope;
    return Response.json(await read(scope));
  } catch (error) {
    return fromAccessError(error);
  }
}

/** Change either language (context.edit, like the other brand details). The audit entry keeps the old values. */
export async function PATCH(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "context.edit");
    if (scope instanceof Response) return scope;
    const body = Edit.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid languages", status: 400, detail: body.error.issues.map((i) => i.message).join("; ") });
    }
    const before = await read(scope);
    if (!(await savePreferences(scope, body.data))) {
      return problemResponse({ type: "https://api.brandpilot/errors/conflict", title: "Not set up yet", status: 409, detail: "This business isn't set up yet. Try again once it is." });
    }
    await prisma.auditEvent.create({
      data: {
        workspaceId: scope.workspaceId, brandId: scope.brandId, actorUserId: scope.userId, action: "brand.languages_changed",
        entityType: "BrandProfile", entityId: scope.brandId, metadata: { before, change: body.data },
      },
    });
    return Response.json(await read(scope));
  } catch (error) {
    return fromAccessError(error);
  }
}
