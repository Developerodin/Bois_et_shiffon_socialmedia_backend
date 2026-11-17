import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  const fn = () => vi.fn();
  const db = {
    workspaceMember: { findUnique: fn(), findFirst: fn(), create: fn() },
    role: { findUnique: fn(), createMany: fn(), findUniqueOrThrow: fn() },
    brand: { findFirst: fn() },
    brandMember: { findFirst: fn() },
    creditEntry: { createMany: fn(), aggregate: fn() },
    workspace: { create: fn() },
    auditEvent: { create: fn() },
  };
  return { db, userId: fn() };
});
vi.mock("@/server/db/prisma", () => ({ prisma: m.db }));
vi.mock("@/server/auth/request-user", () => ({ requestUserId: m.userId }));

import { authorizeBrandRoute } from "@/server/api/brand-route";
import { AccessDeniedError } from "@/server/auth/errors";
import { ensurePersonalWorkspace } from "@/server/services/accounts";
import { creditBalance, STARTER_CREDITS } from "@/server/services/credits";

const params = Promise.resolve({ workspaceId: "w1", brandId: "b1" });
const request = () => new Request("http://localhost/api/v1/workspaces/w1/brands/b1/x");

beforeEach(() => {
  vi.clearAllMocks();
  m.userId.mockResolvedValue("u1");
  m.db.workspaceMember.findUnique.mockResolvedValue({ id: "m1", role: "MEMBER", roleRef: { permissions: ["brand.read", "content.create"] } });
  m.db.brand.findFirst.mockResolvedValue({ id: "b1", workspaceId: "w1", status: "ACTIVE" });
  m.db.brandMember.findFirst.mockResolvedValue(null);
});

describe("authorizeBrandRoute", () => {
  it("reads the member and the project grant once each", async () => {
    await expect(authorizeBrandRoute(request(), params, "content.create")).resolves.toEqual({ userId: "u1", workspaceId: "w1", brandId: "b1" });
    expect(m.db.workspaceMember.findUnique).toHaveBeenCalledTimes(1);
    expect(m.db.brandMember.findFirst).toHaveBeenCalledTimes(1);
    expect(m.db.brand.findFirst).toHaveBeenCalledTimes(1);
  });

  it("refuses someone outside the workspace", async () => {
    m.db.workspaceMember.findUnique.mockResolvedValue(null);
    await expect(authorizeBrandRoute(request(), params, "content.create")).rejects.toThrow(new AccessDeniedError("Not a workspace member"));
  });

  it("refuses a member without the route's permission", async () => {
    await expect(authorizeBrandRoute(request(), params, "content.approve")).rejects.toThrow(new AccessDeniedError("Missing permission content.approve"));
  });

  it("counts a project grant's permissions", async () => {
    m.db.brandMember.findFirst.mockResolvedValue({ role: { permissions: ["content.approve"] } });
    await expect(authorizeBrandRoute(request(), params, "content.approve")).resolves.toBeTruthy();
  });
});

describe("starter credits", () => {
  it("are not written by a balance read", async () => {
    m.db.creditEntry.aggregate.mockResolvedValue({ _sum: { delta: 20 } });
    expect(await creditBalance("w1")).toBe(20);
    expect(m.db.creditEntry.createMany).not.toHaveBeenCalled();
  });

  it("are granted when a workspace is made", async () => {
    m.db.workspaceMember.findFirst.mockResolvedValue(null);
    m.db.workspace.create.mockResolvedValue({ id: "w9" });
    m.db.role.findUniqueOrThrow.mockResolvedValue({ id: "r1" });
    await ensurePersonalWorkspace(m.db as never, { id: "u1", email: "a@b.c" });
    expect(m.db.creditEntry.createMany).toHaveBeenCalledWith({ data: [{ workspaceId: "w9", delta: STARTER_CREDITS, reason: "initial-grant", refId: "initial" }], skipDuplicates: true });
  });
});
