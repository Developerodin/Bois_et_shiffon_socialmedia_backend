import { followUpCounts } from "@/server/crm/follow-ups";
import { crmRoute, json } from "@/server/crm/route";

/** The viewer's follow-up counts for the Overview (inbox.read): needs a reply, overdue, waiting, theirs. */
export const GET = crmRoute(["inbox.read"], async (scope) => json({ counts: await followUpCounts(scope) }));
