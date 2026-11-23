import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ $transaction: vi.fn() }));
const m = vi.hoisted(() => ({ authorize: vi.fn(), hit: vi.fn() }));
vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: m.authorize }));
vi.mock("@/server/auth/rate-limit", () => ({ hitRateLimit: m.hit }));

import { AccessDeniedError } from "@/server/auth/errors";
import type { PermissionKey } from "@/server/auth/permissions.catalog";
import { POST as tasksPost } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/tasks/route";
import { POST as batchPost } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/tasks/batch/route";
import { POST as commentsPost } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/tasks/[taskId]/comments/route";

let perms = new Set<PermissionKey>(["brand.read", "tasks.read", "tasks.manage"]);
const params = { params: Promise.resolve({ workspaceId: "w1", brandId: "b1", taskId: "t1" }) };
// The three routes take different params; one loose type lets one table drive them all.
const post = (route: (req: Request, ctx: typeof params) => Promise<Response>, body: unknown) => route(new Request("http://x/api", { method: "POST", body: JSON.stringify(body) }), params);
const task = { title: "Fix menu", areas: ["WEBSITE"], priority: "NORMAL" };
const routes = [
  ["create", tasksPost, task],
  ["batch", batchPost, { requestId: "6f1c2c1e-6a43-4c1b-9a3e-2f1d5b7c8a90", tasks: [task] }],
  ["comment", commentsPost, { body: "Looks good" }],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  perms = new Set<PermissionKey>(["brand.read", "tasks.read", "tasks.manage"]);
  m.authorize.mockImplementation(async (_r: Request, _p: unknown, key: PermissionKey) => {
    if (!perms.has(key)) throw new AccessDeniedError(`Missing permission ${key}`);
    return { workspaceId: "w1", brandId: "b1", userId: "u1", perms, clientReviewer: false };
  });
  m.hit.mockResolvedValue({ allowed: false, count: 61 });
});

describe("task write limits", () => {
  it.each(routes)("POST %s past 60 a minute per person → 429, nothing written", async (kind, route, body) => {
    const res = await post(route, body);
    expect(res.status).toBe(429);
    expect(m.hit).toHaveBeenCalledWith(`tasks.${kind}:u1`, 60, 60_000);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("a refused permission is a 403 and spends nothing", async () => {
    perms = new Set<PermissionKey>(["brand.read"]);
    for (const [, route, body] of routes) expect((await post(route, body)).status).toBe(403);
    expect(m.hit).not.toHaveBeenCalled();
  });
});
