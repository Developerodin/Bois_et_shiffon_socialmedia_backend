import { invalidBody } from "@/server/crm/common";
import { listFollowUps, QueueQuery } from "@/server/crm/follow-ups";
import { crmRoute, json } from "@/server/crm/route";

/** The follow-up queue: `?filter=open|mine|needsReply|overdue|waiting|closed&cursor=` (inbox.read). */
export const GET = crmRoute(["inbox.read"], async (scope, _p, request) => {
  const query = QueueQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return invalidBody(query.error.issues[0]?.message);
  return json(await listFollowUps(scope, query.data));
});
