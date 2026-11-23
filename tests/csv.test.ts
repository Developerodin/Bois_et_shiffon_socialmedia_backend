import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  perms: new Set<string>(["content.download"]),
  contentItem: { findMany: vi.fn(async () => []) },
  auditEvent: { create: vi.fn(async () => ({})) },
  queryRaw: vi.fn(async () => []),
  auditReport: { findFirst: vi.fn(async () => ({ findings: [{ severity: "high", category: "SEO", title: "No title", detail: "d", urls: ["https://a"], fix: "f" }] })) },
  hit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/server/db/prisma", () => ({ prisma: { contentItem: m.contentItem, auditEvent: m.auditEvent, auditReport: m.auditReport, $queryRaw: m.queryRaw } }));
vi.mock("@/server/auth/rate-limit", () => ({ hitRateLimit: m.hit }));
vi.mock("@/server/api/brand-route", async () => {
  const { AccessDeniedError } = await import("@/server/auth/errors");
  return {
    authorizeBrandRoute: async (_r: Request, _p: unknown, key: string) => {
      if (!m.perms.has(key)) throw new AccessDeniedError(`Missing permission ${key}`);
      return { userId: "u1", workspaceId: "w1", brandId: "b1", perms: m.perms };
    },
  };
});

import { GET } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/content/export/route";
import { GET as findingsGet } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/audit-reports/export/route";
import { toCsv } from "@/shared";

const cols = [{ key: "a", label: "A" }];
const cell = (v: string) => toCsv(cols, [{ a: v }]).split("\r\n")[1];
const call = (qs = "") => GET(new Request(`http://x/content/export${qs}`), { params: Promise.resolve({ workspaceId: "w1", brandId: "b1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  m.perms = new Set(["content.download", "analytics.read"]);
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
      { id: "i1", title: "T", channel: "INSTAGRAM_POST", status: "APPROVED", scheduledFor: new Date("2026-11-21T10:00:00Z"), postUrl: null, owner: { name: "Ann", email: "ann@x.com" }, campaign: null },
      { id: "i2", title: "U", channel: "INSTAGRAM_POST", status: "APPROVED", scheduledFor: new Date("2026-11-22T10:00:00Z"), postUrl: null, owner: { name: null, email: "bo@x.com" }, campaign: null },
    ] as never);
    m.queryRaw.mockResolvedValueOnce([{ contentItemId: "i1", caption: "=evil" }] as never);
    const res = await call();
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const text = await res.text();
    expect(text).toContain("'=evil");
    // An owner without a name: "A team member" to someone who can't manage members, as in the app.
    expect(text).toContain(",Ann,");
    expect(text).toContain(",A team member,");
    expect(text).not.toMatch(/@|,bo,/);
    expect(m.queryRaw).toHaveBeenCalledTimes(1);
    expect(m.auditEvent.create).toHaveBeenCalled();
  });
});

describe("CSV owner names", () => {
  it("give a nameless owner's email local part only to people who manage members", async () => {
    m.perms = new Set(["content.download", "project.members.manage"]);
    m.contentItem.findMany.mockResolvedValueOnce([
      { id: "i2", title: "U", channel: "INSTAGRAM_POST", status: "APPROVED", scheduledFor: new Date("2026-11-22T10:00:00Z"), postUrl: null, owner: { name: "  ", email: "bo@x.com" }, campaign: null },
    ] as never);
    const text = await (await call()).text();
    expect(text).toContain(",bo,");
    expect(text).not.toContain("@");
  });
});

describe("both exports (calendar CSV, findings Excel)", () => {
  const findings = (qs = "?kind=GEO") => findingsGet(new Request(`http://x/audit-reports/export${qs}`), { params: Promise.resolve({ workspaceId: "w1", brandId: "b1" }) });

  it("share one allowance per person and answer 429 the same way", async () => {
    await call();
    await findings();
    expect(m.hit.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["export:u1", "export:u1"]);
    m.hit.mockResolvedValue({ allowed: false });
    for (const res of [await call(), await findings()]) {
      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({ title: "Too many exports. Try again later.", status: 429 });
    }
    m.hit.mockResolvedValue({ allowed: true });
  });

  it("send the same download headers", async () => {
    const res = await findings();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="geo-findings-\d{4}-\d{2}-\d{2}\.xlsx"$/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect((await call()).headers.get("Content-Disposition")).toMatch(/^attachment; filename="calendar-/);
  });

  it("refuse a bad kind with a 400 before using the allowance", async () => {
    const res = await findings("?kind=X");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ detail: "kind must be SEO or GEO" });
    expect(m.hit).not.toHaveBeenCalled();
  });
});
