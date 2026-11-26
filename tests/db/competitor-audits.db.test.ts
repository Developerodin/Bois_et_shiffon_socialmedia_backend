import { beforeAll, describe, expect, it } from "vitest";
import { blockedAuditError } from "@/server/agents/definitions/site-audit";
import { prisma } from "@/server/db/prisma";
import { creditBalance } from "@/server/services/credits";
import { auditAllCompetitors, listCompetitors, startCompetitorAudit } from "@/server/services/competitor-audits";

/** Competitor audits against Postgres: the full-over-partial pick and the blocked-site refusal's queries. */
let ws: string;
let userId: string;
const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
const audit = (domain: string, createdAt: Date, approach: object) =>
  prisma.siteAudit.create({ data: { domain, url: `https://${domain}`, scores: {}, findings: [], aiCrawlers: [], approach, socials: [], pagesRead: 0, createdAt } });

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-competitor-audits" } })).id;
  userId = (await prisma.user.create({ data: { email: "u@competitor-audits.test", name: "u" } })).id;
  await prisma.brand.create({ data: { id: "ca-b", workspaceId: ws, slug: "ca-b", displayName: "B" } });
  await prisma.competitor.createMany({
    data: [
      { id: "c-mixed", workspaceId: ws, brandId: "ca-b", name: "Mixed", domain: "mixed.test", source: "manual" },
      { id: "c-blocked", workspaceId: ws, brandId: "ca-b", name: "Blocked", domain: "blocked.test", source: "manual" },
    ],
  });
  // A full audit (no `partial` key at all) older than a partial one: the full one is shown.
  await audit("mixed.test", ago(3), { positioning: "full" });
  await audit("mixed.test", ago(1), { partial: true });
  await prisma.agentRun.create({
    data: { workspaceId: ws, brandId: "ca-b", agentKey: "site-audit", trigger: "manual", status: "FAILED", input: { domain: "blocked.test" }, error: blockedAuditError("blocked.test"), finishedAt: ago(2), createdAt: ago(2) },
  });
});

describe("competitor audits", () => {
  it("shows the fresh full audit over a newer partial one", async () => {
    const { competitors } = await listCompetitors(ws, "ca-b");
    const mixed = competitors.find((c) => c.domain === "mixed.test")!;
    expect(mixed.audit).toMatchObject({ partial: false, approach: { positioning: "full" } });
    expect(competitors.find((c) => c.domain === "blocked.test")).toMatchObject({ auditBlocked: true });
  });

  it("refuses a new audit of a site that blocked us, without spending credits", async () => {
    const before = await prisma.creditEntry.findMany({ where: { workspaceId: ws } });
    const result = await startCompetitorAudit({ workspaceId: ws, brandId: "ca-b", userId, competitorId: "c-blocked" });
    expect(result).toMatchObject({ status: "blocked" });
    expect(await prisma.creditEntry.findMany({ where: { workspaceId: ws } })).toEqual(before);
  });
});

describe("audit all", () => {
  // Its own workspace: the starter grant (20 credits) pays for two audits.
  let ws2: string;
  beforeAll(async () => {
    ws2 = (await prisma.workspace.create({ data: { name: "W2", slug: "w-competitor-audit-all" } })).id;
    await prisma.brand.create({ data: { id: "aa-b", workspaceId: ws2, slug: "aa-b", displayName: "B" } });
    const row = (id: string) => ({ id, workspaceId: ws2, brandId: "aa-b", name: id, domain: `${id}.test`, source: "manual" });
    await prisma.competitor.createMany({ data: ["aa-new1", "aa-new2", "aa-new3", "aa-single", "aa-fresh", "aa-blocked", "aa-running"].map(row) });
    await audit("aa-fresh.test", ago(2), { positioning: "fresh" });
    await prisma.agentRun.createMany({
      data: [
        { workspaceId: ws2, brandId: "aa-b", agentKey: "site-audit", trigger: "manual", status: "FAILED", input: { domain: "aa-blocked.test" }, error: blockedAuditError("aa-blocked.test"), finishedAt: ago(1), createdAt: ago(1) },
        { workspaceId: ws2, brandId: "aa-b", agentKey: "site-audit", trigger: "manual", status: "QUEUED", input: { domain: "aa-running.test" } },
      ],
    });
  });

  it("skips fresh, blocked and running sites, and never overspends alongside a single audit", async () => {
    const [all, single] = await Promise.all([
      auditAllCompetitors({ workspaceId: ws2, brandId: "aa-b", userId, competitorIds: ["aa-fresh", "aa-blocked", "aa-running", "aa-new1", "aa-new2", "aa-new3"] }),
      startCompetitorAudit({ workspaceId: ws2, brandId: "aa-b", userId, competitorId: "aa-single" }),
    ]);
    expect(all.skipped.filter((s) => ["aa-fresh", "aa-blocked", "aa-running"].includes(s.id))).toEqual([
      { id: "aa-fresh", reason: "fresh" },
      { id: "aa-blocked", reason: "blocked" },
      { id: "aa-running", reason: "running" },
    ]);
    // 20 credits pay for exactly two audits between the two callers, whichever took the lock first.
    const startedCount = all.started.length + (single.status === "started" ? 1 : 0);
    expect(startedCount).toBe(2);
    expect(await creditBalance(ws2)).toBe(0);
    // The ones audit-all couldn't pay for wait for credits, in the order given.
    const waiting = ["aa-new1", "aa-new2", "aa-new3"].filter((id) => !all.started.includes(id));
    expect(all.skipped.filter((s) => s.reason === "credits").map((s) => s.id)).toEqual(waiting);
    expect(all.started).toEqual(["aa-new1", "aa-new2", "aa-new3"].slice(0, all.started.length));
    expect(await prisma.agentRun.count({ where: { workspaceId: ws2, status: "QUEUED", NOT: { input: { path: ["domain"], equals: "aa-running.test" } } } })).toBe(2);
  });
});

describe("audit all on a brand with site audits turned off", () => {
  let ws3: string;
  beforeAll(async () => {
    ws3 = (await prisma.workspace.create({ data: { name: "W3", slug: "w-competitor-audit-off" } })).id;
    await prisma.brand.create({ data: { id: "off-b", workspaceId: ws3, slug: "off-b", displayName: "B" } });
    await prisma.brandAgentConfig.create({ data: { workspaceId: ws3, brandId: "off-b", agentKey: "site-audit", enabled: false } });
    await prisma.competitor.createMany({
      data: ["off-1", "off-2", "off-3"].map((id) => ({ id, workspaceId: ws3, brandId: "off-b", name: id, domain: `${id}.test`, source: "manual" })),
    });
  });

  it("stops at the first refusal instead of charging and refunding for every site", async () => {
    const r = await auditAllCompetitors({ workspaceId: ws3, brandId: "off-b", userId, competitorIds: ["off-1", "off-2", "off-3"] });
    expect(r.started).toEqual([]);
    expect(r.skipped).toEqual(["off-1", "off-2", "off-3"].map((id) => ({ id, reason: "disabled" })));
    // One charge and its refund (the first site), nothing for the rest.
    expect(await prisma.creditEntry.count({ where: { workspaceId: ws3, reason: { in: ["site-audit", "refund"] } } })).toBe(2);
    expect(await creditBalance(ws3)).toBe(20);
  });

  it("says when the workspace is never charged, so the page doesn't cap audits at the balance", async () => {
    expect((await listCompetitors(ws3, "off-b")).credits.unlimited).toBe(false);
    process.env.UNLIMITED_CREDIT_WORKSPACES = ws3;
    try {
      expect((await listCompetitors(ws3, "off-b")).credits.unlimited).toBe(true);
    } finally {
      delete process.env.UNLIMITED_CREDIT_WORKSPACES;
    }
  });
});
