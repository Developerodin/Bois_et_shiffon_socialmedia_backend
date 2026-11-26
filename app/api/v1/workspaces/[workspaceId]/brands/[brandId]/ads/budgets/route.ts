import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { AccessDeniedError } from "@/server/auth/errors";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { BudgetBody, listBudgets, MonthSchema, setBudget } from "@/server/data/budgets";

const NO_STORE = { "Cache-Control": "private, no-store" };
const invalid = (detail: string) => problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid budget", status: 400, detail });

/** The month's Meta and Google budgets and their pacing, `?month=YYYY-MM` (24 months back to 12 ahead). ads.read. */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "ads.read");
    if (scope instanceof Response) return scope;
    const month = MonthSchema.safeParse(new URL(request.url).searchParams.get("month"));
    if (!month.success) return invalid("month must be YYYY-MM, from 24 months back to 12 ahead.");
    return Response.json(await listBudgets(scope, month.data), { headers: NO_STORE });
  } catch (error) {
    return fromAccessError(error);
  }
}

/**
 * Set a month's budget `{ platform, month, amount, currency }` ("0" removes it). Needs commercial.manage and ads.read
 * (a budget is shown with the spend). 30 an hour per brand and person, counted before validation, so refused bodies
 * count too. The write and its audit are one transaction.
 */
export async function PUT(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "commercial.manage");
    if (scope instanceof Response) return scope;
    if (!scope.perms.has("ads.read")) throw new AccessDeniedError("Missing permission ads.read");
    if (!(await hitRateLimit(`ads-budget:${scope.brandId}:${scope.userId}`, 30, 60 * 60_000)).allowed) {
      return problemResponse({ type: "https://api.brandpilot/errors/rate-limited", title: "Slow down", status: 429, detail: "Budgets were changed too often. Try again later." });
    }
    const body = BudgetBody.safeParse(await request.json().catch(() => null));
    if (!body.success) return invalid("platform META or GOOGLE; month YYYY-MM (24 months back to 12 ahead); amount a number with at most the currency's decimals; a supported currency.");
    const done = await setBudget(scope, body.data);
    return Response.json({ done, ...(await listBudgets(scope, body.data.month)) }, { headers: NO_STORE });
  } catch (error) {
    return fromAccessError(error);
  }
}
