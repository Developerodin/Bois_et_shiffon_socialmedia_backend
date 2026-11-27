import type { z } from "zod";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { AccessDeniedError } from "@/server/auth/errors";
import { crmProblem, type CrmScope, invalidBody } from "@/server/crm/common";
import type { PermissionKey } from "@/shared";

export const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * A CRM route handler: the brand guard with `perms[0]`, every other key in `perms` required too, errors through
 * crmProblem. The API is not behind the `crm` web flag (as quotes): permission-checked only.
 */
export function crmRoute<P extends BrandRouteParams>(perms: readonly [PermissionKey, ...PermissionKey[]], fn: (scope: CrmScope, params: P, request: Request) => Promise<Response>) {
  return async (request: Request, context: { params: Promise<P> }) => {
    try {
      const scope = await authorizeBrandRoute(request, context.params, perms[0]);
      if (scope instanceof Response) return scope;
      for (const k of perms.slice(1)) if (!scope.perms.has(k)) throw new AccessDeniedError(`Missing permission ${k}`);
      return await fn(scope, await context.params, request);
    } catch (error) {
      return crmProblem(error);
    }
  };
}

/** The JSON body parsed by `schema`, or a 400 Response to return. */
export async function bodyOf<T>(request: Request, schema: z.ZodType<T>): Promise<T | Response> {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  return parsed.success ? parsed.data : invalidBody(parsed.error.issues[0]?.message);
}

export const json = (data: unknown, status = 200) => Response.json(data, { status, headers: NO_STORE });
