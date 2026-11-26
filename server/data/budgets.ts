import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AD_BUDGET_PLATFORMS, isEcbCurrency, type AdBudgetDto, type AdBudgetsDto, type PacingDto } from "@/shared";
import { prisma } from "@/server/db/prisma";
import { minorDigits, tooPrecise } from "@/server/quotes/quotes";
import { rateTable } from "./fx";
import { dayDate, dayOf } from "./sources";

/**
 * Monthly ad budgets per platform (plan 2026-11-26-phase-2-followup, Task 3) and Meta's pacing against them. Read
 * only through GET ads/budgets (ads.read); written through PUT (commercial.manage and ads.read). Every query is scoped
 * by workspace and brand. Spend in another currency than the budget is converted through the ECB rates (fx.ts).
 */
type Scope = { workspaceId: string; brandId: string };

const monthIndex = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
const currentMonth = (now = new Date()) => now.toISOString().slice(0, 7);

/** "YYYY-MM", from 24 months before the current (UTC) month to 12 after it. The one month rule for GET and PUT. */
export const MonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .refine((m) => {
    const delta = monthIndex(m) - monthIndex(currentMonth());
    return delta >= -24 && delta <= 12;
  }, "month out of range");

/** amount: a decimal string with at most 2 decimals (the column's), no more than the currency has (JPY none). */
export const BudgetBody = z
  .object({
    platform: z.enum(AD_BUDGET_PLATFORMS),
    month: MonthSchema,
    amount: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/),
    currency: z.string().refine((c) => c === "EUR" || isEcbCurrency(c), "unknown currency"),
  })
  .refine((b) => !tooPrecise(b.amount, minorDigits(b.currency)), { message: "too many decimals for the currency", path: ["amount"] });
export type BudgetInput = z.infer<typeof BudgetBody>;

const firstDay = (month: string) => `${month}-01`;
const lastDay = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;

/**
 * The brand's Meta spend per currency and day over from..to, converted into `currency`; null when a rate is missing.
 * Also the oldest stale rate used. Only ad accounts whose source is on (an account switched off keeps its old rows,
 * which mustn't count against this month's budget).
 */
export async function convertedSpend(scope: Scope, from: string, to: string, currency: string) {
  const accounts = await prisma.dataSource.findMany({
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId, kind: "META_ADS", status: { not: "OFF" } },
    select: { externalId: true },
  });
  const rows = await prisma.adDay.groupBy({
    by: ["currency", "day"],
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId, platform: "META", accountId: { in: accounts.map((a) => a.externalId) }, day: { gte: dayDate(from), lte: dayDate(to) } },
    _sum: { spend: true },
  });
  const table = await rateTable([currency, ...rows.map((r) => r.currency)], from, to);
  let total = new Prisma.Decimal(0);
  let stale: string | null = null;
  for (const r of rows) {
    const c = table.convert(r._sum.spend ?? 0, r.currency, currency, dayOf(r.day));
    if (!c) return null;
    total = total.plus(c.amount);
    if (c.stale && c.rateDay && (stale === null || c.rateDay < stale)) stale = c.rateDay;
  }
  return { total, stale };
}

/** Meta pacing for a month's budget (see PacingDto). */
async function metaPacing(scope: Scope, budget: { amount: Prisma.Decimal; currency: string }, month: string): Promise<PacingDto> {
  const sources = await prisma.dataSource.findMany({
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId, kind: "META_ADS", status: { not: "OFF" } },
    select: { syncedThrough: true },
  });
  // The least advanced account decides: a lagging one's missing days would read as under-spending.
  if (!sources.length || sources.some((s) => !s.syncedThrough)) return { platform: "META", state: "no_data" };
  const held = sources.map((s) => dayOf(s.syncedThrough!)).sort()[0];
  const first = firstDay(month);
  const end = lastDay(month);
  const through = held < end ? held : end;
  if (through < first) return { platform: "META", state: "no_data" };
  const spend = await convertedSpend(scope, first, through, budget.currency);
  if (!spend) return { platform: "META", state: "no_rate" };
  const expected = budget.amount.mul(daysBetween(first, through)).div(daysBetween(first, end));
  const ratio = expected.isZero() ? 0 : spend.total.div(expected).toDecimalPlaces(2).toNumber();
  return {
    platform: "META",
    state: "ok",
    through,
    spent: spend.total.toFixed(2),
    expected: expected.toFixed(2),
    ratio,
    status: ratio < 0.9 ? "under" : ratio > 1.1 ? "over" : "on",
    currency: budget.currency,
    staleRateFrom: spend.stale,
  };
}

/** GET ads/budgets: the month's budgets, their pacing, and the currency a new budget starts in. */
export async function listBudgets(scope: Scope, month: string): Promise<AdBudgetsDto> {
  const rows = await prisma.adBudget.findMany({
    where: { workspaceId: scope.workspaceId, brandId: scope.brandId, month: dayDate(firstDay(month)) },
    orderBy: { platform: "asc" },
  });
  const budgets: AdBudgetDto[] = rows.map((r) => ({ platform: r.platform, month, amount: r.amount.toFixed(2), currency: r.currency, updatedAt: r.updatedAt.toISOString() }));
  const pacing: PacingDto[] = [];
  for (const r of rows) pacing.push(r.platform === "META" ? await metaPacing(scope, r, month) : { platform: r.platform, state: "google_later" });
  return { month, budgets, pacing, defaultCurrency: await defaultCurrency(scope) };
}

/** The ad account's currency, else the shop's latest order's, else EUR (B&C has no Meta account yet). */
async function defaultCurrency(scope: Scope) {
  const ads = await prisma.dataSource.findFirst({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId, kind: "META_ADS" }, select: { settings: true } });
  const account = (ads?.settings as { currency?: unknown } | null)?.currency;
  if (account === "EUR" || isEcbCurrency(account)) return account;
  const order = await prisma.shopOrder.findFirst({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId }, orderBy: { processedAt: "desc" }, select: { currency: true } });
  return order && (order.currency === "EUR" || isEcbCurrency(order.currency)) ? order.currency : "EUR";
}

/**
 * Sets (or with amount 0 clears) a month's budget, and audits it in the same transaction with the previous amount
 * and currency. Returns what was done.
 */
export async function setBudget(scope: Scope & { userId: string }, input: BudgetInput) {
  const where = { brandId_platform_month: { brandId: scope.brandId, platform: input.platform, month: dayDate(firstDay(input.month)) } };
  const clear = new Prisma.Decimal(input.amount).isZero();
  return prisma.$transaction(async (tx) => {
    // One writer per brand, platform and month at a time: the audit's previous amount is the one replaced, and two
    // first-time saves can't both try to create the row.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ads-budget:${scope.brandId}:${input.platform}:${input.month}`}))`;
    const previous = await tx.adBudget.findFirst({ where: { workspaceId: scope.workspaceId, ...where.brandId_platform_month } });
    let row: { id: string } | null = null;
    if (clear) {
      if (previous) await tx.adBudget.delete({ where: { id: previous.id } });
    } else {
      row = await tx.adBudget.upsert({
        where,
        create: { workspaceId: scope.workspaceId, brandId: scope.brandId, platform: input.platform, month: where.brandId_platform_month.month, amount: input.amount, currency: input.currency, updatedByUserId: scope.userId },
        update: { amount: input.amount, currency: input.currency, updatedByUserId: scope.userId },
        select: { id: true },
      });
    }
    const entityId = row?.id ?? previous?.id;
    if (entityId) {
      await tx.auditEvent.create({
        data: {
          workspaceId: scope.workspaceId, brandId: scope.brandId, actorUserId: scope.userId,
          action: clear ? "ads.budget.cleared" : "ads.budget.set", entityType: "AdBudget", entityId,
          metadata: {
            platform: input.platform, month: input.month, amount: clear ? "0" : input.amount, currency: input.currency,
            previousAmount: previous?.amount.toFixed(2) ?? null, previousCurrency: previous?.currency ?? null,
          },
        },
      });
    }
    return clear ? "cleared" : "set";
  });
}
