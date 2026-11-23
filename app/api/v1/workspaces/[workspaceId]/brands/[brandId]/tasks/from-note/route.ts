import { z } from "zod";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { ModelNotConfiguredError } from "@/server/ai/models";
import { AiProviderError } from "@/server/ai/provider";
import { taskViewer } from "@/server/tasks/access";
import { taskProblem } from "@/server/tasks/errors";
import { NOTE_MAX, proposeTasks } from "@/server/tasks/from-note";

const Body = z.object({ text: z.string().max(NOTE_MAX, `A note can be at most ${NOTE_MAX} characters`), requestId: z.string().max(100).optional() });

/** Proposed tasks from a pasted note (tasks.manage); nothing is stored until POST tasks/batch. */
export async function POST(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "tasks.manage");
    if (scope instanceof Response) return scope;
    const body = Body.safeParse(await request.json().catch(() => null));
    if (!body.success) return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid note", status: 400, detail: body.error.issues[0]?.message });
    return Response.json(await proposeTasks(scope, taskViewer(scope), body.data.text));
  } catch (error) {
    // The same AI failures the translate route maps: no model set (503), the model failed or answered badly (502).
    if (error instanceof ModelNotConfiguredError) {
      return problemResponse({ type: "https://api.brandpilot/errors/ai-not-configured", title: "AI isn't set up", status: 503, detail: error.message });
    }
    if (error instanceof AiProviderError) {
      return problemResponse({ type: "https://api.brandpilot/errors/ai-failed", title: "Couldn't read the note", status: 502, detail: "Couldn't read the note right now, try again." });
    }
    return taskProblem(error) ?? fromAccessError(error);
  }
}
