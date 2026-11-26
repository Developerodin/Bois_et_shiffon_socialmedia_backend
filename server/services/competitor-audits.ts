import { blockedAuditError } from "@/server/agents/definitions/site-audit";
import { AgentStartError, startAgentRun } from "@/server/agents/engine";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/prisma";
import { enqueueJob } from "@/server/jobs/queue";
import { AUDIT_FRESH_DAYS, creditBalance, CREDIT_COSTS, hasUnlimitedCredits, InsufficientCreditsError, refundCharge, spendCredits } from "@/server/services/credits";
import type { AuditAllQueued, AuditAllResult, AuditAllSkip, CompetitorAudit, CompetitorAuditSummary, CompetitorScores, CompetitorsListDto } from "@/shared";

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

/** A partial audit (the site blocked our crawler) keeps its marker in the approach JSON; read in SQL as `partial`. */
const PARTIAL_SQL = Prisma.sql`COALESCE(approach->>'partial' = 'true', false)`;

type AuditRow = { id: string; domain: string; scores: CompetitorScores; createdAt: Date; partial: boolean; newestAt: Date };
type FullAuditRow = AuditRow & Omit<CompetitorAudit, keyof CompetitorAuditSummary>;

/**
 * One row per domain, the shared audit to show (from any customer, never who requested it): the newest full audit
 * while it is fresh, so a later partial one (the site started blocking us) doesn't hide it, else the newest of any
 * kind. `newestAt` is the newest audit of any kind, which decides whether a later failure still shows. DISTINCT ON
 * runs in Postgres over the (domain, createdAt) index, so only these rows travel. `full` adds the columns the
 * competitor's own view shows; the list leaves them out.
 */
async function latestAudits(domains: string[], staleBefore: Date, full: true): Promise<FullAuditRow[]>;
async function latestAudits(domains: string[], staleBefore: Date, full?: false): Promise<AuditRow[]>;
async function latestAudits(domains: string[], staleBefore: Date, full = false): Promise<AuditRow[]> {
  if (!domains.length) return [];
  return prisma.$queryRaw<AuditRow[]>`
    SELECT DISTINCT ON (domain) id, domain, scores, "createdAt", ${PARTIAL_SQL} AS partial,
      max("createdAt") OVER (PARTITION BY domain) AS "newestAt"
      ${full ? Prisma.sql`, url, findings, "aiCrawlers", approach, socials, sources, "pagesRead"` : Prisma.empty}
    FROM "SiteAudit"
    WHERE domain IN (${Prisma.join(domains)})
    ORDER BY domain, (NOT ${PARTIAL_SQL} AND "createdAt" >= (${staleBefore}::timestamptz AT TIME ZONE 'UTC')) DESC, "createdAt" DESC`;
}

/**
 * This brand's competitors, each with the latest shared audit of its domain (latestAudits) as the list shows it.
 * `withCredits`: the caller may run audits (agents.run), so the workspace's balance is read and returned; a client
 * reviewer gets the list without it.
 */
export async function listCompetitors(workspaceId: string, brandId: string, { withCredits = false } = {}): Promise<CompetitorsListDto> {
  const competitors = await prisma.competitor.findMany({ where: { workspaceId, brandId }, orderBy: { createdAt: "asc" } });
  const domains = competitors.map((c) => c.domain);
  const staleBefore = Date.now() - AUDIT_FRESH_DAYS * 86_400_000;
  const [audits, running, failed, geo, balance] = await Promise.all([
    latestAudits(domains, new Date(staleBefore)),
    // Any workspace's running audit counts (shared library), but only for this brand's domains.
    // ponytail: the JSON-path filter has no index, so this reads the QUEUED and RUNNING site audits of every workspace;
    // fine while few run at once. Past that, add a domain column or an expression index on input->>'domain'.
    domains.length
      ? prisma.agentRun.findMany({
          where: { agentKey: "site-audit", status: { in: ["QUEUED", "RUNNING"] }, OR: domains.map((d) => ({ input: { path: ["domain"], equals: d } })) },
          select: { input: true },
        })
      : [],
    // This workspace's own failed audits only: another customer's error text is theirs.
    // ponytail: newest 50 failures cover a brand's competitor list; past that, query per domain. The JSON-path filter
    // has no index either, so it reads all of this workspace's failed site audits; the same upgrade applies.
    domains.length
      ? prisma.agentRun.findMany({
          where: { workspaceId, agentKey: "site-audit", status: "FAILED", OR: domains.map((d) => ({ input: { path: ["domain"], equals: d } })) },
          orderBy: { createdAt: "desc" },
          take: 50,
          select: { input: true, error: true, createdAt: true, finishedAt: true },
        })
      : [],
    prisma.auditReport.findFirst({ where: { workspaceId, brandId, kind: "GEO" }, orderBy: { createdAt: "desc" }, select: { metrics: true } }),
    withCredits ? creditBalance(workspaceId) : null,
  ]);
  const runningDomains = new Set(running.map((r) => (r.input as { domain?: string } | null)?.domain));
  const mentions = new Map(((geo?.metrics as { competitors?: { name: string; mentions: number }[] } | null)?.competitors ?? []).map((c) => [c.name.toLowerCase(), c.mentions]));
  return {
    // `unlimited`: the workspace is never charged (UNLIMITED_CREDIT_WORKSPACES), so the page must not cap audits at the balance.
    ...(balance !== null ? { credits: { balance, auditCost: CREDIT_COSTS.siteAudit, unlimited: hasUnlimitedCredits(workspaceId) } } : {}),
    competitors: competitors.map((c) => {
      const audit = audits.find((a) => a.domain === c.domain) ?? null;
      const newestAt = audit?.newestAt ?? null;
      // The latest failure, unless any audit (full or partial) landed after it.
      const fail = failed.find((r) => (r.input as { domain?: string } | null)?.domain === c.domain);
      const failedAt = fail && (fail.finishedAt ?? fail.createdAt);
      const showFailure = !!failedAt && (!newestAt || failedAt > newestAt);
      // The site refused automated readers, so another audit would fail the same way until the block lifts.
      const block = blockFromFailure(c.domain, fail, newestAt);
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
        audit: audit && summary(audit, staleBefore),
      };
    }),
  };
}

const summary = (a: AuditRow, staleBefore: number): CompetitorAuditSummary => ({
  id: a.id,
  domain: a.domain,
  scores: a.scores,
  createdAt: a.createdAt.toISOString(),
  stale: a.createdAt.getTime() < staleBefore,
  partial: a.partial,
});

/** The audit listCompetitors shows for this competitor, in full, for its own view; null when it has none yet. */
export async function competitorAudit(workspaceId: string, brandId: string, competitorId: string): Promise<CompetitorAudit | null> {
  const competitor = await prisma.competitor.findFirstOrThrow({ where: { id: competitorId, workspaceId, brandId }, select: { domain: true } });
  const staleBefore = Date.now() - AUDIT_FRESH_DAYS * 86_400_000;
  const [a] = await latestAudits([competitor.domain], new Date(staleBefore), true);
  if (!a) return null;
  return { ...summary(a, staleBefore), url: a.url, findings: a.findings, aiCrawlers: a.aiCrawlers, approach: a.approach, socials: a.socials, sources: a.sources, pagesRead: a.pagesRead };
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
  // Three independent reads at once: a remote database makes each round trip count (Audit all runs this per site).
  const [running, fail, newest] = await Promise.all([
    prisma.agentRun.findFirst({
      where: { agentKey: "site-audit", status: { in: ["QUEUED", "RUNNING"] }, input: { path: ["domain"], equals: competitor.domain } },
      select: { id: true },
    }),
    prisma.agentRun.findFirst({
      where: { workspaceId: input.workspaceId, agentKey: "site-audit", status: "FAILED", input: { path: ["domain"], equals: competitor.domain } },
      orderBy: { createdAt: "desc" },
      select: { error: true, createdAt: true, finishedAt: true },
    }),
    prisma.siteAudit.findFirst({ where: { domain: competitor.domain }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  if (running) return { status: "already-running" };

  // The site refused automated readers on this workspace's last try: another would fail and refund the same way.
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

/**
 * Audit several competitors at once, in the order given: the page puts the ones AI names most first and the
 * never-audited before the stale (planAuditAll on the web), so the order is decided in one place. Each site goes
 * through startCompetitorAudit, whose spend takes the workspace's credit lock, so a single audit pressed at the same
 * time can't make the two overspend. Sites that are fresh, blocked or already running are skipped without a charge.
 * Once credits run out (or the daily run cap is hit, or site audits are turned off for the brand) the rest wait. The
 * web's planAuditAll (lib/competitor-audit.ts) picks candidates with the same fresh / blocked / running rules as the
 * skips below. One site failing to start doesn't stop the others, and those already started stay charged and are
 * reported. Runs in the AUDIT_ALL_JOB (runAuditAllJob), so the press itself answers at once.
 * ponytail: sequential starts, a few queries each (several seconds per site on a remote database); fine for a brand's
 * handful of competitors (the route caps the list at 50).
 */
export async function auditAllCompetitors(input: { workspaceId: string; brandId: string; userId: string; competitorIds: string[] }): Promise<AuditAllResult> {
  const { competitors } = await listCompetitors(input.workspaceId, input.brandId);
  const started: string[] = [];
  const skipped: AuditAllResult["skipped"] = [];
  let stop: "credits" | "limit" | "disabled" | null = null;
  for (const id of [...new Set(input.competitorIds)]) {
    const c = competitors.find((x) => x.id === id);
    const reason: AuditAllSkip | null = !c ? "not-tracked" : c.auditRunning ? "running" : c.auditBlocked ? "blocked" : c.audit && !c.audit.stale ? "fresh" : stop;
    if (reason) {
      skipped.push({ id, reason });
      continue;
    }
    try {
      const r = await startCompetitorAudit({ workspaceId: input.workspaceId, brandId: input.brandId, userId: input.userId, competitorId: id });
      if (r.status === "started") started.push(id);
      else if (r.status === "insufficient-credits") skipped.push({ id, reason: (stop = "credits") });
      else skipped.push({ id, reason: r.status === "blocked" ? "blocked" : "running" });
    } catch (e) {
      // startCompetitorAudit refunded its charge before rethrowing. The daily cap (429) and a disabled site-audit agent
      // (409) would refuse every later site too, so stop instead of charging and refunding for each.
      if (e instanceof AgentStartError && e.status === 429) skipped.push({ id, reason: (stop = "limit") });
      else if (e instanceof AgentStartError && e.status === 409) skipped.push({ id, reason: (stop = "disabled") });
      else {
        console.error("[competitors] audit-all: an audit didn't start", e);
        skipped.push({ id, reason: "failed" });
      }
    }
  }
  return { started, skipped, balance: await creditBalance(input.workspaceId) };
}

export const AUDIT_ALL_JOB = "competitors.audit-all";

const AuditAllPayload = z.object({ workspaceId: z.string(), brandId: z.string(), userId: z.string(), competitorIds: z.array(z.string()).max(50) });

/**
 * Queues Audit all and answers at once: starting each site takes several round trips, so eight sites in the request
 * outlasted the page's wait. Only the cheap skip is decided here (ids this brand doesn't track); the job decides the
 * rest. `pressId` keys the job, so a press sent twice (a retry after a timeout) queues one job.
 * The caller kicks the runner.
 */
export async function queueAuditAll(input: { workspaceId: string; brandId: string; userId: string; competitorIds: string[]; pressId: string }): Promise<AuditAllQueued> {
  const ids = [...new Set(input.competitorIds)];
  const tracked = new Set(
    (await prisma.competitor.findMany({ where: { workspaceId: input.workspaceId, brandId: input.brandId, id: { in: ids } }, select: { id: true } })).map((c) => c.id),
  );
  const queued = ids.filter((id) => tracked.has(id));
  const skipped = ids.filter((id) => !tracked.has(id)).map((id) => ({ id, reason: "not-tracked" as const }));
  if (queued.length) {
    await enqueueJob({
      type: AUDIT_ALL_JOB,
      workspaceId: input.workspaceId,
      brandId: input.brandId,
      payload: { workspaceId: input.workspaceId, brandId: input.brandId, userId: input.userId, competitorIds: queued },
      // A rerun after a crash is safe: sites already started show as running and are skipped without a charge.
      maxAttempts: 3,
      idempotencyKey: `${AUDIT_ALL_JOB}:${input.brandId}:${input.pressId}`,
    });
  }
  return { queued, skipped };
}

/** Job handler for AUDIT_ALL_JOB: the starts, with every stop rule (auditAllCompetitors). The page's list shows the result. */
export async function runAuditAllJob(payload: unknown) {
  const r = await auditAllCompetitors(AuditAllPayload.parse(payload));
  if (r.skipped.length) console.info(`[competitors] audit-all: started ${r.started.length}, skipped ${r.skipped.map((s) => s.reason).join(", ")}`);
}
