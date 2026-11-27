import type { Finding } from "@/server/seo/checks";
import { cleanText } from "@/server/text";

/**
 * The weekly link check's pure parts (server/seo/site-crawl.ts runs the crawl): what one fetch says about a link, the
 * audit findings a finished cycle makes, and its numbers for the report's metrics.links.
 */
export type LinkOutcome = "ok" | "broken" | "server-error" | "chain" | "loop" | "skipped" | "unknown";
/** A fetch's answer (`redirects` = hops followed), or what it threw. */
export type LinkCheck = { status: number; redirects: number } | { error: unknown };

/** Findings list at most this many targets (most-linked first); the rest are counted. */
export const LINK_FINDING_URLS = 20;

/**
 * One fetch, classified. `rechecking`: the row already answered 5xx once. Returns "recheck" for a first 5xx (tried
 * again at the end of the cycle, so a blip isn't reported) and "wait" for a first 429 (the site asks us to slow down:
 * the run pauses and the row is tried again at the end, like a 5xx; a second 429 is "unknown", so one URL that always
 * answers 429 can't hold the cycle up). 401/403 are never "broken": a login wall or a bot filter, not a missing page.
 */
export function classifyLink(check: LinkCheck, rechecking = false): LinkOutcome | "recheck" | "wait" {
  if ("error" in check) {
    const message = check.error instanceof Error ? check.error.message : "";
    if (message === "Too many redirects") return "loop";
    if (message === "Redirected to another site") return "skipped";
    return "unknown";
  }
  const { status, redirects } = check;
  if (status === 429) return rechecking ? "unknown" : "wait";
  if (status === 401 || status === 403) return "unknown";
  if (status >= 400 && status < 500) return "broken";
  if (status >= 500) return rechecking ? "server-error" : "recheck";
  return redirects >= 2 ? "chain" : "ok";
}

/** The SiteCrawlUrl fields the findings and metrics read. */
export type LinkRow = {
  url: string;
  checkedAt: Date | null;
  status: number | null;
  redirects: number;
  outcome: string | null;
  carryCount: number;
  sources: string[];
};

const KINDS = [
  {
    id: "links-broken",
    severity: "high" as const,
    outcomes: ["broken"],
    title: "Broken internal links",
    lead: (n: number) => `${n} page${n === 1 ? "" : "s"} your site links to answer "not found" (404, 410 or another client error):`,
    fix: "Point each link at a live page, remove it, or redirect the missing page to its closest live replacement.",
  },
  {
    id: "links-server-error",
    severity: "medium" as const,
    outcomes: ["server-error"],
    title: "Internal links to pages that fail with a server error",
    lead: (n: number) => `${n} page${n === 1 ? "" : "s"} your site links to failed with a server error twice in this week's check:`,
    fix: "Ask your developer or host why these pages fail (5xx) and fix them, or stop linking to them.",
  },
  {
    id: "links-redirect-chain",
    severity: "low" as const,
    outcomes: ["chain", "loop"],
    title: "Internal links through redirect chains or loops",
    lead: (n: number) => `${n} link target${n === 1 ? "" : "s"} on your site go through two or more redirects, or loop:`,
    fix: "Link straight to the final address, and break any redirect loop so the page answers.",
  },
];

const label = (r: LinkRow) =>
  // "loop": a loop, or more redirects than the fetch follows (4+).
  r.outcome === "loop" ? "redirect loop or 4+ redirects" : r.outcome === "chain" ? `${r.redirects} redirects` : String(r.status ?? "no answer");

/**
 * The audit findings of a cycle's rows (category "Links"): broken (high), server errors (medium), redirect chains and
 * loops (low). Only targets some page links to (carryCount ≥ 1). `urls` = up to LINK_FINDING_URLS targets, most-linked
 * first, kept whole (urlKey matching); the detail names each with one page linking to it, both through cleanText
 * (website text never reaches a prompt, task or email uncleaned).
 */
export function linkFindings(rows: LinkRow[]): Finding[] {
  const findings: Finding[] = [];
  for (const k of KINDS) {
    const bad = rows
      .filter((r) => r.carryCount >= 1 && r.outcome !== null && k.outcomes.includes(r.outcome))
      .sort((a, b) => b.carryCount - a.carryCount || a.url.localeCompare(b.url));
    if (!bad.length) continue;
    const shown = bad.slice(0, LINK_FINDING_URLS);
    const lines = shown.map((r) => {
      const on = r.sources[0] ? `, e.g. ${cleanText(r.sources[0], 300)}` : "";
      return `- ${cleanText(r.url, 300)} (${label(r)}) — on ${r.carryCount} page${r.carryCount === 1 ? "" : "s"}${on}`;
    });
    const more = bad.length > shown.length ? `\nand ${bad.length - shown.length} more` : "";
    findings.push({
      id: k.id,
      category: "Links",
      severity: k.severity,
      title: k.title,
      detail: `${k.lead(bad.length)}\n${lines.join("\n")}${more}`,
      urls: shown.map((r) => cleanText(r.url, 2_000)),
      fix: k.fix,
    });
  }
  return findings;
}

/** A finished cycle's numbers for the report's metrics.links (finding-tasks.ts clears links-* tasks only when complete). */
export function linkMetrics(
  crawl: { id: string; finishedAt: Date | null; status: string; pages: number; targets: number; checked: number; overflow: number; coverageCut: boolean },
  rows: LinkRow[],
) {
  const count = (...outcomes: string[]) => rows.filter((r) => r.outcome !== null && outcomes.includes(r.outcome)).length;
  return {
    crawlId: crawl.id,
    finishedAt: crawl.finishedAt?.toISOString() ?? null,
    pages: crawl.pages,
    targets: crawl.targets,
    checked: crawl.checked,
    broken: count("broken"),
    serverErrors: count("server-error"),
    chains: count("chain"),
    loops: count("loop"),
    unknown: count("unknown"),
    skipped: count("skipped"),
    unchecked: rows.filter((r) => r.checkedAt === null || r.outcome === "recheck").length + crawl.overflow,
    // Only a whole-site check may clear link tasks: COMPLETE and nothing left out.
    complete: crawl.status === "COMPLETE" && !crawl.coverageCut,
    coverageCut: crawl.coverageCut,
  };
}
