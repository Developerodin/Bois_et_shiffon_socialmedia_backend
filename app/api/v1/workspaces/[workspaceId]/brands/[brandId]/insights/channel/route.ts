import type { ChannelAnalyticsDto } from "@/shared";
import { fromAccessError } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { channelAnalytics, DEFAULT_DAYS, MAX_DAYS } from "@/server/data/channel-analytics";
import { badRange } from "@/server/data/sources";

/** "meta" is the Meta calendar's name for its Facebook Page. */
const CHANNELS = { instagram: "instagram", facebook: "facebook", meta: "facebook" } as const;

/**
 * The connected Instagram account's or Facebook Page's own numbers over the last `days` whole UTC days (1–30, default
 * 28), read live from Meta (cached up to 15 minutes): ChannelAnalyticsDto. `?channel=instagram|facebook|meta`.
 * Needs analytics.read.
 */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "analytics.read");
    if (scope instanceof Response) return scope;
    const params = new URL(request.url).searchParams;
    const channel = Object.hasOwn(CHANNELS, params.get("channel") ?? "") ? CHANNELS[params.get("channel") as keyof typeof CHANNELS] : null;
    const days = params.has("days") ? Number(params.get("days")) : DEFAULT_DAYS;
    if (!channel || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
      return badRange(MAX_DAYS, `channel must be instagram, facebook or meta; days a whole number from 1 to ${MAX_DAYS}.`);
    }
    const body: ChannelAnalyticsDto = await channelAnalytics(scope, channel, days);
    return Response.json(body);
  } catch (error) {
    return fromAccessError(error);
  }
}
