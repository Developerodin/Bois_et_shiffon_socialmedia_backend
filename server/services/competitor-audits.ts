import { blockedAuditError } from "@/server/agents/definitions/site-audit";
import { startAgentRun } from "@/server/agents/engine";
import { prisma } from "@/server/db/prisma";
import { AUDIT_FRESH_DAYS, creditBalance, CREDIT_COSTS, InsufficientCreditsError, refundCharge, spendCredits } from "@/server/services/credits";

/**
 * How long a "this site blocks automated readers" failure hides the Audit button. Not forever: a site may relax its bot
 * protection, so after this the customer can try again (and is refunded again if it still blocks us).
 */
export const AUDIT_BLOCK_DAYS = 7;

type FailedRun = { error: string | null; createdAt: Date; finishedAt: Date | null };

/**
 * When this workspace's latest failed audit of `domain` was the site refusing automated readers, and no audit of the
 * domain (from any workspace) has landed since: the failure's date and when the block lifts. Otherwise null. The block
 * is active while `until` is in the future; after that the list still says the site blocked us, softly.
 */
export function blockFromFailure(domain: string, fail: FailedRun | null | undefined, newestAuditAt: Date | null | undefined) {
  if (!fail || fail.error !== blockedAuditError(domain)) return null;
  const at = fail.finishedAt ?? fail.createdAt;
  if (newestAuditAt && newestAuditAt >= at) return null;
  return { at, until: new Date(at.getTime() + AUDIT_BLOCK_DAYS * 86_400_000) };
}

/** A partial audit (the site blocked our crawler) keeps its marker in the approach JSON. */
const isPartial = (a: { approach: unknown }) => (a.approach as { partial?: boolean } | null)?.partial === true;

/** Public fields of a shared audit: never who requested it. */
const PUBLIC_AUDIT = {
  id: true,
  domain: true,
  url: true,
  scores: true,
  findings: true,
  aiCrawlers: true,
  approach: true,
  socials: true,
  sources: true,
  pagesRead: true,
  createdAt: true,
} as const;

/**
 * This brand's competitors, each with the latest shared audit of its domain (from any customer): the newest full audit
 * while it is fresh, so a later partial one (the site started blocking us) doesn't hide it, else the newest of any kind.
 */
export async function listCompetitors(workspaceId: string, brandId: string) {
  const competitors = await prisma.competitor.findMany({ where: { workspaceId, brandId }, orderBy: { createdAt: "asc" } });
  const domains = competitors.map((c) => c.domain);
  const staleBefore = Date.now() - AUDIT_FRESH_DAYS * 86_400_000;
  const [audits, fresh, running, failed, geo, balance] = await Promise.all([
    prisma.siteAudit.findMany({ where: { domain: { in: domains } }, orderBy: { createdAt: "desc" }, distinct: ["domain"], select: PUBLIC_AUDIT }),
    // Every fresh audit, to find the newest full one; the partial marker is picked in code, since a JSON-path NOT
    // drops rows without the key. ponytail: paid audits keep this to a few rows per domain per AUDIT_FRESH_DAYS.
    prisma.siteAudit.findMany({ where: { domain: { in: domains }, createdAt: { gte: new Date(staleBefore) } }, orderBy: { createdAt: "desc" }, select: PUBLIC_AUDIT }),
    // Any workspace's running audit counts (shared library), but only for this brand's domains.
    domains.length
      ? prisma.agentRun.findMany({
          where: { agentKey: "site-audit", status: { in: ["QUEUED", "RUNNING"] }, OR: domains.map((d) => ({ input: { path: ["domain"], equals: d } })) },
          select: { input: true },
        })
      : [],
    // This workspace's own failed audits only: another customer's error text is theirs.
    // ponytail: newest 50 failures cover a brand's competitor list; past that, query per domain.
    domains.length
      ? prisma.agentRun.findMany({
          where: { workspaceId, agentKey: "site-audit", status: "FAILED", OR: domains.map((d) => ({ input: { path: ["domain"], equals: d } })) },
          orderBy: { createdAt: "desc" },
          take: 50,
          select: { input: true, error: true, createdAt: true, finishedAt: true },
        })
      : [],
    prisma.auditReport.findFirst({ where: { workspaceId, brandId, kind: "GEO" }, orderBy: { createdAt: "desc" }, select: { metrics: true } }),
    creditBalance(workspaceId),
  ]);
  const runningDomains = new Set(running.map((r) => (r.input as { domain?: string } | null)?.domain));
  const mentions = new Map(((geo?.metrics as { competitors?: { name: string; mentions: number }[] } | null)?.competitors ?? []).map((c) => [c.name.toLowerCase(), c.mentions]));
  return {
    credits: { balance, auditCost: CREDIT_COSTS.siteAudit },
    competitors: competitors.map((c) => {
      const newest = audits.find((a) => a.domain === c.domain) ?? null;
      const audit = fresh.find((a) => a.domain === c.domain && !isPartial(a)) ?? newest;
      // The latest failure, unless any audit (full or partial) landed after it.
      const fail = failed.find((r) => (r.input as { domain?: string } | null)?.domain === c.domain);
      const failedAt = fail && (fail.finishedAt ?? fail.createdAt);
      const showFailure = !!failedAt && (!newest || failedAt > newest.createdAt);
      // The site refused automated readers, so another audit would fail the same way until the block lifts.
      const block = blockFromFailure(c.domain, fail, newest?.createdAt);
      const activeBlock = block && block.until.getTime() > Date.now() ? block.until : null;
      return {
        id: c.id,
        name: c.name,
        domain: c.domain,
        source: c.source,
        aiMentions: mentions.get(c.name.toLowerCase()) ?? null,
        auditRunning: runningDomains.has(c.domain),
        auditError: showFailure ? (fail?.error ?? "The audit failed.") : null,
        auditBlocked: !!activeBlock,
        auditBlockedUntil: activeBlock?.toISOString() ?? null,
        /** When the latest failure was the site blocking us, even once the block has lifted (the list words it softly). */
        auditBlockedAt: block?.at.toISOString() ?? null,
        audit: audit && {
          ...audit,
          createdAt: audit.createdAt.toISOString(),
          stale: audit.createdAt.getTime() < staleBefore,
          partial: isPartial(audit),
        },
      };
    }),
  };
}

export type StartAuditResult =
  | { status: "started"; charged: number }
  | { status: "already-running" }
  | { status: "insufficient-credits"; balance: number; needed: number }
  | { status: "blocked"; until: string };

/**
 * Fresh audit of a competitor's domain, paid by this workspace. If any customer's audit of the same
 * domain is already running, nobody is charged twice: the result lands in the shared library for all.
 * Charge first (atomic, locked), start the run with the charge id, refund if the start fails;
 * the engine refunds too if the run finally fails (onAgentRunFailure).
 */
export async function startCompetitorAudit(input: { workspaceId: string; brandId: string; userId: string; competitorId: string }): Promise<StartAuditResult> {
  const competitor = await prisma.competitor.findFirstOrThrow({ where: { id: input.competitorId, workspaceId: input.workspaceId, brandId: input.brandId } });
  const running = await prisma.agentRun.findFirst({
    where: { agentKey: "site-audit", status: { in: ["QUEUED", "RUNNING"] }, input: { path: ["domain"], equals: competitor.domain } },
    select: { id: true },
  });
  if (running) return { status: "already-running" };

  // The site refused automated readers on this workspace's last try: another would fail and refund the same way.
  const [fail, newest] = await Promise.all([
    prisma.agentRun.findFirst({
      where: { workspaceId: input.workspaceId, agentKey: "site-audit", status: "FAILED", input: { path: ["domain"], equals: competitor.domain } },
      orderBy: { createdAt: "desc" },
      select: { error: true, createdAt: true, finishedAt: true },
    }),
    prisma.siteAudit.findFirst({ where: { domain: competitor.domain }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  const block = blockFromFailure(competitor.domain, fail, newest?.createdAt);
  if (block && block.until.getTime() > Date.now()) return { status: "blocked", until: block.until.toISOString() };

  let chargeId: string;
  try {
    chargeId = await spendCredits({ workspaceId: input.workspaceId, amount: CREDIT_COSTS.siteAudit, reason: "site-audit", userId: input.userId });
  } catch (e) {
    if (e instanceof InsufficientCreditsError) return { status: "insufficient-credits", balance: e.balance, needed: e.needed };
    throw e;
  }
  try {
    const run = await startAgentRun({
      workspaceId: input.workspaceId,
      brandId: input.brandId,
      agentKey: "site-audit",
      trigger: "manual",
      userId: input.userId,
      input: { domain: competitor.domain },
      prepaidChargeId: chargeId,
    });
    // A second click while the first is queued joins that run; give this charge back.
    if ((run.input as { chargeId?: string } | null)?.chargeId !== chargeId) {
      await refundCharge(input.workspaceId, chargeId);
      return { status: "already-running" };
    }
  } catch (e) {
    await refundCharge(input.workspaceId, chargeId);
    throw e;
  }
  return { status: "started", charged: CREDIT_COSTS.siteAudit };
}
