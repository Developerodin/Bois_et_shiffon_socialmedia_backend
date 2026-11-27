import { ConversationCreate, createConversation } from "@/server/crm/conversations";
import { bodyOf, crmRoute, json } from "@/server/crm/route";

/** A logged conversation with its first message, on a customer: inbox.read and crm.manage (it links a customer). */
export const POST = crmRoute(["inbox.read", "crm.manage"], async (scope, _p, request) => {
  const body = await bodyOf(request, ConversationCreate);
  if (body instanceof Response) return body;
  return json({ conversation: await createConversation(scope, body) }, 201);
});
