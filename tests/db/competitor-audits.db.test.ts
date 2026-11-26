import { beforeAll, describe, expect, it } from "vitest";
import { blockedAuditError } from "@/server/agents/definitions/site-audit";
import { prisma } from "@/server/db/prisma";
import { listCompetitors, startCompetitorAudit } from "@/server/services/competitor-audits";

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
