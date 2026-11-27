import { brandToday } from "@/server/crm/conversations";
import { crmRoute, json } from "@/server/crm/route";
import { summarizeConversation } from "@/server/crm/summary";

type Params = { workspaceId: string; brandId: string; conversationId: string };

/** The conversation's AI summary and a suggested next step (never applied by itself). inbox.read. */
export const POST = crmRoute<Params>(["inbox.read"], async (scope, p) => json({ summary: await summarizeConversation(scope, p.conversationId, await brandToday(scope)) }));
