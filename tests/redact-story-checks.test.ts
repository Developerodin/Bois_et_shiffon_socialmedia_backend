import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; results: unknown; version: { body: unknown; item: { workspaceId: string } } };
const db = vi.hoisted(() => ({
  rows: [] as Row[],
  qualityCheck: { findMany: vi.fn(), update: vi.fn(async () => ({})) },
  auditEvent: { create: vi.fn(async (_a: object) => ({})) },
  user: { findMany: vi.fn(async (): Promise<object[]> => []) },
  contentVersion: { update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
}));
vi.mock("@/server/db/prisma", () => ({ prisma: db }));

import { redactStoryChecks } from "@/scripts/redact-story-checks";

const frame = (rights: object) => ({ label: "L", headline: "H", body: "B", rights });
const story = (...rights: object[]) => ({ frames: rights.map(frame), cta: "c", link: "", hook: "h", productIds: [], brandMark: false });
const check = (note: string, status = "pass") => [{ check: "Frames", status: "pass", note: "3 frames, all rendered." }, { check: "Asset rights", status, note }];
const item = { workspaceId: "w1" };
const leaked = { id: "q1", results: check("Frame 1: Confirmed by zoe@x.com; Frame 2: Brand's own; Frame 3: Confirmed by yan@x.com"), version: { body: story({ kind: "confirmed", by: "u7", name: "zoe@x.com" }, { kind: "owned" }, { kind: "confirmed", by: "u8", name: "yan@x.com" }), item } };
const clean = (id: string): Row => ({ id, results: check("Frame 1: Confirmed by Ana"), version: { body: story({ kind: "confirmed", by: "u1", name: "Ana" }), item } });
const silent = () => undefined;

beforeEach(() => {
  vi.clearAllMocks();
  db.rows = [];
  // Cursor pages by id, as Prisma would serve them.
  db.qualityCheck.findMany.mockImplementation(async (a: { take: number; cursor?: { id: string }; skip?: number }) => {
    const start = a.cursor ? db.rows.findIndex((r) => r.id === a.cursor!.id) + (a.skip ?? 0) : 0;
    return db.rows.slice(start, start + a.take);
  });
  // u7 has since set a name; u8 still has none.
  db.user.findMany.mockResolvedValue([{ id: "u7", name: "Zoe", email: "zoe@x.com" }, { id: "u8", name: null, email: "yan@x.com" }]);
});

describe("redact-story-checks", () => {
  it("dry run counts what it would change and writes nothing", async () => {
    db.rows = [leaked, clean("q2")];
    expect(await redactStoryChecks({ apply: false }, silent)).toEqual({ scanned: 2, withEmail: 1, updated: 0, skipped: 0 });
    expect(db.qualityCheck.update).not.toHaveBeenCalled();
  });

  it("--apply rewrites only the rights note, naming people as personName does without reveal; never touches versions", async () => {
    db.rows = [leaked, clean("q2")];
    expect(await redactStoryChecks({ apply: true }, silent)).toEqual({ scanned: 2, withEmail: 1, updated: 1, skipped: 0 });
    expect(db.qualityCheck.update).toHaveBeenCalledTimes(1);
    expect(db.qualityCheck.update).toHaveBeenCalledWith({
      where: { id: "q1" },
      data: { results: check("Frame 1: Confirmed by Zoe; Frame 2: Brand's own; Frame 3: Confirmed by a team member") },
    });
    for (const f of Object.values(db.contentVersion)) expect(f).not.toHaveBeenCalled();
    // One audit event per workspace rewritten, with the count; none on a dry run.
    expect(db.auditEvent.create).toHaveBeenCalledTimes(1);
    expect(db.auditEvent.create).toHaveBeenCalledWith({ data: { workspaceId: "w1", action: "story-checks.redacted", entityType: "Workspace", entityId: "w1", metadata: { count: 1 } } });
  });

  it("writes one audit event for each workspace, and none on a dry run", async () => {
    db.rows = [leaked, { ...leaked, id: "q5", version: { ...leaked.version, item: { workspaceId: "w2" } } }, { ...leaked, id: "q6" }];
    await redactStoryChecks({ apply: false }, silent);
    expect(db.auditEvent.create).not.toHaveBeenCalled();
    await redactStoryChecks({ apply: true }, silent);
    expect(db.auditEvent.create.mock.calls.map((c) => (c[0] as { data: { workspaceId: string; metadata: { count: number } } }).data).map((d) => [d.workspaceId, d.metadata.count])).toEqual([["w1", 2], ["w2", 1]]);
  });

  it("pages by cursor 500 at a time and scopes to a workspace when given", async () => {
    db.rows = [...Array.from({ length: 500 }, (_, i) => clean(`a${String(i).padStart(3, "0")}`)), { ...leaked, id: "z1" }];
    expect(await redactStoryChecks({ apply: true, workspaceId: "w1" }, silent)).toEqual({ scanned: 501, withEmail: 1, updated: 1, skipped: 0 });
    expect(db.qualityCheck.findMany).toHaveBeenCalledTimes(2);
    const first = db.qualityCheck.findMany.mock.calls[0]![0];
    expect(first).toMatchObject({ take: 500, orderBy: { id: "asc" }, where: { version: { item: { channel: "INSTAGRAM_STORY", workspaceId: "w1" } } } });
    expect(db.qualityCheck.findMany.mock.calls[1]![0]).toMatchObject({ cursor: { id: "a499" }, skip: 1 });
  });

  it("leaves a blocked rights row (no names in it) and non-story bodies alone", async () => {
    db.rows = [{ id: "q3", results: check("Frame 2 has no rights confirmation.", "blocker"), version: { body: story({ kind: "owned" }), item } }, { id: "q4", results: check("x@y.com"), version: { body: { caption: "post" }, item } }];
    expect(await redactStoryChecks({ apply: true }, silent)).toEqual({ scanned: 2, withEmail: 0, updated: 0, skipped: 1 });
    expect(db.auditEvent.create).not.toHaveBeenCalled();
  });
});
