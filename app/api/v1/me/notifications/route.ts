import { listNotifications, notificationRoute } from "@/server/notifications/list";

/** The latest notifications in the current workspace (X-Workspace-Id), 20 a page, about tasks the caller can see. */
export async function GET(request: Request) {
  return notificationRoute(request, async (userId, workspaceId) =>
    Response.json(await listNotifications(userId, workspaceId, new URL(request.url).searchParams.get("cursor") ?? undefined)),
  );
}
