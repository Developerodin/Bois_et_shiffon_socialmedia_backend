import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  facts: vi.fn(),
  pageSpeed: vi.fn(),
  create: vi.fn(),
  competitors: vi.fn(),
  audits: vi.fn(),
  runs: vi.fn(),
}));
vi.mock("@/server/seo/site-facts", async (orig) => ({ ...(await orig<object>()), collectSiteFacts: m.facts, runPageSpeed: m.pageSpeed }));
vi.mock("@/server/db/prisma", () => ({
  prisma: {
    siteAudit: { create: m.create, findMany: m.audits },
    competitor: { findMany: m.competitors },
    agentRun: { findMany: m.runs },
    auditReport: { findFirst: vi.fn(async () => null) },
  },
}));
vi.mock("@/server/services/credits", async (orig) => ({ ...(await orig<object>()), creditBalance: vi.fn(async () => 50) }));

import { BLOCKED_REASON, blockedAuditError, SiteBlockedError, siteAuditAgent } from "@/server/agents/definitions/site-audit";
import type { AgentContext } from "@/server/agents/types";
import { siteRefusedUs } from "@/server/seo/site-facts";
import { AUDIT_BLOCK_DAYS, listCompetitors } from "@/server/services/competitor-audits";

const PS = { performance: 41, seo: 88, accessibility: 77, bestPractices: 92, lcpMs: 5200, cls: 0.02 };
const noPages = (failures: Array<{ url: string; error: string }>) => ({
  facts: { startUrl: "https://tikamoon.com", pages: [], robotsTxt: "User-agent: *\nAllow: /", hasSitemap: false, hasLlmsTxt: false },
  failures,
});
const approach = (sources: Array<{ url: string; title: string }>) => ({
  positioning: "Solid wood furniture.",
  audience: "Home owners.",
  products: ["Tables"],
  priceSignals: "Not shown",
  contentThemes: [],
  strengths: [],
  weaknesses: [],
  sources,
});

function ctx(generated: unknown): AgentContext {
  return {
    runId: "r1",
    brand: { workspaceId: "w1" } as AgentContext["brand"],
    log: vi.fn(async () => {}),
    ai: { generateObject: vi.fn(async () => generated) as AgentContext["ai"]["generateObject"] },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.create.mockResolvedValue({ id: "a1" });
});

describe("siteRefusedUs", () => {
  it("counts 401/403/429 on the home page, or every failure a 401/403", () => {
    expect(siteRefusedUs("https://x.com", [{ url: "https://x.com/", error: "HTTP 403 text/html" }])).toBe(true);
    expect(siteRefusedUs("https://x.com", [{ url: "https://x.com/", error: "HTTP 429 text/html" }])).toBe(true);
    expect(siteRefusedUs("https://x.com", [{ url: "https://x.com/a", error: "HTTP 401 text/html" }, { url: "https://x.com/b", error: "HTTP 403 text/html" }])).toBe(true);
  });

  it("does not count server errors, timeouts, robots.txt or a 429 deeper in the site", () => {
    expect(siteRefusedUs("https://x.com", [{ url: "https://x.com/", error: "HTTP 500 text/html" }])).toBe(false);
    expect(siteRefusedUs("https://x.com", [{ url: "https://x.com/", error: "The operation was aborted due to timeout" }])).toBe(false);
    expect(siteRefusedUs("https://x.com", [{ url: "https://x.com/", error: "disallowed by robots.txt" }])).toBe(false);
    expect(siteRefusedUs("https://x.com", [{ url: "https://x.com/a", error: "HTTP 429 text/html" }])).toBe(false);
    expect(siteRefusedUs("https://x.com", [])).toBe(false);
  });
});

describe("site audit of a site that blocks automated readers", () => {
  it("saves a partial audit marked blocked, scored by PageSpeed only, with no invented findings", async () => {
    m.facts.mockResolvedValue(noPages([{ url: "https://tikamoon.com/", error: "HTTP 403 text/html" }]));
    m.pageSpeed.mockResolvedValue({ result: PS });
    const out = await siteAuditAgent.run(ctx(approach([{ url: "https://news.example/tikamoon", title: "Tikamoon profile" }])), { domain: "tikamoon.com" });

    expect(out).toEqual({ auditId: "a1", partial: true });
    const data = m.create.mock.calls[0][0].data;
    expect(data.scores).toMatchObject({ performance: 41, seo: 88, siteChecks: null });
    expect(data.findings).toEqual([]);
    expect(data.pagesRead).toBe(0);
    expect(data.approach).toMatchObject({ positioning: "Solid wood furniture.", partial: true, blockedReason: BLOCKED_REASON });
    expect(data.sources).toEqual([{ url: "https://news.example/tikamoon", title: "Tikamoon profile" }]);
  });

  it("still saves when PageSpeed fails but search found a sourced approach", async () => {
    m.facts.mockResolvedValue(noPages([{ url: "https://tikamoon.com/", error: "HTTP 403 text/html" }]));
    m.pageSpeed.mockResolvedValue({ result: null, error: "HTTP 500" });
    await siteAuditAgent.run(ctx(approach([{ url: "https://news.example/t", title: "T" }])), { domain: "tikamoon.com" });
    expect(m.create.mock.calls[0][0].data.scores).toMatchObject({ performance: null, siteChecks: null });
  });

  it("fails with the fixed, non-retried error when PageSpeed fails and search cites nothing", async () => {
    m.facts.mockResolvedValue(noPages([{ url: "https://tikamoon.com/", error: "HTTP 403 text/html" }]));
    m.pageSpeed.mockResolvedValue({ result: null, error: "Lighthouse returned error: FAILED_DOCUMENT_REQUEST" });
    const run = siteAuditAgent.run(ctx(approach([])), { domain: "tikamoon.com" });
    await expect(run).rejects.toThrow(new SiteBlockedError("tikamoon.com blocks automated readers, so it can't be audited. Your credits were refunded."));
    await expect(run).rejects.toBeInstanceOf(SiteBlockedError);
    expect(m.create).not.toHaveBeenCalled();
  });

  it("keeps the old error for a site that is down or slow", async () => {
    for (const error of ["HTTP 500 text/html", "The operation was aborted due to timeout"]) {
      m.facts.mockResolvedValue(noPages([{ url: "https://tikamoon.com/", error }]));
      m.pageSpeed.mockResolvedValue({ result: PS });
      const c = ctx(approach([]));
      await expect(siteAuditAgent.run(c, { domain: "tikamoon.com" })).rejects.toThrow("Could not read tikamoon.com");
      expect(c.ai.generateObject).not.toHaveBeenCalled();
    }
    expect(m.create).not.toHaveBeenCalled();
  });
});

describe("competitors list: auditBlocked", () => {
  const at = (d: number) => new Date(Date.UTC(2026, 10, d));
  const competitor = (domain: string) => ({ id: domain, name: domain, domain, source: "manual", createdAt: at(1) });
  const failure = (domain: string, error: string, finishedAt: Date) => ({ input: { domain }, error, createdAt: finishedAt, finishedAt });
  const audit = (domain: string, createdAt: Date, approach: object = {}) => ({ id: `a-${domain}`, domain, url: `https://${domain}`, scores: {}, findings: [], aiCrawlers: [], approach, socials: [], sources: [], pagesRead: 0, createdAt });
  // Only Date is faked, so the mocked promises still resolve; "now" is the 8th, three days after the failures below.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(8));
  });
  afterEach(() => vi.useRealTimers());

  it("is true only while the latest blocked failure is newer than any audit", async () => {
    m.competitors.mockResolvedValue([competitor("blocked.com"), competitor("down.com"), competitor("fixed.com")]);
    m.audits.mockResolvedValue([audit("fixed.com", at(10))]);
    m.runs.mockImplementation(async (q: { where: { status: unknown } }) =>
      q.where.status === "FAILED"
        ? [failure("blocked.com", blockedAuditError("blocked.com"), at(5)), failure("down.com", "Could not read down.com", at(5)), failure("fixed.com", blockedAuditError("fixed.com"), at(5))]
        : []);
    const { competitors } = await listCompetitors("w1", "b1");
    const by = Object.fromEntries(competitors.map((c) => [c.domain, c]));
    expect(by["blocked.com"]).toMatchObject({ auditBlocked: true, auditBlockedUntil: at(5 + AUDIT_BLOCK_DAYS).toISOString(), auditError: blockedAuditError("blocked.com") });
    expect(by["down.com"]).toMatchObject({ auditBlocked: false, auditError: "Could not read down.com" });
    // A newer audit (here from another workspace's later attempt) clears both, so the site can be audited again.
    expect(by["fixed.com"]).toMatchObject({ auditBlocked: false, auditError: null });
  });

  it("expires after AUDIT_BLOCK_DAYS so the site can be tried again, keeping the failure text", async () => {
    m.competitors.mockResolvedValue([competitor("blocked.com")]);
    m.audits.mockResolvedValue([]);
    m.runs.mockImplementation(async (q: { where: { status: unknown } }) => (q.where.status === "FAILED" ? [failure("blocked.com", blockedAuditError("blocked.com"), at(5))] : []));
    const until = at(5 + AUDIT_BLOCK_DAYS);

    vi.setSystemTime(until.getTime() - 1);
    expect((await listCompetitors("w1", "b1")).competitors[0]).toMatchObject({ auditBlocked: true, auditBlockedUntil: until.toISOString() });

    vi.setSystemTime(until);
    expect((await listCompetitors("w1", "b1")).competitors[0]).toMatchObject({ auditBlocked: false, auditBlockedUntil: null, auditError: blockedAuditError("blocked.com") });
  });

  it("marks a partial audit with its reason", async () => {
    m.competitors.mockResolvedValue([competitor("tikamoon.com"), competitor("full.com")]);
    m.audits.mockResolvedValue([audit("tikamoon.com", at(10), { partial: true, blockedReason: BLOCKED_REASON }), audit("full.com", at(10), { positioning: "x" })]);
    m.runs.mockResolvedValue([]);
    const { competitors } = await listCompetitors("w1", "b1");
    expect(competitors[0].audit).toMatchObject({ partial: true, blockedReason: BLOCKED_REASON });
    expect(competitors[1].audit).toMatchObject({ partial: false, blockedReason: null });
  });
});
