import { crmRoute, json } from "@/server/crm/route";
import { draftConversationReply } from "@/server/crm/summary";

type Params = { workspaceId: string; brandId: string; conversationId: string };

/** An AI reply draft to copy (nothing is sent). inbox.read and content.create. */
export const POST = crmRoute<Params>(["inbox.read", "content.create"], async (scope, p) => json({ draft: await draftConversationReply(scope, p.conversationId) }));
