import { Prisma } from "@prisma/client";
import { addDays, dayDate } from "@/server/data/sources";

/**
 * The episode step both alert tables share (AdAlert: server/ads/alerts.ts, SeoAlert: server/seo/declines.ts): an alert
 * raised on `day` continues its subject's episode when one is in the join window (that row is locked FOR UPDATE and
 * moved on: lastDay to the later day, values from the latest day only), else `insert` makes a new row (the caller
 * inserts with skipDuplicates on its dedupeKey, so a rerun or a race inserts once). The caller decides what an insert
 * means (a notice), in the same transaction.
 *
 * `join`: `{ before, after }` = the row's lastDay ≥ day − before and firstDay ≤ day + after (so a rerun of an older day
 * never joins a later episode); "subjectKey" = any row of the subject (OVER_PACE: the month is in its subjectKey).
 */
const TABLES = { AdAlert: Prisma.raw(`"AdAlert"`), SeoAlert: Prisma.raw(`"SeoAlert"`) } as const;

export async function recordEpisode(
  tx: Prisma.TransactionClient,
  input: {
    table: keyof typeof TABLES;
    scope: { workspaceId: string; brandId: string };
    subjectKey: string;
    day: string;
    values: Record<string, string>;
    join: { before: number; after: number } | "subjectKey";
    insert: (tx: Prisma.TransactionClient) => Promise<{ id: string } | undefined>;
  },
): Promise<{ insertedId: string | null }> {
  const { scope, subjectKey, day, join } = input;
  // A closed union mapped to constant SQL: the table name is never caller text.
  const table = TABLES[input.table];
  const window = join === "subjectKey"
    ? Prisma.sql`TRUE`
    : Prisma.sql`"lastDay" >= ${dayDate(addDays(day, -join.before))}::date AND "firstDay" <= ${dayDate(addDays(day, join.after))}::date`;
  const [found] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM ${table}
    WHERE "workspaceId" = ${scope.workspaceId} AND "brandId" = ${scope.brandId} AND "subjectKey" = ${subjectKey} AND ${window}
    ORDER BY "lastDay" DESC LIMIT 1
    FOR UPDATE`;
  if (found) {
    // Figures follow the latest day only: a rerun of an earlier day doesn't overwrite newer ones.
    await tx.$executeRaw`
      UPDATE ${table} SET
        "values" = CASE WHEN ${dayDate(day)}::date >= "lastDay" THEN ${JSON.stringify(input.values)}::jsonb ELSE "values" END,
        "lastDay" = GREATEST("lastDay", ${dayDate(day)}::date),
        "updatedAt" = now()
      WHERE id = ${found.id}`;
    return { insertedId: null };
  }
  const inserted = await input.insert(tx);
  return { insertedId: inserted?.id ?? null };
}
