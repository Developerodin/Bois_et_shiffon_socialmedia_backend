import { problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { makeChallenge } from "@/server/reels/clone-challenge";
import { toReelProblem as toProblem } from "@/server/reels/service";

type Params = { params: Promise<BrandRouteParams> };

/** Voices → Clone a voice: the shuffled sentences to read for one attempt (POST …/voices/clones takes its id). */
export async function GET(request: Request, context: Params) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "voices.manage");
    if (scope instanceof Response) return scope;
    if (!(await hitRateLimit(`clone-challenge:user:${scope.userId}`, 20, 3600_000)).allowed) {
      return problemResponse({ type: "https://api.brandpilot/errors/voices", title: "Too many tries for now. Try again in a while.", status: 429 });
    }
    const lang = (new URL(request.url).searchParams.get("lang") ?? "en").slice(0, 16);
    return Response.json(await makeChallenge(scope, lang), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return toProblem(error);
  }
}
