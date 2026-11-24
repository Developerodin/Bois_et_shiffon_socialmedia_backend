import type { DigestBody, DigestsDto } from "@/shared";
import { problemResponse } from "@/server/api/http-error";
import { requestUserId } from "@/server/auth/request-user";
import { prisma } from "@/server/db/prisma";
import { readerAccess, refilterDigest } from "@/server/digest/build";

/**
 * The caller's own latest 8 weekly digests in this workspace. Membership is required now, and every body is filtered by
 * the caller's CURRENT permissions (a section whose key they lost, or a brand they no longer reach, is not shown).
 */
export async function GET(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  const userId = await requestUserId(request);
  if (!userId) return problemResponse({ type: "https://api.brandpilot/errors/unauthorized", title: "Unauthorized", status: 401 });
  const { workspaceId } = await context.params;
  const access = await readerAccess(userId, workspaceId);
  if (!access) return problemResponse({ type: "https://api.brandpilot/errors/access-denied", title: "Forbidden", status: 403, detail: "Access denied" });
  const [rows, user] = await Promise.all([
    prisma.digest.findMany({ where: { userId, workspaceId }, orderBy: { weekStart: "desc" }, take: 8 }),
    prisma.user.findUnique({ where: { id: userId }, select: { digestEmail: true } }),
  ]);
  const dto: DigestsDto = {
    digests: rows.map((r) => ({ id: r.id, weekStart: r.weekStart.toISOString().slice(0, 10), createdAt: r.createdAt.toISOString(), body: refilterDigest(r.body as DigestBody, access) })),
    email: !!user?.digestEmail,
  };
  return Response.json(dto, { headers: { "Cache-Control": "private, no-store" } });
}
