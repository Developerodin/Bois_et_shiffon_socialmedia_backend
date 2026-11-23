import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ $queryRaw: vi.fn() }));
const m = vi.hoisted(() => ({ hit: vi.fn(), authorize: vi.fn() }));
vi.mock("@/server/db/prisma", () => ({ prisma: db }));
vi.mock("@/server/auth/rate-limit", () => ({ hitRateLimit: m.hit }));
vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: m.authorize }));

import type { Prisma } from "@prisma/client";
import { AccessDeniedError } from "@/server/auth/errors";
import type { PermissionKey } from "@/server/auth/permissions.catalog";
import { taskViewer } from "@/server/tasks/access";
import { searchBrand } from "@/server/tasks/search";
import { GET as searchGet } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/search/route";

const scopeOf = (perms: PermissionKey[], clientReviewer = false) => ({ workspaceId: "w1", brandId: "b1", userId: "u1", perms: new Set(perms), clientReviewer });
const STAFF = scopeOf(["brand.read", "tasks.read"]);
const text = (s: Prisma.Sql) => s.sql.replace(/\s+/g, " ");
const sqls = () => db.$queryRaw.mock.calls.map((c) => c[0] as Prisma.Sql);
const sqlFor = (table: string) => sqls().find((s) => text(s).includes(`FROM "${table}"`));
const get = (q: string) => searchGet(new Request(`http://x/api/search?q=${encodeURIComponent(q)}`), { params: Promise.resolve({ workspaceId: "w1", brandId: "b1" }) });

let scope = STAFF;
beforeEach(() => {
  vi.clearAllMocks();
  scope = STAFF;
  m.hit.mockResolvedValue({ allowed: true, count: 1 });
  db.$queryRaw.mockResolvedValue([]);
  m.authorize.mockImplementation(async (_r: Request, _p: unknown, key: PermissionKey) => {
    if (!scope.perms.has(key)) throw new AccessDeniedError(`Missing permission ${key}`);
    return scope;
  });
});

describe("searchBrand", () => {
  it("search escapes wildcards", async () => {
    await searchBrand(STAFF, taskViewer(STAFF), "  50%_off\\x  ");
    expect(db.$queryRaw).toHaveBeenCalledTimes(5);
    for (const sql of sqls()) {
      expect(text(sql)).toContain("ILIKE");
      expect(text(sql)).toContain("ORDER BY similarity(");
      expect(text(sql)).toContain("LIMIT 5");
      expect(sql.values).toContain("%50\\%\\_off\\\\x%");
      expect(sql.values).toContain("50%_off\\x");
      expect(sql.values).toEqual(expect.arrayContaining(["w1", "b1"]));
    }
  });

  it("rate-limited after 30", async () => {
    m.hit.mockResolvedValue({ allowed: false, count: 31 });
    const err = await searchBrand(STAFF, taskViewer(STAFF), "menu").catch((e) => e);
    expect(err).toMatchObject({ status: 429 });
    expect(m.hit).toHaveBeenCalledWith("search:u1", 30, 60_000);
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect((await get("menu")).status).toBe(429);
  });

  it("under 2 chars → empty", async () => {
    const empty = { tasks: [], projects: [], posts: [], products: [], campaigns: [] };
    expect(await searchBrand(STAFF, taskViewer(STAFF), " a ")).toEqual(empty);
    const res = await get("");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(empty);
    expect(m.hit).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("over 100 chars → 400", async () => {
    expect((await get("x".repeat(101))).status).toBe(400);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("groups hits by kind, tagged with their kind", async () => {
    db.$queryRaw.mockImplementation(async (sql: Prisma.Sql) => (text(sql).includes(`FROM "Product"`) ? [{ id: "p1", title: "Oak menu board" }] : []));
    const out = await searchBrand(STAFF, taskViewer(STAFF), "menu");
    expect(out.products).toEqual([{ kind: "product", id: "p1", title: "Oak menu board" }]);
    expect(out.tasks).toEqual([]);
  });

  it("tasks go through the visibility rule; a client gets shared projects, and posts, products and campaigns like their lists", async () => {
    const client = scopeOf(["brand.read", "tasks.read"], true);
    await searchBrand(client, taskViewer(client), "menu");
    expect(db.$queryRaw).toHaveBeenCalledTimes(5);
    expect(text(sqlFor("Task")!)).toContain(`t."reviewerId" =`);
    expect(text(sqlFor("WorkProject")!)).toContain(`p."clientVisible"`);
    expect(text(sqlFor("ContentItem")!)).toContain(`<> 'CANCELLED'`);
    expect(text(sqlFor("Product")!)).toContain(`"archivedAt" IS NULL`);
    expect(text(sqlFor("Campaign")!)).toContain(`"archivedAt" IS NULL`);
  });

  it("each kind needs its own list route's key", async () => {
    const keys: Record<string, PermissionKey> = {};
    // Record the key each list asks for, then stop before its body runs.
    m.authorize.mockImplementation(async () => {
      throw new AccessDeniedError("stop");
    });
    const list = (path: string) => import(`@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/${path}/route`);
    for (const [kind, path] of [["posts", "content"], ["products", "products"], ["campaigns", "campaigns"], ["projects", "work-projects"], ["tasks", "tasks"]] as const) {
      m.authorize.mockClear();
      await (await list(path)).GET(new Request("http://x/api"), { params: Promise.resolve({ workspaceId: "w1", brandId: "b1" }) }).catch(() => null);
      keys[kind] = m.authorize.mock.calls[0]![2];
    }
    expect(keys).toEqual({ posts: "brand.read", products: "brand.read", campaigns: "brand.read", projects: "tasks.read", tasks: "tasks.read" });
    // Search asks brand.read at the route and tasks.read (through the viewer) for tasks and projects.
    const reader = scopeOf(["brand.read"]);
    await searchBrand(reader, taskViewer(reader), "menu");
    expect(sqls().map((s) => text(s).match(/FROM "(\w+)"/)![1]).sort()).toEqual(["Campaign", "ContentItem", "Product"]);
  });

  it("without tasks.read: no task or project query", async () => {
    const reader = scopeOf(["brand.read"]);
    const out = await searchBrand(reader, taskViewer(reader), "menu");
    expect(out.tasks).toEqual([]);
    expect(out.projects).toEqual([]);
    expect(sqlFor("Task")).toBeUndefined();
    expect(sqlFor("WorkProject")).toBeUndefined();
    expect(text(sqlFor("Product")!)).toContain(`"archivedAt" IS NULL`);
    expect(text(sqlFor("Campaign")!)).toContain(`"archivedAt" IS NULL`);
  });

  it("no brand.read → 403", async () => {
    scope = scopeOf([]);
    expect((await get("menu")).status).toBe(403);
  });
});
