import { z } from "zod";
import { OPEN_STATUSES } from "@/shared";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The calendar window: every open post, plus anything changed in the last 30 days (so recent history still shows).
 * ponytail: the recent branch is served by the (brandId, updatedAt) index; the OR of two ranges is the ceiling. A view
 * of past dates (the calendar's month mode) asks for its dates with ?from&to instead (contentRange below).
 */
export function contentWindow(now: Date) {
  return { OR: [{ status: { in: [...OPEN_STATUSES] } }, { updatedAt: { gte: new Date(now.getTime() - 30 * DAY_MS) } }] };
}

/** The longest ?from..to span: a month grid is at most 6 weeks, with room to spare. */
export const MAX_RANGE_DAYS = 62;
const iso = z.union([z.string().date(), z.string().datetime({ offset: true })]);

/**
 * ?from&to: scheduledFor in [from, to). Neither given: null (the calendar window). Otherwise the dates, or the reason
 * they're refused: both ISO dates, from before to, at most MAX_RANGE_DAYS apart.
 */
export function contentRange(from: string | null, to: string | null): { from: Date; to: Date } | null | string {
  if (from === null && to === null) return null;
  if (!iso.safeParse(from).success || !iso.safeParse(to).success) return "from and to: ISO dates, both";
  const range = { from: new Date(from!), to: new Date(to!) };
  if (range.from >= range.to) return "from must be before to";
  if (range.to.getTime() - range.from.getTime() > MAX_RANGE_DAYS * DAY_MS) return `from..to: at most ${MAX_RANGE_DAYS} days`;
  return range;
}
