import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ access: vi.fn() }));
vi.mock("@/server/db/prisma", () => ({ prisma: {} }));
vi.mock("@/server/auth/request-user", () => ({ requestUserId: vi.fn(async () => "u1") }));
vi.mock("@/server/auth/access", () => ({ brandAccess: m.access }));

import { SYSTEM_ROLES } from "@/server/auth/permissions.catalog";
import { QuoteCreate, QuoteEdit, quoteTotals } from "@/server/quotes/quotes";
import { GET as list, POST as create } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/quotes/route";
import { PATCH as edit } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/quotes/[quoteId]/route";
import { quoteNumber, type PermissionKey } from "@/shared";

const params = (extra: { quoteId?: string } = {}) => ({ params: Promise.resolve({ workspaceId: "w1", brandId: "b1", quoteId: "", ...extra }) });
const req = (method: string, body?: unknown) => new Request("http://x", { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const roleKeys = (slug: string) => new Set(SYSTEM_ROLES.find((r) => r.slug === slug)!.permissions as PermissionKey[]);

describe("quote totals", () => {
  it("are worked out from the lines and discount, in cents", () => {
    const lines = [{ quantity: 3, unitPrice: "19.99" }, { quantity: 1, unitPrice: "0.05" }];
    expect(quoteTotals(lines, null)).toEqual({ subtotal: "60.02", discount: "0.00", total: "60.02" });
    expect(quoteTotals(lines, { kind: "PERCENT", value: "10" })).toEqual({ subtotal: "60.02", discount: "6.00", total: "54.02" });
    expect(quoteTotals(lines, { kind: "AMOUNT", value: "100" })).toEqual({ subtotal: "60.02", discount: "60.02", total: "0.00" });
  });

  it("totals a client sends are dropped, never read", () => {
    const body = QuoteCreate.parse({ lines: [{ title: "Sofa", quantity: 1, unitPrice: "900", total: "1" }], totals: { total: "1.00" } });
    expect(body).not.toHaveProperty("totals");
    expect(body.lines[0]).not.toHaveProperty("total");
  });

  it("101 lines are refused", () => {
    const lines = Array.from({ length: 101 }, () => ({ title: "x", quantity: 1, unitPrice: "1" }));
    expect(QuoteCreate.safeParse({ lines }).success).toBe(false);
    expect(QuoteCreate.safeParse({ lines: lines.slice(1) }).success).toBe(true);
    expect(QuoteEdit.safeParse({ version: 1, lines: [{ title: "x", quantity: 10_000, unitPrice: "1" }] }).success).toBe(false);
  });

  it("a discount is checked by its kind: a percentage within 0–100 with at most 2 decimals, an amount as a price", () => {
    const ok = (kind: string, value: string) => QuoteCreate.safeParse({ lines: [], discount: { kind, value } }).success;
    expect([ok("PERCENT", "0"), ok("PERCENT", "12.5"), ok("PERCENT", "99.99"), ok("PERCENT", "100")]).toEqual([true, true, true, true]);
    expect([ok("PERCENT", "100.01"), ok("PERCENT", "150"), ok("PERCENT", "12.345"), ok("PERCENT", "-5")]).toEqual([false, false, false, false]);
    // An amount may pass 100 and carry 3 decimals (the currency's own decimals are checked on save).
    expect([ok("AMOUNT", "150"), ok("AMOUNT", "1.255")]).toEqual([true, true]);
    expect(ok("AMOUNT", "1.2345")).toBe(false);
  });

  it("numbers read Q-0042", () => {
    expect(quoteNumber(42)).toBe("Q-0042");
    expect(quoteNumber(12345)).toBe("Q-12345");
  });
});

describe("quote routes", () => {
  it("viewer, creator and client reviewer are refused by default", async () => {
    for (const slug of ["viewer", "creator", "client-reviewer"]) {
      m.access.mockResolvedValue({ perms: roleKeys(slug), clientReviewer: slug === "client-reviewer" });
      expect((await list(req("GET"), params())).status, slug).toBe(403);
      expect((await create(req("POST", { lines: [] }), params())).status, slug).toBe(403);
      expect((await edit(req("PATCH", { version: 1 }), params({ quoteId: "q1" }))).status, slug).toBe(403);
    }
  });

  it("a request with 101 lines is a 400", async () => {
    m.access.mockResolvedValue({ perms: roleKeys("manager"), clientReviewer: false });
    const lines = Array.from({ length: 101 }, () => ({ title: "x", quantity: 1, unitPrice: "1" }));
    expect((await create(req("POST", { lines }), params())).status).toBe(400);
  });
});
