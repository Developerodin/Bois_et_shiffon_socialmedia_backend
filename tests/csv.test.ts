import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  perms: new Set<string>(["content.download"]),
  contentItem: { findMany: vi.fn(async () => []) },
  auditEvent: { create: vi.fn(async () => ({})) },
  queryRaw: vi.fn(async () => []),
  hit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/server/db/prisma", () => ({ prisma: { contentItem: m.contentItem, auditEvent: m.auditEvent, $queryRaw: m.queryRaw } }));
vi.mock("@/server/auth/rate-limit", () => ({ hitRateLimit: m.hit }));
vi.mock("@/server/api/brand-route", async () => {
  const { AccessDeniedError } = await import("@/server/auth/errors");
  return {
    authorizeBrandRoute: async (_r: Request, _p: unknown, key: string) => {
      if (!m.perms.has(key)) throw new AccessDeniedError(`Missing permission ${key}`);
      return { userId: "u1", workspaceId: "w1", brandId: "b1" };
    },
  };
});

import { GET } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/content/export/route";
import { toCsv } from "@/shared";

const cols = [{ key: "a", label: "A" }];
const cell = (v: string) => toCsv(cols, [{ a: v }]).split("\r\n")[1];
const call = (qs = "") => GET(new Request(`http://x/content/export${qs}`), { params: Promise.resolve({ workspaceId: "w1", brandId: "b1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  m.perms = new Set(["content.download"]);
});

describe("toCsv", () => {
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "|cmd", "＝1", "＋1", "－1", "＠x", " =1", "\t=1", "\r=1"])("neutralises formula cells: %j", (v) => {
    expect(cell(v)).toMatch(/^"?'/);
  });
  it("leaves plain text alone", () => expect(cell("hello")).toBe("hello"));
  it("quotes commas, quotes and newlines", () => {
    expect(cell("a,b")).toBe('"a,b"');
    expect(cell('say "hi"')).toBe('"say ""hi"""');
    expect(cell("l1\nl2")).toBe('"l1\nl2"');
  });
  it("starts with a BOM and uses CRLF", () => {
    const out = toCsv(cols, [{ a: "x" }]);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out).toBe("\uFEFFA\r\nx\r\n");
  });
});

describe("GET /content/export", () => {
  it("refuses a range over 366 days", async () => {
    const res = await call("?from=2026-01-01&to=2027-06-01");
    expect(res.status).toBe(400);
    expect(m.contentItem.findMany).not.toHaveBeenCalled();
  });
  it("needs content.download", async () => {
    m.perms = new Set();
    expect((await call()).status).toBe(403);
    expect(m.hit).not.toHaveBeenCalled();
  });
  it("returns a csv with captions from one raw query", async () => {
    m.contentItem.findMany.mockResolvedValueOnce([
      { id: "i1", title: "T", channel: "INSTAGRAM_POST", status: "APPROVED", scheduledFor: new Date("2026-11-21T10:00:00Z"), postUrl: null, owner: { name: "Ann" }, campaign: null },
    ] as never);
    m.queryRaw.mockResolvedValueOnce([{ contentItemId: "i1", caption: "=evil" }] as never);
    const res = await call();
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const text = await res.text();
    expect(text).toContain("'=evil");
    expect(m.queryRaw).toHaveBeenCalledTimes(1);
    expect(m.auditEvent.create).toHaveBeenCalled();
  });
});
