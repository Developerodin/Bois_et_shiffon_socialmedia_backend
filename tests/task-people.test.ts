import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ workspaceMember: { findMany: vi.fn() } }));
const m = vi.hoisted(() => ({ people: vi.fn(), authorize: vi.fn() }));
vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/services/project-members", () => ({ listProjectPeople: m.people }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: m.authorize }));

import { AccessDeniedError } from "@/server/auth/errors";
import type { PermissionKey } from "@/server/auth/permissions.catalog";
import { GET as peopleGet } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/tasks/people/route";

let perms = new Set<PermissionKey>(["brand.read", "tasks.read"]);
let clientReviewer = false;
const get = () => peopleGet(new Request("http://x/api"), { params: Promise.resolve({ workspaceId: "w1", brandId: "b1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  perms = new Set<PermissionKey>(["brand.read", "tasks.read"]);
  clientReviewer = false;
  m.authorize.mockImplementation(async (_r: Request, _p: unknown, key: PermissionKey) => {
    if (!perms.has(key)) throw new AccessDeniedError(`Missing permission ${key}`);
    return { workspaceId: "w1", brandId: "b1", userId: "u1", perms, clientReviewer };
  });
  // Workspace roles holding tasks.read: Ana only (Dee's role reads the brand but not its tasks).
  db.workspaceMember.findMany.mockResolvedValue([
    { userId: "u1", roleRef: { permissions: ["brand.read", "tasks.read", "content.approve"] } },
    { userId: "u4", roleRef: { permissions: ["brand.read"] } },
  ]);
  m.people.mockResolvedValue({
    viaWorkspace: [
      { userId: "u1", name: "Ana", email: "ana@x.com", role: "Owner", active: true },
      { userId: "u4", name: "Dee", email: "dee@x.com", role: "Reader", active: true },
    ],
    people: [
      { id: "g1", userId: "u3", name: "Cy", email: "cy@x.com", role: { id: "r", name: "Creator", permissions: ["brand.read", "tasks.read"] }, active: true, client: false },
      { id: "g2", userId: "u5", name: "Bea", email: "bea@x.com", role: { id: "c", name: "Client reviewer", permissions: ["brand.read", "tasks.read"] }, active: true, client: true },
      { id: "g3", userId: "u6", name: "Eve", email: "eve@x.com", role: { id: "v", name: "Viewer", permissions: ["brand.read"] }, active: true, client: false },
    ],
    invitations: [],
  });
});

describe("GET tasks/people", () => {
  it("lists tasks.read holders by name, clients included and marked, without emails", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      people: [
        { id: "u1", name: "Ana", gone: false, client: false },
        { id: "u5", name: "Bea", gone: false, client: true },
        { id: "u3", name: "Cy", gone: false, client: false },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("@");
  });

  it("no tasks.read → 403", async () => {
    perms = new Set<PermissionKey>(["brand.read"]);
    expect((await get()).status).toBe(403);
    expect(m.people).not.toHaveBeenCalled();
  });

  it("a client reviewer → 403 (the list names the team)", async () => {
    clientReviewer = true;
    expect((await get()).status).toBe(403);
    expect(m.people).not.toHaveBeenCalled();
  });
});
