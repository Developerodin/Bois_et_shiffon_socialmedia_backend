import { addNote, NoteInput } from "@/server/crm/customers";
import { bodyOf, crmRoute, json } from "@/server/crm/route";

type Params = { workspaceId: string; brandId: string; customerId: string };

/** The team's note on a customer (append-only). */
export const POST = crmRoute<Params>(["crm.manage"], async (scope, p, request) => {
  const body = await bodyOf(request, NoteInput);
  if (body instanceof Response) return body;
  return json({ note: await addNote(scope, p.customerId, body) }, 201);
});
