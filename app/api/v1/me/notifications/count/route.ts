import { countUnread, notificationRoute } from "@/server/notifications/list";

/** Unread notifications in the current workspace, up to 100 (the bell's badge). */
export async function GET(request: Request) {
  return notificationRoute(request, async (userId, workspaceId) => Response.json({ count: await countUnread(userId, workspaceId) }));
}
