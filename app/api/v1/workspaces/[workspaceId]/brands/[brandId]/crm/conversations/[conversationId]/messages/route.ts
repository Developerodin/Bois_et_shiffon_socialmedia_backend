import { logMessage, MessageInput } from "@/server/crm/conversations";
import { bodyOf, crmRoute, json } from "@/server/crm/route";

type Params = { workspaceId: string; brandId: string; conversationId: string };

/** Log one message that happened elsewhere (nothing is sent). inbox.read. */
export const POST = crmRoute<Params>(["inbox.read"], async (scope, p, request) => {
  const body = await bodyOf(request, MessageInput);
  if (body instanceof Response) return body;
  return json({ conversation: await logMessage(scope, p.conversationId, body) }, 201);
});
