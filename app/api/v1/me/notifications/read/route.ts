import { NotificationKind } from "@prisma/client";
import { z } from "zod";
import { problemResponse } from "@/server/api/http-error";
import { markRead, notificationRoute } from "@/server/notifications/list";

const Body = z.union([
  z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(100) }),
  z.object({ all: z.literal(true) }),
  // A bell group: one kind on one business, up to (and including) its newest notice the bell showed.
  z.object({ group: z.object({ kind: z.enum(NotificationKind), brandId: z.string().min(1).max(100), upTo: z.iso.datetime() }) }),
]);

/** Mark some (`ids`), a bell group (`group`) or all of the caller's notifications in the current workspace read. */
export async function POST(request: Request) {
  return notificationRoute(request, async (userId, workspaceId) => {
    const body = Body.safeParse(await request.json().catch(() => null));
    if (!body.success) return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid request", status: 400, detail: body.error.issues[0]?.message });
    return Response.json({ updated: await markRead(userId, workspaceId, "ids" in body.data ? body.data.ids : "group" in body.data ? body.data.group : "all") });
  });
}
