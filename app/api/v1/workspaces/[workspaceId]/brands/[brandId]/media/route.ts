import { randomUUID } from "node:crypto";
import { fromAccessError, problemResponse, uploadLengthStatus } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { LIBRARY_MAX, MEDIA_MAX_BYTES } from "@/shared";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { prisma } from "@/server/db/prisma";
import { imageType, mediaKey, putMedia, signedMediaUrl } from "@/server/storage/media";

const invalid = (title: string, status = 400) => problemResponse({ type: "https://api.brandpilot/errors/media", title, status, detail: title });

/**
 * Upload one image to the brand's private media storage. Returns its key (passed as `mediaKeys`
 * when publishing) and a one-hour preview link. With `library=1` (Business M08) it's also added to the brand's
 * photo library (BrandProfile.uploads, titled `title`), where the writers and reels find it.
 * ponytail: files nobody publishes stay in the bucket; add a bucket lifecycle rule if storage grows.
 */
export async function POST(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    // Creators upload the photo they shoot (owner, 2026-11-18); every role with publish.execute also has content.create.
    const scope = await authorizeBrandRoute(request, context.params, "content.create");
    if (scope instanceof Response) return scope;
    // ponytail: 60 an hour per user, shared by the web and the phone; each upload writes a file nobody may ever publish.
    if (!(await hitRateLimit(`media-upload:${scope.userId}`, 60, 3_600_000)).allowed) return invalid("Too many uploads. Try again in a while.", 429);
    // fetch with a FormData body (the web and the phone) always sends a Content-Length.
    const length = uploadLengthStatus(request, MEDIA_MAX_BYTES + 64 * 1024);
    if (length === 411) return invalid("Send the image with a Content-Length", 411);
    if (length === 413) return invalid("Images can be up to 4 MB", 413);

    const form = (await request.formData().catch(() => null)) ?? new FormData();
    const file = form.get("file");
    if (!(file instanceof File)) return invalid("Choose an image to upload");
    if (file.size > MEDIA_MAX_BYTES) return invalid("Images can be up to 4 MB", 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = imageType(bytes);
    if (!kind) return invalid("Upload a JPG or PNG image");

    const library = form.get("library") === "1";
    if (library) {
      const profile = await prisma.brandProfile.findFirst({ where: { brandId: scope.brandId, workspaceId: scope.workspaceId }, select: { uploads: true } });
      if (!profile) return invalid("This business has no profile yet", 409);
      if (Array.isArray(profile.uploads) && profile.uploads.length >= LIBRARY_MAX) return invalid(`Up to ${LIBRARY_MAX} photos. Remove some first.`, 409);
    }

    const key = mediaKey(scope, `${randomUUID()}.${kind.ext}`);
    await putMedia(key, bytes, kind.type);
    if (library) {
      const title = String(form.get("title") ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || "Photo";
      const entry = JSON.stringify([{ key, title, addedAt: new Date().toISOString() }]);
      // One statement: two uploads at once both land.
      await prisma.$executeRaw`
        UPDATE "BrandProfile" SET "updatedAt" = now(), "uploads" = COALESCE("uploads", '[]'::jsonb) || ${entry}::jsonb
        WHERE "brandId" = ${scope.brandId} AND "workspaceId" = ${scope.workspaceId}`;
    }
    return Response.json({ key, previewUrl: await signedMediaUrl(key) }, { status: 201 });
  } catch (error) {
    return fromAccessError(error);
  }
}
