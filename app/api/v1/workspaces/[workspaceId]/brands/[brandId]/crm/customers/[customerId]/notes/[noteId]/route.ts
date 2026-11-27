import { deleteNote } from "@/server/crm/customers";
import { crmRoute } from "@/server/crm/route";

type Params = { workspaceId: string; brandId: string; customerId: string; noteId: string };

/** The author's own note, within 24 h (else 403 / 409). */
export const DELETE = crmRoute<Params>(["crm.manage"], async (scope, p) => {
  await deleteNote(scope, p.customerId, p.noteId);
  return new Response(null, { status: 204 });
});
