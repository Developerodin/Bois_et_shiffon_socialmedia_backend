import { ConversationPatch, getConversation, updateConversation } from "@/server/crm/conversations";
import { bodyOf, crmRoute, json } from "@/server/crm/route";

type Params = { workspaceId: string; brandId: string; conversationId: string };

/** The conversation with its latest 200 messages (inbox.read). */
export const GET = crmRoute<Params>(["inbox.read"], async (scope, p) => json({ conversation: await getConversation(scope, p.conversationId) }));

/** Owner, next action, subject, waiting, close/reopen (inbox.read); changing the customer also needs crm.manage. */
export const PATCH = crmRoute<Params>(["inbox.read"], async (scope, p, request) => {
  const body = await bodyOf(request, ConversationPatch);
  if (body instanceof Response) return body;
  return json({ conversation: await updateConversation(scope, p.conversationId, body) });
});
