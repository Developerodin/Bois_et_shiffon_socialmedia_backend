import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ brandAgentConfig: { findMany: vi.fn(async () => [] as unknown[]) }, agentRun: { findMany: vi.fn() }, $queryRaw: vi.fn() }));
vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: async () => ({ userId: "u1", workspaceId: "w1", brandId: "b1", perms: new Set(["agents.read"]) }) }));
vi.mock("@/server/jobs/runner", () => ({ kickIfDue: vi.fn(async () => {}) }));

import { GET } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/agents/route";

const call = () => GET(new Request("http://x/agents"), { params: Promise.resolve({ workspaceId: "w1", brandId: "b1" }) });
type Agent = { key: string; lastRun: { id: string; status: string; startedAt: string | null; finishedAt: string | null; error: string | null } | null };

beforeEach(() => vi.clearAllMocks());

describe("GET /agents latest runs", () => {
  it("reads each agent's newest run in one scoped query, not every run", async () => {
    const t = new Date("2026-11-20T10:00:00Z");
    db.$queryRaw.mockResolvedValue([
      { id: "r1", agentKey: "creator", status: "FAILED", startedAt: t, finishedAt: t, error: "x".repeat(400) },
      { id: "r2", agentKey: "quality", status: "RUNNING", startedAt: t, finishedAt: null, error: null },
    ]);
    const { agents } = (await (await call()).json()) as { agents: Agent[] };
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.agentRun.findMany).not.toHaveBeenCalled();
    const [strings, ...values] = db.$queryRaw.mock.calls[0]! as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join("?");
    expect(sql).toMatch(/DISTINCT ON \("agentKey"\)/);
    expect(sql).toMatch(/ORDER BY "agentKey", "createdAt" DESC/);
    expect(values).toEqual(["w1", "b1"]);
    const creator = agents.find((a) => a.key === "creator")!;
    expect(creator.lastRun).toEqual({ id: "r1", status: "FAILED", startedAt: t.toISOString(), finishedAt: t.toISOString(), error: "x".repeat(300) });
    expect(agents.find((a) => a.key === "quality")!.lastRun).toEqual({ id: "r2", status: "RUNNING", startedAt: t.toISOString(), finishedAt: null, error: null });
    expect(agents.every((a) => a.key === "creator" || a.key === "quality" ? true : a.lastRun === null)).toBe(true);
  });
});
