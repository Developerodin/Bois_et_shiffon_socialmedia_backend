import { z } from "zod";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { AiProviderError } from "@/server/ai/provider";
import { ModelNotConfiguredError } from "@/server/ai/models";
import { hitRateLimit, limitKey } from "@/server/auth/rate-limit";
import { prisma } from "@/server/db/prisma";
import { CONTEXT_DOC_KINDS } from "@/server/services/context-docs";
import { TranslateLimited, translateTexts } from "@/server/services/translate";
import { CONTENT_LANGUAGES } from "@/shared";

// A long document is a few AI calls in waves of three.
export const maxDuration = 300;

const KINDS = CONTEXT_DOC_KINDS.map((k) => k.kind) as [string, ...string[]];

// By reference only: the server loads the text inside the brand, so this is never a free translator for any text.
const Body = z
  .object({
    to: z.enum(CONTENT_LANGUAGES),
    opportunityIds: z.array(z.string().min(1).max(40)).min(1).max(20).optional(),
    doc: z.object({ kind: z.enum(KINDS), version: z.number().int().min(1) }).strict().optional(),
  })
  .strict()
  .refine((b) => (b.opportunityIds ? 1 : 0) + (b.doc ? 1 : 0) === 1, "Send either opportunityIds or doc");

// Counted per AI call (a 100k-character document is ~9), not per request, on the cheapest tier; no credits, so
// capped per person and per workspace. A cached answer counts nothing.
const PER_PERSON = { limit: 40, windowMs: 10 * 60_000 };
const PER_WORKSPACE = { limit: 150, windowMs: 10 * 60_000 };

/**
 * A machine translation of this brand's ideas (title, summary, angle, reason) or one document version, for reading.
 * Nothing is saved: the result is only shown. brand.read, like reading them.
 */
export async function POST(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "brand.read");
    if (scope instanceof Response) return scope;
    const body = Body.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid request", status: 400, detail: body.error.issues.map((i) => i.message).join("; ") });
    }
    const admit = async (calls: number) => {
      const [person, workspace] = await Promise.all([
        hitRateLimit(limitKey("translate:user", scope.userId), PER_PERSON.limit, PER_PERSON.windowMs, calls),
        hitRateLimit(limitKey("translate:workspace", scope.workspaceId), PER_WORKSPACE.limit, PER_WORKSPACE.windowMs, calls),
      ]);
      return person.allowed && workspace.allowed;
    };
    const where = { workspaceId: scope.workspaceId, brandId: scope.brandId };
    const { to, opportunityIds, doc } = body.data;

    if (doc) {
      const found = await prisma.brandContextDoc.findFirst({ where: { ...where, kind: doc.kind, version: doc.version }, select: { markdown: true } });
      if (!found) return problemResponse({ type: "https://api.brandpilot/errors/not-found", title: "Not found", status: 404 });
      const [markdown] = await translateTexts(scope, [found.markdown], to, admit);
      return Response.json({ markdown });
    }

    // The three fields the Ideas panel shows (angle isn't shown, so it isn't paid for).
    const ideas = await prisma.opportunity.findMany({ where: { ...where, id: { in: opportunityIds } }, select: { id: true, title: true, summary: true, reason: true } });
    const out = await translateTexts(scope, ideas.flatMap((o) => [o.title, o.summary, o.reason]), to, admit);
    return Response.json({ opportunities: ideas.map((o, i) => ({ id: o.id, title: out[i * 3], summary: out[i * 3 + 1], reason: out[i * 3 + 2] })) });
  } catch (error) {
    if (error instanceof TranslateLimited) {
      return problemResponse({ type: "https://api.brandpilot/errors/rate-limited", title: "Slow down", status: 429, detail: error.message });
    }
    if (error instanceof ModelNotConfiguredError) {
      return problemResponse({ type: "https://api.brandpilot/errors/ai-not-configured", title: "AI isn't set up", status: 503, detail: error.message });
    }
    if (error instanceof AiProviderError || (error instanceof Error && error.message.startsWith("The translation didn't line up"))) {
      return problemResponse({ type: "https://api.brandpilot/errors/ai-failed", title: "Couldn't translate", status: 502, detail: "Couldn't translate this right now. Try again." });
    }
    return fromAccessError(error);
  }
}
