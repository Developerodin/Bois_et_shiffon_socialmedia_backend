import { OPEN_STATUSES } from "@/shared";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The calendar window: every open post, plus anything changed in the last 30 days (so recent history still shows).
 * ponytail: the recent branch has no updatedAt index, so it scans the brand's posts; fine per brand (thousands). Add
 * an index on (brandId, updatedAt) if one brand's history grows past that.
 */
export function contentWindow(now: Date) {
  return { OR: [{ status: { in: [...OPEN_STATUSES] } }, { updatedAt: { gte: new Date(now.getTime() - 30 * DAY_MS) } }] };
}
