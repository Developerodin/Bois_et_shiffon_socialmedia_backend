import { OPEN_STATUSES } from "@/shared";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The calendar window: every open post, plus anything changed in the last 30 days (so recent history still shows).
 * ponytail: the recent branch is served by the (brandId, updatedAt) index; the OR of two ranges is the ceiling: if one
 * brand's open posts grow past the page of 200, add from/to params instead.
 */
export function contentWindow(now: Date) {
  return { OR: [{ status: { in: [...OPEN_STATUSES] } }, { updatedAt: { gte: new Date(now.getTime() - 30 * DAY_MS) } }] };
}
